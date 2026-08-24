/**
 * HA unit tests: pure decision functions (election / term judgment / registry
 * merge / diff / MCP URL derivation) plus the HubHa quorum-lease state machine
 * driven over in-memory RPC pipes (no sockets, no real peers).
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshHelmStore, NodeRegistry } from '@dsh-helm/store'
import type { WireMessage } from '@dsh-helm/protocol'
import { CP_METHODS, RpcPeer } from '@dsh-helm/protocol'
import { HubHa, electLeader, judgeTerm, mergeRegistryEntries, registryDiff, derivePeerMcpUrl, mcpCallLeader, QUORUM_LOST_ERROR } from '../src/ha.js'

// ---- pure functions ----

describe('electLeader', () => {
  it('picks the smallest priority', () => {
    expect(electLeader([{ cpId: 'aaa', priority: 0 }, { cpId: 'bbb', priority: 5 }])).toBe('aaa')
    expect(electLeader([{ cpId: 'bbb', priority: 1 }, { cpId: 'aaa', priority: 0 }])).toBe('aaa')
  })
  it('breaks ties by lexicographic cp_id', () => {
    expect(electLeader([{ cpId: 'bbb', priority: 0 }, { cpId: 'aaa', priority: 0 }])).toBe('aaa')
  })
  it('returns empty for no candidates', () => {
    expect(electLeader([])).toBe('')
  })
})

describe('judgeTerm', () => {
  const local = { term: 3, leader: 'aaa' }
  it('accepts a higher peer term (fencing)', () => {
    expect(judgeTerm(local, { term: 4, leader: 'bbb' })).toBe('accept-peer')
  })
  it('stays stable when we are ahead', () => {
    expect(judgeTerm(local, { term: 2, leader: 'bbb' })).toBe('stable')
  })
  it('stays stable for the same term and leader', () => {
    expect(judgeTerm(local, { term: 3, leader: 'aaa' })).toBe('stable')
  })
  it('flags split-brain for the same term with a different leader', () => {
    expect(judgeTerm(local, { term: 3, leader: 'bbb' })).toBe('split-brain')
  })
  it('never conflicts with an undecided peer', () => {
    expect(judgeTerm(local, { term: 3, leader: '' })).toBe('stable')
  })
})

describe('mergeRegistryEntries', () => {
  it('adds new entries and tracks the reporting peer', () => {
    const m = new Map()
    const r = mergeRegistryEntries(m, [{ node_id: 'n1', display_name: 'one', status: 'online', connected: true }], {
      directConnections: new Set(),
      peerId: 'bbb',
    })
    expect(r).toEqual({ added: 1, updated: 0 })
    expect(m.get('n1')).toMatchObject({ node_id: 'n1', connected: true, peer: 'bbb' })
  })
  it('lets the newer last_seen win for metadata', () => {
    const m = new Map()
    mergeRegistryEntries(m, [{ node_id: 'n1', display_name: 'old', status: 'offline', connected: false, last_seen: '2026-01-01T00:00:00Z' }], {
      directConnections: new Set(),
      peerId: 'aaa',
    })
    const r = mergeRegistryEntries(m, [{ node_id: 'n1', display_name: 'new', status: 'online', connected: true, last_seen: '2026-01-02T00:00:00Z' }], {
      directConnections: new Set(),
      peerId: 'bbb',
    })
    expect(r.updated).toBe(1)
    expect(m.get('n1')).toMatchObject({ display_name: 'new', status: 'online', connected: true, peer: 'bbb' })
  })
  it('ORs connected with direct connections (direct CP authoritative)', () => {
    const m = new Map()
    mergeRegistryEntries(m, [{ node_id: 'n1', display_name: 'x', status: 'online', connected: true, last_seen: '2026-01-02T00:00:00Z' }], {
      directConnections: new Set(),
      peerId: 'bbb',
    })
    const r = mergeRegistryEntries(m, [{ node_id: 'n1', display_name: 'x', status: 'online', connected: false, last_seen: '2026-01-01T00:00:00Z' }], {
      directConnections: new Set(['n1']),
      peerId: 'aaa',
    })
    // stale incoming is ignored for metadata, but our direct connection keeps it connected
    expect(r.updated).toBe(0)
    expect(m.get('n1')!.connected).toBe(true)
  })
})

describe('registryDiff', () => {
  it('only returns entries that changed since the last send', () => {
    const prev = new Map<string, string>()
    const all = [
      { node_id: 'n1', display_name: 'one', status: 'online', connected: true },
      { node_id: 'n2', display_name: 'two', status: 'offline', connected: false },
    ] as Parameters<typeof registryDiff>[1]
    const first = registryDiff(prev, all)
    expect(first).toHaveLength(2)
    const second = registryDiff(prev, all)
    expect(second).toHaveLength(0)
    const changed = registryDiff(prev, [{ node_id: 'n1', display_name: 'one', status: 'offline', connected: true }] as Parameters<typeof registryDiff>[1])
    expect(changed).toHaveLength(1)
    expect(changed[0]!.node_id).toBe('n1')
  })
})

describe('derivePeerMcpUrl', () => {
  it('maps default mesh port to the MCP port above it', () => {
    expect(derivePeerMcpUrl('ws://127.0.0.1:3470')).toBe('http://127.0.0.1:3471')
    expect(derivePeerMcpUrl('ws://hub.example.com:3470')).toBe('http://hub.example.com:3471')
  })
  it('maps a custom mesh port to port+1', () => {
    expect(derivePeerMcpUrl('ws://127.0.0.1:13480')).toBe('http://127.0.0.1:13481')
  })
  it('keeps wss -> https', () => {
    expect(derivePeerMcpUrl('wss://hub.example.com:3470')).toBe('https://hub.example.com:3471')
  })
})

describe('mcpCallLeader', () => {
  it('initializes, keeps the session id, and calls tools/call', async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push({ url: String(url), body, headers: init.headers as Record<string, string> })
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
        })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const res = await mcpCallLeader('http://127.0.0.1:13481', 'sessions_create', { title: 't' }, fetchImpl)
    expect(res.isError).toBeFalsy()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('http://127.0.0.1:13481/mcp')
    expect(calls[1]!.headers['mcp-session-id']).toBe('sess-1')
  })
  it('throws on initialize failure', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(mcpCallLeader('http://x', 'sessions_create', {}, fetchImpl)).rejects.toThrow(/http 500/)
  })
})

// ---- HubHa state machine (in-memory pipes) ----

/**
 * A queue-based RpcPeer pipe between the test side (local) and the hub
 * (remote). hubHa.registerInboundPeer(cpId, pipe.remote) installs the HA
 * handlers on `remote`; the test drives requests from `local`.
 */
