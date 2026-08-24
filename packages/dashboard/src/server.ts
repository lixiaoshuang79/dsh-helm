/**
 * Read-only control-plane dashboard: a single loopback HTTP server that
 * aggregates hub / tunnel / tailscale / service status for humans.
 * Deliberately dependency-light (node:http only) — no framework needed for
 * two routes and a static file.
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStatus, type DashboardStatus } from './status.js'

export const DEFAULT_DASHBOARD_PORT = 3480
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1'

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
 *   GET /api/status -> aggregated status JSON
 *   GET /           -> public/index.html (only whitelisted file, no traversal)
 * Everything else -> 404.
 */
export async function startDashboard(opts: DashboardServerOptions = {}): Promise<StartedDashboard> {
  const host = opts.host ?? DEFAULT_DASHBOARD_HOST
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT
  const statusFetcher = opts.statusFetcher ?? collectStatus

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`)
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const status = await statusFetcher()
        sendJson(res, 200, status)
        return
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
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
