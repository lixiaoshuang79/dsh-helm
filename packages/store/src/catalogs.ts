/**
 * Session and workspace catalogs.
 *
 * Global keys are `node_id:native_id` — native DSH ids are preserved verbatim
 * and are node-private; the global key never rewrites them. Workspace paths
 * are attributes only, never identity (the same path on two OSes is two
 * distinct workspaces).
 */

import type { DatabaseLike } from './db.js'
import type { SessionInfo, WorkspaceInfo } from '@dsh-helm/protocol'

export interface SessionRow {
  global_key: string
  node_id: string
  native_session_id: string
  title?: string
  status: string
  updated_at?: string
  workspace_id?: string
  live: number
}

export interface WorkspaceRow {
  global_key: string
  node_id: string
  native_workspace_id: string
  path: string
  title?: string
  session_count?: number
}

export function sessionGlobalKey(nodeId: string, nativeSessionId: string): string {
  return `${nodeId}:${nativeSessionId}`
}

export function workspaceGlobalKey(nodeId: string, nativeWorkspaceId: string): string {
  return `${nodeId}:${nativeWorkspaceId}`
}

/** Split a global key back into node_id + native id. */
export function splitGlobalKey(globalKey: string): { node_id: string; native_id: string } {
  const idx = globalKey.indexOf(':')
  if (idx <= 0) throw new Error(`invalid global key: ${globalKey}`)
  return { node_id: globalKey.slice(0, idx), native_id: globalKey.slice(idx + 1) }
}

export class SessionCatalog {
  constructor(private db: DatabaseLike) {}

  /** Upsert session metadata reported by a node. */
  upsert(nodeId: string, s: SessionInfo): void {
    this.db
      .prepare(
        `INSERT INTO sessions (global_key, node_id, native_session_id, title, status, updated_at, workspace_id, live)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(global_key) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           updated_at = excluded.updated_at,
           workspace_id = excluded.workspace_id,
           live = excluded.live`,
      )
      .run(
        sessionGlobalKey(nodeId, s.native_session_id),
        nodeId,
        s.native_session_id,
        s.title ?? null,
        s.status,
        s.updated_at ?? null,
        s.workspace_id ?? null,
        s.live ? 1 : 0,
      )
  }

  /** Bulk reconcile: replace a node's catalog with the reported set. */
  reconcile(nodeId: string, sessions: SessionInfo[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`DELETE FROM sessions WHERE node_id = ?`).run(nodeId)
      const stmt = this.db.prepare(
        `INSERT INTO sessions (global_key, node_id, native_session_id, title, status, updated_at, workspace_id, live)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const s of sessions) {
        stmt.run(
          sessionGlobalKey(nodeId, s.native_session_id),
          nodeId,
          s.native_session_id,
          s.title ?? null,
          s.status,
          s.updated_at ?? null,
          s.workspace_id ?? null,
          s.live ? 1 : 0,
        )
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Look up by global key; also accepts a bare native id (resolved via unique index). */
  get(ref: string): SessionRow | undefined {
    if (ref.includes(':')) {
      return this.db.prepare(`SELECT * FROM sessions WHERE global_key = ?`).get(ref) as SessionRow | undefined
    }
    // Bare native id: prefer the exact match; if ambiguous across nodes, undefined.
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE native_session_id = ? LIMIT 2`)
      .all(ref) as SessionRow[]
    return rows.length === 1 ? rows[0] : undefined
  }

  /** Find the owning node for a native session id. */
  ownerOf(nativeSessionId: string): string | undefined {
    return this.get(nativeSessionId)?.node_id
  }

  list(nodeId?: string): SessionRow[] {
    if (nodeId) return this.db.prepare(`SELECT * FROM sessions WHERE node_id = ?`).all(nodeId) as SessionRow[]
    return this.db.prepare(`SELECT * FROM sessions`).all() as SessionRow[]
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c
  }

  removeNode(nodeId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE node_id = ?`).run(nodeId)
  }
}

export class WorkspaceCatalog {
  constructor(private db: DatabaseLike) {}

  upsert(nodeId: string, w: WorkspaceInfo): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (global_key, node_id, native_workspace_id, path, title, session_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(global_key) DO UPDATE SET
           path = excluded.path,
           title = excluded.title,
           session_count = excluded.session_count`,
      )
      .run(
        workspaceGlobalKey(nodeId, w.native_workspace_id),
        nodeId,
        w.native_workspace_id,
        w.path,
        w.title ?? null,
        w.session_count ?? null,
      )
  }

  reconcile(nodeId: string, workspaces: WorkspaceInfo[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`DELETE FROM workspaces WHERE node_id = ?`).run(nodeId)
      const stmt = this.db.prepare(
        `INSERT INTO workspaces (global_key, node_id, native_workspace_id, path, title, session_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const w of workspaces) {
        stmt.run(workspaceGlobalKey(nodeId, w.native_workspace_id), nodeId, w.native_workspace_id, w.path, w.title ?? null, w.session_count ?? null)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Resolve a workspace by global key, native id, or path (path match scoped to a node when given). */
  resolve(ref: string, nodeId?: string): WorkspaceRow | undefined {
    if (ref.includes(':')) {
      return this.db.prepare(`SELECT * FROM workspaces WHERE global_key = ?`).get(ref) as WorkspaceRow | undefined
    }
    if (nodeId) {
      const byNative = this.db
        .prepare(`SELECT * FROM workspaces WHERE node_id = ? AND native_workspace_id = ?`)
        .get(nodeId, ref) as WorkspaceRow | undefined
      if (byNative) return byNative
      return this.db.prepare(`SELECT * FROM workspaces WHERE node_id = ? AND path = ?`).get(nodeId, ref) as WorkspaceRow | undefined
    }
    const byNative = this.db.prepare(`SELECT * FROM workspaces WHERE native_workspace_id = ? LIMIT 2`).all(ref) as WorkspaceRow[]
    if (byNative.length === 1) return byNative[0]
    const byPath = this.db.prepare(`SELECT * FROM workspaces WHERE path = ? LIMIT 2`).all(ref) as WorkspaceRow[]
    if (byPath.length === 1) return byPath[0]
    return undefined
  }

  /** Owning node of a workspace (by native id or path). */
  ownerOf(ref: string): string | undefined {
    return this.resolve(ref)?.node_id
  }

  list(nodeId?: string): WorkspaceRow[] {
    if (nodeId) return this.db.prepare(`SELECT * FROM workspaces WHERE node_id = ?`).all(nodeId) as WorkspaceRow[]
    return this.db.prepare(`SELECT * FROM workspaces`).all() as WorkspaceRow[]
  }

  removeNode(nodeId: string): void {
    this.db.prepare(`DELETE FROM workspaces WHERE node_id = ?`).run(nodeId)
  }
}
