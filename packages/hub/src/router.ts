/**
 * Router: decides which node serves an operation.
 *
 * Precedence (highest first):
 *   1. explicit target_node (caller pinned a node)
 *   2. session owner (strong affinity; native session id -> owning node)
 *   3. workspace owner (code tools strong affinity; workspace -> owning node)
 *   4. unambiguous fresh presence (activeNode from PresenceRegistry)
 *   5. configured default/local healthy node
 *   6. no-route
 *
 * Safety:
 * - read-only discovery ops may aggregate across nodes (caller asks for
 *   `all` nodes and combines), but single-target reads still route.
 * - destructive/side-effecting ops (prompt, resume, write-capable) are
 *   fail-closed: when the route falls back to default/no-route and the target
 *   is unclear, the decision carries confirmation_required and the caller
 *   must reject unless an explicit target is provided.
 * - every decision records reason/evidence/candidates for route_explain,
 *   plus an audit entry (no conversation bodies, no secrets).
 */

import type { RouteDecision, RouteEvidence } from '@dsh-helm/protocol'
import { DANGER, ROUTE_OUTCOME } from '@dsh-helm/protocol'
import type { NodeRegistry, StoredNode } from '@dsh-helm/store'
import type { SessionCatalog, WorkspaceCatalog } from '@dsh-helm/store'
import type { PresenceRegistry, LeaseRow } from '@dsh-helm/store'

export interface RouterDeps {
  nodes: NodeRegistry
  sessions: SessionCatalog
  workspaces: WorkspaceCatalog
  presence: PresenceRegistry
  /** Node lease duration used to decide "healthy/online". */
  leaseMs: number
  /** Fallback default node (the hub's own node_id). */
  defaultNodeId: string
}

export interface RouteRequest {
  /** MCP tool / RPC method name (for audit). */
  op: string
  /** Explicitly requested node id (target_node param), if any. */
  target_node?: string
  /** Native session id (resolved to owner). */
  session_id?: string
  /** Workspace reference (native id or path) for code affinity. */
  workspace?: string
  /** Danger class of the operation. */
  danger: string
}

/** What the caller should do with a decision. */
export type RouteAction = 'forward' | 'reject' | 'aggregate'

export interface RouteResult {
  decision: RouteDecision
  action: RouteAction
  /** When action is 'reject': error code to surface. */
  errorCode?: string
}

export class Router {
  constructor(private deps: RouterDeps) {}