class Pipe {
  qLR: WireMessage[] = [] // local -> remote
  qRL: WireMessage[] = [] // remote -> local
  local: RpcPeer
  remote: RpcPeer
  constructor() {
    this.local = new RpcPeer({ send: (m) => this.qLR.push(m) }, () => {})
    this.remote = new RpcPeer({ send: (m) => this.qRL.push(m) }, () => {})
  }
  pump(): void {
    while (this.qLR.length > 0) this.remote.dispatchPublic(this.qLR.shift()!)
    while (this.qRL.length > 0) this.local.dispatchPublic(this.qRL.shift()!)
  }
  async request(method: string, params: unknown): Promise<unknown> {
    const p = this.local.request(method, params, { timeoutMs: 3_000 })
    const deadline = Date.now() + 3_000
    for (;;) {
      this.pump()
      const winner = await Promise.race([
        p.then((v) => ({ done: true as const, v })),
        new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), 10)),
      ])
      if (winner.done) return winner.v
      if (Date.now() > deadline) throw new Error(`pipe timeout on ${method}`)
    }
  }
}

function makeStore(): { store: DshHelmStore; nodes: NodeRegistry; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-ha-'))
  const store = new DshHelmStore({ file: join(dir, 'store.sqlite3') })
  const nodes = new NodeRegistry(store.db)
  return { store, nodes, dir }
}

function makeHa(overrides: Record<string, unknown> = {}): {
  ha: HubHa
  store: DshHelmStore
  nodes: NodeRegistry
  dir: string
} {
  const { store, nodes, dir } = makeStore()
  const ha = new HubHa({
    cpId: 'aaa',
    peerUrls: ['ws://127.0.0.1:13480'],
    cpToken: 'tok',
    tokenLookup: () => 'tok',
    store,
    nodes,
    connections: new Map(),
    leaseMs: 45_000,
    leaseTtlMs: 45_000,
    leaseRenewMs: 10_000,
    ...overrides,
  } as Parameters<typeof HubHa>[0])
  return { ha, store, nodes, dir }
}

