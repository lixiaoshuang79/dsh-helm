/**
 * Phase: node-agent multi-endpoint (dual-CP fallback) validation.
 *
 * The agent dials [hub_url, ...fallback_urls] in order, advancing one step on
 * every reconnect and pinning the endpoint that last connected. A refused
 * connection (close while still 'connecting') also triggers a reconnect.
 */

import { describe, expect, it } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection } from '../../hub/src/index.js'
import { HelmNodeAgent } from '../src/index.js'
import { FakeBackend } from './backend-fixtures.js'
import type { WireMessage } from '../../protocol/src/index.js'

class FakeHubSocket {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  private toHub: (m: WireMessage) => void = () => {}
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

function hubSide(cp: ControlPlane, conns: Map<string, HubConnection>, socket: FakeHubSocket): { reset: () => void } {
  let conn: HubConnection | undefined
  socket.attach((m) => {
    console.log('HUB-SIDE rx:', JSON.stringify(m).slice(0, 90))
    if (!conn) {
      conn = new HubConnection({ cp, send: (mm) => socket.serverSend(mm), onClose: (id) => id && conns.delete(id) })
    }
    conn.inbound(m)
  })
  return {
    reset: () => {
      conn = undefined
    },
  }
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms))

describe('node-agent endpoint failover', () => {
  it('tries hub_url first, falls back to fallback_urls, and pins the working endpoint', async () => {
    const store = new DshHelmStore({ file: ':memory:' })
    const nodes = new NodeRegistry(store.db)
    const sessions = new SessionCatalog(store.db)
    const workspaces = new WorkspaceCatalog(store.db)
    const presence = new PresenceRegistry(store.db)
    const conns = new Map<string, HubConnection>()
    const cp = new ControlPlane({
      store, nodes, sessions, workspaces, presence,
      hubId: 'hub-test', schemaVersion: 1, heartbeatMs: 15_000, leaseMs: 45_000,
      defaultNodeId: 'n-agent', tokenLookup: (id) => (id === 'n-agent' ? 'tok' : undefined),
      connections: conns, log: () => {},
    })
    const logs: string[] = []
    const socketA = new FakeHubSocket()
    const socketB = new FakeHubSocket()
    const backend = new FakeBackend({ sessions: [], workspaces: [] })
    const agent = new HelmNodeAgent({
      config: {
        node_id: 'n-agent',
        hub_url: 'ws://cp-a/',
        fallback_urls: ['ws://cp-b/'],
        token: 'tok',
        local_mcp_url: 'http://127.0.0.1:3457/mcp', local_mcp_token: 't',
        host_api_url: 'http://127.0.0.1:3080',
        display_name: 'a', local_probe_ms: 10_000, reconcile_ms: 10_000,
      },
      backend,
      wsFactory: (url) => (url.includes('cp-b') ? socketB : socketA),
      heartbeatMs: 15_000,
      leaseMs: 45_000,
      log: (l) => logs.push(l),
    })
    const sideA = hubSide(cp, conns, socketA)
    const sideB = hubSide(cp, conns, socketB)
    try {
      agent.start()
      // first connect goes to the primary hub_url
      expect(logs.some((l) => l.includes('connecting to control plane ws://cp-a/'))).toBe(true)
      socketA.onopen?.()
      await settle(150)
      expect(conns.has('n-agent')).toBe(true)

      // primary drops -> reconnect advances to the fallback
      conns.get('n-agent')?.close()
      conns.delete('n-agent')
      sideA.reset()
      socketA.onclose?.()
      await settle(50)
      expect(conns.has('n-agent')).toBe(false)
      await settle(1600) // backoff (1s + jitter)
      expect(logs.some((l) => l.includes('connecting to control plane ws://cp-b/'))).toBe(true)
      socketB.onopen?.()
      await settle(200)
      expect(conns.has('n-agent')).toBe(true)
      expect(logs.some((l) => l.includes('connected to hub'))).toBe(true)

      // fallback drops too -> round-robin back to the primary
      conns.get('n-agent')?.close()
      conns.delete('n-agent')
      sideB.reset()
      socketB.onclose?.()
      await settle(1600)
      expect(logs.filter((l) => l.includes('connecting to control plane ws://cp-a/')).length).toBeGreaterThanOrEqual(2)
      socketA.onopen?.()
      await settle(200)
      expect(conns.has('n-agent')).toBe(true)
    } finally {
      agent.stop()
      store.close()
    }
  })

  it('reconnects when the connection is refused while still connecting (multi-endpoint)', async () => {
    const store = new DshHelmStore({ file: ':memory:' })
    const nodes = new NodeRegistry(store.db)
    const sessions = new SessionCatalog(store.db)
    const workspaces = new WorkspaceCatalog(store.db)
    const presence = new PresenceRegistry(store.db)
    const conns = new Map<string, HubConnection>()
    const cp = new ControlPlane({
      store, nodes, sessions, workspaces, presence,
      hubId: 'hub-test', schemaVersion: 1, heartbeatMs: 15_000, leaseMs: 45_000,
      defaultNodeId: 'n-agent', tokenLookup: (id) => (id === 'n-agent' ? 'tok' : undefined),
      connections: conns, log: () => {},
    })
    const logs: string[] = []
    const socketA = new FakeHubSocket()
    const socketB = new FakeHubSocket()
    const backend = new FakeBackend({ sessions: [], workspaces: [] })
    const agent = new HelmNodeAgent({
      config: {
        node_id: 'n-agent',
        hub_url: 'ws://cp-a/',
        fallback_urls: ['ws://cp-b/'],
        token: 'tok',
        local_mcp_url: 'http://127.0.0.1:3457/mcp', local_mcp_token: 't',
        host_api_url: 'http://127.0.0.1:3080',
        display_name: 'a', local_probe_ms: 10_000, reconcile_ms: 10_000,
      },
      backend,
      wsFactory: (url) => (url.includes('cp-b') ? socketB : socketA),
      heartbeatMs: 15_000,
      leaseMs: 45_000,
      log: (l) => logs.push(l),
    })
    hubSide(cp, conns, socketB)
    try {
      agent.start()
      // A never accepts: its connection is refused (close while 'connecting').
      socketA.onclose?.()
      await settle(1600)
      // the agent must have moved on to the fallback B
      expect(logs.some((l) => l.includes('connecting to control plane ws://cp-b/'))).toBe(true)
      socketB.onopen?.()
      await settle(200)
      expect(conns.has('n-agent')).toBe(true)
    } finally {
      agent.stop()
      store.close()
    }
  })

  it('returns to the primary hub when it recovers while pinned on a fallback', async () => {
    const store = new DshHelmStore({ file: ':memory:' })
    const nodes = new NodeRegistry(store.db)
    const sessions = new SessionCatalog(store.db)
    const workspaces = new WorkspaceCatalog(store.db)
    const presence = new PresenceRegistry(store.db)
    const conns = new Map<string, HubConnection>()
    const cp = new ControlPlane({
      store, nodes, sessions, workspaces, presence,
      hubId: 'hub-test', schemaVersion: 1, heartbeatMs: 200, leaseMs: 45_000,
      defaultNodeId: 'n-agent', tokenLookup: (id) => (id === 'n-agent' ? 'tok' : undefined),
      connections: conns, log: () => {},
    })
    const logs: string[] = []
    const socketB = new FakeHubSocket()
    // Primary socket is mutable: it "dies" when the hub restarts and is
    // replaced by a fresh socket when the hub comes back.
    let primarySocket = new FakeHubSocket()
    const backend = new FakeBackend({ sessions: [], workspaces: [] })
    const agent = new HelmNodeAgent({
      config: {
        node_id: 'n-agent',
        hub_url: 'ws://cp-a/',
        fallback_urls: ['ws://cp-b/'],
        token: 'tok',
        local_mcp_url: 'http://127.0.0.1:3457/mcp', local_mcp_token: 't',
        host_api_url: 'http://127.0.0.1:3080',
        display_name: 'a', local_probe_ms: 10_000, reconcile_ms: 10_000,
      },
      backend,
      wsFactory: (url) => (url.includes('cp-b') ? socketB : primarySocket),
      heartbeatMs: 200,
      leaseMs: 45_000,
      log: (l) => logs.push(l),
    })
    hubSide(cp, conns, primarySocket)
    const sideB = hubSide(cp, conns, socketB)
    try {
      agent.start()
      // 1) primary never accepts (refused while connecting): the agent fails
      //    over to the fallback and pins it
      primarySocket.onclose?.()
      await settle(1700) // backoff (1s + jitter)
      expect(logs.some((l) => l.includes('connecting to control plane ws://cp-b/'))).toBe(true)
      socketB.onopen?.()
      await settle(300)
      expect(conns.has('n-agent')).toBe(true)
      expect(logs.some((l) => l.includes('connected to hub'))).toBe(true)

      // 2) primary comes back: the heartbeat probe detects it and the agent
      //    switches back. Wait out the probe that is still parked on the dead
      //    socket, replace the socket with a live one, then poll: each probe
      //    lives one heartbeat cycle (200ms), so keep accepting it.
      await settle(3200)
      primarySocket = new FakeHubSocket()
      hubSide(cp, conns, primarySocket)
      const deadline = Date.now() + 8000
      let switched = false
      while (Date.now() < deadline && !switched) {
        primarySocket.onopen?.() // accept probe/connect attempts on the fresh socket
        await settle(250)
        switched = logs.some((l) => l.includes('primary hub reachable again; switching back'))
      }
      expect(switched).toBe(true)

      // 3) the switch-back reconnect dials the primary again; poll until the
      //    handshake lands on the fresh socket.
      await settle(3000) // reconnect delay (backoff ~2s)
      const deadline2 = Date.now() + 6000
      let backOnPrimary = false
      while (Date.now() < deadline2 && !backOnPrimary) {
        primarySocket.onopen?.()
        await settle(250)
        backOnPrimary = conns.has('n-agent')
      }
      expect(backOnPrimary).toBe(true)
      expect(logs.filter((l) => l.includes('connecting to control plane ws://cp-a/')).length).toBeGreaterThanOrEqual(2)
    } finally {
      agent.stop()
      store.close()
    }
  })
})