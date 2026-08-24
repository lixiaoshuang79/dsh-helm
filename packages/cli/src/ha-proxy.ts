/**
 * HA front proxy for the tunnel entry point.
 *
 * OpenAI Secure MCP Tunnel clients support exactly one MCP backend per
 * channel (`main` is mandatory and unique; extra `--mcp.server-url` values
 * are independent channels with no failover semantics — see
 * https://github.com/openai/tunnel-client/blob/master/docs/connectors.md).
 * To keep a single ChatGPT connector reachable across control-plane
 * failover, this proxy sits between the tunnel-client and the control
 * planes: the tunnel always talks to 127.0.0.1:3481 (this process), which
 * forwards /mcp to the currently healthy control plane.
 *
 * Switching is latency-aware: the local (primary) control plane is
 * preferred; after N consecutive failed health probes it switches to the
 * secondary (remote) plane and keeps re-probing the primary so it can
 * switch back once healthy again.
 */

export type HaBackendId = 'primary' | 'secondary'

export interface HaBackend {
  id: HaBackendId
  label: string
  /** Base URL, e.g. http://127.0.0.1:3471 */
  baseUrl: string
}

export interface HaProxyStatus {
  active: HaBackendId | 'none'
  backends: Record<HaBackendId, { label: string; baseUrl: string; healthy: boolean }>
  failoverCount: number
  switchedAt: string | null
  lastProbe: string | null
}

export interface HaProxyOptions {
  /** Local control plane (preferred). */
  primary: HaBackend
  /** Remote control plane (failover target). */
  secondary: HaBackend
  /** Health probe interval in ms. Default 2000. */
  probeIntervalMs?: number
  /** Consecutive failed probes before switching away. Default 3. */
  failThreshold?: number
  /** Consecutive successful probes before switching back to primary. Default 2. */
  recoverThreshold?: number
  /**
   * Health URL path relative to the backend base URL. Default /healthz.
   * Pass /readyz flips for probes that must check readiness.
   */
  healthPath?: string
  /** Overridable HTTP probe for tests. */
  probe?: (url: string, timeoutMs: number) => Promise<boolean>
  /** Overridable fetch for tests. */
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

const DEFAULT_TIMEOUT_MS = 3000

function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => {
      if (!r.ok) return false
      return r.text().then((t) => (t.trim().length === 0 ? true : t.includes('ready') || t.includes('ok') || t.includes('true')))
    })
    .catch(() => false)
}

export interface HaProxy {
  status(): HaProxyStatus
  /** Handle one inbound HTTP request. Returns the outbound Node response info. */
  handle(req: Request): Promise<Response>
  close(): void
}

/**
 * A controller used as the internal request path. `handle()` follows the
 * WHATWG Request/Response shape so tests can drive it without sockets.
 */
export class HaProxyController implements HaProxy {
  private active: HaBackendId = 'primary'
  private healthy: Record<HaBackendId, boolean> = { primary: false, secondary: false }
  private failCount = 0
  private recoverCount = 0
  private failoverCount = 0
  private switchedAt: string | null = null
  private lastProbe: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly probedFetch: (url: string, timeoutMs: number) => Promise<boolean>
  private readonly forwardFetch: typeof fetch
  private readonly log: (line: string) => void

  constructor(
    private readonly opts: HaProxyOptions,
    startProbing = true,
  ) {
    this.probedFetch = opts.probe ?? probeHealth
    this.forwardFetch = opts.fetchImpl ?? fetch
    this.log = opts.log ?? ((l) => console.log(`[ha-proxy] ${l}`))
    this.healthy = { primary: false, secondary: false }
    if (startProbing) {
      this.timer = setInterval(() => void this.probeTick(), opts.probeIntervalMs ?? 2000)
      void this.probeTick()
    }
  }

