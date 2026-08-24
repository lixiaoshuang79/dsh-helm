import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { JsonRpcRequest, JsonRpcResponse, WireMessage } from '@dsh-helm/protocol'
import { computeMac, generateNonce, HUB_METHODS } from '@dsh-helm/protocol'
import { DshHelmStore, NodeRegistry, RegistrationTokenStore, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '@dsh-helm/store'
import { ControlPlane, HubConnection, PairingService } from '../src/index.js'
import type { PairingConsumeResult } from '../src/pairing.js'

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

const CODE_RE = /^dshp-[0-9a-z]{20}$/
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Rig {
  store: DshHelmStore
  cp: ControlPlane
  pairing: PairingService
  regTokens: RegistrationTokenStore
  logs: string[]
}

function rig(overrides: { ttlMs?: number; maxFailures?: number; rateLimit?: { windowMs: number; max: number } } = {}): Rig {
  const store = new DshHelmStore({ file: ':memory:' })
  const nodes = new NodeRegistry(store.db)
  const sessions = new SessionCatalog(store.db)
  const workspaces = new WorkspaceCatalog(store.db)
  const presence = new PresenceRegistry(store.db)
  const regTokens = new RegistrationTokenStore(store.db)
  const logs: string[] = []
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
    defaultNodeId: 'n-default',
    tokenLookup: (id) => (id === 'legacy-node' ? 'legacy-token' : regTokens.get(id)),
    connections: new Map<string, HubConnection>(),
    log: (l) => logs.push(l),
  })
  const pairing = new PairingService({ cp, store, log: (l) => logs.push(l), ...overrides })
  cp.pairing = pairing
  return { store, cp, pairing, regTokens, logs }
}

const stores: DshHelmStore[] = []

function track(r: Rig): Rig {
  stores.push(r.store)
  return r
}

afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

