/**
 * PairingService: one-time device enrollment (pairing) for the control plane.
 *
 * Flow:
 *   1. An operator creates a pairing code (dashboard /api/pair, hub GET
 *      /pair/new, or `dsh-helm pair`). The code is shown in plaintext exactly
 *      once; the hub persists only sha256(code).
 *   2. A new device runs `dsh-helm join --control-plane <ws> --code <code>`.
 *      It connects with the unauthenticated enrollment node_id prefix
 *      (`enroll:<uuid>`), calls enrollment.consume, and receives a long-term
 *      node token.
 *   3. The token is persisted in registration_tokens and merged into the hub
 *      token lookup, so the new agent authenticates with the standard HMAC
 *      handshake on its next connect — no hub env vars need to change.
 *
 * Security notes (see docs/security.md):
 *   - Codes are single-use: consumeIfPending is an atomic UPDATE guarded by
 *     status='pending', so a concurrent replay loses the race.
 *   - Brute force: codes carry ~104 bits of entropy; the hub additionally
 *     rate-limits per peer (5 tries / 10s) and locks a hash after
 *     maxFailures (5) consecutive failed attempts.
 *   - No plaintext code or token is ever logged; logs carry only the first
 *     8 hex chars of the code hash.
 */

import { createHash, randomBytes } from 'node:crypto'
import { ENROLL_NODE_ID_PREFIX, NODE_TOKEN_BYTES, PAIRING_CODE_PATTERN } from '@dsh-helm/protocol'
import type { DshHelmStore, EnrollmentCodeStore, EnrollmentStatus, RegistrationTokenStore } from '@dsh-helm/store'
import { EnrollmentCodeStore as EnrollmentCodeStoreImpl, RegistrationTokenStore as RegistrationTokenStoreImpl } from '@dsh-helm/store'
import type { ControlPlane } from './control-plane.js'

export const DEFAULT_PAIRING_TTL_MS = 10 * 60_000
export const DEFAULT_MAX_FAILURES = 5
export const DEFAULT_RATE_LIMIT = { windowMs: 10_000, max: 5 } as const

export type PairingFailReason = 'not_found' | 'expired' | 'already_used' | 'locked' | 'rate_limited'
export type PairingConsumeResult = { ok: true; token: string } | { ok: false; reason: PairingFailReason }

export interface PairingCodeRow {
  codeHashPrefix: string
  status: EnrollmentStatus
  createdAt: string
  expiresAt: string
  consumedAt?: string
}

export interface PairingOptions {
  cp: ControlPlane
  store: DshHelmStore
  /** Code validity window (default 10 minutes). */
  ttlMs?: number
  /** Consecutive failed attempts before a hash is locked (default 5). */
  maxFailures?: number
  /** Per-peer consume rate limit (default 5 tries / 10s). */
  rateLimit?: { windowMs: number; max: number }
  log?: (line: string) => void
}

interface RateWindow {
  start: number
  count: number
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** dshp- + 20 base36 chars from 13 random bytes (~104 bits). */
function generateCode(): string {
  const n = BigInt('0x' + randomBytes(13).toString('hex'))
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
  let out = ''
  let v = n
  for (let i = 0; i < 20; i++) {
    out = chars[Number(v % 36n)]! + out
    v /= 36n
  }
  return `dshp-${out}`
}

/** A real node id is a non-empty, bounded string and never an enroll id. */
function isValidNodeId(nodeId: string): boolean {
  return nodeId.length > 0 && nodeId.length <= 128 && !nodeId.startsWith(ENROLL_NODE_ID_PREFIX)
}

export class PairingService {
  private codes: EnrollmentCodeStore
  private tokens: RegistrationTokenStore
  private ttlMs: number
  private maxFailures: number
  private rateLimit: { windowMs: number; max: number }
  private logFn?: (line: string) => void
  /** In-memory failure counters for hashes with no row (wrong-code guesses). */
  private unknownFailures = new Map<string, number>()
  /** Sliding windows per peer (authenticated node_id or enroll:<uuid>). */
  private windows = new Map<string, RateWindow>()

  constructor(opts: PairingOptions) {
    this.codes = new EnrollmentCodeStoreImpl(opts.store.db)
    this.tokens = new RegistrationTokenStoreImpl(opts.store.db)
    this.ttlMs = opts.ttlMs ?? DEFAULT_PAIRING_TTL_MS
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES
    this.rateLimit = opts.rateLimit ?? DEFAULT_RATE_LIMIT
    this.logFn = opts.log ?? opts.cp.log.bind(opts.cp)
  }

  private log(line: string): void {
    this.logFn?.(line)
  }

