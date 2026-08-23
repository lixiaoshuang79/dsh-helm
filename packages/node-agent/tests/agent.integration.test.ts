import { describe, expect, it, beforeEach } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection } from '../../hub/src/index.js'
import { HelmNodeAgent, LocalDshBridge, type WebSocketLike } from '../src/index.js'
import type { WireMessage, NodeInfo } from '../../protocol/src/index.js'

/**
 * FakeWebSocket: in-memory duplex that satisfies WebSocketLike (agent side)
 * and pipes JSON strings to/from a HubConnection.
 */
class FakeWebSocket implements WebSocketLike {
  readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  private toHub: (msg: WireMessage) => void = () => {}
  private opened = false

  constructor() {}
  setHubSink(fn: (msg: WireMessage) => void): void {
    this.toHub = fn
  }
  send(data: string): void {
    try {
      this.toHub(JSON.parse(data) as WireMessage)
    } catch {
      /* ignore */
    }
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
  /** Test helper: simulate server -> client message. */
  serverSend(msg: WireMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  /** Test helper: open the socket (like ws onopen). */
  open(): void {
    this.readyState = 1
    this.opened = true
    this.onopen?.()
  }
}

/** Fake local daemon with controllable behavior. */
function fakeDaemon(opts: { failHealth?: boolean } = {}) {
  const fetchImpl = async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}')
    let result: unknown
    if (body.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'helm-daemon', version: '0.1.1' } }
    } else if (body.method === 'tools/call') {
      const name = body.params.name
      if (name === 'supervisor_health') {
        if (opts.failHealth) throw new Error('ECONNREFUSED')
        result = { structuredContent: { status: 'ok', serena: { connected: true }, adapters: [{ id: 'dsh', health: 'ok' }] } }
      } else if (name === 'sessions_list') {
        result = { structuredContent: { sessions: [{ session_id: 's-local', title: 't', status: 'idle', live: false }] } }
      } else if (name === 'workspaces_list') {
        result = { structuredContent: { workspaces: [{ workspace_id: 'w-local', path: '/Users/me/proj' }] } }
      } else if (name === 'sessions_prompt') {
        result = { structuredContent: { ok: true, reply: 'processed by local daemon' } }
      } else {
        result = { structuredContent: { ok: true } }
      }
    } else {
      result = {}
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch }
}

interface Rig {
  store: DshHelmStore
  cp: ControlPlane
  conns: Map<string, HubConnection>
  bridge: LocalDshBridge
  agent: HelmNodeAgent
  socket: FakeWebSocket
  nodes: NodeRegistry
  sessions: SessionCatalog
  workspaces: WorkspaceCatalog
}

function buildRig(opts: { failHealth?: boolean } = {}): Rig {
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
    hubId: 'hub-test',
    schemaVersion: 1,
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    defaultNodeId: 'n-agent',
    tokenLookup: (id) => (id === 'n-agent' ? 'agent-token' : undefined),
    connections: conns,
    log: () => {},
  })
  const { fetchImpl } = fakeDaemon(opts)
  const bridge = new LocalDshBridge({ url: 'http://127.0.0.1:3457/mcp', token: 'local-tok', fetchImpl })
  const socket = new FakeWebSocket()
  const agent = new HelmNodeAgent({
    config: {
      node_id: 'n-agent',
      hub_url: 'ws://test/',
      token: 'agent-token',
      local_mcp_url: 'http://127.0.0.1:3457/mcp',
      local_mcp_token: 'local-tok',
      display_name: 'agent-host',
      local_probe_ms: 10_000,
      reconcile_ms: 10_000,
    },
    bridge,
    wsFactory: () => socket,
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    log: () => {},
  })
  return { store, cp, conns, bridge, agent, socket, nodes, sessions, workspaces }
}

