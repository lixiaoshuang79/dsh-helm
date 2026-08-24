/**
 * LocalHelmBackend: the node agent's interface to its local Helm MCP daemon.
 *
 * The backend abstraction exists so the agent is transport-agnostic: the
 * default `McpLocalHelmBackend` talks to the existing per-machine Helm daemon
 * over standard MCP (initialize / tools/list / tools/call) at
 * `http://127.0.0.1:3457/mcp` with a Bearer token read from the local token
 * file (never argv, never logs). Tests use FakeBackend instead.
 *
 * If upstream later ships a native multi-adapter node extension, only this
 * backend is swapped — hub protocol/registry/router are untouched.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One tool as exposed by the local Helm MCP (schema snapshot / tools/list). */
export interface LocalHelmTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface LocalHelmBackend {
  /** MCP initialize; returns server info. */
  connect(): Promise<{ name?: string; version?: string }>
  /** tools/list — dynamic discovery of the local 19-tool surface. */
  listTools(): Promise<LocalHelmTool[]>
  /** tools/call — invoke one local Helm tool. */
  callTool(name: string, args: unknown): Promise<McpToolCallResult>
  /** Structured health probe of the local datapath. */
  probeHealth(): Promise<{ ok: boolean; detail?: string }>
  /** Structured metadata reconciliation (sessions/workspaces from local daemon). */
  reconcile(): Promise<{ sessions: Array<Record<string, unknown>>; workspaces: Array<Record<string, unknown>> }>
  disconnect(): void
  readonly connected: boolean
}

export interface McpToolCallResult {
  /** Tool result content (MCP content blocks). */
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>
  /** Structured content when available. */
  structuredContent?: Record<string, unknown>
  isError?: boolean
  [k: string]: unknown
}

/** Default token file of the local Helm daemon (0600, same file the tunnel uses).
 *  agent-helm >=0.1.2 moved its runtime files to ~/.agent-helm/; probe the new
 *  location first and fall back to the legacy ~/.agent-chatgpt-helm/ so both
 *  plugin generations on a dual-machine control plane keep working. */
export function defaultHelmTokenFile(): string {
  const home = process.env.HOME ?? '.'
  const candidates = [
    join(home, '.agent-helm', 'token'),
    join(home, '.agent-chatgpt-helm', 'token'),
  ]
  for (const c of candidates) {
    try {
      if (readFileSync(c, 'utf8').trim().length > 0) return c
    } catch {
      /* try next */
    }
  }
  return candidates[0]!
}

export interface McpLocalHelmBackendOptions {
  /** Default http://127.0.0.1:3457/mcp */
  url?: string
  /** Bearer token; if omitted, read from the local token file (never argv/log). */
  token?: string
  /** Override token file path (tests). */
  tokenFile?: string
  /** fetch impl for tests (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

/**
 * Default backend: standard MCP client over fetch to the local Helm daemon.
 * Minimal JSON-RPC (initialize handshake + session-id header management) —
 * no SDK dependency, unit-testable against a fake HTTP endpoint.
 */
export class McpLocalHelmBackend implements LocalHelmBackend {
  private url: string
  private token: string
  private fetchImpl: typeof fetch
  private logFn?: (line: string) => void
  private sessionId?: string
  private serverInfo?: { name?: string; version?: string }
  private nextId = 1

  constructor(opts: McpLocalHelmBackendOptions = {}) {
    this.url = opts.url ?? 'http://127.0.0.1:3457/mcp'
    this.token = opts.token ?? readTokenFile(opts.tokenFile ?? defaultHelmTokenFile())
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.logFn = opts.log
  }

  /** MCP initialize; returns server info. Idempotent while a session is live. */
  async connect(): Promise<{ name?: string; version?: string }> {
    if (this.sessionId) return this.serverInfo ?? {}
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

  /** tools/list — dynamic discovery of the local 19-tool surface. */
  async listTools(): Promise<LocalHelmTool[]> {
    const res = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} })
    const body = res.body as { result?: { tools?: LocalHelmTool[] } }
    return body.result?.tools ?? []
  }

  /** Structured health probe of the local datapath. */
  async probeHealth(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await this.callTool('supervisor_health', {})
      const sc = (res.structuredContent ?? {}) as { status?: string; serena?: { connected?: boolean } }
      const ok = sc.status === 'ok' || !!sc.serena?.connected
      return { ok, detail: ok ? undefined : `local helm health: ${sc.status ?? 'unknown'}` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message.slice(0, 120) : String(err) }
    }
  }

  /** Structured metadata reconciliation from the local daemon. */
  async reconcile(): Promise<{ sessions: Array<Record<string, unknown>>; workspaces: Array<Record<string, unknown>> }> {
    let sessions: Array<Record<string, unknown>> = []
    let workspaces: Array<Record<string, unknown>> = []
    try {
      const list = (await this.callTool('sessions_list', {})).structuredContent ?? {}
      sessions = (list['sessions'] as Array<Record<string, unknown>>) ?? []
    } catch {
      /* datapath issues reported via probeHealth */
    }
    try {
      const list = (await this.callTool('workspaces_list', {})).structuredContent ?? {}
      workspaces = (list['workspaces'] as Array<Record<string, unknown>>) ?? []
    } catch {
      /* tolerate */
    }
    return { sessions, workspaces }
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

/** Read the Bearer token from the local token file (trimmed). Missing file -> ''. */
export function readTokenFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
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
