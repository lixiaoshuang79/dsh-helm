/**
 * Presence registry: short-lease presence leases.
 *
 * Contract (from protocol constants):
 * - presence renew interval 20s, TTL 60s (clamped by provider),
 * - manual claims default TTL 10min and may pin,
 * - ambiguity window: two high-confidence fresh claims on different nodes
 *   within PRESENCE_AMBIGUITY_WINDOW_MS make the signal ambiguous.
 */

import type { DatabaseLike } from './db.js'
import type { PresenceClaim, PresenceRecord } from '@dsh-helm/protocol'
import {
  DEFAULT_PRESENCE_TTL_MS,
  MANUAL_CLAIM_TTL_MS,
  PRESENCE_AMBIGUITY_WINDOW_MS,
} from '@dsh-helm/protocol'

export interface PresenceOptions {
  ttlMs?: number
  manualTtlMs?: number
  ambiguityWindowMs?: number
}

export interface LeaseRow {
  node_id: string
  source: string
  confidence: number
  observed_at: string
  expires_at: string
  pinned: number
}

export class PresenceRegistry {
  private ttlMs: number
  private manualTtlMs: number
  private ambiguityWindowMs: number

  constructor(
    private db: DatabaseLike,
    opts: PresenceOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PRESENCE_TTL_MS
    this.manualTtlMs = opts.manualTtlMs ?? MANUAL_CLAIM_TTL_MS
    this.ambiguityWindowMs = opts.ambiguityWindowMs ?? PRESENCE_AMBIGUITY_WINDOW_MS
  }

  /** Ambiguity window (ms) — exposed for the router's evidence builder. */
  get ambiguityWindow(): number {
    return this.ambiguityWindowMs
  }

  /** Record a presence claim; clamps TTL by source and returns the stored record. */
  claim(claim: PresenceClaim): PresenceRecord {
    const isManual = claim.source === 'manual'
    const requested = claim.ttl_ms > 0 ? claim.ttl_ms : isManual ? this.manualTtlMs : this.ttlMs
    const ttl = isManual ? Math.min(requested, this.manualTtlMs * 6) : Math.min(requested, this.ttlMs)
    const expiresAt = new Date(Date.parse(claim.observed_at) + ttl).toISOString()
    this.db
      .prepare(
        `INSERT INTO presence_leases (node_id, source, confidence, observed_at, expires_at, pinned)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           source = excluded.source,
           confidence = excluded.confidence,
           observed_at = excluded.observed_at,
           expires_at = excluded.expires_at,
           pinned = excluded.pinned`,
      )
      .run(claim.node_id, claim.source, claim.confidence, claim.observed_at, expiresAt, claim.pinned ? 1 : 0)
    return { node_id: claim.node_id, source: claim.source, confidence: claim.confidence, observed_at: claim.observed_at, expires_at: expiresAt, pinned: !!claim.pinned }
  }

  /** Explicit release (manual claim end). */
  release(nodeId: string): void {
    this.db.prepare(`DELETE FROM presence_leases WHERE node_id = ?`).run(nodeId)
  }

  /** Drop expired leases (call periodically or on read). */
  sweep(now = Date.now()): number {
    const res = this.db.prepare(`DELETE FROM presence_leases WHERE expires_at < ?`).run(new Date(now).toISOString())
    return Number(res.changes)
  }

  /** Live (unexpired) leases. */
  live(now = Date.now()): LeaseRow[] {
    this.sweep(now)
    return this.db.prepare(`SELECT * FROM presence_leases`).all() as LeaseRow[]
  }

  get(nodeId: string): LeaseRow | undefined {
    const row = this.db.prepare(`SELECT * FROM presence_leases WHERE node_id = ?`).get(nodeId) as LeaseRow | undefined
    if (!row) return undefined
    if (Date.parse(row.expires_at) < Date.now()) {
      this.release(nodeId)
      return undefined
    }
    return row
  }

  /**
   * Determine the active presence node:
   * - pinned manual claim wins outright (highest confidence among pins),
   * - otherwise the freshest lease with confidence >= 0.8 wins,
   * - if two nodes both hold fresh high-confidence leases within the
   *   ambiguity window -> ambiguous (undefined).
   */
  activeNode(now = Date.now()): { node_id: string; record: LeaseRow } | undefined {
    const leases = this.live(now)
    if (leases.length === 0) return undefined
    const pins = leases.filter((l) => l.pinned)
    if (pins.length > 0) {
      pins.sort((a, b) => b.confidence - a.confidence)
      return { node_id: pins[0]!.node_id, record: pins[0]! }
    }
    const fresh = leases.filter((l) => l.confidence >= 0.8)
    if (fresh.length === 0) {
      // No high-confidence claim: fall back to the most recent lease overall.
      fresh.push(...leases)
    }
    fresh.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))
    const top = fresh[0]!
    // Ambiguity: a second node claimed within the window with close freshness.
    const second = fresh[1]
    if (second) {
      const gap = Math.abs(Date.parse(top.observed_at) - Date.parse(second.observed_at))
      if (gap <= this.ambiguityWindowMs && second.confidence >= 0.8) {
        return undefined // ambiguous
      }
    }
    return { node_id: top.node_id, record: top }
  }
}
