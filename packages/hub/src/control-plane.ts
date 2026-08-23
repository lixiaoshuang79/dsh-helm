/**
 * ControlPlane: the hub's core service.
 *
 * Owns the store-backed registries, the router, the health aggregator and the
 * per-connection RPC server. Each authenticated node connection gets a
 * NodeConnection which:
 *   - verifies the HMAC handshake (server side),
 *   - serves hub RPC methods (node.register, node.heartbeat, ...),
 *   - forwards routed node-agent RPC calls (health, listWorkspaces,
 *     createSession, ..., mcp.call).
 *
 * Transport-agnostic: a NodeConnection is driven by WireMessage in/out, so
 * tests can run it over in-memory pipes while production runs it over ws/wss.
 */

import type { WireMessage, NodeInfo, NodeStatus, SessionInfo, WorkspaceInfo, PresenceClaim, HealthReport } from '@dsh-helm/protocol'
import { HUB_METHODS, NODE_METHODS, PROTOCOL_ERROR } from '@dsh-helm/protocol'
import type { DshHelmStore, NodeRegistry, StoredNode, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '@dsh-helm/store'
import { Router, type RouteResult } from './router.js'
import { HealthAggregator } from './health.js'

export interface ControlPlaneOptions {
  store: DshHelmStore
  nodes: NodeRegistry
  sessions: SessionCatalog
  workspaces: WorkspaceCatalog
  presence: PresenceRegistry
  hubId: string
  schemaVersion: number
  heartbeatMs: number
  leaseMs: number
  defaultNodeId: string
  /** Node token lookup by node_id (from a secure store; never logged). */
  tokenLookup(nodeId: string): string | undefined
  /** In-memory map of live connections by node_id. */
  connections: Map<string, NodeConnection>
  log?: (line: string) => void
}

/** A connected (authenticated) node session. */
export interface NodeConnection {
  nodeId: string
  /** Send a request to the node and await its response. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  /** Send a notification to the node. */
  notify(method: string, params?: unknown): void
  /** Close this connection. */
  close(): void
}

export interface RegisterPayload {
  node: NodeInfo
}

export interface HeartbeatPayload {
  node_id: string
  status: NodeStatus
}

export interface ReconcilePayload {
  node_id: string
  sessions?: SessionInfo[]
  workspaces?: WorkspaceInfo[]
}

export interface PresencePayload {
  claim: PresenceClaim
}

export class ControlPlane {
  readonly router: Router
  readonly health: HealthAggregator
  private audit = 0
  readonly connections: Map<string, NodeConnection>
  readonly heartbeatMs: number
  readonly leaseMs: number

  constructor(private opts: ControlPlaneOptions) {
    this.router = new Router({
      nodes: opts.nodes,
      sessions: opts.sessions,
      workspaces: opts.workspaces,
      presence: opts.presence,
      leaseMs: opts.leaseMs,
      defaultNodeId: opts.defaultNodeId,
    })
    this.health = new HealthAggregator({ nodes: opts.nodes, leaseMs: opts.leaseMs })
    this.connections = opts.connections
    this.heartbeatMs = opts.heartbeatMs
    this.leaseMs = opts.leaseMs
  }

  get hubId(): string {
    return this.opts.hubId
  }

  get schemaVersion(): number {
    return this.opts.schemaVersion
  }

  log(line: string): void {
    this.opts.log?.(line)
  }

  /** Token lookup for the handshake server. */
  lookupToken(nodeId: string): string | undefined {
    return this.opts.tokenLookup(nodeId)
  }

  /** Node authenticated: register connection, refresh registry. */
  onNodeAuthenticated(nodeId: string, conn: NodeConnection): void {
    this.opts.connections.set(nodeId, conn)
    this.log(`node authenticated: ${nodeId}`)
  }

  /** Handle node.register (initial or re-register after reconnect). */
  handleRegister(payload: RegisterPayload): { node_id: string; heartbeat_ms: number; lease_ms: number } {
    const node = payload.node
    if (!node || typeof node.node_id !== 'string' || !node.node_id) {
      throw rpcError(PROTOCOL_ERROR.INVALID_REQUEST, 'register requires node info')
    }
    this.opts.nodes.register(node, 'online')
    return { node_id: node.node_id, heartbeat_ms: this.opts.heartbeatMs, lease_ms: this.opts.leaseMs }
  }

  /** Handle node.heartbeat. */
  handleHeartbeat(payload: HeartbeatPayload): { ok: true } {
    const { node_id, status } = payload
    const node = this.opts.nodes.get(node_id)
    if (!node) throw rpcError(PROTOCOL_ERROR.NODE_ID_CONFLICT, `unknown node: ${node_id}`)
    if (node.status === 'blocked') throw rpcError(PROTOCOL_ERROR.AUTH_FAILED, `node blocked: ${node_id}`)
    this.opts.nodes.heartbeat(node_id, status)
    return { ok: true }
  }

  /** Handle node.release: node shutting down gracefully. */
  handleRelease(nodeId: string): { ok: true } {
    this.opts.nodes.markOffline(nodeId, 'node released')
    this.opts.connections.delete(nodeId)
    this.log(`node released: ${nodeId}`)
    return { ok: true }
  }

  /** Handle catalog.reconcile (session/workspace metadata after register). */
  handleReconcile(payload: ReconcilePayload): { ok: true } {
    const { node_id, sessions, workspaces } = payload
    if (!node_id) throw rpcError(PROTOCOL_ERROR.INVALID_REQUEST, 'reconcile requires node_id')
    if (sessions) this.opts.sessions.reconcile(node_id, sessions)
    if (workspaces) this.opts.workspaces.reconcile(node_id, workspaces)
    return { ok: true }
  }

  /** Handle presence.report. */
  handlePresenceReport(payload: PresencePayload): { ok: true } {
    const claim = payload?.claim
    if (!claim || !claim.node_id) throw rpcError(PROTOCOL_ERROR.INVALID_REQUEST, 'presence report requires claim')
    this.opts.presence.claim(claim)
    return { ok: true }
  }

  /** Forward an operation to the routed node (or reject). */
  async forward(route: RouteResult, op: string, params?: unknown, callId = `c${++this.audit}`): Promise<unknown> {
    if (route.action !== 'forward' || !route.decision.node_id) {
      throw rpcError(-32010, route.errorCode ?? 'no_route', route.decision.reason)
    }
    const conn = this.opts.connections.get(route.decision.node_id)
    if (!conn) {
      throw rpcError(-32011, 'node_unavailable', `node ${route.decision.node_id} has no live connection`)
    }
    this.auditRoute(callId, op, route)
    try {
      const res = await conn.request(NODE_METHODS.MCP_CALL, { tool: op, args: params }, 60_000)
      this.auditResult(callId, op, route, 'ok')
      return res
    } catch (err) {
      this.auditResult(callId, op, route, `error:${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}`)
      throw err
    }
  }

  /** Read-only aggregation: list workspaces across all healthy nodes. */
  async aggregateWorkspaces(): Promise<Array<{ node_id: string; workspaces: WorkspaceInfo[] }>> {
    const out: Array<{ node_id: string; workspaces: WorkspaceInfo[] }> = []
    for (const node of this.opts.nodes.onlineNodes(this.opts.leaseMs)) {
      const conn = this.opts.connections.get(node.node_id)
      if (!conn) continue
      try {
        const ws = (await conn.request(NODE_METHODS.LIST_WORKSPACES, {}, 15_000)) as WorkspaceInfo[]
        out.push({ node_id: node.node_id, workspaces: ws ?? [] })
      } catch {
        // node unreachable for this read; skip
      }
    }
    return out
  }

  /** Read-only aggregation: list sessions across all healthy nodes. */
  async aggregateSessions(): Promise<Array<{ node_id: string; sessions: SessionInfo[] }>> {
    const out: Array<{ node_id: string; sessions: SessionInfo[] }> = []
    for (const node of this.opts.nodes.onlineNodes(this.opts.leaseMs)) {
      const conn = this.opts.connections.get(node.node_id)
      if (!conn) continue
      try {
        const ss = (await conn.request(NODE_METHODS.LIST_SESSIONS, {}, 15_000)) as SessionInfo[]
        out.push({ node_id: node.node_id, sessions: ss ?? [] })
      } catch {
        // skip unreachable node
      }
    }
    return out
  }

  /** Full aggregate health: control + per-node layers. */
  aggregateHealth(): { control: ReturnType<HealthAggregator['controlHealth']>; nodes: ReturnType<HealthAggregator['all']> } {
    return this.health.aggregate(true)
  }

  /** Live node map for route_explain / nodes_list. */
  nodeCatalog(): Array<{ node: StoredNode; connection: boolean }> {
    return this.opts.nodes.list().map((n) => ({ node: n, connection: this.opts.connections.has(n.node_id) }))
  }

  private auditRoute(callId: string, op: string, route: RouteResult): void {
    this.opts.log?.(`route ${callId} ${op} -> ${route.decision.node_id} (${route.decision.outcome})`)
    // route_log persistence lives in the store layer; ControlPlane keeps an
    // in-memory ring for diagnostics (persisted audit added in later phase).
  }

  private auditResult(callId: string, op: string, route: RouteResult, result: string): void {
    this.opts.log?.(`route-result ${callId} ${op} ${result}`)
  }
}

function rpcError(code: number, message: string, detail?: string): Error {
  const err = new Error(message) as Error & { code?: number; detail?: string }
  ;(err as { code?: number }).code = code
  if (detail) (err as { detail?: string }).detail = detail
  return err
}

export { rpcError }

/** Build the hub-side RPC handler table for one authenticated node connection. */
export function hubRpcHandlers(cp: ControlPlane, nodeId: string) {
  return {
    [HUB_METHODS.NODE_REGISTER]: (p: unknown) => cp.handleRegister(p as RegisterPayload),
    [HUB_METHODS.NODE_HEARTBEAT]: (p: unknown) => cp.handleHeartbeat(p as HeartbeatPayload),
    [HUB_METHODS.NODE_RELEASE]: () => cp.handleRelease(nodeId),
    [HUB_METHODS.CATALOG_RECONCILE]: (p: unknown) => cp.handleReconcile(p as ReconcilePayload),
    [HUB_METHODS.PRESENCE_REPORT]: (p: unknown) => cp.handlePresenceReport(p as PresencePayload),
  }
}
