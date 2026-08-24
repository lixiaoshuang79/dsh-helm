/**
 * Read-only control-plane dashboard: a single loopback HTTP server that
 * aggregates hub / tunnel / tailscale / service status for humans, plus the
 * device enrollment (pairing) API.
 *
 * Security:
 * - Binds 127.0.0.1 only (loopback).
 * - Every /api/pair* mutation requires `X-Dashboard-Token` — a random token
 *   generated at startup and injected into index.html at serve time. This
 *   defeats cross-site requests: a foreign origin cannot read the token
 *   (no CORS headers are emitted), so its preflight always fails.
 * - GET /api/status stays read-only and unauthenticated (no secrets).
 *
 * Pairing flows through the hub's own loopback endpoints (GET /pair/new,
 * GET /pair/list on :3471); this server never holds pairing codes itself.
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStatus, type DashboardStatus } from './status.js'
import { buildJoinTip, fetchHubPairCode, fetchHubPairList, type HubPairListEntry } from './pair.js'
import { DEFAULT_HUB_URL } from './hub.js'
import { fetchMcpMetrics } from './metrics.js'

export const DEFAULT_DASHBOARD_PORT = 3480
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1'

/** Marker replaced with the runtime dashboard token when serving index.html. */
export const DASHBOARD_TOKEN_MARKER = '__DSH_DASHBOARD_TOKEN__'

/**
 * Resolved relative to this module: `src/../public` in dev (vitest) and
 * `lib/../public` in the built package — both point at packages/dashboard/public.
 */
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url))

export interface DashboardServerOptions {
  port?: number
  host?: string
  /** Injectable status source (tests inject a fake; defaults to collectStatus). */
  statusFetcher?: () => Promise<DashboardStatus>
  /** Hub HTTP origin for pairing endpoints (default http://127.0.0.1:3471). */
  pairHubUrl?: string
  /** Hub HTTP origin for the /api/metrics proxy (default: DEFAULT_HUB_URL). */
  metricsHubUrl?: string
  /** Injectable tailscale IPv4 source for the join tip (default: platform probe). */
  tailscaleIpFetcher?: () => Promise<string | null>
  /** Fixed dashboard token (tests); default: random 16 bytes hex. */
  dashboardToken?: string
}

export interface StartedDashboard {
  server: http.Server
  port: number
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/**
 * Start the dashboard HTTP server. Routes:
 *   GET  /api/status        -> aggregated status JSON (read-only)
 *   GET  /api/metrics       -> hub MCP metrics proxy (read-only; failure becomes { error } body)
 *   POST /api/pair          -> { code, expiresAt, tip } (X-Dashboard-Token)
 *   GET  /api/pair/status   -> { codes: [...] } (X-Dashboard-Token)
 *   OPTIONS /api/pair*      -> 204 preflight (no CORS headers: same-origin only)
 *   GET  /                  -> public/index.html (only whitelisted file, no traversal)
 * Everything else -> 404.
 */
export async function startDashboard(opts: DashboardServerOptions = {}): Promise<StartedDashboard> {
  const host = opts.host ?? DEFAULT_DASHBOARD_HOST
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT
  const statusFetcher = opts.statusFetcher ?? collectStatus
  const pairHubUrl = opts.pairHubUrl ?? 'http://127.0.0.1:3471'
  const metricsHubUrl = opts.metricsHubUrl ?? DEFAULT_HUB_URL
  const tailscaleIpFetcher = opts.tailscaleIpFetcher
  const dashboardToken = opts.dashboardToken ?? randomBytes(16).toString('hex')

  const authorized = (req: http.IncomingMessage): boolean => req.headers['x-dashboard-token'] === dashboardToken

  const serveIndex = async (res: http.ServerResponse): Promise<void> => {
    let html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    // Server-side token injection: the page needs the token for /api/pair*.
    // Split/replace so every occurrence of the marker becomes the token.
    if (html.includes(DASHBOARD_TOKEN_MARKER)) {
      html = html.split(DASHBOARD_TOKEN_MARKER).join(dashboardToken)
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`)
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const status = await statusFetcher()
        sendJson(res, 200, status)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/metrics') {
        // 只读代理：转发 hub 的 GET /metrics。探测容错（hub 未就绪时
        // fetchMcpMetrics 返回 { error }）不转为 5xx——与 /api/status
        // 的「分区错误」语义一致，前端按错误行渲染。
        const metrics = await fetchMcpMetrics(metricsHubUrl)
        sendJson(res, 200, metrics)
        return
      }
      if (url.pathname.startsWith('/api/pair')) {
        // Cross-origin preflight: browsers MUST preflight because of the
        // custom header; we emit no access-control-allow-origin, so any
        // cross-origin caller (which cannot read the token) is blocked.
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-methods': 'POST, GET, OPTIONS',
            'access-control-allow-headers': 'content-type, x-dashboard-token',
            'access-control-max-age': '600',
          })
          res.end()
          return
        }
        if (!authorized(req)) {
          sendJson(res, 401, { error: 'missing or invalid X-Dashboard-Token' })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/pair') {
          const pair = await fetchHubPairCode(pairHubUrl)
          const tip = await buildJoinTip(pair.code, tailscaleIpFetcher)
          sendJson(res, 200, { ...pair, tip })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/pair/status') {
          const codes: HubPairListEntry[] = await fetchHubPairList(pairHubUrl)
          sendJson(res, 200, { codes })
          return
        }
        sendJson(res, 404, { error: 'not found' })
        return
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        await serveIndex(res)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`internal error: ${msg}`)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port
  console.log(`dsh-helm dashboard listening on http://${host}:${actualPort}`)
  return { server, port: actualPort }
}
