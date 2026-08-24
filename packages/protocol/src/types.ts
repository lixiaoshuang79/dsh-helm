/**
 * Shared types for the node mesh protocol (schema version 1).
 *
 * Design rules:
 * - node_id is a stable UUID generated at first install; hostname is only a
 *   display_name and never an identity.
 * - native DSH session/workspace ids are preserved verbatim; the global
 *   catalog keys are `node_id:native_id` strings.
 * - The wire carries metadata only — never DSH conversation bodies.
 */

/** Platform description of a node. */
export interface PlatformInfo {
  os: 'darwin' | 'win32' | 'linux'
  arch: string
  /** OS release string (e.g. macOS version, Windows build). */
  release: string
  /** Node.js version running the agent. */
  nodeVersion: string
}

/** Component versions of a node. */
export interface ComponentVersions {
  /** DeepSeek Harness version (DSH). */
  dsh?: string
  /** beforewave agent-chatgpt-helm npm version. */
  helmCore?: string
  /** dsh-helm node agent version. */
  agent: string
  /** Wire protocol schema version. */
  protocol: number
}

/** Capability flags of a node. */
export interface NodeCapabilities {
  /** Can host native DSH sessions. */
  sessions: boolean
  /** Has local helm daemon + Serena code intelligence. */
  serena: boolean
  /** Has a working tunnel entry (only meaningful on the hub node). */
  tunnel: boolean
  /** Runs a presence sidecar provider. */
  presenceProvider: boolean
  /** Agent is the configured default/local node for read-only fallback. */
  defaultNode: boolean
}

/** Node identity and static metadata (sent at register, stored in registry). */
export interface NodeInfo {
  /** Stable UUID; the only identity. Generated at first install. */
  node_id: string
  /** Human-readable name; NOT an identity. */
  display_name: string
  platform: PlatformInfo
  versions: ComponentVersions
  capabilities: NodeCapabilities
  /** Local config dir (e.g. ~/.dsh/helm) — informational only. */
  config_home?: string
}

/** Runtime status of a node (heartbeat payload). */
export interface NodeStatus {
  /** Monotonic heartbeat sequence number. */
  seq: number
  /** Clock at heartbeat emission (ISO string). */
  ts: string
  /** Adapter/datapath health summary, layered per HealthLayer. */
  health: HealthReport
  /** Workspace count reported by the node's local DSH. */
  workspace_count: number
  /** Session count reported by the node's local DSH. */
  session_count: number
  /** Load hint (0..1, optional). */
  load?: number
}

/** Layered health report. Each layer is independent; never collapse to one status. */
export interface HealthReport {
  /** Control-plane layer (hub process/store). Hub-computed, nodes omit. */
  control?: LayerHealth
  /** Node channel + lease layer. */
  channel: LayerHealth
  /** DSH plugin/adapter bridge layer (local helm daemon reachable). */
  adapter: LayerHealth
  /** Datapath layer: sessions_list actually works end-to-end. */
  datapath: LayerHealth
  /** Serena/workspace runtime layer. */
  serena: LayerHealth
  /** Optional tunnel/entry layer (hub node only). */
  tunnel?: LayerHealth
}

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown'

export interface LayerHealth {
  status: HealthStatus
  /** Short machine-readable code, e.g. 'adapter-unreachable'. */
  code?: string
  /** Human-readable detail (no secrets). */
  detail?: string
  /** Last check timestamp ISO. */
  checked_at?: string
}

/** Workspace metadata catalog entry (key = node_id:native_workspace_id). */
export interface WorkspaceInfo {
  /** Native DSH workspace id (UUID, node-private). */
  native_workspace_id: string
  /** Workspace path — an attribute only; never a global identity. */
  path: string
  title?: string
  session_count?: number
}

/** Session metadata catalog entry (key = node_id:native_session_id). */
export interface SessionInfo {
  /** Native DSH session id, preserved verbatim. */
  native_session_id: string
  title?: string
  status: SessionStatus
  updated_at?: string
  workspace_id?: string
  /** Whether the session currently has a live agent on the node. */
  live: boolean
}

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'failed'
  | 'cancelled'
  | 'unknown'