  private async probeBackend(id: HaBackendId): Promise<boolean> {
    const b = this.opts[id]
    const url = `${b.baseUrl.replace(/\/$/, '')}/${(this.opts.healthPath ?? 'healthz').replace(/^\//, '')}`
    const ok = await this.probedFetch(url, DEFAULT_TIMEOUT_MS)
    this.lastProbe = new Date().toISOString()
    if (ok !== this.healthy[id]) this.log(`backend ${id} (${b.label}) ${ok ? 'healthy' : 'unhealthy'}`)
    this.healthy[id] = ok
    return ok
  }

  /** Advance the health state machine. Returns the active backend after this tick. */
  async probeTick(): Promise<HaBackendId> {
    const primaryOk = await this.probeBackend('primary')
    // Always probe secondary too, so /ha-status shows both states.
    const secondaryOk = await this.probeBackend('secondary')

    if (this.active === 'primary') {
      if (primaryOk) {
        this.failCount = 0
        return 'primary'
      }
      this.failCount += 1
      if (this.failCount >= (this.opts.failThreshold ?? 3)) {
        // Switch only when the secondary is reachable; otherwise stay and
        // keep reporting the error to clients via the backend's own 5xx.
        if (secondaryOk) {
          this.switchTo('secondary')
        }
      }
    } else {
      if (secondaryOk) {
        this.recoverCount += 1
        if (primaryOk && this.recoverCount >= (this.opts.recoverThreshold ?? 2)) {
          this.switchTo('primary')
          this.recoverCount = 0
        }
      } else {
        this.recoverCount = 0
        // Secondary dead: fall back to primary if it looks alive; otherwise
        // stay on secondary (its errors surface to clients).
        if (primaryOk) this.switchTo('primary')
      }
    }
    return this.active
  }

  private switchTo(id: HaBackendId): void {
    if (this.active === id) return
    this.active = id
    this.failoverCount += 1
    this.switchedAt = new Date().toISOString()
    this.failCount = 0
    this.recoverCount = 0
    this.log(`switching to ${id} backend (failover #${this.failoverCount})`)
  }

  status(): HaProxyStatus {
    return {
      active: this.active,
      backends: {
        primary: { ...this.opts.primary, healthy: this.healthy.primary },
        secondary: { ...this.opts.secondary, healthy: this.healthy.secondary },
      },
      failoverCount: this.failoverCount,
      switchedAt: this.switchedAt,
      lastProbe: this.lastProbe,
    }
  }

  /**
   * Forward one request to the active backend. Only the MCP surface is
   * proxied: POST /mcp (JSON-RPC, session-id header pass-through), plus
   * GET /healthz and /readyz. Anything else → 404.
   */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    if (path !== '/mcp' && path !== '/healthz' && path !== '/readyz') {
      return new Response(JSON.stringify({ error: 'ha-proxy: not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    const backend = this.opts[this.active]
    const target = `${backend.baseUrl.replace(/\/$/, '')}${path}`
    const headers = new Headers(req.headers)
    headers.delete('host')
    try {
      const res = await this.forwardFetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' ? undefined : await req.text(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      })
      const outHeaders = new Headers()
      for (const [k, v] of res.headers) {
        // Keep only end-to-end headers relevant for MCP JSON responses.
        if (k === 'content-type' || k === 'mcp-session-id' || k === 'content-length') outHeaders.set(k, v)
      }
      const text = await res.text()
      return new Response(text, { status: res.status, headers: outHeaders })
    } catch (err) {
      this.log(`forward to ${backend.label} failed: ${String(err)}`)
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: `ha-proxy: backend ${backend.id} unreachable` } }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** Parse an HTTP server request into a WHATWG Request for HaProxyController. */
export function toWebRequest(req: import('node:http').IncomingMessage): Promise<Request> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const h = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') h.set(k, v)
        else if (Array.isArray(v)) for (const x of v) h.append(k, x)
      }
      const init: RequestInit = { method: req.method, headers: h }
      if (req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0) init.body = body
      resolve(new Request(u, init))
    })
    req.on('error', reject)
  })
}