  /**
   * Generate a one-time pairing code. The plaintext is returned exactly once;
   * only sha256(code) is persisted.
   */
  async createPairingCode(opts?: { ttlMs?: number }): Promise<{ code: string; expiresAt: string }> {
    const ttlMs = opts?.ttlMs ?? this.ttlMs
    const now = Date.now()
    const expiresAt = iso(now + ttlMs)
    const createdAt = iso(now)
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateCode()
      try {
        this.codes.insert(sha256Hex(code), expiresAt, createdAt)
        this.log(`pairing: code created (hash=${sha256Hex(code).slice(0, 8)}, expires=${expiresAt})`)
        return { code, expiresAt }
      } catch {
        // hash collision (astronomically unlikely): regenerate
      }
    }
    throw new Error('pairing: failed to generate a unique code')
  }

  /** RPC-facing entry: validates the payload then consumes the code. */
  consume(params: unknown, peerId: string): Promise<PairingConsumeResult> {
    const p = (params ?? {}) as Record<string, unknown>
    if (typeof p.display_name !== 'undefined' && (typeof p.display_name !== 'string' || p.display_name.length > 128)) {
      return Promise.resolve({ ok: false, reason: 'not_found' })
    }
    const code = typeof p.code === 'string' ? p.code : ''
    const nodeId = typeof p.node_id === 'string' ? p.node_id : ''
    return Promise.resolve(this.consumePairingCode(code, nodeId, peerId))
  }

  /**
   * Consume a pairing code for a node. Reasons:
   *   not_found     - unknown/malformed code or node_id
   *   expired       - code past expires_at
   *   already_used  - code consumed before (or lost a concurrent race)
   *   locked        - hash locked after repeated failures
   *   rate_limited  - too many attempts from this peer
   */
  consumePairingCode(code: string, nodeId: string, peerId: string): PairingConsumeResult {
    if (!this.allowRate(peerId)) {
      this.log(`pairing: consume rate limited (peer=${peerId.slice(0, 24)})`)
      return { ok: false, reason: 'rate_limited' }
    }
    // Fail closed on malformed input without leaking why.
    if (!PAIRING_CODE_PATTERN.test(code) || !isValidNodeId(nodeId)) {
      return { ok: false, reason: 'not_found' }
    }
    const hash = sha256Hex(code)
    const now = Date.now()
    const row = this.codes.get(hash)
    if (!row) {
      const n = (this.unknownFailures.get(hash) ?? 0) + 1
      if (n >= this.maxFailures) {
        this.unknownFailures.delete(hash)
        this.codes.insertLockedShadow(hash, n, iso(now))
        this.log(`pairing: locked unknown hash ${hash.slice(0, 8)} after ${n} failed attempts`)
        return { ok: false, reason: 'locked' }
      }
      this.unknownFailures.set(hash, n)
      return { ok: false, reason: 'not_found' }
    }
    if (row.status === 'locked') return { ok: false, reason: 'locked' }
    if (row.status === 'consumed') return this.failAndMaybeLock(hash, 'already_used')
    if (Date.parse(row.expires_at) <= now) return this.failAndMaybeLock(hash, 'expired')

    // pending + unexpired: mint the long-term token and atomically consume.
    const token = randomBytes(NODE_TOKEN_BYTES).toString('base64url')
    if (!this.codes.consumeIfPending(hash, iso(now), nodeId)) {
      return this.failAndMaybeLock(hash, 'already_used')
    }
    this.tokens.upsert(nodeId, token, iso(now))
    this.log(`pairing: code ${hash.slice(0, 8)} consumed by node ${nodeId}`)
    return { ok: true, token }
  }

  /** Status for the dashboard — never the code or the token. */
  pairingCodeStatus(codeHash: string): { status: EnrollmentStatus; expiresAt: string } | null {
    const row = this.codes.get(codeHash)
    return row ? { status: row.status, expiresAt: row.expires_at } : null
  }

  /** Recent codes (hash prefix only) for the dashboard. */
  listCodes(limit = 20): PairingCodeRow[] {
    return this.codes.listRecent(limit).map((r) => ({
      codeHashPrefix: r.code_hash.slice(0, 8),
      status: r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      consumedAt: r.consumed_at,
    }))
  }

  private failAndMaybeLock(hash: string, reason: 'already_used' | 'expired'): PairingConsumeResult {
    const n = this.codes.recordFailure(hash)
    if (n >= this.maxFailures) {
      this.codes.lock(hash)
      this.log(`pairing: locked hash ${hash.slice(0, 8)} after ${n} failed attempts`)
      return { ok: false, reason: 'locked' }
    }
    return { ok: false, reason }
  }

  private allowRate(peerId: string): boolean {
    const now = Date.now()
    let w = this.windows.get(peerId)
    if (!w || now - w.start >= this.rateLimit.windowMs) {
      w = { start: now, count: 0 }
      this.windows.set(peerId, w)
    }
    w.count++
    if (this.windows.size > 1024) {
      // Bound memory on peer churn (each enroll connection is a fresh peer).
      for (const [k, v] of this.windows) {
        if (now - v.start >= this.rateLimit.windowMs) this.windows.delete(k)
      }
    }
    return w.count <= this.rateLimit.max
  }
}
