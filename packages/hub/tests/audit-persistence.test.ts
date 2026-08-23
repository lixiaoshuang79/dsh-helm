/**
 * Phase 6: audit + route_log persistence validation.
 *
 * Every routed op writes an audit row and a route_log row (no bodies, no
 * secrets); results update the pending audit row.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry, AuditLog } from '../../store/src/index.js'
import { ControlPlane, HubConnection, HubMcpServer } from '../src/index.js'
import { FakeNode } from '../tests/fake-node.js'
import type { WireMessage, NodeInfo } from '../../protocol/src/index.js'

function nodeInfo(id: string, name: string): NodeInfo {
  return {
    node_id: id,
    display_name: name,
    platform: { os: 'darwin', arch: 'arm64', release: 't', nodeVersion: 'v22' },
    versions: { agent: '0.1.0', protocol: 1 },
    capabilities: { sessions: true, serena: true, tunnel: false, presenceProvider: true, defaultNode: true },
  }
}

interface Rig {
  store: DshHelmStore
  audit: AuditLog
  cp: ControlPlane
  mcp: HubMcpServer
  node: FakeNode
}

function buildRig(): Rig {
  const store = new DshHelmStore({ file: ':memory:' })
  const audit = new AuditLog(store.db)
  const cp = new ControlPlane({
    store,
    nodes: new NodeRegistry(store.db),
    sessions: new SessionCatalog(store.db),
    workspaces: new WorkspaceCatalog(store.db),
    presence: new PresenceRegistry(store.db),
    hubId: 'hub-1',
    schemaVersion: 1,
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    defaultNodeId: 'n-main',
    tokenLookup: (id) => (id === 'n-main' ? 'tok' : undefined),
    connections: new Map<string, HubConnection>(),
    audit,
    log: () => {},
  })
  const mcp = new HubMcpServer({ cp, log: () => {} })
  const node = new FakeNode({ node: nodeInfo('n-main', 'main'), token: 'tok', schemaVersion: 1 })
  let toHub: (m: WireMessage) => void = () => {}
  let toNode: (m: WireMessage) => void = () => {}
  const conn = new HubConnection({ cp, send: (m) => toNode(m), onClose: () => {} })
  node.attach((m) => toHub(m))
  toHub = (m) => conn.inbound(m)
  toNode = (m) => node.inbound(m)
  node.start()
  return { store, audit, cp, mcp, node }
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

describe('audit persistence', () => {
  let rig: Rig
  beforeEach(() => {
    rig = buildRig()
  })

  it('a routed op writes audit + route_log rows with result updated', async () => {
    await settle()
    const before = rig.audit.count()
    const res = await rig.mcp.callTool({ name: 'sessions_create', arguments: { title: 'x' } })
    expect(res.isError).toBeFalsy()
    expect(rig.audit.count()).toBe(before + 1)
    const rows = rig.audit.list(10)
    expect(rows[0]!.op).toBe('sessions_create')
    expect(rows[0]!.result).toBe('ok')
    expect(rows[0]!.danger).toBe('write')
    expect(rows[0]!.target_node).toBe('n-main')
    // route_log present
    const routes = rig.audit.recentRoutes(5)
    expect(routes[0]!.op).toBe('sessions_create')
    expect(routes[0]!.decision.outcome).toBe('default_local')
    expect(routes[0]!.decision.node_id).toBe('n-main')
  })

  it('failed forwards record error result', async () => {
    await settle()
    // fail the mcp.call path for sessions_create on the fake node
    rig.node.failMethods = new Set(['mcp.call:sessions_create'])
    const res = await rig.mcp.callTool({ name: 'sessions_create', arguments: { title: 'x' } })
    expect(res.isError).toBe(true)
    const rows = rig.audit.list(10)
    expect(rows[0]!.result.startsWith('error:')).toBe(true)
  })

  it('rejected routes are NOT written to audit (fail-closed before forward)', async () => {
    await settle()
    // mark the only node offline -> destructive prompt has no route
    const nodes = new NodeRegistry(rig.store.db)
    nodes.markOffline('n-main', 'test')
    const before = rig.audit.count()
    const res = await rig.mcp.callTool({ name: 'sessions_prompt', arguments: { session_id: 'ghost', message: 'x' } })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('route rejected')
    expect(rig.audit.count()).toBe(before) // no audit row for rejected route
  })
})