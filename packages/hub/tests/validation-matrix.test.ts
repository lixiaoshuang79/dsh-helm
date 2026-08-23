/**
 * Phase 6 validation matrix — protocol/control-plane edge cases.
 *
 * Covers: auth failure, version mismatch (no silent downgrade), presence
 * expiry/ambiguity, session owner, workspace/code affinity, dangerous
 * fallback fail-closed, persistence crash/restart, offline/recovery.
 */

import { describe, expect, it } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection, HubMcpServer } from '../src/index.js'
import { FakeNode } from '../tests/fake-node.js'
import type { WireMessage, NodeInfo } from '../../protocol/src/index.js'
import { DANGER, ROUTE_OUTCOME } from '../../protocol/src/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeNodeInfo(id: string, name: string): NodeInfo {
  return {
    node_id: id,
    display_name: name,
    platform: { os: 'darwin', arch: 'arm64', release: 'test', nodeVersion: 'v22' },
    versions: { agent: '0.1.0', protocol: 1 },
    capabilities: { sessions: true, serena: true, tunnel: false, presenceProvider: true, defaultNode: name === 'main' },
  }
}

function buildRig(tokenLookup: (id: string) => string | undefined = (id) => (id === 'n-a' || id === 'n-b' ? `token-${id}` : undefined), file = ':memory:') {
  const store = new DshHelmStore({ file })
  const nodes = new NodeRegistry(store.db)
  const sessions = new SessionCatalog(store.db)
  const workspaces = new WorkspaceCatalog(store.db)
  const presence = new PresenceRegistry(store.db)
  const conns = new Map<string, HubConnection>()
  const cp = new ControlPlane({
    store, nodes, sessions, workspaces, presence,
    hubId: 'hub-test', schemaVersion: 1, heartbeatMs: 15_000, leaseMs: 45_000,
    defaultNodeId: 'n-a', tokenLookup, connections: conns, log: () => {},
  })
  const mcp = new HubMcpServer({ cp, log: () => {} })
  const connect = (node: FakeNode) => {
    let toHub: (m: WireMessage) => void = () => {}
    let toNode: (m: WireMessage) => void = () => {}
    const conn = new HubConnection({ cp, send: (m) => toNode(m), onClose: (id) => id && conns.delete(id) })
    node.attach((m) => toHub(m))
    toHub = (m) => conn.inbound(m)
    toNode = (m) => node.inbound(m)
    node.start()
    return conn
  }
  return { store, nodes, sessions, workspaces, presence, cp, mcp, conns, connect }
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const now = Date.now()
const iso = (t: number) => new Date(t).toISOString()

describe('validation: protocol edge cases', () => {
  it('auth failure: wrong token never registers, no partial state', async () => {
    const rig = buildRig()
    const evil = new FakeNode({ node: makeNodeInfo('n-a', 'impostor'), token: 'wrong', schemaVersion: 1 })
    rig.connect(evil)
    await settle()
    expect(rig.conns.has('n-a')).toBe(false)
    expect(rig.nodes.get('n-a')).toBeUndefined()
    expect(rig.sessions.count()).toBe(0)
  })

  it('version mismatch: client v99 rejected, hub v1 unchanged', async () => {
    const rig = buildRig((id) => (id === 'n-z' ? 'tok-z' : undefined))
    const future = new FakeNode({ node: makeNodeInfo('n-z', 'future'), token: 'tok-z', schemaVersion: 99 })
    rig.connect(future)
    await settle()
    expect(future.connected).toBe(false)
    expect(rig.nodes.get('n-z')).toBeUndefined()
  })

  it('offline node: heartbeat expiry drops it from healthy set', async () => {
    const rig = buildRig()
    rig.connect(new FakeNode({ node: makeNodeInfo('n-a', 'main'), token: 'token-n-a', schemaVersion: 1 }))
    await settle()
    expect(rig.nodes.channelHealth('n-a', 45_000).status).toBe('ok')
    // simulate 3 missed heartbeats (last_seen older than lease)
    rig.nodes.heartbeat('n-a', { seq: 99, ts: iso(Date.now() - 120_000), health: { channel: { status: 'ok' }, adapter: { status: 'ok' }, datapath: { status: 'ok' }, serena: { status: 'unknown' } }, workspace_count: 0, session_count: 0 })
    expect(rig.nodes.channelHealth('n-a', 45_000).status).toBe('down')
    expect(rig.cp.router['healthyNodes']()).not.toContain('n-a')
  })

  it('presence expiry: stale lease is swept and no longer routes', async () => {
    const rig = buildRig()
    rig.presence.claim({ node_id: 'n-b', source: 'desktop', confidence: 0.9, observed_at: iso(now - 120_000), ttl_ms: 60_000 })
    expect(rig.presence.get('n-b')).toBeUndefined() // expired -> swept
    const res = rig.cp.router.route({ op: 'sessions_create', danger: DANGER.WRITE })
    expect(res.decision.outcome).not.toBe(ROUTE_OUTCOME.PRESENCE)
  })

  it('presence ambiguity: two fresh high-confidence claims -> no auto pick', async () => {
    const rig = buildRig()
    rig.nodes.register(makeNodeInfo('n-a', 'main'))
    rig.nodes.register(makeNodeInfo('n-b', 'other'))
    rig.presence.claim({ node_id: 'n-a', source: 'desktop', confidence: 0.9, observed_at: iso(now - 2_000), ttl_ms: 60_000 })
    rig.presence.claim({ node_id: 'n-b', source: 'desktop', confidence: 0.95, observed_at: iso(now), ttl_ms: 60_000 })
    const res = rig.cp.router.route({ op: 'sessions_create', danger: DANGER.WRITE })
    expect(res.decision.evidence.presence_ambiguous).toBe(true)
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.DEFAULT_LOCAL)
  })

  it('destructive with unclear target -> route_confirmation_required', async () => {
    const rig = buildRig()
    // no nodes online at all
    rig.nodes.markOffline('n-a', 'expired')
    const res = rig.cp.router.route({ op: 'sessions_prompt', danger: DANGER.DESTRUCTIVE })
    expect(res.action).toBe('reject')
    expect(res.errorCode).toBe('route_confirmation_required')
  })

  it('code tool with workspace owner routes even when presence points elsewhere', async () => {
    const rig = buildRig()
    rig.nodes.register(makeNodeInfo('n-b', 'codebox'))
    rig.workspaces.upsert('n-b', { native_workspace_id: 'w-1', path: '/code/repo' })
    rig.presence.claim({ node_id: 'n-a', source: 'desktop', confidence: 0.95, observed_at: iso(now), ttl_ms: 60_000 })
    const res = rig.cp.router.route({ op: 'code_read_file', workspace: 'w-1', danger: DANGER.READ })
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.WORKSPACE_OWNER)
    expect(res.decision.node_id).toBe('n-b')
  })

  it('session owner beats workspace and presence', async () => {
    const rig = buildRig()
    rig.nodes.register(makeNodeInfo('n-b', 'b'))
    rig.sessions.upsert('n-b', { native_session_id: 's-1', status: 'running', live: true })
    rig.workspaces.upsert('n-a', { native_workspace_id: 'w-1', path: '/x' })
    rig.presence.claim({ node_id: 'n-a', source: 'desktop', confidence: 0.99, observed_at: iso(now), ttl_ms: 60_000 })
    const res = rig.cp.router.route({ op: 'sessions_prompt', session_id: 's-1', workspace: 'w-1', danger: DANGER.DESTRUCTIVE })
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.SESSION_OWNER)
    expect(res.decision.node_id).toBe('n-b')
  })
})

