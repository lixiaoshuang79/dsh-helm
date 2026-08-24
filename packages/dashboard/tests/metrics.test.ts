import { afterEach, describe, expect, it } from 'vitest'
import http, { type Server, type IncomingMessage } from 'node:http'
import { AddressInfo } from 'node:net'
import { fetchMcpMetrics } from '../src/metrics.js'
import { startDashboard } from '../src/server.js'

interface MockRecord {
  path: string | undefined
  response: string
  status: number
}

const servers: Server[] = []

/** Mock hub：按 path 匹配返回固定响应（参照 status.test.ts 的 startMockServer）。 */
function startMockServer(records: MockRecord[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req: IncomingMessage, res) => {
      const rec = records.find((r) => r.path === req.url)
      if (!rec) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(rec.status, { 'content-type': 'application/json' }).end(rec.response)
    })
    srv.on('error', reject)
    servers.push(srv)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

const METRICS_OK = JSON.stringify({
  status: 'ok',
  version: '0.1.0',
  uptimeMs: 1234567,
  requestCount: 42,
  avgResponseBytes: 1234,
  maxResponseBytes: 98765,
  truncationCount: 2,
  errorCount: 1,
  activeConnections: 3,
  perTool: [
    { tool: 'sessions_get', count: 10, avgBytes: 800, maxBytes: 1200, truncated: 0, errors: 0 },
    { tool: 'tools_call', count: 5, avgBytes: 3000, maxBytes: 98765, truncated: 2, errors: 1 },
  ],
})

afterEach(() => {
  while (servers.length) servers.pop()?.close()
})

describe('fetchMcpMetrics', () => {
  it('parses a healthy /metrics payload', async () => {
    const base = await startMockServer([{ path: '/metrics', response: METRICS_OK, status: 200 }])
    const m = await fetchMcpMetrics(base)
    expect(m.status).toBe('ok')
    expect(m.version).toBe('0.1.0')
    expect(m.uptimeMs).toBe(1234567)
    expect(m.requestCount).toBe(42)
    expect(m.avgResponseBytes).toBe(1234)
    expect(m.maxResponseBytes).toBe(98765)
    expect(m.truncationCount).toBe(2)
    expect(m.errorCount).toBe(1)
    expect(m.activeConnections).toBe(3)
    expect(m.perTool).toHaveLength(2)
    expect(m.perTool![0]).toMatchObject({ tool: 'sessions_get', count: 10, truncated: 0 })
    expect(m.perTool![1]).toMatchObject({ tool: 'tools_call', truncated: 2, errors: 1 })
    expect(m.error).toBeUndefined()
  })

  it('carries the degraded status through', async () => {
    const body = JSON.stringify({ status: 'degraded', requestCount: 0, perTool: [] })
    const base = await startMockServer([{ path: '/metrics', response: body, status: 200 }])
    const m = await fetchMcpMetrics(base)
    expect(m.status).toBe('degraded')
  })

  it('never throws on HTTP errors', async () => {
    const base = await startMockServer([{ path: '/metrics', response: 'oops', status: 500 }])
    const m = await fetchMcpMetrics(base)
    expect(m.error).toMatch(/metrics http 500/)
  })

  it('never throws when the endpoint is missing (old hub without /metrics)', async () => {
    const base = await startMockServer([{ path: '/healthz', response: '{"ok":true}', status: 200 }])
    const m = await fetchMcpMetrics(base)
    expect(m.error).toMatch(/404/)
  })

  it('never throws when the body is not JSON', async () => {
    const base = await startMockServer([{ path: '/metrics', response: 'not-json', status: 200 }])
    const m = await fetchMcpMetrics(base)
    expect(m.error).toMatch(/unreachable|JSON|json/i)
  })

  it('never throws when the hub is down', async () => {
    const m = await fetchMcpMetrics('http://127.0.0.1:1', 500)
    expect(m.error).toMatch(/unreachable/)
  })
})

describe('GET /api/metrics proxy', () => {
  /** 起一个只服务 /metrics 的 fake hub 和指向它的 dashboard server。 */
  async function startPair(hubMetrics: { status: number; body: string }) {
    const hubHits: string[] = []
    const hub = http.createServer((req, res) => {
      hubHits.push(`${req.method} ${req.url}`)
      res.writeHead(hubMetrics.status, { 'content-type': 'application/json' }).end(hubMetrics.body)
    })
    servers.push(hub)
    const hubPort = await new Promise<number>((resolve) => {
      hub.listen(0, '127.0.0.1', () => {
        const addr = hub.address()
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
      })
    })
    const dash = await startDashboard({
      port: 0,
      statusFetcher: async () => ({}) as never,
      metricsHubUrl: `http://127.0.0.1:${hubPort}`,
    })
    servers.push(dash.server)
    return { dash, hubHits }
  }

  it('proxies the hub /metrics payload (read-only, no token needed)', async () => {
    const { dash, hubHits } = await startPair({ status: 200, body: METRICS_OK })
    const res = await fetch(`http://127.0.0.1:${dash.port}/api/metrics`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; requestCount: number; perTool: Array<{ tool: string }> }
    expect(body.status).toBe('ok')
    expect(body.requestCount).toBe(42)
    expect(body.perTool).toHaveLength(2)
    expect(body.perTool[0].tool).toBe('sessions_get')
    expect(hubHits).toEqual(['GET /metrics'])
  })

  it('surfaces a hub failure as a 200 { error } body (per-section tolerance)', async () => {
    const { dash, hubHits } = await startPair({ status: 500, body: 'oops' })
    const res = await fetch(`http://127.0.0.1:${dash.port}/api/metrics`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toMatch(/metrics http 500/)
    expect(hubHits).toEqual(['GET /metrics'])
  })

  it('returns 200 { error } when the hub is unreachable', async () => {
    const dash = await startDashboard({ port: 0, metricsHubUrl: 'http://127.0.0.1:1' })
    servers.push(dash.server)
    const res = await fetch(`http://127.0.0.1:${dash.port}/api/metrics`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toMatch(/unreachable/)
  })
})