describe('pairing lifecycle', () => {
  it('create -> consume returns a long-term token; replay is already_used', async () => {
    const { pairing, regTokens } = track(rig())
    const { code, expiresAt } = await pairing.createPairingCode()
    expect(code).toMatch(CODE_RE)
    expect(expiresAt).toBeTruthy()

    const first = pairing.consumePairingCode(code, 'node-1', 'peer-a')
    expect(first.ok).toBe(true)
    if (first.ok) {
      // 32 random bytes -> 43 base64url chars; never the code itself
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(first.token).not.toContain(code)
      // persisted for the hub's token lookup (pairing closes the loop)
      expect(regTokens.get('node-1')).toBe(first.token)
    }

    const replay = pairing.consumePairingCode(code, 'node-2', 'peer-b')
    expect(replay).toEqual({ ok: false, reason: 'already_used' })
    // replay must not mint a second token
    expect(regTokens.get('node-2')).toBeUndefined()
  })

  it('expired codes are rejected (ttlMs=1 -> expired)', async () => {
    const { pairing } = track(rig({ ttlMs: 1 }))
    const { code } = await pairing.createPairingCode()
    await sleep(5)
    expect(pairing.consumePairingCode(code, 'node-1', 'peer-a')).toEqual({ ok: false, reason: 'expired' })
  })

  it('five consecutive failed attempts on an existing code lock it', async () => {
    const { pairing } = track(rig())
    const { code } = await pairing.createPairingCode()
    const ok = pairing.consumePairingCode(code, 'node-1', 'peer-a')
    expect(ok.ok).toBe(true)
    // replays increment the failure counter; the 5th attempt locks the hash
    const reasons: PairingConsumeResult[] = []
    for (let i = 0; i < 5; i++) reasons.push(pairing.consumePairingCode(code, 'node-2', 'peer-b'))
    expect(reasons.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['already_used', 'already_used', 'already_used', 'already_used', 'locked'])
    expect(pairing.consumePairingCode(code, 'node-3', 'peer-c')).toEqual({ ok: false, reason: 'locked' })
  })

  it('five consecutive wrong codes lock the guessed hash (brute force)', async () => {
    const { pairing } = track(rig())
    const wrong = 'dshp-aaaaaaaaaaaaaaaaaaaa'
    const results: PairingConsumeResult[] = []
    for (let i = 0; i < 6; i++) results.push(pairing.consumePairingCode(wrong, 'node-1', `peer-${i}`))
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['not_found', 'not_found', 'not_found', 'not_found', 'locked', 'locked'])
    // a shadow locked row exists for the wrong hash; a real code is unaffected
    const { pairing: p2 } = track(rig())
    const real = await p2.createPairingCode()
    expect(p2.consumePairingCode(real.code, 'node-x', 'peer-x').ok).toBe(true)
  })

  it('rate limits per peer (5 tries / 10s window)', async () => {
    const { pairing } = track(rig({ maxFailures: 100, rateLimit: { windowMs: 10_000, max: 3 } }))
    const wrong = 'dshp-bbbbbbbbbbbbbbbbbbbb'
    const r1 = pairing.consumePairingCode(wrong, 'node-1', 'peer-1')
    const r2 = pairing.consumePairingCode(wrong, 'node-1', 'peer-1')
    const r3 = pairing.consumePairingCode(wrong, 'node-1', 'peer-1')
    const r4 = pairing.consumePairingCode(wrong, 'node-1', 'peer-1')
    expect(r1).toEqual({ ok: false, reason: 'not_found' })
    expect(r2).toEqual({ ok: false, reason: 'not_found' })
    expect(r3).toEqual({ ok: false, reason: 'not_found' })
    expect(r4).toEqual({ ok: false, reason: 'rate_limited' })
  })

  it('rejects malformed input without leaking (not_found)', async () => {
    const { pairing } = track(rig())
    expect(pairing.consumePairingCode('not-a-code', 'node-1', 'peer')).toEqual({ ok: false, reason: 'not_found' })
    expect(pairing.consumePairingCode('dshp-0123456789abcdefghij', '', 'peer')).toEqual({ ok: false, reason: 'not_found' })
    // a node cannot enroll with the enroll prefix itself
    expect(pairing.consumePairingCode('dshp-0123456789abcdefghij', 'enroll:evil', 'peer')).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('pairing storage & redaction', () => {
  it('store holds only the hash — never the plaintext code', async () => {
    const { pairing, store } = track(rig())
    const { code } = await pairing.createPairingCode()
    const rows = store.db.prepare(`SELECT * FROM enrollment_codes`).all() as Array<{ code_hash: string; status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.code_hash).toBe(sha256Hex(code))
    expect(rows[0]!.code_hash).toHaveLength(64)
    // no column value anywhere contains the plaintext code
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain(code)
  })

  it('logs only hash prefixes — never the code or the token', async () => {
    const { pairing, logs } = track(rig())
    const { code } = await pairing.createPairingCode()
    const res = pairing.consumePairingCode(code, 'node-1', 'peer-a')
    if (!res.ok) throw new Error('consume should succeed')
    const logText = logs.join('\n')
    expect(logText).not.toContain(code)
    expect(logText).not.toContain(res.token)
    expect(logText).toContain(sha256Hex(code).slice(0, 8))
  })

  it('error responses carry only the reason — never token material', async () => {
    const { pairing } = track(rig())
    const { code } = await pairing.createPairingCode()
    const ok = pairing.consumePairingCode(code, 'node-1', 'peer-a')
    if (!ok.ok) throw new Error('consume should succeed')
    const replay = pairing.consumePairingCode(code, 'node-2', 'peer-b')
    expect(JSON.stringify(replay)).not.toContain(ok.token)
    expect(replay).toEqual({ ok: false, reason: 'already_used' })
  })

  it('pairingCodeStatus exposes status/expiry without the code', async () => {
    const { pairing } = track(rig())
    const { code, expiresAt } = await pairing.createPairingCode()
    const hash = sha256Hex(code)
    expect(pairing.pairingCodeStatus(hash)).toEqual({ status: 'pending', expiresAt })
    pairing.consumePairingCode(code, 'node-1', 'peer')
    expect(pairing.pairingCodeStatus(hash)).toEqual({ status: 'consumed', expiresAt })
    expect(pairing.pairingCodeStatus(sha256Hex('dshp-ffffffffffffffffffff'))).toBeNull()
  })

  it('listCodes returns recent codes with hash prefixes only', async () => {
    const { pairing } = track(rig())
    const { code } = await pairing.createPairingCode()
    const { code: code2 } = await pairing.createPairingCode()
    pairing.consumePairingCode(code, 'node-1', 'peer')
    const list = pairing.listCodes(10)
    expect(list).toHaveLength(2)
    expect(list[0]!.codeHashPrefix).toHaveLength(8)
    expect(JSON.stringify(list)).not.toContain(code)
    expect(JSON.stringify(list)).not.toContain(code2)
    expect(list.map((c) => c.status).sort()).toEqual(['consumed', 'pending'])
  })
})

describe('enrollment over the wire (unauthenticated enroll connection)', () => {
  it('hello(enroll:*) -> welcome (no challenge) -> enrollment.consume -> token, then closes', async () => {
    const { cp, pairing, store } = track(rig())
    const { code } = await pairing.createPairingCode()
    const sent: WireMessage[] = []
    const conn = new HubConnection({ cp, send: (m) => sent.push(m), onClose: () => {} })

    conn.inbound({ type: 'hello', v: 1, node_id: 'enroll:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nonce: generateNonce() })
    const welcome = sent.find((m) => m.type === 'welcome')
    expect(welcome).toBeDefined()
    // no challenge was issued on the enroll path
    expect(sent.some((m) => m.type === 'challenge')).toBe(false)

    sent.length = 0
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 7, method: HUB_METHODS.ENROLLMENT_CONSUME, params: { code, node_id: 'new-node-1', display_name: 'test-device' } }
    conn.inbound({ type: 'rpc', v: 1, body: req })
    await sleep(0) // let the RPC handler's microtasks flush
    const respFrame = sent.find((m) => m.type === 'rpc')
    const body = respFrame?.body as JsonRpcResponse | undefined
    expect(body?.id).toBe(7)
    const result = body?.result as { ok: boolean; token: string } | undefined
    expect(result?.ok).toBe(true)
    if (!result?.ok) throw new Error('enroll consume should succeed')

    // token persisted: the paired node can now authenticate with the hub
    expect(new RegistrationTokenStore(store.db).get('new-node-1')).toBe(result.token)
    // enroll connections are never registered as routable nodes
    expect(cp.connections.has('enroll:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(false)
    expect(cp.connections.has('new-node-1')).toBe(false)

    // success triggers a server-side close shortly after the response
    await sleep(60)
    const after = sent.filter((m) => m.type === 'rpc')
    expect(after).toHaveLength(1) // no further messages; connection closed
  })

  it('a paired node authenticates with the standard HMAC handshake (token merged into lookup)', async () => {
    const { cp, pairing } = track(rig())
    const { code } = await pairing.createPairingCode()
    const res = pairing.consumePairingCode(code, 'paired-node', 'peer-a')
    if (!res.ok) throw new Error('consume should succeed')

    const sent: WireMessage[] = []
    const conn = new HubConnection({ cp, send: (m) => sent.push(m), onClose: () => {} })
    const clientNonce = generateNonce()
    conn.inbound({ type: 'hello', v: 1, node_id: 'paired-node', nonce: clientNonce })
    const challenge = sent.find((m) => m.type === 'challenge')
    expect(challenge).toBeDefined()
    if (challenge?.type !== 'challenge') throw new Error('expected challenge')
    conn.inbound({
      type: 'auth',
      v: 1,
      node_id: 'paired-node',
      nonce: clientNonce,
      mac: computeMac(res.token, clientNonce, challenge.nonce),
    })
    expect(sent.some((m) => m.type === 'welcome')).toBe(true)
    expect(cp.connections.has('paired-node')).toBe(true)
  })

  it('replay on an enroll connection returns already_used', async () => {
    const { cp, pairing } = track(rig())
    const { code } = await pairing.createPairingCode()
    const sent: WireMessage[] = []
    const conn = new HubConnection({ cp, send: (m) => sent.push(m), onClose: () => {} })
    conn.inbound({ type: 'hello', v: 1, node_id: 'enroll:11111111-2222-3333-4444-555555555555', nonce: generateNonce() })
    sent.length = 0
    conn.inbound({ type: 'rpc', v: 1, body: { jsonrpc: '2.0', id: 1, method: HUB_METHODS.ENROLLMENT_CONSUME, params: { code, node_id: 'n-1' } } })
    conn.inbound({ type: 'rpc', v: 1, body: { jsonrpc: '2.0', id: 2, method: HUB_METHODS.ENROLLMENT_CONSUME, params: { code, node_id: 'n-2' } } })
    await sleep(0) // let the RPC handlers' microtasks flush
    const bodies = sent.filter((m) => m.type === 'rpc').map((m) => (m as { body: JsonRpcResponse }).body)
    expect((bodies[0]?.result as { ok: boolean }).ok).toBe(true)
    expect((bodies[1]?.result as { ok: boolean; reason: string })).toEqual({ ok: false, reason: 'already_used' })
  })
})
