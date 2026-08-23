/**
 * Audit log + route log DAO.
 *
 * The audit table records every routed operation (no conversation bodies, no
 * secrets — only op, target, decision, danger, result). The route log stores
 * full RouteDecision JSON for `route_explain` forensics.
 */

import type { DatabaseLike } from './db.js'
import type { AuditEntry, RouteDecision } from '@dsh-helm/protocol'

export interface AuditRow {
  id: number
  ts: string
  call_id: string
  op: string
  actor_node?: string
  target_node: string
  session_id?: string
  decision: string
  danger: string
  /** 0/1 from SQLite. */
  explicit: number
  result: string
}

export class AuditLog {
  constructor(private db: DatabaseLike) {}

  /** Append an audit entry. */
  append(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit (ts, call_id, op, actor_node, target_node, session_id, decision, danger, explicit, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts,
        entry.call_id,
        entry.op,
        entry.actor_node ?? null,
        entry.target_node,
        entry.session_id ?? null,
        entry.decision,
        entry.danger,
        entry.explicit ? 1 : 0,
        entry.result,
      )
  }

  list(limit = 100, op?: string): AuditRow[] {
    if (op) {
      return this.db.prepare(`SELECT * FROM audit WHERE op = ? ORDER BY id DESC LIMIT ?`).all(op, limit) as AuditRow[]
    }
    return this.db.prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`).all(limit) as AuditRow[]
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM audit`).get() as { c: number }).c
  }

  /** Append a route decision record. */
  logRoute(callId: string, op: string, decision: RouteDecision): void {
    this.db
      .prepare(`INSERT INTO route_log (ts, call_id, op, decision, explicit) VALUES (?, ?, ?, ?, ?)`)
      .run(new Date().toISOString(), callId, op, JSON.stringify(decision), decision.explicit ? 1 : 0)
  }

  recentRoutes(limit = 50): Array<{ ts: string; call_id: string; op: string; decision: RouteDecision; explicit: boolean }> {
    const rows = this.db.prepare(`SELECT * FROM route_log ORDER BY id DESC LIMIT ?`).all(limit) as Array<{
      ts: string
      call_id: string
      op: string
      decision: string
      explicit: number
    }>
    return rows.map((r) => ({ ...r, decision: JSON.parse(r.decision), explicit: !!r.explicit }))
  }
}