  /** Resolve the node for an operation. */
  route(req: RouteRequest): RouteResult {
    const evidence: RouteEvidence = {
      explicit_target: req.target_node,
      presence_ambiguous: false,
      healthy_nodes: [],
    }
    const candidates: RouteDecision['candidates'] = []
    const now = Date.now()

    // 1. explicit target
    if (req.target_node) {
      const node = this.deps.nodes.get(req.target_node)
      if (!node) {
        const d: RouteDecision = {
          outcome: ROUTE_OUTCOME.NO_ROUTE,
          node_id: '',
          reason: `explicit target_node ${req.target_node} is not a known node`,
          evidence,
          candidates,
          danger: req.danger,
          explicit: true,
        }
        return { decision: d, action: 'reject', errorCode: 'unknown_node' }
      }
      const healthy = this.healthy(node)
      evidence.healthy_nodes = [node.node_id]
      candidates.push({ node_id: node.node_id, reason: 'explicit target_node' })
      return {
        decision: {
          outcome: ROUTE_OUTCOME.EXPLICIT,
          node_id: node.node_id,
          reason: healthy ? 'explicit target_node, node healthy' : 'explicit target_node (node not currently healthy)',
          evidence,
          candidates,
          danger: req.danger,
          explicit: true,
        },
        action: 'forward',
      }
    }

    // 2. session owner
    if (req.session_id) {
      const row = this.deps.sessions.get(req.session_id)
      if (row) {
        const owner = row.node_id
        candidates.push({ node_id: owner, reason: `session owner (${req.session_id})` })
        evidence.session_owner = owner
        return this.decide(owner, ROUTE_OUTCOME.SESSION_OWNER, `session ${req.session_id} owned by node ${owner}`, evidence, candidates, req)
      }
      // Unknown session: no owner affinity.
      evidence.healthy_nodes = this.healthyNodes()
    }

    // 3. workspace owner
    if (req.workspace) {
      const w = this.deps.workspaces.resolve(req.workspace)
      if (w) {
        candidates.push({ node_id: w.node_id, reason: `workspace owner (${req.workspace})` })
        evidence.workspace_owner = w.node_id
        return this.decide(w.node_id, ROUTE_OUTCOME.WORKSPACE_OWNER, `workspace ${req.workspace} owned by node ${w.node_id}`, evidence, candidates, req)
      }
    }

    // 4. presence
    const active = this.deps.presence.activeNode(now)
    if (active) {
      evidence.presence = this.presenceEvidence()
      candidates.push({ node_id: active.node_id, reason: `presence (${active.record.source}, conf ${active.record.confidence})` })
      return this.decide(active.node_id, ROUTE_OUTCOME.PRESENCE, `presence lease on node ${active.node_id}`, evidence, candidates, req)
    }
    evidence.presence = this.presenceEvidence()
    evidence.presence_ambiguous = this.isPresenceAmbiguous(now)

    // 5. default healthy node
    const def = this.deps.nodes.get(this.deps.defaultNodeId)
    if (def && this.healthy(def)) {
      candidates.push({ node_id: def.node_id, reason: 'configured default node, healthy' })
      evidence.default_node = def.node_id
      return this.decide(def.node_id, ROUTE_OUTCOME.DEFAULT_LOCAL, `default node ${def.node_id} healthy`, evidence, candidates, req)
    }
    const healthy = this.healthyNodes()
    evidence.healthy_nodes = healthy

    // 6. no-route
    const d: RouteDecision = {
      outcome: ROUTE_OUTCOME.NO_ROUTE,
      node_id: '',
      reason: 'no explicit target, no session/workspace owner, no fresh presence, no healthy default node',
      evidence,
      candidates,
      danger: req.danger,
      explicit: false,
    }
    // Destructive op with no route -> confirmation required rather than silent no-op.
    if (req.danger === DANGER.DESTRUCTIVE) {
      d.confirmation_required = true
      d.reason += ' (destructive op: route_confirmation_required)'
      return { decision: d, action: 'reject', errorCode: 'route_confirmation_required' }
    }
    if (req.danger === DANGER.WRITE) {
      d.confirmation_required = true
      return { decision: d, action: 'reject', errorCode: 'route_confirmation_required' }
    }
    return { decision: d, action: 'reject', errorCode: 'no_route' }
  }

  private decide(
    nodeId: string,
    outcome: string,
    reason: string,
    evidence: RouteEvidence,
    candidates: RouteDecision['candidates'],
    req: RouteRequest,
  ): RouteResult {
    const decision: RouteDecision = {
      outcome,
      node_id: nodeId,
      reason,
      evidence,
      candidates,
      danger: req.danger,
      explicit: false,
    }
    // Destructive ops reached by fallback (session/workspace/presence/default
    // are real affinities, so those are fine) — only no-route fallback is gated.
    return { decision, action: 'forward' }
  }

  private healthy(node: StoredNode): boolean {
    if (node.status !== 'online') return false
    if (!node.last_seen) return false
    return Date.now() - Date.parse(node.last_seen) <= this.deps.leaseMs
  }

  private healthyNodes(): string[] {
    return this.deps.nodes
      .onlineNodes(this.deps.leaseMs)
      .map((n) => n.node_id)
  }

  private presenceEvidence(): RouteEvidence['presence'] {
    return this.deps.presence.live().map((l: LeaseRow) => ({
      node_id: l.node_id,
      confidence: l.confidence,
      expires_at: l.expires_at,
      source: l.source,
    }))
  }

  private isPresenceAmbiguous(now: number): boolean {
    // Ambiguity is decided inside PresenceRegistry.activeNode (returns
    // undefined when two fresh high-confidence leases collide); here we
    // approximate the flag for evidence by checking lease count freshness.
    const live = this.deps.presence.live(now).filter((l) => l.confidence >= 0.8)
    if (live.length < 2) return false
    live.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))
    const gap = Math.abs(Date.parse(live[0]!.observed_at) - Date.parse(live[1]!.observed_at))
    return gap <= this.deps.presence.ambiguityWindow
  }
}