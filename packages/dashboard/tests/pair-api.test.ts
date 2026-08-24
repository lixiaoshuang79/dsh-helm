import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import { startDashboard, DASHBOARD_TOKEN_MARKER } from '../src/server.js'

const TEST_TOKEN = 'test-dashboard-token-0123456789abcdef'

/** Minimal fake hub serving the loopback pairing endpoints. */
function fakeHub(): { server: Server; port: Promise<number>; hits: string[] } {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    if (req.method === 'GET' && req.url === '/pair/new') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'dshp-0123456789abcdefghij', expiresAt: '2026-08-24T13:00:00.000Z' }))
      return
    }
    if (req.method === 'GET' && req.url === '/pair/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ codes: [{ codeHashPrefix: 'abcdef12', status: 'pending', createdAt: '2026-08-24T12:00:00.000Z', expiresAt: '2026-08-24T12:10:00.000Z' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const port = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  return { server, port, hits }
}

const servers: Server[] = []
const hubs: Server[] = []

function trackDash(opts: Parameters<typeof startDashboard>[0]) {
  return startDashboard(opts).then((started) => {
    servers.push(started.server)
    return started
  })
}

afterEach(async () => {
  await Promise.all(
    [...servers.splice(0), ...hubs.splice(0)].map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
})

describe('dashboard pairing API', () => {
  it('POST /api/pair requires X-Dashboard-Token (401 without)', async () => {
    const hub = fakeHub()
    hubs.push(hub.server)
    const hubPort = await hub.port
    const { port } = await trackDash({ port: 0, dashboardToken: TEST_TOKEN, pairHubUrl: `http://127.0.0.1:${hubPort}` })

    const res = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(hub.hits).toHaveLength(0) // hub never reached without a token
  })

  it('POST /api/pair with the token proxies the hub and adds a join tip', async () => {
    const hub = fakeHub()
    hubs.push(hub.server)
    const hubPort = await hub.port
    const { port } = await trackDash({
      port: 0,
      statusFetcher: async () => ({}) as never,
      dashboardToken: TEST_TOKEN,
      pairHubUrl: `http://127.0.0.1:${hubPort}`,
      tailscaleIpFetcher: async () => '100.64.0.1',
    })

    const res = await fetch(`http://127.0.0.1:${port}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-token': TEST_TOKEN },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { code: string; expiresAt: string; tip: string }
    expect(body.code).toBe('dshp-0123456789abcdefghij')
    expect(body.expiresAt).toBe('2026-08-24T13:00:00.000Z')
    expect(body.tip).toBe('dsh-helm join --control-plane ws://100.64.0.1:3470 --code dshp-0123456789abcdefghij')
    expect(hub.hits).toEqual(['GET /pair/new'])
  })

  it('OPTIONS /api/pair returns 204 without CORS origin (same-origin only)', async () => {
    const hub = fakeHub()
    hubs.push(hub.server)
    const hubPort = await hub.port
    const { port } = await trackDash({ port: 0, dashboardToken: TEST_TOKEN, pairHubUrl: `http://127.0.0.1:${hubPort}` })

    const res = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-headers')).toContain('x-dashboard-token')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('GET /api/pair/status requires the token and proxies the hub list', async () => {
    const hub = fakeHub()
    hubs.push(hub.server)
    const hubPort = await hub.port
    const { port } = await trackDash({ port: 0, dashboardToken: TEST_TOKEN, pairHubUrl: `http://127.0.0.1:${hubPort}` })

    const denied = await fetch(`http://127.0.0.1:${port}/api/pair/status`)
    expect(denied.status).toBe(401)

    const res = await fetch(`http://127.0.0.1:${port}/api/pair/status`, { headers: { 'x-dashboard-token': TEST_TOKEN } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { codes: Array<{ codeHashPrefix: string; status: string }> }
    expect(body.codes).toHaveLength(1)
    expect(body.codes[0]).toMatchObject({ codeHashPrefix: 'abcdef12', status: 'pending' })
    expect(hub.hits).toEqual(['GET /pair/list'])
  })

  it('serves index.html with the injected dashboard token (marker replaced)', async () => {
    const hub = fakeHub()
    hubs.push(hub.server)
    const hubPort = await hub.port
    const { port } = await trackDash({ port: 0, dashboardToken: TEST_TOKEN, pairHubUrl: `http://127.0.0.1:${hubPort}` })

    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('dsh-helm Control Plane Dashboard')
    expect(html).toContain('新增 DSH 设备')
    expect(html).toContain(TEST_TOKEN)
    expect(html).not.toContain(DASHBOARD_TOKEN_MARKER)
  })

  it('returns 500 when the hub pairing endpoint is unreachable', async () => {
    const { port } = await trackDash({ port: 0, dashboardToken: TEST_TOKEN, pairHubUrl: 'http://127.0.0.1:1' })
    const res = await fetch(`http://127.0.0.1:${port}/api/pair`, {
      method: 'POST',
      headers: { 'x-dashboard-token': TEST_TOKEN },
      body: '{}',
    })
    expect(res.status).toBe(500)
  })
})