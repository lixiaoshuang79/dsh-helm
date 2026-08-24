/**
 * Hub status probe: GET /healthz + MCP initialize + tools/call nodes_list.
 *
 * The hub exposes a Streamable-HTTP MCP endpoint (POST /mcp): an
 * `initialize` request returns an `mcp-session-id` response header which
 * must be sent back on subsequent requests before `tools/call` is accepted.
 *
 * Never throws: every failure is returned as a `{ hubOk: false, error }`
 * object so the dashboard can render per-section errors instead of dying.
 */

export const DEFAULT_HUB_URL = 'http://127.0.0.1:3471'
export const DEFAULT_HUB_TIMEOUT_MS = 5000

export interface HubNodePlatform {
  os?: string
  arch?: string
  release?: string
  nodeVersion?: string
}

export interface HubNodeVersions {
  agent?: string
  protocol?: string
}

export interface HubNode {
  node_id: string
  display_name?: string
  platform?: HubNodePlatform
  versions?: HubNodeVersions
  capabilities?: Record<string, boolean | string>
  status?: string
  connected?: boolean
  last_seen?: string
}

export interface HubStatus {
  hubOk: boolean
  /** Node count reported by /healthz. */
  nodeCount: number
  /** Full node list from nodes_list (empty when the MCP step failed). */
  nodes: HubNode[]
  error?: string
}

interface JsonRpcResponse {
  result?: unknown
  error?: { code?: number; message?: string }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeNodes(raw: unknown): HubNode[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (n): n is HubNode => typeof n === 'object' && n !== null && typeof (n as Record<string, unknown>)['node_id'] === 'string',
  )
}

async function postJson(
  url: URL,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; headers: Headers; body: JsonRpcResponse | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let parsed: JsonRpcResponse | null = null
  try {
    parsed = JSON.parse(text) as JsonRpcResponse
  } catch {
    parsed = null
  }
  return { status: res.status, headers: res.headers, body: parsed }
}

/**
 * Probe the hub control plane. `hubUrl` is the hub origin (e.g.
 * `http://127.0.0.1:3471`); `/healthz` and `/mcp` are derived from it.
 */
export async function fetchHubStatus(hubUrl: string, timeoutMs: number = DEFAULT_HUB_TIMEOUT_MS): Promise<HubStatus> {
  const base = new URL(hubUrl)
  const healthzUrl = new URL('/healthz', base)
  const mcpUrl = new URL('/mcp', base)
  try {
    // 1. liveness/count: GET /healthz
    const healthzRes = await fetch(healthzUrl, { signal: AbortSignal.timeout(timeoutMs) })
    if (!healthzRes.ok) {
      return { hubOk: false, nodeCount: 0, nodes: [], error: `healthz http ${healthzRes.status}` }
    }
    const healthz = (await healthzRes.json().catch(() => null)) as { nodes?: unknown } | null
    const nodeCount = typeof healthz?.nodes === 'number' ? healthz.nodes : 0

    // 2. MCP session bootstrap: initialize (session id comes back in a header)
    const init = await postJson(
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: '@dsh-helm/dashboard', version: '0.1.0' },
        },
      },
      {},
      timeoutMs,
    )
    if (init.status !== 200) {
      return { hubOk: false, nodeCount, nodes: [], error: `mcp initialize http ${init.status}` }
    }
    const sessionId = init.headers.get('mcp-session-id')
    if (!sessionId) {
      return { hubOk: false, nodeCount, nodes: [], error: 'mcp initialize: no mcp-session-id header' }
    }

    // 3. tool call: nodes_list (requires the session header)
    const call = await postJson(
      mcpUrl,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nodes_list', arguments: {} } },
      { 'mcp-session-id': sessionId },
      timeoutMs,
    )
    if (call.status !== 200) {
      return { hubOk: false, nodeCount, nodes: [], error: `mcp tools/call http ${call.status}` }
    }
    if (call.body?.error) {
      return { hubOk: false, nodeCount, nodes: [], error: `mcp tools/call error: ${call.body.error.message ?? call.body.error.code}` }
    }
    const result = call.body?.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined
    if (!result || result.isError) {
      return { hubOk: false, nodeCount, nodes: [], error: 'mcp tools/call: error result' }
    }
    const text = result.content?.find((c) => c.type === 'text')?.text
    if (!text) {
      return { hubOk: false, nodeCount, nodes: [], error: 'mcp tools/call: no text content' }
    }
    const parsed = JSON.parse(text) as { nodes?: unknown }
    return { hubOk: true, nodeCount, nodes: normalizeNodes(parsed.nodes) }
  } catch (err) {
    return { hubOk: false, nodeCount: 0, nodes: [], error: `hub unreachable: ${errMsg(err)}` }
  }
}
