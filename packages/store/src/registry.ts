/**
 * Node registry DAO: node lifecycle (register / heartbeat / offline / block),
 * backed by the `nodes` table. Node identity is the stable node_id (UUID);
 * hostname is only display_name.
 */

import type { NodeInfo, NodeStatus, HealthReport } from '@dsh-helm/protocol'
import type { DatabaseLike } from './db.js'

export type NodeStatusValue = 'online' | 'offline' | 'blocked'

export interface NodeRow {
  node_id: string
  display_name: string
  platform: string
  versions: string
  capabilities: string
  config_home?: string
  status: NodeStatusValue
  last_seen?: string
  heartbeat_seq: number
  registered_at: string
  blocked_reason?: string
  schema_version: number
}

export interface StoredNode extends Omit<NodeRow, 'platform' | 'versions' | 'capabilities'> {
  platform: import('@dsh-helm/protocol').PlatformInfo
  versions: import('@dsh-helm/protocol').ComponentVersions
  capabilities: import('@dsh-helm/protocol').NodeCapabilities
}

export class NodeRegistry {
  /** Latest per-node HealthReport from heartbeats (memory only; metadata store
   *  never persists payloads, and health is inherently ephemeral). */
  private healthCache = new Map<string, HealthReport>()

  constructor(private db: DatabaseLike) {}

  /** Register (or refresh metadata of) a node. Preserves status/last_seen on re-register. */
  register(node: NodeInfo, status: NodeStatusValue = 'online'): void {
    const existing = this.get(node.node_id)
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO nodes (node_id, display_name, platform, versions, capabilities, config_home, status, last_seen, heartbeat_seq, registered_at, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           display_name = excluded.display_name,
           platform = excluded.platform,
           versions = excluded.versions,
           capabilities = excluded.capabilities,
           config_home = excluded.config_home,
           schema_version = excluded.schema_version`,
      )
      .run(
        node.node_id,
        node.display_name,
        JSON.stringify(node.platform),
        JSON.stringify(node.versions),
        JSON.stringify(node.capabilities),
        node.config_home ?? null,
        status,
        existing?.last_seen ?? now,
        now,
        node.versions.protocol,
      )
  }

  /** Record a heartbeat; returns the updated row. */
  heartbeat(nodeId: string, status: NodeStatus): void {
    this.db
      .prepare(`UPDATE nodes SET status = 'online', last_seen = ?, heartbeat_seq = ? WHERE node_id = ?`)
      .run(status.ts, status.seq, nodeId)
    if (status.health) this.healthCache.set(nodeId, status.health)
  }

  /** Latest reported layered health for a node (undefined if never reported). */
  healthReport(nodeId: string): HealthReport | undefined {
    return this.healthCache.get(nodeId)
  }

  /** Mark a node offline (lease expiry / heartbeat loss). */
  markOffline(nodeId: string, reason?: string): void {
    this.healthCache.delete(nodeId)
    this.db
      .prepare(`UPDATE nodes SET status = 'offline', blocked_reason = ? WHERE node_id = ?`)
      .run(reason ?? null, nodeId)
  }

  /** Block a node (e.g. schema version incompatible). */
  block(nodeId: string, reason: string): void {
    this.db.prepare(`UPDATE nodes SET status = 'blocked', blocked_reason = ? WHERE node_id = ?`).run(reason, nodeId)
  }

  /** Unblock a node (e.g. after upgrade). */
  unblock(nodeId: string): void {
    this.db.prepare(`UPDATE nodes SET status = 'offline', blocked_reason = NULL WHERE node_id = ?`).run(nodeId)
  }

  get(nodeId: string): StoredNode | undefined {
    const row = this.db.prepare(`SELECT * FROM nodes WHERE node_id = ?`).get(nodeId) as NodeRow | undefined
    return row ? this.hydrate(row) : undefined
  }

  list(status?: NodeStatusValue): StoredNode[] {
    const rows = status
      ? (this.db.prepare(`SELECT * FROM nodes WHERE status = ?`).all(status) as NodeRow[])
      : (this.db.prepare(`SELECT * FROM nodes`).all() as NodeRow[])
    return rows.map((r) => this.hydrate(r))
  }

  /** Nodes online within their lease (last_seen + lease) — healthy candidates. */
  onlineNodes(leaseMs: number): StoredNode[] {
    const cutoff = new Date(Date.now() - leaseMs).toISOString()
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE status = 'online' AND last_seen >= ?`)
      .all(cutoff) as NodeRow[]
    return rows.map((r) => this.hydrate(r))
  }

  remove(nodeId: string): void {
    this.db.prepare(`DELETE FROM nodes WHERE node_id = ?`).run(nodeId)
  }

  /** Node health summary from registry perspective (channel layer). */
  channelHealth(nodeId: string, leaseMs: number): import('@dsh-helm/protocol').LayerHealth {
    const n = this.get(nodeId)
    if (!n) return { status: 'unknown', code: 'node-unknown', detail: 'node not registered' }
    if (n.status === 'blocked') return { status: 'down', code: 'node-blocked', detail: n.blocked_reason }
    const lastSeen = n.last_seen ? Date.parse(n.last_seen) : 0
    const age = Date.now() - lastSeen
    if (n.status === 'online' && age <= leaseMs) {
      return { status: 'ok', checked_at: new Date().toISOString() }
    }
    return { status: 'down', code: 'lease-expired', detail: `last seen ${Math.round(age / 1000)}s ago` }
  }

  /** Aggregate channel health across all nodes (used by HealthAggregator). */
  allChannelHealth(leaseMs: number): Record<string, import('@dsh-helm/protocol').LayerHealth> {
    const out: Record<string, import('@dsh-helm/protocol').LayerHealth> = {}
    for (const n of this.list()) {
      out[n.node_id] = this.channelHealth(n.node_id, leaseMs)
    }
    return out
  }

  private hydrate(row: NodeRow): StoredNode {
    return {
      ...row,
      platform: JSON.parse(row.platform),
      versions: JSON.parse(row.versions),
      capabilities: JSON.parse(row.capabilities),
    }
  }
}

export function toHealthReport(layers: Record<string, import('@dsh-helm/protocol').LayerHealth>): HealthReport {
  return layers as unknown as HealthReport
}
