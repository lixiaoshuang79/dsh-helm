/**
 * Node agent configuration: identity, hub endpoint, local DSH endpoint.
 *
 * node_id is the stable identity (UUID); hostname is display only. Token is
 * read from a private file (0600) — never from argv or environment dumps.
 */

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

export interface NodeAgentConfig {
  /** Stable identity UUID. */
  node_id: string
  /** Primary hub WebSocket URL, e.g. wss://hub.example.com/ (ws:// loopback/test ok). */
  hub_url: string
  /** Fallback control-plane endpoints tried in order when hub_url is
   *  unreachable (dual-CP HA). Empty = single-endpoint behavior. */
  fallback_urls: string[]
  /** Secret token for hub auth. */
  token: string
  /** Local helm daemon MCP endpoint (loopback only). */
  local_mcp_url: string
  /** DSH web backend host API base URL (loopback; used for steer injection,
   *  which the MCP tool surface does not expose). Default http://127.0.0.1:3080. */
  host_api_url: string
  /** Bearer token for the local daemon (from ~/.agent-chatgpt-helm/token). */
  local_mcp_token: string
  /** Display name (hostname-like); NOT identity. */
  display_name: string
  /** Health check interval for local probe (ms). */
  local_probe_ms: number
  /** Reconcile interval for session/workspace metadata (ms). */
  reconcile_ms: number
}

export interface NodeConfigFile {
  node_id?: string
  hub_url?: string
  fallback_urls?: string[]
  token?: string
  local_mcp_url?: string
  local_mcp_token?: string
  host_api_url?: string
  display_name?: string
  local_probe_ms?: number
  reconcile_ms?: number
}

const DEFAULT_LOCAL_MCP = 'http://127.0.0.1:3457/mcp'
const DEFAULT_HOST_API = 'http://127.0.0.1:3080'

export function defaultConfigDir(): string {
  return join(process.env.HOME ?? '.', '.dsh', 'helm')
}

/**
 * Load config; generates node_id + token on first run (persists 0600).
 */
export function loadConfig(dir?: string, file?: NodeConfigFile): NodeAgentConfig {
  const cfgDir = dir ?? defaultConfigDir()
  const path = join(cfgDir, 'node.json')
  let disk: NodeConfigFile = {}
  try {
    disk = JSON.parse(readFileSync(path, 'utf8')) as NodeConfigFile
  } catch {
    // first run
  }
  const merged: NodeConfigFile = { ...disk, ...file }
  const node_id = merged.node_id ?? randomUUID()
  const token = merged.token ?? randomBytes(32).toString('base64url')
  const display_name = merged.display_name ?? hostname()
  const cfg: NodeAgentConfig = {
    node_id,
    hub_url: merged.hub_url ?? '',
    fallback_urls: merged.fallback_urls ?? [],
    token,
    local_mcp_url: merged.local_mcp_url ?? DEFAULT_LOCAL_MCP,
    local_mcp_token: merged.local_mcp_token ?? '',
    host_api_url: merged.host_api_url ?? DEFAULT_HOST_API,
    display_name,
    local_probe_ms: merged.local_probe_ms ?? 10_000,
    reconcile_ms: merged.reconcile_ms ?? 60_000,
  }
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(path, JSON.stringify({ ...cfg, token }, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
  return cfg
}