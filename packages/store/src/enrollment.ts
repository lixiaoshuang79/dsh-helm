/**
 * Enrollment (device pairing) DAOs, backed by the v2 schema tables.
 *
 * Security contract:
 * - enrollment_codes stores ONLY sha256(code) hex — the plaintext pairing
 *   code exists once, in the createPairingCode response, and is never
 *   persisted anywhere.
 * - consumeIfPending is the atomic single-use gate: an UPDATE ... WHERE
 *   status='pending' whose affected-rows count is 0 means another consumer
 *   won the race (replay protection under concurrency).
 * - registration_tokens is the persisted node token lookup; the hub merges
 *   it with DSH_HELM_TOKEN at handshake time so a freshly enrolled node can
 *   authenticate without touching hub env vars.
 */

import type { DatabaseLike } from './db.js'

export type EnrollmentStatus = 'pending' | 'consumed' | 'locked'

export interface EnrollmentCodeRow {
  code_hash: string
  expires_at: string
  status: EnrollmentStatus
  fail_count: number
  created_at: string
  consumed_at?: string
  consumed_by?: string
}

export class EnrollmentCodeStore {
  constructor(private db: DatabaseLike) {}

  /** Store a fresh pending code (sha256 hex only). Throws on hash collision. */
  insert(codeHash: string, expiresAt: string, createdAt: string): void {
    this.db
      .prepare(`INSERT INTO enrollment_codes (code_hash, expires_at, status, fail_count, created_at) VALUES (?, ?, 'pending', 0, ?)`)
      .run(codeHash, expiresAt, createdAt)
  }

  get(codeHash: string): EnrollmentCodeRow | undefined {
    return this.db.prepare(`SELECT * FROM enrollment_codes WHERE code_hash = ?`).get(codeHash) as EnrollmentCodeRow | undefined
  }

  /**
   * Atomically consume a pending code. Returns true only when THIS call
   * flipped the row from pending to consumed (affected rows = 1); false
   * means a concurrent consumer already took it.
   */
  consumeIfPending(codeHash: string, nowIso: string, nodeId: string): boolean {
    const r = this.db
      .prepare(`UPDATE enrollment_codes SET status = 'consumed', consumed_at = ?, consumed_by = ? WHERE code_hash = ? AND status = 'pending'`)
      .run(nowIso, nodeId, codeHash)
    return Number(r.changes) > 0
  }

  /** Increment the failure counter for a real code row; returns the new count. */
  recordFailure(codeHash: string): number {
    this.db.prepare(`UPDATE enrollment_codes SET fail_count = fail_count + 1 WHERE code_hash = ?`).run(codeHash)
    const row = this.db.prepare(`SELECT fail_count FROM enrollment_codes WHERE code_hash = ?`).get(codeHash) as { fail_count: number } | undefined
    return row?.fail_count ?? 0
  }

  lock(codeHash: string): void {
    this.db.prepare(`UPDATE enrollment_codes SET status = 'locked' WHERE code_hash = ?`).run(codeHash)
  }

  /**
   * Insert a locked shadow row for a hash that does not exist in the table
   * (repeated wrong-code guesses). Never consumable (status='locked').
   */
  insertLockedShadow(codeHash: string, failCount: number, nowIso: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO enrollment_codes (code_hash, expires_at, status, fail_count, created_at) VALUES (?, ?, 'locked', ?, ?)`)
      .run(codeHash, '1970-01-01T00:00:00.000Z', failCount, nowIso)
  }

  /** Recent codes for the dashboard (never contains plaintext). */
  listRecent(limit: number): EnrollmentCodeRow[] {
    return this.db.prepare(`SELECT * FROM enrollment_codes ORDER BY created_at DESC LIMIT ?`).all(limit) as EnrollmentCodeRow[]
  }
}

export interface RegistrationTokenRow {
  node_id: string
  token: string
  created_at: string
}

export class RegistrationTokenStore {
  constructor(private db: DatabaseLike) {}

  /** Persist a node's long-term token (upsert; re-enrollment replaces). */
  upsert(nodeId: string, token: string, createdAt: string): void {
    this.db
      .prepare(`INSERT INTO registration_tokens (node_id, token, created_at) VALUES (?, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`)
      .run(nodeId, token, createdAt)
  }

  get(nodeId: string): string | undefined {
    const row = this.db.prepare(`SELECT token FROM registration_tokens WHERE node_id = ?`).get(nodeId) as { token: string } | undefined
    return row?.token
  }

  list(): RegistrationTokenRow[] {
    return this.db.prepare(`SELECT * FROM registration_tokens ORDER BY created_at DESC`).all() as RegistrationTokenRow[]
  }
}
