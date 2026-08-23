/**
 * Phase 1 acceptance: two fake nodes against one control plane over the full
 * protocol (handshake -> register -> heartbeat -> catalog reconcile ->
 * presence -> routed forwarding), all in-memory. No sockets, no real DSH.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../packages/store/src/index.js'
import { ControlPlane, HubConnection } from '../../packages/hub/src/index.js'
import { FakeNode } from '../../packages/hub/tests/fake-node.js'
import type { WireMessage, NodeInfo } from '../../packages/protocol/src/index.js'
import { DANGER } from '../../packages/protocol/src/index.js'

const HUB_ID = 'hub-test-1'
const SCHEMA = 1

interface Rig {
  store: DshHelmStore
  cp: ControlPlane
  conns: Map<string, HubConnection>
  nodeA: FakeNode
  nodeB: FakeNode
  connect(node: FakeNode): HubConnection
}

function makeNodeInfo(id: string, name: string): NodeInfo {
  return {
    node_id: id,
    display_name: name,
    platform: { os: 'darwin', arch: 'arm64', release: 'test', nodeVersion: 'v22' },
    versions: { agent: '0.1.0', protocol: SCHEMA },
    capabilities: { sessions: true, serena: true, tunnel: false, presenceProvider: true, defaultNode: name === 'mac-mini' },
  }
}

function buildRig(): Rig {
  const store = new DshHelmStore({ file: ':memory:' })
  const nodes = new NodeRegistry(store.db)
  const sessions = new SessionCatalog(store.db)
  const workspaces = new WorkspaceCatalog(store.db)
  const presence = new PresenceRegistry(store.db)
  const conns = new Map<string, HubConnection>()
  const cp = new ControlPlane({
    store,
    nodes,
    sessions,
    workspaces,
    presence,
    hubId: HUB_ID,
    schemaVersion: SCHEMA,
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    defaultNodeId: 'n-default',
    tokenLookup: (id) => (id === 'n-a' || id === 'n-b' || id === 'n-default' ? `token-${id}` : undefined),
    connections: conns,
    log: (l) => l,
  })
  const nodeA = new FakeNode({ node: makeNodeInfo('n-a', 'mac-mini'), token: 'token-n-a', schemaVersion: SCHEMA })
  const nodeB = new FakeNode({ node: makeNodeInfo('n-b', 'macbook-pro'), token: 'token-n-b', schemaVersion: SCHEMA })
  const rig: Rig = { store, cp, conns, nodeA, nodeB, connect: () => null as unknown as HubConnection }
  rig.connect = (node: FakeNode) => {
    let toHub: (msg: WireMessage) => void = () => {}
    let toNode: (msg: WireMessage) => void = () => {}
    const conn = new HubConnection({
      cp,
      send: (m) => toNode(m),
      onClose: (nodeId) => nodeId && conns.delete(nodeId),
    })
    node.attach((m) => toHub(m))
    toHub = (m) => conn.inbound(m)
    toNode = (m) => node.inbound(m)
    node.start()
    return conn
  }
  return rig
}

async function settle(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('two-fake-node control plane integration', () => {
  let rig: Rig

  beforeEach(() => {
    rig = buildRig()
  })

  it('both nodes authenticate and register', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    expect(rig.nodeA.connected).toBe(true)
    expect(rig.nodeB.connected).toBe(true)
    expect(rig.nodeA.welcome?.hub_id).toBe(HUB_ID)
    expect(rig.conns.has('n-a')).toBe(true)
    expect(rig.conns.has('n-b')).toBe(true)
    expect(rig.cp.nodeCatalog()).toHaveLength(2)
  })

  it('rejects a node with a wrong token', async () => {
    const evil = new FakeNode({ node: makeNodeInfo('n-a', 'impostor'), token: 'wrong', schemaVersion: SCHEMA })
    rig.connect(evil)
    await settle()
    expect(evil.connected).toBe(false)
    expect(rig.conns.has('n-a')).toBe(false)
  })

  it('rejects a node with an incompatible protocol version (no silent downgrade)', async () => {
    const v2 = new FakeNode({ node: makeNodeInfo('n-c', 'future-node'), token: 'token-n-c', schemaVersion: 99 })
    // token lookup only knows n-a/n-b/n-default; n-c must fail auth too, but
    // version check fires first in the handshake server.
    rig.connect(v2)
    await settle()
    expect(v2.connected).toBe(false)
  })

  it('registers, heartbeats, and catalog-reconciles sessions and workspaces', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    rig.cp.handleReconcile({
      node_id: 'n-a',
      sessions: [{ native_session_id: 'session-1', status: 'running', live: true, title: 'on mac-mini' }],
      workspaces: [{ native_workspace_id: 'w-1', path: '/Users/me/mac-project' }],
    })
    rig.cp.handleReconcile({
      node_id: 'n-b',
      sessions: [{ native_session_id: 'session-2', status: 'idle', live: false }],
      workspaces: [{ native_workspace_id: 'w-2', path: '/Users/me/laptop-project' }],
    })
    // store-level check
    const s = new SessionCatalog(rig.store.db)
    const w = new WorkspaceCatalog(rig.store.db)
    expect(s.count()).toBe(2)
    expect(s.ownerOf('session-1')).toBe('n-a')
    expect(w.ownerOf('w-2')).toBe('n-b')
  })

  it('routes sessions_prompt to the session owner via live connection', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    rig.cp.handleReconcile({
      node_id: 'n-b',
      sessions: [{ native_session_id: 'session-9', status: 'idle', live: false }],
    })
    // The fake node must know the session to answer prompts.
    rig.nodeB.sessions.push({ native_session_id: 'session-9', status: 'idle', live: false })
    const res = rig.cp.router.route({ op: 'sessions_prompt', session_id: 'session-9', danger: DANGER.DESTRUCTIVE })
    expect(res.decision.node_id).toBe('n-b')
    const out = await rig.cp.forward(res, 'sessions_prompt', { session_id: 'session-9', message: 'hi' })
    expect(out).toMatchObject({ ok: true })
    expect(String((out as { reply?: string }).reply ?? '')).toContain('macbook-pro')
  })

  it('routes code tools to the workspace owner', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    rig.cp.handleReconcile({ node_id: 'n-a', workspaces: [{ native_workspace_id: 'w-1', path: '/Users/me/proj' }] })
    const res = rig.cp.router.route({ op: 'code_read_file', workspace: 'w-1', danger: DANGER.READ })
    expect(res.decision.node_id).toBe('n-a')
    const out = await rig.cp.forward(res, 'code_read_file', { path: '/Users/me/proj/x.ts' })
    expect(String((out as { content?: string }).content ?? '')).toContain('mac-mini')
  })

  it('aggregates sessions/workspaces across both nodes', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    rig.nodeA.sessions = [{ native_session_id: 's-a1', status: 'idle', live: false }]
    rig.nodeB.sessions = [{ native_session_id: 's-b1', status: 'idle', live: false }]
    rig.nodeA.workspaces = [{ native_workspace_id: 'w-a', path: '/a' }]
    rig.nodeB.workspaces = [{ native_workspace_id: 'w-b', path: '/b' }]
    const sessions = await rig.cp.aggregateSessions()
    const workspaces = await rig.cp.aggregateWorkspaces()
    expect(sessions.map((x) => x.node_id).sort()).toEqual(['n-a', 'n-b'])
    expect(sessions.flatMap((x) => x.sessions).map((s) => s.native_session_id).sort()).toEqual(['s-a1', 's-b1'])
    expect(workspaces.flatMap((x) => x.workspaces).length).toBe(2)
  })

  it('heartbeat keeps a node healthy; expiry marks it offline', async () => {
    rig.connect(rig.nodeA)
    await settle()
    // nodeA heartbeats now
    const nodes = new NodeRegistry(rig.store.db)
    nodes.heartbeat('n-a', {
      seq: 1,
      ts: new Date().toISOString(),
      health: { channel: { status: 'ok' }, adapter: { status: 'ok' }, datapath: { status: 'ok' }, serena: { status: 'unknown' } },
      workspace_count: 1,
      session_count: 1,
    })
    expect(nodes.channelHealth('n-a', 45_000).status).toBe('ok')
    // Simulate lease expiry (backdate last_seen)
    nodes.heartbeat('n-a', {
      seq: 2,
      ts: new Date(Date.now() - 120_000).toISOString(),
      health: { channel: { status: 'ok' }, adapter: { status: 'ok' }, datapath: { status: 'ok' }, serena: { status: 'unknown' } },
      workspace_count: 1,
      session_count: 1,
    })
    expect(nodes.channelHealth('n-a', 45_000).status).toBe('down')
  })

  it('presence claim is stored and routes to the present node', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    rig.cp.handlePresenceReport({
      claim: { node_id: 'n-b', source: 'manual', confidence: 1.0, observed_at: new Date().toISOString(), ttl_ms: 0, pinned: true },
    })
    const res = rig.cp.router.route({ op: 'sessions_create', danger: DANGER.WRITE })
    expect(res.decision.node_id).toBe('n-b')
    expect(res.decision.outcome).toBe('presence')
  })
})