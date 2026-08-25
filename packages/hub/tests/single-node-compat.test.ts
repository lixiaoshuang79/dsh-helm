/**
 * Phase 6: single-node regression — local compat mode.
 *
 * With exactly one node (the default), hub routing must behave like the
 * single-machine daemon: every routable op converges on that node, discovery
 * aggregates from it, and the MCP surface stays 19-tool compatible.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
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
  cp: ControlPlane
  mcp: HubMcpServer
  node: FakeNode
  nodes: NodeRegistry
  store: DshHelmStore
}

function buildSingleNodeRig(): Rig {
  const store = new DshHelmStore({ file: ':memory:' })
  const nodes = new NodeRegistry(store.db)
  const cp = new ControlPlane({
    store,
    nodes,
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
  return { cp, mcp, node, nodes, store }
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

describe('single-node local compat mode', () => {
  let rig: Rig
  beforeEach(() => {
    rig = buildSingleNodeRig()
  })

  it('sessions_create with no target converges on the single node', async () => {
    await settle()
    const res = await rig.mcp.callTool({ name: 'sessions_create', arguments: { title: 't' } })
    expect(res.isError).toBeFalsy()
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed._route.node_id).toBe('n-main')
    expect(parsed.session_id).toBeTruthy()
  })

  it('workspace code ops route to the single node', async () => {
    await settle()
    rig.cp.workspaceCatalog().upsert('n-main', { native_workspace_id: 'w-1', path: '/Users/me/proj' })
    const res = await rig.mcp.callTool({ name: 'code_use_workspace', arguments: { workspace: 'w-1' } })
    expect(JSON.parse(res.content[0]!.text)._route.node_id).toBe('n-main')
  })

  it('presence claim on the single node pins it', async () => {
    await settle()
    const res = await rig.mcp.callTool({ name: 'presence_claim', arguments: { node_id: 'n-main' } })
    expect(JSON.parse(res.content[0]!.text).pinned).toBe(true)
  })

  it('supervisor_health reports the single node in layered form', async () => {
    await settle()
    const res = await rig.mcp.callTool({ name: 'supervisor_health' })
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0]!.node_id).toBe('n-main')
    expect(parsed.adapters).toHaveLength(1)
  })

  it('19-tool compat surface intact (no unknown tool from ChatGPT)', async () => {
    const tools = (rig.mcp.listTools() as Array<{ name: string }>).map((t) => t.name)
    const compat = ['code_read_file', 'code_list_dir', 'code_find_file', 'code_search_for_pattern', 'code_get_symbols_overview', 'code_find_symbol', 'code_find_referencing_symbols', 'code_use_workspace', 'projects_list', 'supervisor_health', 'agents_list', 'workspaces_list', 'sessions_create', 'sessions_list', 'sessions_get', 'sessions_resume', 'sessions_prompt', 'sessions_wait', 'sessions_cancel']
    for (const t of compat) expect(tools).toContain(t)
  })

  it('no-route fail-closed still guards destructive ops when node offline', async () => {
    await settle()
    rig.nodes.markOffline('n-main', 'test')
    const res = await rig.mcp.callTool({ name: 'sessions_prompt', arguments: { session_id: 'ghost', message: '[model-check] 当前模型是 gpt-5-6-thinking: x' } })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('route rejected')
  })
})