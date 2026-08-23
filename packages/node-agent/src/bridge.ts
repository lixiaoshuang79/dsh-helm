/**
 * LocalDshBridge: MCP client to the local helm daemon.
 *
 * The node agent's "adapter" — reaches the local DSH through the helm
 * daemon's Streamable HTTP MCP endpoint (127.0.0.1:3457/mcp) with a Bearer
 * token, exactly like ChatGPT's tunnel does. This keeps the node agent out of
 * the daemon's unix-socket adapter protocol (loopback-only, unauthenticated)
 * and reuses the mature 19-tool MCP surface.
 *
 * Implemented with a minimal JSON-RPC client (initialize handshake +
 * session-id header management) — no SDK dependency, fully unit-testable
 * against a fake HTTP endpoint.
 */

export interface McpToolCallResult {
  /** Tool result content (MCP content blocks). */
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>
  /** Structured content when available. */
  structuredContent?: Record<string, unknown>
  isError?: boolean
  [k: string]: unknown
}

export interface LocalDshBridgeOptions {
  url: string
  token: string
  /** fetch impl for tests (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

export class LocalDshBridge {
  private url: string
  private token: string
  private fetchImpl: typeof fetch
  private logFn?: (line: string) => void
  private sessionId?: string
  private serverInfo?: { name?: string; version?: string }
  private nextId = 1

  constructor(opts: LocalDshBridgeOptions) {
    this.url = opts.url
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.logFn = opts.log
  }

  /** MCP initialize; returns server info. */
  async connect(): Promise<{ name?: string; version?: string }> {
    const res = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'dsh-helm-node-agent', version: '0.1.0' },
      },
    })
    const body = res.body as {
      result?: { serverInfo?: { name?: string; version?: string } }
      error?: { message?: string }
    }
    if (body.error) throw new Error(`mcp initialize failed: ${body.error.message}`)
    this.serverInfo = body.result?.serverInfo
    // notify initialized (fire and forget; failure tolerated)
    try {
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    } catch {
      /* daemon tolerates missing notification */
    }
    return this.serverInfo ?? {}
  }

  /** Call one MCP tool. */
  async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    const res = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args ?? {} },
    })
    const body = res.body as {
      result?: McpToolCallResult & { error?: { message?: string } }
      error?: { code?: number; message?: string }
    }
    if (body.error) throw new Error(`mcp tool ${name} failed: ${body.error.message}`)
    const result = body.result
    if (!result) throw new Error(`mcp tool ${name}: empty result`)
    if (result.isError) {
      const text = result.content?.map((c) => c.text ?? '').join('\n') ?? ''
      throw new Error(`mcp tool ${name} error: ${text.slice(0, 300)}`)
    }
    return result
  }

  /** Tools/list (for capability discovery). */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const res = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} })
    const body = res.body as { result?: { tools?: Array<{ name: string; description?: string }> } }
    return body.result?.tools ?? []
  }

  disconnect(): void {
    this.sessionId = undefined
    this.serverInfo = undefined
  }

  get connected(): boolean {
    return this.sessionId !== undefined
  }

  private async post(message: unknown): Promise<{ body: unknown; headers: Headers }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    let res: Response
    try {
      res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(message) })
    } catch (err) {
      throw new Error(`local daemon unreachable: ${err instanceof Error ? err.message : String(err)}`)
    }
    const sessionId = res.headers.get('mcp-session-id')
    if (sessionId) this.sessionId = sessionId
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`local daemon http ${res.status}: ${text.slice(0, 200)}`)
    }
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      // streamable http may return SSE; extract the first data line
      body = parseSseJson(text)
    }
    return { body, headers: res.headers }
  }
}

function parseSseJson(text: string): unknown {
  for (const line of text.split('\n')) {
    const m = /^data:\s*(.*)$/.exec(line.trim())
    if (m && m[1]) {
      try {
        return JSON.parse(m[1])
      } catch {
        /* keep scanning */
      }
    }
  }
  return {}
}

/** Session info adapter: 19-tool daemon -> node AgentAdapter semantics. */
export interface LocalSessionInfo {
  session_id?: string
  title?: string
  status?: string
  [k: string]: unknown
}

export interface LocalWorkspaceInfo {
  workspace_id?: string
  id?: string
  path?: string
  title?: string
  [k: string]: unknown
}