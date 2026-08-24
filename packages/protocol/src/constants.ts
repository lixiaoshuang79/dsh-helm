/**
 * dsh-helm protocol v1 constants.
 *
 * Central defaults for the node mesh. All timing values are in milliseconds
 * unless noted. These are the single source of truth; tests and docs must not
 * hardcode divergent values.
 */

/** Node protocol schema version. Bump only on incompatible wire changes. */
export const NODE_PROTOCOL_VERSION = 1 as const

/** Store schema version (SQLite migrations). */
export const STORE_SCHEMA_VERSION = 2 as const

/** Default heartbeat interval for node agents (ms). */
export const DEFAULT_HEARTBEAT_MS = 15_000

/** Node lease duration: how long a node stays "online" without heartbeats (ms). */
export const DEFAULT_NODE_LEASE_MS = 45_000

/** Heartbeat loss count that marks a node offline (3 x heartbeat). */
export const HEARTBEAT_LOSS_THRESHOLD = 3

/** Presence provider renew interval (ms). */
export const DEFAULT_PRESENCE_RENEW_MS = 20_000

/** Presence lease TTL (ms). */
export const DEFAULT_PRESENCE_TTL_MS = 60_000

/**
 * Ambiguity window: when two nodes both report high-confidence presence
 * within this window, the router treats the presence signal as ambiguous.
 */
export const PRESENCE_AMBIGUITY_WINDOW_MS = 15_000

/** Manual presence claim default TTL (ms). */
export const MANUAL_CLAIM_TTL_MS = 10 * 60_000

/** Reconnect backoff base (ms) for node agent -> hub. */
export const RECONNECT_BACKOFF_BASE_MS = 1_000

/** Reconnect backoff maximum (ms). */
export const RECONNECT_BACKOFF_MAX_MS = 30_000

/** Hub mesh listen port (control plane WebSocket server). */
export const DEFAULT_HUB_MESH_PORT = 3470

/** Hub MCP server port (single connector entry). */
export const DEFAULT_HUB_MCP_PORT = 3471

/** Node token length in bytes (random secret). */
export const NODE_TOKEN_BYTES = 32

/**
 * Node_id prefix that marks an *unauthenticated enrollment* connection.
 * A client that wants to join the mesh without a token connects with
 * node_id = `enroll:<uuid>`; the hub skips the HMAC challenge for these
 * connections and allows exactly one RPC: enrollment.consume (then closes).
 * Real node ids are UUIDs and can never collide with this prefix.
 */
export const ENROLL_NODE_ID_PREFIX = 'enroll:' as const

/**
 * Enrollment pairing code shape: `dshp-` + 20 base36 chars (~104 bits).
 * The plaintext code is shown exactly once (create response); the hub only
 * ever stores sha256(code).
 */
export const PAIRING_CODE_PATTERN = /^dshp-[0-9a-z]{20}$/

/** HMAC algorithm for challenge handshake. */
export const HMAC_ALGORITHM = 'sha256' as const

/** Protocol error codes (JSON-RPC style negative / namespace codes). */
export const PROTOCOL_ERROR = {
  /** Version negotiation failed; client must upgrade or be rejected. */
  VERSION_MISMATCH: -32001,
  /** Authentication (HMAC challenge) failed. */
  AUTH_FAILED: -32002,
  /** Node already registered with a different token or identity conflict. */
  NODE_ID_CONFLICT: -32003,
  /** Unknown method. */
  METHOD_NOT_FOUND: -32004,
  /** Invalid request shape. */
  INVALID_REQUEST: -32600,
  /** Internal error. */
  INTERNAL_ERROR: -32603,
} as const

/** Router outcome codes. */
export const ROUTE_OUTCOME = {
  EXPLICIT: 'explicit',
  SESSION_OWNER: 'session_owner',
  WORKSPACE_OWNER: 'workspace_owner',
  PRESENCE: 'presence',
  DEFAULT_LOCAL: 'default_local',
  NO_ROUTE: 'no_route',
  AMBIGUOUS: 'ambiguous',
  CONFIRMATION_REQUIRED: 'confirmation_required',
} as const

/** Operation danger classes used by the router's fail-closed policy. */
export const DANGER = {
  /** Read-only discovery: safe to aggregate across nodes. */
  READ: 'read',
  /** State-changing but reversible / low impact (e.g. cancel). */
  WRITE: 'write',
  /** Destructive / side-effecting: requires explicit or presence-backed target. */
  DESTRUCTIVE: 'destructive',
} as const

/**
 * Control-plane HA: node_id prefix a hub uses when authenticating to a peer
 * hub over the node mesh. The peer is treated as a "special node" whose
 * identity is `cp:<cp_id>`; the server side looks its token up with the same
 * token table (DSH_HELM_TOKEN / registration_tokens accept
 * `cp:<cp_id>=<token>` entries).
 */
export const CP_NODE_PREFIX = 'cp:' as const

/** RPC methods between control-plane peers (hub <-> hub over the node mesh). */
export const CP_METHODS = {
  /** Full registry + leader state exchange on peer connect (request/response). */
  SYNC: 'cp.sync',
  /** Periodic heartbeat carrying leader state + registry diff. */
  HEARTBEAT: 'cp.heartbeat',
  /** Leader election proposal (term + leader + candidate set); ack/refuse. */
  ELECT: 'cp.elect',
  /** Write-lease renew from the lease-holding leader (2/2 quorum). */
  LEASE_RENEW: 'cp.lease.renew',
} as const

/** Default CP peer heartbeat interval (ms). */
export const DEFAULT_CP_HEARTBEAT_MS = 5_000

/**
 * Write-lease renew interval (ms): the elected leader renews its write lease
 * to the peer (2/2 quorum). Each successful renew refreshes the lease.
 */
export const DEFAULT_CP_LEASE_RENEW_MS = 10_000

/**
 * Write-lease TTL (ms): after this long without a peer renew/heartbeat the
 * cluster has no quorum — the leader demotes to read-only and all WRITE_TOOLS
 * are refused with QUORUM_LOST. Followers stay read-only and NEVER promote on
 * their own (no split-brain double-write).
 */
export const DEFAULT_CP_LEASE_TTL_MS = 45_000

/** Default CP election priority (smallest wins; tie -> smaller cp_id). */
export const DEFAULT_CP_PRIORITY = 0

/** Store kv keys for the persisted CP term/leader (fencing state). */
export const CP_TERM_KV = {
  TERM: 'cp_term',
  LEADER: 'cp_leader',
  LEADER_TERM: 'cp_leader_term',
} as const