async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('HelmNodeAgent <-> hub integration', () => {
  let rig: Rig

  beforeEach(() => {
    rig = buildRig()
  })

  it('connects, registers, reconciles catalog, and heartbeats', async () => {
    // Wire the fake socket to a HubConnection
    const conn = new HubConnection({
      cp: rig.cp,
      send: (m) => rig.socket.serverSend(m),
      onClose: (id) => id && rig.conns.delete(id),
    })
    rig.socket.setHubSink((m) => conn.inbound(m))
    rig.agent.start()
    rig.socket.open()
    await settle(150)

    expect(rig.socket.readyState).toBe(1)
    // hub accepted the node
    expect(rig.conns.has('n-agent')).toBe(true)
    // node registry has the node (register succeeded)
    const node = rig.nodes.get('n-agent')
    expect(node?.display_name).toBe('agent-host')
    // catalog reconcile landed
    expect(rig.sessions.ownerOf('s-local')).toBe('n-agent')
    expect(rig.workspaces.ownerOf('w-local')).toBe('n-agent')
    // health probe ran via supervisor_health
    expect(node?.status).toBe('online')
    rig.agent.stop()
    conn.close()
    rig.store.close()
  })

  it('hub routes a prompt to the node agent -> local daemon', async () => {
    const conn = new HubConnection({
      cp: rig.cp,
      send: (m) => rig.socket.serverSend(m),
      onClose: (id) => id && rig.conns.delete(id),
    })
    rig.socket.setHubSink((m) => conn.inbound(m))
    rig.agent.start()
    rig.socket.open()
    await settle(150)

    // Give the node a session to prompt
    rig.sessions.upsert('n-agent', { native_session_id: 's-local', status: 'idle' })
    const route = rig.cp.router.route({ op: 'sessions_prompt', session_id: 's-local', danger: 'destructive' })
    expect(route.decision.node_id).toBe('n-agent')
    const out = await rig.cp.forward(route, 'sessions_prompt', { session_id: 's-local', message: 'hello' })
    expect(out).toMatchObject({ ok: true })
    expect(String((out as { reply?: string }).reply ?? '')).toContain('local daemon')
    rig.agent.stop()
    conn.close()
    rig.store.close()
  })

  it('datapath health goes down when local daemon is unreachable', async () => {
    const rig2 = buildRig({ failHealth: true })
    const conn = new HubConnection({
      cp: rig2.cp,
      send: (m) => rig2.socket.serverSend(m),
      onClose: (id) => id && rig2.conns.delete(id),
    })
    rig2.socket.setHubSink((m) => conn.inbound(m))
    rig2.agent.start()
    rig2.socket.open()
    await settle(150)
    const health = await rig2.agent.probeLocal()
    expect(health.adapter.status).toBe('down')
    expect(health.datapath.status).toBe('down')
    rig2.agent.stop()
    conn.close()
    rig2.store.close()
  })

  it('handshake failure (wrong token) never registers', async () => {
    const store = new DshHelmStore({ file: ':memory:' })
    const nodes = new NodeRegistry(store.db)
    const conns = new Map<string, HubConnection>()
    const cp = new ControlPlane({
      store,
      nodes,
      sessions: new SessionCatalog(store.db),
      workspaces: new WorkspaceCatalog(store.db),
      presence: new PresenceRegistry(store.db),
      hubId: 'hub-test',
      schemaVersion: 1,
      heartbeatMs: 15_000,
      leaseMs: 45_000,
      defaultNodeId: 'n-agent',
      tokenLookup: () => undefined, // no valid tokens
      connections: conns,
      log: () => {},
    })
    const { fetchImpl } = fakeDaemon()
    const bridge = new LocalDshBridge({ url: 'http://127.0.0.1:3457/mcp', token: 'local-tok', fetchImpl })
    const socket = new FakeWebSocket()
    const agent = new HelmNodeAgent({
      config: {
        node_id: 'n-bad',
        hub_url: 'ws://test/',
        token: 'wrong',
        local_mcp_url: 'http://127.0.0.1:3457/mcp',
        local_mcp_token: 'local-tok',
        display_name: 'bad',
        local_probe_ms: 10_000,
        reconcile_ms: 10_000,
      },
      bridge,
      wsFactory: () => socket,
      log: () => {},
    })
    const conn = new HubConnection({ cp, send: (m) => socket.serverSend(m), onClose: () => {} })
    socket.setHubSink((m) => conn.inbound(m))
    agent.start()
    socket.open()
    await settle(150)
    expect(conns.has('n-bad')).toBe(false)
    expect(nodes.get('n-bad')).toBeUndefined()
    agent.stop()
    conn.close()
    store.close()
  })
})