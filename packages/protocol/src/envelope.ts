/**
 * Wire envelope for the node mesh (node-protocol v1).
 *
 * Handshake sequence over a (wss/ws) connection:
 *   1. client -> hello      {v, node_id, nonce}
 *   2. server -> challenge  {v, node_id, nonce}          (server nonce)
 *   3. client -> auth       {v, node_id, nonce, mac}     mac = HMAC(token, client_nonce + server_nonce)
 *   4. server -> welcome    {v, hub_id, schema_version}  or error VERSION_MISMATCH/AUTH_FAILED
 *
 * After welcome, both sides exchange JSON-RPC 2.0 messages wrapped in an
 * envelope carrying the protocol version (no silent downgrade: mismatched
 * versions are rejected, never negotiated down).
 */

export const ENVELOPE_VERSION = NODE_PROTOCOL_VERSION

import { NODE_PROTOCOL_VERSION } from './constants.js'

/** Client -> server handshake step 1. */
export interface HelloMessage {
  type: 'hello'
  v: number
  node_id: string
  /** Client random nonce (base64url, 16+ bytes). */
  nonce: string
}

/** Server -> client handshake step 2. */
export interface ChallengeMessage {
  type: 'challenge'
  v: number
  node_id: string
  /** Server random nonce (base64url). */
  nonce: string
}

/** Client -> server handshake step 3. */
export interface AuthMessage {
  type: 'auth'
  v: number
  node_id: string
  /** Client nonce from hello (echoed). */
  nonce: string
  /** HMAC-SHA256(token, client_nonce + server_nonce), base64url. */
  mac: string
}

/** Server -> client handshake step 4 (success). */
export interface WelcomeMessage {
  type: 'welcome'
  v: number
  hub_id: string
  schema_version: number
  /** Server-assigned reconnect hints. */
  heartbeat_ms: number
  lease_ms: number
}

/** Server -> client handshake step 4 (failure). */
export interface HandshakeErrorMessage {
  type: 'error'
  v: number
  code: number
  message: string
}

/** Post-handshake JSON-RPC frame. */
export interface RpcFrame<T = unknown> {
  type: 'rpc'
  v: number
  /** JSON-RPC 2.0 request/response/notification body. */
  body: T
}

/** Server -> client: lease/heartbeat expectation update (rare). */
export interface ControlMessage {
  type: 'control'
  v: number
  kind: 'lease_update' | 'ping'
  heartbeat_ms?: number
  lease_ms?: number
}

export type WireMessage =
  | HelloMessage
  | ChallengeMessage
  | AuthMessage
  | WelcomeMessage
  | HandshakeErrorMessage
  | RpcFrame
  | ControlMessage

/** JSON-RPC 2.0 request (id required for our client; notifications carry no id). */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** RPC methods a node agent serves (mirrors AgentAdapter semantics + node ops). */
export const NODE_METHODS = {
  HEALTH: 'health',
  LIST_WORKSPACES: 'listWorkspaces',
  CREATE_SESSION: 'createSession',
  LIST_SESSIONS: 'listSessions',
  GET_SESSION: 'getSession',
  RESUME_SESSION: 'resumeSession',
  PROMPT: 'prompt',
  CANCEL: 'cancel',
  /** Generic passthrough of an MCP tool call to the local helm daemon. */
  MCP_CALL: 'mcp.call',
  /** Generic capability discovery: node's local tools/list. */
  TOOLS_LIST: 'tools.list',
  /** Presence provider report. */
  PRESENCE_REPORT: 'presence.report',
  /** Session/workspace metadata reconcile payload (after (re)register). */
  CATALOG_RECONCILE: 'catalog.reconcile',
  /** Explicit node-side audit append (hub asks node to record locally). */
  AUDIT_APPEND: 'audit.append',
} as const

/** RPC methods the hub serves (node agent -> hub direction). */
export const HUB_METHODS = {
  NODE_REGISTER: 'node.register',
  NODE_HEARTBEAT: 'node.heartbeat',
  NODE_RELEASE: 'node.release',
  CATALOG_RECONCILE: 'catalog.reconcile',
  PRESENCE_REPORT: 'presence.report',
} as const
