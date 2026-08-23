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
export const STORE_SCHEMA_VERSION = 1 as const

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