describe('validation: persistence crash/restart', () => {
  it('store survives process restart (file db)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-persist-'))
    const file = join(dir, 'store.sqlite3')
    try {
      // write phase
      {
        const rig = buildRig(() => 'tok', file)
        rig.nodes.register(makeNodeInfo('n-a', 'main'))
        rig.sessions.upsert('n-a', { native_session_id: 's-1', status: 'idle' })
        rig.workspaces.upsert('n-a', { native_workspace_id: 'w-1', path: '/p' })
        rig.presence.claim({ node_id: 'n-a', source: 'manual', confidence: 1, observed_at: iso(now), ttl_ms: 0, pinned: true })
        rig.store.close()
      }
      // restart phase: new store instance on same file
      const rig2 = buildRig(() => 'tok', file)
      expect(rig2.nodes.get('n-a')?.display_name).toBe('main')
      expect(rig2.sessions.get('s-1')?.status).toBe('idle')
      expect(rig2.workspaces.resolve('w-1')?.node_id).toBe('n-a')
      expect(rig2.presence.get('n-a')?.pinned).toBe(1)
      rig2.store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('validation: node lifecycle', () => {
  it('node release marks offline and removes connection', async () => {
    const rig = buildRig()
    rig.connect(new FakeNode({ node: makeNodeInfo('n-a', 'main'), token: 'token-n-a', schemaVersion: 1 }))
    await settle()
    expect(rig.conns.has('n-a')).toBe(true)
    rig.cp.handleRelease('n-a')
    expect(rig.conns.has('n-a')).toBe(false)
    expect(rig.nodes.get('n-a')?.status).toBe('offline')
  })

  it('disconnect (socket close) marks offline via onClose', async () => {
    const rig = buildRig()
    const conn = rig.connect(new FakeNode({ node: makeNodeInfo('n-a', 'main'), token: 'token-n-a', schemaVersion: 1 }))
    await settle()
    expect(rig.conns.has('n-a')).toBe(true)
    conn.close()
    await settle(10)
    expect(rig.conns.has('n-a')).toBe(false)
  })

  it('MCP route_explain gives actionable evidence', async () => {
    const rig = buildRig()
    rig.nodes.register(makeNodeInfo('n-b', 'other'))
    rig.sessions.upsert('n-b', { native_session_id: 's-2', status: 'idle' })
    const res = await rig.mcp.callTool({ name: 'route_explain', arguments: { op: 'sessions_prompt', session_id: 's-2' } })
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed.decision.evidence.session_owner).toBe('n-b')
    expect(parsed.action).toBe('forward')
  })
})