/** Presence claim payload from a presence provider (via node agent). */
export interface PresenceClaim {
  node_id: string
  /** Provider id: 'manual' | 'desktop' | 'browser' | 'idle'. */
  source: string
  /** 0..1 confidence the human is actively using this node now. */
  confidence: number
  /** When the observation was made (ISO). */
  observed_at: string
  /** Requested TTL (ms); hub may clamp. */
  ttl_ms: number
  /** Manual claims can pin and bypass presence ambiguity. */
  pinned?: boolean
}

/** Resolved presence record held by the hub. */
export interface PresenceRecord {
  node_id: string
  source: string
  confidence: number
  observed_at: string
  /** Absolute expiry (ISO). */
  expires_at: string
  pinned: boolean
}

/** Route decision produced by the router (also persisted in route_log). */
export interface RouteDecision {
  /** Which catalog/rule selected the node. */
  outcome: string
  /** Selected node id, or '' when no route. */
  node_id: string
  /** Why (human-readable, no secrets). */
  reason: string
  /** Evidence: catalog lookups, presence records consulted. */
  evidence: RouteEvidence
  /** Candidate nodes considered (id + one-line reason), ordered by preference. */
  candidates: Array<{ node_id: string; reason: string }>
  /** Danger class of the operation. */
  danger: string
  /** True when the caller explicitly requested this node. */
  explicit: boolean
  /** True when the decision required (or would require) human confirmation. */
  confirmation_required?: boolean
}

export interface RouteEvidence {
  explicit_target?: string
  session_owner?: string
  workspace_owner?: string
  presence?: Array<{ node_id: string; confidence: number; expires_at: string; source: string }>
  presence_ambiguous: boolean
  default_node?: string
  healthy_nodes: string[]
}

/** Audit log entry (hub side; no conversation content, no secrets). */
export interface AuditEntry {
  ts: string
  /** Call id correlating a request across logs. */
  call_id: string
  /** MCP tool / rpc method name. */
  op: string
  actor_node?: string
  target_node: string
  session_id?: string
  /** Route outcome code. */
  decision: string
  danger: string
  explicit: boolean
  /** Result summary: 'ok' | 'error:<code>' | 'rejected'. */
  result: string
}

// ---- Control-plane HA (dual-CP) wire types ----

/** One node entry in the CP-to-CP registry sync. */
export interface CpSyncNode {
  node_id: string
  display_name: string
  /** Whether the REPORTING cp has a live direct connection to this node. */
  connected: boolean
  /** ISO timestamp of the node's last heartbeat, as seen by the reporting cp. */
  last_seen?: string
  /** 'online' | 'offline' | 'blocked' as seen by the reporting cp. */
  status: string
  platform?: PlatformInfo
  versions?: ComponentVersions
  capabilities?: NodeCapabilities
  health?: HealthReport
}

/** Leader/heartbeat state exchanged between CP peers over the node mesh. */
export interface CpPeerState {
  /** Sender cp_id. */
  from: string
  /** Election priority (smallest wins; tie -> smaller cp_id). */
  priority: number
  /** Persisted term of the sender (fencing). */
  term: number
  /** cp_id the sender currently recognizes as leader ('' when undecided). */
  leader: string
  /** Term under which that leader was elected (0 when none). */
  leaderTerm: number
  /**
   * Sender's HA phase: 'nominating' | 'leader-leased' | 'read-only-no-quorum'
   * | 'follower' | 'standalone'. Written by HubHa; optional for wire compat.
   */
  phase?: string
  /** Write-lease epoch (term of the lease currently held; 0 = none). */
  leaseEpoch?: number
  /** Registry entries (full on cp.sync, diff on cp.heartbeat). */
  registry: CpSyncNode[]
}

/** Role of a control-plane instance. */
export type CpRole = 'leader' | 'follower' | 'standalone'