/**
 * Contract tests: Hub 19-tool compat surface vs upstream baseline, and
 * dynamic tools.list discovery from node backends.
 *
 * 1. Static snapshot: TOOLS (19 compat) names + key params match the upstream
 *    baseline documented in docs/upstream-compat.md.
 * 2. Dynamic: a connected node's tools.list (from its LocalHelmBackend) is
 *    discoverable by the hub and aligns with the compat surface — unknown
 *    local tools are pass-through capable, hub-only tools handled locally.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection, HubMcpServer, TOOLS, COMPAT_TOOLS } from '../src/index.js'
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

/** Upstream 19-tool baseline snapshot (docs/upstream-compat.md §3). */
const UPSTREAM_19 = [
  'code_read_file', 'code_list_dir', 'code_find_file', 'code_search_for_pattern',
  'code_get_symbols_overview', 'code_find_symbol', 'code_find_referencing_symbols',
  'code_use_workspace',
  'projects_list', 'supervisor_health', 'agents_list', 'workspaces_list',
  'sessions_create', 'sessions_list', 'sessions_get', 'sessions_resume',
  'sessions_prompt', 'sessions_wait', 'sessions_cancel',
]

interface Rig {
  cp: ControlPlane
  mcp: HubMcpServer
  node: FakeNode
  store: DshHelmStore
}

function buildRig(): Rig {
  const store = new DshHelmStore({ file: ':memory:' })
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
  return { cp, mcp, node, store }
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

describe('19-tool contract (upstream compat baseline)', () => {
  it('static: hub exposes exactly the 19 upstream tools (names match snapshot)', () => {
    const compatNames = COMPAT_TOOLS.map((t) => t.name).sort()
    expect(compatNames).toEqual([...UPSTREAM_19].sort())
  })

  it('static: 5 control-plane tools are added on top (24 total)', () => {
    const all = TOOLS.map((t) => t.name)
    expect(all).toHaveLength(24)
    for (const ctrl of ['nodes_list', 'node_get', 'route_explain', 'presence_claim', 'presence_release']) {
      expect(all).toContain(ctrl)
    }
  })

  it('static: routable tools carry optional target_node (stripped before forwarding)', () => {
    for (const t of TOOLS) {
      if (t.sessionRouted || t.workspaceRouted) {
        expect(t.schema.properties['target_node'], `${t.name} missing target_node`).toBeDefined()
        expect(t.schema.properties['target_node']).toMatchObject({ type: 'string' })
      }
    }
    // presence/route control tools are not node-routed
    for (const ctrl of ['presence_claim', 'presence_release', 'route_explain', 'nodes_list', 'node_get']) {
      const def = TOOLS.find((t) => t.name === ctrl)!
      expect(def.sessionRouted || def.workspaceRouted).toBeFalsy()
    }
  })

  it('static: snake_case args preserved for upstream compat', () => {
    const prompt = TOOLS.find((t) => t.name === 'sessions_prompt')!
    expect(prompt.schema.required).toEqual(['session_id', 'message'])
    const create = TOOLS.find((t) => t.name === 'sessions_create')!
    expect(create.schema.properties['initial_message']).toBeDefined()
    expect(create.schema.properties['workspace']).toBeDefined()
  })
})

describe('dynamic tools.list discovery', () => {
  let rig: Rig
  beforeEach(() => {
    rig = buildRig()
  })

  it('hub can query a connected node\'s tools.list (generic discovery)', async () => {
    await settle()
    // Direct node RPC: TOOLS_LIST is a node-side generic capability.
    const conn = rig.cp.connections.get('n-main')!
    const tools = (await conn.request('tools.list', {}, 5_000)) as { node_id: string; tools: Array<{ name: string }> }
    expect(tools.node_id).toBe('n-main')
    const names = tools.tools.map((t) => t.name)
    for (const name of UPSTREAM_19) expect(names).toContain(name)
  })

  it('hub-local discovery tools never route to nodes', async () => {
    await settle()
    const res = await rig.mcp.callTool({ name: 'nodes_list' })
    expect(res.isError).toBeFalsy()
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed.nodes).toHaveLength(1)
  })

  it('target_node is stripped before forwarding (not sent to local helm)', async () => {
    await settle()
    rig.cp.sessionCatalog().upsert('n-main', { native_session_id: 's-1', status: 'idle' })
    rig.node.sessions.push({ native_session_id: 's-1', status: 'idle', live: false })
    const res = await rig.mcp.callTool({ name: 'sessions_get', arguments: { session_id: 's-1', target_node: 'n-main' } })
    expect(res.isError).toBeFalsy()
    // the node's local helm must never see target_node
    expect(rig.node.lastMcpCall?.tool).toBe('sessions_get')
    expect(rig.node.lastMcpCall?.args).toEqual({ session_id: 's-1' })
  })
})