describe('HubHa standalone (no peers)', () => {
  it('is readwrite with term 1 and persists nothing', () => {
    const { ha, store, dir } = makeHa({ peerUrls: [] })
    try {
      expect(ha.role()).toBe('standalone')
      expect(ha.writeMode()).toBe('readwrite')
      expect(ha.quorum()).toBe(true)
      expect(ha.termValue).toBe(1)
      expect(ha.statusPayload().phase).toBe('standalone')
      const kv = store.db.prepare(`SELECT value FROM kv WHERE key = 'cp_term'`).get() as { value?: string } | undefined
      expect(kv).toBeUndefined()
      ha.start()
      ha.stop()
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('HubHa quorum state machine', () => {
  it('starts multi-CP read-only (nominating) even when persisted as leader', () => {
    const base = makeStore()
    try {
      // persisted term says we were leader at term 7
      base.store.db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('cp_term','7'),('cp_leader','aaa'),('cp_leader_term','7')`).run()
      const ha2 = new HubHa({
        cpId: 'aaa', peerUrls: ['ws://127.0.0.1:13480'], cpToken: 'tok', tokenLookup: () => 'tok',
        store: base.store, nodes: base.nodes, connections: new Map(), leaseMs: 45_000,
      })
      expect(ha2.termValue).toBe(7)
      expect(ha2.role()).toBe('leader')
      // but NO quorum at startup: read-only until a lease is confirmed
      expect(ha2.writeMode()).toBe('readonly')
      expect(ha2.statusPayload().phase).toBe('nominating')
      ha2.stop()
    } finally {
      base.store.close()
      rmSync(base.dir, { recursive: true, force: true })
    }
  })

  it('accepts an election, becomes leased leader ONLY after the lease is confirmed, and demotes on peer loss', async () => {
    const { ha, store, dir } = makeHa()
    const pipe = new Pipe()
    ha.registerInboundPeer('bbb', pipe.remote)
    ha.start()
    try {
      expect(ha.writeMode()).toBe('readonly')
      // peer elects us at term 5 — the election alone must NOT grant writes:
      // we stay read-only (nominating) until the peer acks the write lease.
      await pipe.request(CP_METHODS.ELECT, { term: 5, leader: 'aaa', candidates: [{ cpId: 'aaa', priority: 0 }] })
      expect(ha.role()).toBe('leader')
      expect(ha.statusPayload().phase).toBe('nominating')
      expect(ha.writeMode()).toBe('readonly')
      expect(ha.statusPayload().leaseEpoch).toBe(0)
      // peer confirms the lease (cp.lease.renew ack) -> readwrite
      pipe.local.on(CP_METHODS.LEASE_RENEW, () => ({ ok: true }))
      const deadline = Date.now() + 4_000
      while (ha.writeMode() !== 'readwrite' && Date.now() < deadline) {
        pipe.pump()
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(ha.writeMode()).toBe('readwrite')
      expect(ha.statusPayload().phase).toBe('leader-leased')
      expect(ha.termValue).toBe(5)
      expect(ha.statusPayload().leaseEpoch).toBe(5)
      // peer gone -> immediate demotion to read-only, no self-promotion
      ha.onPeerDisconnected('bbb', 'inbound')
      expect(ha.writeMode()).toBe('readonly')
      expect(ha.role()).toBe('leader') // identity kept, write access lost
      expect(ha.termValue).toBe(5) // term NOT bumped
      expect(ha.statusPayload().phase).toBe('read-only-no-quorum')
      expect(ha.statusPayload().failoverCount).toBe(1)
      // writes are refused with the structured QUORUM_LOST error
      const res = await ha.handleWrite('sessions_create', { title: 'x' })
      expect(res.isError).toBe(true)
      expect(res.content?.[0]?.text).toContain(QUORUM_LOST_ERROR)
    } finally {
      ha.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a follower NEVER promotes on leader loss (no term bump, stays read-only)', async () => {
    const { ha, store, dir } = makeHa()
    const pipe = new Pipe()
    ha.registerInboundPeer('bbb', pipe.remote)
    try {
      // peer already has a lease at term 9 -> we align as follower
      await pipe.request(CP_METHODS.SYNC, {
        from: 'bbb', priority: 0, term: 9, leader: 'bbb', leaderTerm: 9,
        phase: 'leader-leased', leaseEpoch: 9, registry: [],
      })
      expect(ha.writeMode()).toBe('readonly')
      expect(ha.statusPayload().phase).toBe('follower')
      // lease renew from the leader keeps us follower
      await pipe.request(CP_METHODS.LEASE_RENEW, { term: 9, epoch: 9 })
      expect(ha.statusPayload().phase).toBe('follower')
      // leader disappears: we stay read-only, term unchanged
      ha.onPeerDisconnected('bbb', 'inbound')
      expect(ha.role()).toBe('follower')
      expect(ha.termValue).toBe(9)
      expect(ha.statusPayload().phase).toBe('read-only-no-quorum')
      expect(ha.writeMode()).toBe('readonly')
    } finally {
      ha.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('split-brain bumps the term and forces a fresh election', async () => {
    const { ha, store, dir } = makeHa()
    const pipe = new Pipe()
    ha.registerInboundPeer('bbb', pipe.remote)
    try {
      // first align both sides at term 5 with the same leader (aaa)
      await pipe.request(CP_METHODS.SYNC, {
        from: 'bbb', priority: 0, term: 5, leader: 'aaa', leaderTerm: 5, phase: 'follower', leaseEpoch: 5, registry: [],
      })
      expect(ha.termValue).toBe(5)
      // then the peer claims the SAME term with a DIFFERENT leader: split-brain
      await pipe.request(CP_METHODS.SYNC, {
        from: 'bbb', priority: 0, term: 5, leader: 'bbb', leaderTerm: 5, phase: 'leader-leased', leaseEpoch: 5, registry: [],
      })
      expect(ha.termValue).toBe(6) // bumped
      expect(ha.statusPayload().phase).toBe('read-only-no-quorum')
      expect(ha.writeMode()).toBe('readonly')
    } finally {
      ha.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a leased leader whose peer stops acking loses quorum after the TTL', async () => {
    const { ha, store, dir } = makeHa({ leaseTtlMs: 300 })
    const pipe = new Pipe()
    ha.registerInboundPeer('bbb', pipe.remote)
    pipe.local.on(CP_METHODS.LEASE_RENEW, () => ({ ok: true }))
    ha.start()
    try {
      await pipe.request(CP_METHODS.ELECT, { term: 5, leader: 'aaa', candidates: [{ cpId: 'aaa', priority: 0 }] })
      // elect + lease ack both flow through the pipe -> leader-leased
      const electDeadline = Date.now() + 4_000
      while (ha.writeMode() !== 'readwrite' && Date.now() < electDeadline) {
        pipe.pump()
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(ha.writeMode()).toBe('readwrite')
      // never ack the lease again; the 1s tick must demote us within ~2s
      const deadline = Date.now() + 4_000
      let phase = ha.statusPayload().phase
      while (phase === 'leader-leased' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
        phase = ha.statusPayload().phase
      }
      expect(phase).toBe('read-only-no-quorum')
      expect(ha.writeMode()).toBe('readonly')
      expect(ha.statusPayload().failoverCount).toBeGreaterThanOrEqual(1)
    } finally {
      ha.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovers via a fresh negotiated election and lease (write access restored)', async () => {
    const { ha, store, dir } = makeHa()
    const pipe = new Pipe()
    ha.registerInboundPeer('bbb', pipe.remote)
    // auto-election: the deterministic winner (aaa < bbb) proposes; the
    // test-side peer acks elect + lease renews
    pipe.local.on(CP_METHODS.ELECT, (req) => ({ ok: true, term: (req as { term: number }).term, leader: (req as { leader: string }).leader, phase: 'follower' }))
    pipe.local.on(CP_METHODS.LEASE_RENEW, () => ({ ok: true }))
    ha.start()
    try {
      // first take the lease at term 5 (elect ack + lease ack both pumped)
      await pipe.request(CP_METHODS.ELECT, { term: 5, leader: 'aaa', candidates: [{ cpId: 'aaa', priority: 0 }] })
      let mode = ha.writeMode()
      const electDeadline = Date.now() + 4_000
      while (mode !== 'readwrite' && Date.now() < electDeadline) {
        pipe.pump()
        await new Promise((r) => setTimeout(r, 50))
        mode = ha.writeMode()
      }
      expect(mode).toBe('readwrite')
      // peer drops -> read-only, no promotion
      ha.onPeerDisconnected('bbb', 'inbound')
      expect(ha.writeMode()).toBe('readonly')
      // peer reconnects -> fresh negotiated election (term+1) + lease -> writes back
      ha.registerInboundPeer('bbb', pipe.remote)
      const deadline = Date.now() + 5_000
      mode = ha.writeMode()
      while (mode !== 'readwrite' && Date.now() < deadline) {
        pipe.pump()
        await new Promise((r) => setTimeout(r, 150))
        mode = ha.writeMode()
      }
      expect(mode).toBe('readwrite')
      expect(ha.termValue).toBeGreaterThan(5)
      expect(ha.statusPayload().phase).toBe('leader-leased')
      expect(ha.statusPayload().leaseEpoch).toBe(ha.termValue)
    } finally {
      ha.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exposes a complete /cp-status shape', async () => {
    const { ha, store, dir } = makeHa()
    try {
      const s = ha.statusPayload()
      expect(s).toMatchObject({
        cpId: 'aaa',
        role: 'leader',
        phase: 'nominating',
        term: 1,
        leaderId: 'aaa',
        writeMode: 'readonly',
        quorum: false,
        leaseEpoch: 0,
        syncOk: false,
        failoverCount: 0,
      })
      expect(Array.isArray(s.peers)).toBe(true)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
