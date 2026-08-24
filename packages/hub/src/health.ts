/**
 * HealthAggregator: layered health across the control plane and nodes.
 *
 * Never collapses to a single `status: ok` — each layer is reported
 * independently so a dead datapath is visible even when the channel is up:
 *   control  -> hub process + store (hub-computed)
 *   channel  -> node WS connection + lease freshness
 *   adapter  -> node's DSH plugin/adapter bridge (from node heartbeat)
 *   datapath -> node's sessions_list actually works (from node heartbeat)
 *   serena   -> node's Serena/workspace runtime (from node heartbeat)
 *   tunnel   -> optional entry tunnel (hub node only, from node heartbeat)
 */

import type { HealthStatus, LayerHealth } from '@dsh-helm/protocol'
import { DEFAULT_NODE_LEASE_MS } from '@dsh-helm/protocol'
import type { NodeRegistry, StoredNode } from '@dsh-helm/store'

export interface HealthAggregatorDeps {
  nodes: NodeRegistry
  leaseMs?: number
}

export interface NodeHealthSummary {
  node_id: string
  display_name: string
  status: HealthStatus
  channel: LayerHealth
  adapter: LayerHealth
  datapath: LayerHealth
  serena: LayerHealth
  tunnel?: LayerHealth
  last_seen?: string
}

export class HealthAggregator {
  private leaseMs: number

  constructor(private deps: HealthAggregatorDeps) {
    this.leaseMs = deps.leaseMs ?? DEFAULT_NODE_LEASE_MS
  }

  /** Layered health for the control plane itself. */
  controlHealth(storeOk: boolean): LayerHealth {
    return storeOk
      ? { status: 'ok', checked_at: new Date().toISOString() }
      : { status: 'down', code: 'store-unavailable', detail: 'control plane store unreachable' }
  }

  /** Layered health summary for one node (channel from registry + reported layers). */
  nodeHealth(node: StoredNode): NodeHealthSummary {
    const reported = this.deps.nodes.healthReport(node.node_id)
    const channel = this.deps.nodes.channelHealth(node.node_id, this.leaseMs)
    const adapter: LayerHealth = reported?.adapter ?? { status: 'unknown', code: 'no-report', detail: 'node has not reported adapter health' }
    const datapath: LayerHealth = reported?.datapath ?? { status: 'unknown', code: 'no-report', detail: 'node has not reported datapath health' }
    const serena: LayerHealth = reported?.serena ?? { status: 'unknown', code: 'no-report', detail: 'node has not reported serena health' }
    const status: HealthStatus = [channel, adapter, datapath].some((l) => l.status === 'down')
      ? 'down'
      : [channel, adapter, datapath].some((l) => l.status === 'degraded')
        ? 'degraded'
        : channel.status === 'ok' && adapter.status === 'ok'
          ? 'ok'
          : 'unknown'
    return {
      node_id: node.node_id,
      display_name: node.display_name,
      status,
      channel,
      adapter,
      datapath,
      serena,
      tunnel: reported?.tunnel,
      last_seen: node.last_seen,
    }
  }

  /** Summary for every registered node. */
  all(): NodeHealthSummary[] {
    return this.deps.nodes.list().map((n) => this.nodeHealth(n))
  }

  /** Full aggregate: control + per-node. */
  aggregate(storeOk: boolean): { control: LayerHealth; nodes: NodeHealthSummary[] } {
    return { control: this.controlHealth(storeOk), nodes: this.all() }
  }
}