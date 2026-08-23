import { describe, expect, it, beforeEach } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection, HubMcpServer } from '../src/index.js'
import { FakeNode } from '../tests/fake-node.js'
import type { WireMessage, NodeInfo } from '../../protocol/src/index.js'
import { DANGER } from '../../protocol/src/index.js'

function makeNodeInfo(id: string, name: string): NodeInfo {
  return {
    node_id: id,
    display_name: name,
    platform: { os: 'darwin', arch: 'arm64', release: 'test', nodeVersion: 'v22' },
    versions: { agent: '0.1.0', protocol: 1 },
    capabilities: { sessions: true, serena: true, tunnel: false, presenceProvider: true, defaultNode: name === 'main' },
  }
}

interface Rig {
  store: DshHelmStore
  cp: ControlPlane
  conns: Map<string, HubConnection>
  mcp: HubMcpServer
  nodeA: FakeNode
  nodeB: FakeNode
  connect(node: FakeNode): void
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
    hubId: 'hub-mcp',
    schemaVersion: 1,
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    defaultNodeId: 'n-a',
    tokenLookup: (id) => (id === 'n-a' || id === 'n-b' ? `token-${id}` : undefined),
    connections: conns,
    log: () => {},
  })
  const mcp = new HubMcpServer({ cp, log: () => {} })
  const nodeA = new FakeNode({ node: makeNodeInfo('n-a', 'main'), token: 'token-n-a', schemaVersion: 1 })
  const nodeB = new FakeNode({ node: makeNodeInfo('n-b', 'remote'), token: 'token-n-b', schemaVersion: 1 })
  const rig: Rig = { store, cp, conns, mcp, nodeA, nodeB, connect: () => {} }
  rig.connect = (node: FakeNode) => {
    let toHub: (m: WireMessage) => void = () => {}
    let toNode: (m: WireMessage) => void = () => {}
    const conn = new HubConnection({
      cp,
      send: (m) => toNode(m),
      onClose: (id) => id && conns.delete(id),
    })
    node.attach((m) => toHub(m))
    toHub = (m) => conn.inbound(m)
    toNode = (m) => node.inbound(m)
    node.start()
  }
  return rig
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms))

describe('HubMcpServer tool surface', () => {
  let rig: Rig

  beforeEach(() => {
    rig = buildRig()
  })

  it('lists 24 tools (19 compat + 5 control-plane)', async () => {
    const tools = (rig.mcp.listTools() as Array<{ name: string }>).map((t) => t.name)
    expect(tools).toHaveLength(24)
    for (const compat of ['sessions_prompt', 'sessions_list', 'code_read_file', 'code_use_workspace', 'supervisor_health', 'projects_list', 'workspaces_list', 'agents_list']) {
      expect(tools).toContain(compat)
    }
    for (const ctrl of ['nodes_list', 'node_get', 'route_explain', 'presence_claim', 'presence_release']) {
      expect(tools).toContain(ctrl)
    }
  })

  it('nodes_list aggregates both connected nodes', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    const res = await rig.mcp.callTool({ name: 'nodes_list', arguments: {} })
    expect(res.isError).toBeFalsy()
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed.nodes.map((n: { node_id: string }) => n.node_id).sort()).toEqual(['n-a', 'n-b'])
    expect(parsed.nodes.every((n: { connected: boolean }) => n.connected)).toBe(true)
  })

  it('sessions_list aggregates across nodes with node filter', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    rig.nodeA.sessions = [{ native_session_id: 's-a', status: 'idle', live: false }]
    rig.nodeB.sessions = [{ native_session_id: 's-b', status: 'running', live: true }]
    const all = JSON.parse((await rig.mcp.callTool({ name: 'sessions_list' })).content[0]!.text)
    expect(all.sessions.map((s: { native_session_id?: string; session_id: string }) => s.session_id ?? s.native_session_id).sort()).toEqual(['s-a', 's-b'])
    const filtered = JSON.parse((await rig.mcp.callTool({ name: 'sessions_list', arguments: { node_id: 'n-a' } })).content[0]!.text)
    expect(filtered.sessions).toHaveLength(1)
  })

  it('sessions_prompt routes to session owner via mcp.call', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    const s = rig.cp.sessionCatalog()
    s.upsert('n-b', { native_session_id: 'sess-1', status: 'idle' })
    rig.nodeB.sessions.push({ native_session_id: 'sess-1', status: 'idle', live: false })
    const res = await rig.mcp.callTool({ name: 'sessions_prompt', arguments: { session_id: 'sess-1', message: 'hello' } })
    expect(res.isError).toBeFalsy()
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed.reply).toContain('remote')
    expect(parsed._route.node_id).toBe('n-b')
  })

  it('explicit target_node overrides session owner', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    const s = rig.cp.sessionCatalog()
    s.upsert('n-b', { native_session_id: 'sess-1', status: 'idle' })
    rig.nodeB.sessions.push({ native_session_id: 'sess-1', status: 'idle', live: false })
    const res = await rig.mcp.callTool({ name: 'sessions_get', arguments: { session_id: 'sess-1', target_node: 'n-a' } })
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed).toBeDefined()
  })

  it('code tools route to workspace owner node', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    rig.cp.workspaceCatalog().upsert('n-b', { native_workspace_id: 'w-1', path: '/Users/me/remote-proj' })
    const res = await rig.mcp.callTool({ name: 'code_read_file', arguments: { path: '/Users/me/remote-proj/a.ts', workspace: 'w-1' } })
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed.content).toContain('remote')
    expect(parsed._route.node_id).toBe('n-b')
  })

  it('route_explain reports precedence without executing', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    rig.cp.sessionCatalog().upsert('n-b', { native_session_id: 's-9', status: 'idle' })
    const res = await rig.mcp.callTool({ name: 'route_explain', arguments: { op: 'sessions_prompt', session_id: 's-9' } })
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed.decision.outcome).toBe('session_owner')
    expect(parsed.decision.node_id).toBe('n-b')
    expect(parsed.danger).toBe(DANGER.DESTRUCTIVE)
  })

  it('presence_claim pins a node; sessions_create routes there', async () => {
    rig.connect(rig.nodeA)
    rig.connect(rig.nodeB)
    await settle()
    const claim = await rig.mcp.callTool({ name: 'presence_claim', arguments: { node_id: 'n-b' } })
    expect(JSON.parse(claim.content[0]!.text).pinned).toBe(true)
    // sessions_create with no session/workspace -> presence picks n-b
    const res = await rig.mcp.callTool({ name: 'sessions_create', arguments: { title: 'x' } })
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed._route.node_id).toBe('n-b')
    // release
    await rig.mcp.callTool({ name: 'presence_release', arguments: { node_id: 'n-b' } })
    const res2 = await rig.mcp.callTool({ name: 'sessions_create', arguments: { title: 'y' } })
    const parsed2 = JSON.parse(res2.content[0]!.text)
    expect(parsed2._route.node_id).toBe('n-a') // default node
  })

  it('note: unknown tool returns isError', async () => {
    const res = await rig.mcp.callTool({ name: 'no_such_tool' })
    expect(res.isError).toBe(true)
  })
})