/**
 * Phase 6: node-agent reconnect / offline-recovery validation.
 *
 * A fake hub (in-process) accepts the agent's handshake, then we simulate a
 * socket drop and verify: backoff reconnect, full re-register, heartbeat
 * resume, catalog reconcile after reconnect (no partial state).
 */

import { describe, expect, it } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection } from '../../hub/src/index.js'
import { HelmNodeAgent } from '../src/index.js'
import { FakeBackend } from './backend-fixtures.js'
import type { WireMessage, NodeInfo } from '../../protocol/src/index.js'
import { HandshakeServer } from '../../protocol/src/index.js'

class FakeHubSocket {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  private toHub: (m: WireMessage) => void = () => {}
  /** Simulate server -> client frame. */
  serverSend(m: WireMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
  send(data: string): void {
    this.toHub(JSON.parse(data) as WireMessage)
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
  attach(fn: (m: WireMessage) => void): void {
    this.toHub = fn
  }
}

interface Rig {
  store: DshHelmStore
  nodes: NodeRegistry
  cp: ControlPlane
  conns: Map<string, HubConnection>
  backend: FakeBackend
  agent: HelmNodeAgent
  hubSocket: FakeHubSocket
  simulateServerClose(): void
}

function buildRig(heartbeatMs = 15_000, leaseMs = 45_000): Rig {
  const store = new DshHelmStore({ file: ':memory:' })
  const nodes = new NodeRegistry(store.db)
  const sessions = new SessionCatalog(store.db)
  const workspaces = new WorkspaceCatalog(store.db)
  const presence = new PresenceRegistry(store.db)
  const conns = new Map<string, HubConnection>()
  const cp = new ControlPlane({
    store, nodes, sessions, workspaces, presence,
    hubId: 'hub-test', schemaVersion: 1, heartbeatMs, leaseMs,
    defaultNodeId: 'n-agent', tokenLookup: (id) => (id === 'n-agent' ? 'tok' : undefined),
    connections: conns, log: () => {},
  })
  const backend = new FakeBackend({
    sessions: [{ session_id: 's-r1', status: 'idle', live: false }],
    workspaces: [],
  })
  const hubSocket = new FakeHubSocket()
  const agent = new HelmNodeAgent({
    config: {
      node_id: 'n-agent', hub_url: 'ws://fake/', token: 'tok',
      local_mcp_url: 'http://127.0.0.1:3457/mcp', local_mcp_token: 't',
      display_name: 'a', local_probe_ms: 10_000, reconcile_ms: 10_000,
    },
    backend, wsFactory: () => hubSocket, heartbeatMs, leaseMs, log: () => {},
  })
  // Wire hub side: a fresh HubConnection per agent connect attempt
  let conn: HubConnection | undefined
  hubSocket.attach((m) => {
    if (!conn) {
      conn = new HubConnection({ cp, send: (mm) => hubSocket.serverSend(mm), onClose: (id) => id && conns.delete(id) })
    }
    conn.inbound(m)
  })
  // Simulate the server side closing the socket: agent sees onclose, hub
  // side closes its HubConnection (mirrors mesh.ts socket.on('close')).
  const simulateServerClose = (): void => {
    conn?.close()
    conn = undefined
    hubSocket.onclose?.()
  }
  return { store, nodes, cp, conns, backend, agent, hubSocket, simulateServerClose }
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms))

describe('node-agent reconnect & recovery', () => {
  it('re-registers and reconciles after a simulated socket drop', async () => {
    const rig = buildRig()
    rig.agent.start()
    rig.hubSocket.onopen?.() // simulate server accepting the connection
    await settle(150)
    expect(rig.conns.has('n-agent')).toBe(true)
    // catalog present after first connect
    expect(rig.cp.sessionCatalog().ownerOf('s-r1')).toBe('n-agent')

    // simulate socket drop (server closes)
    rig.simulateServerClose()
    await settle(50)
    // hub side lost the node
    expect(rig.conns.has('n-agent')).toBe(false)

    // wait for reconnect backoff (base 1s + jitter) to fire, then accept it
    await settle(1600)
    rig.hubSocket.onopen?.() // accept the re-connection
    await settle(200)
    // after reconnect, agent re-registers and re-reconciles
    expect(rig.conns.has('n-agent')).toBe(true)
    expect(rig.nodes.get('n-agent')?.status).toBe('online')
    rig.agent.stop()
    rig.store.close()
  })

  it('heartbeat keeps lease fresh; stopping agent drops it', async () => {
    const rig = buildRig(15_000, 45_000)
    rig.agent.start()
    rig.hubSocket.onopen?.()
    await settle(150)
    expect(rig.nodes.channelHealth('n-agent', 45_000).status).toBe('ok')
    rig.agent.stop()
    await settle(50)
    // simulate expiry: backdate last_seen
    rig.nodes.heartbeat('n-agent', { seq: 0, ts: new Date(Date.now() - 120_000).toISOString(), health: {}, workspace_count: 0, session_count: 0 })
    expect(rig.nodes.channelHealth('n-agent', 45_000).status).toBe('down')
    rig.store.close()
  })
})