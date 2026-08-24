/**
 * HubMcpServer HA write-gating tests: with a fake WriteForwarder, WRITE_TOOLS
 * must be intercepted while writeMode() is 'readonly' (forwarded when the
 * forwarder is a follower, refused with QUORUM_LOST otherwise) and must
 * execute locally while writeMode() is 'readwrite' (standalone / leader).
 */

import { describe, expect, it } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection, HubMcpServer, QUORUM_LOST_ERROR } from '../src/index.js'
import { FakeNode } from '../tests/fake-node.js'
import type { WireMessage, NodeInfo } from '../../protocol/src/index.js'
import type { WriteForwarder } from '../src/mcp/server.js'
import type { McpCallResult } from '../src/mcp/server.js'

function makeNodeInfo(id: string, name: string): NodeInfo {
  return {
    node_id: id,
    display_name: name,
    platform: { os: 'darwin', arch: 'arm64', release: 'test', nodeVersion: 'v22' },
    versions: { agent: '0.1.0', protocol: 1 },
    capabilities: { sessions: true, serena: true, tunnel: false, presenceProvider: true, defaultNode: true },
  }
}

function buildRig(ha?: WriteForwarder): {
  store: DshHelmStore
  cp: ControlPlane
  mcp: HubMcpServer
  node: FakeNode
  close(): void
} {
  const store = new DshHelmStore({ file: ':memory:' })
  const nodes = new NodeRegistry(store.db)
  const sessions = new SessionCatalog(store.db)
  const workspaces = new WorkspaceCatalog(store.db)
  const presence = new PresenceRegistry(store.db)
  const conns = new Map<string, HubConnection>()
  const cp = new ControlPlane({
    store, nodes, sessions, workspaces, presence,
    hubId: 'hub-mcp', schemaVersion: 1, heartbeatMs: 15_000, leaseMs: 45_000,
    defaultNodeId: 'n-a', tokenLookup: (id) => (id === 'n-a' ? 'tok' : undefined),
    connections: conns, log: () => {},
  })
  const mcp = new HubMcpServer({ cp, ha, log: () => {} })
  const node = new FakeNode({ node: makeNodeInfo('n-a', 'main'), token: 'tok', schemaVersion: 1 })
  let toHub: (m: WireMessage) => void = () => {}
  let toNode: (m: WireMessage) => void = () => {}
  const conn = new HubConnection({ cp, send: (m) => toNode(m), onClose: (id) => id && conns.delete(id) })
  node.attach((m) => toHub(m))
  toHub = (m) => conn.inbound(m)
  toNode = (m) => node.inbound(m)
  node.start()
  return {
    store, cp, mcp, node,
    close: () => {
      store.close()
    },
  }
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms))

/** A controllable fake forwarder. */
class FakeForwarder implements WriteForwarder {
  mode: 'readwrite' | 'readonly' = 'readwrite'
  forwarded: Array<{ name: string; args: Record<string, unknown> }> = []
  writeMode(): 'readwrite' | 'readonly' {
    return this.mode
  }
  async handleWrite(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.forwarded.push({ name, args })
    return { content: [{ type: 'text', text: 'forwarded-ok' }] }
  }
}

describe('HubMcpServer HA write gating', () => {
  it('executes writes locally when writeMode is readwrite (leader/standalone)', async () => {
    const fw = new FakeForwarder()
    const rig = buildRig(fw)
    try {
      await settle()
      const res = await rig.mcp.callTool({ name: 'sessions_create', arguments: { title: 't' } })
      expect(res.isError).toBeFalsy()
      expect(fw.forwarded).toHaveLength(0) // ran locally (routed to the node)
      const text = res.content?.[0]?.text ?? ''
      expect(text).toContain('session-') // node executed sessions_create via mcp.call
    } finally {
      rig.close()
    }
  })

  it('forwards WRITE_TOOLS to the leader while writeMode is readonly (follower)', async () => {
    const fw = new FakeForwarder()
    fw.mode = 'readonly'
    const rig = buildRig(fw)
    try {
      await settle()
      const res = await rig.mcp.callTool({ name: 'sessions_create', arguments: { title: 't' } })
      expect(res.content?.[0]?.text).toBe('forwarded-ok')
      expect(fw.forwarded).toHaveLength(1)
      expect(fw.forwarded[0]).toMatchObject({ name: 'sessions_create' })
      expect(rig.node.sessions.length).toBe(0) // nothing ran on the node
    } finally {
      rig.close()
    }
  })

  it('refuses writes when the forwarder returns the QUORUM_LOST error', async () => {
    const fw = new FakeForwarder()
    fw.mode = 'readonly'
    fw.handleWrite = async () => ({ content: [{ type: 'text', text: QUORUM_LOST_ERROR }], isError: true })
    const rig = buildRig(fw)
    try {
      await settle()
      const res = await rig.mcp.callTool({ name: 'presence_claim', arguments: { display_name: 'x' } })
      expect(res.isError).toBe(true)
      expect(res.content?.[0]?.text).toBe(QUORUM_LOST_ERROR)
    } finally {
      rig.close()
    }
  })

  it('does NOT gate read tools while readonly (reads stay local)', async () => {
    const fw = new FakeForwarder()
    fw.mode = 'readonly'
    const rig = buildRig(fw)
    try {
      await settle()
      const res = await rig.mcp.callTool({ name: 'sessions_list', arguments: {} })
      expect(res.isError).toBeFalsy()
      expect(fw.forwarded).toHaveLength(0)
    } finally {
      rig.close()
    }
  })
})
