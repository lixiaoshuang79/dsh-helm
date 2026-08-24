import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { startDashboard, type DashboardServerOptions } from '../src/server.js'
import type { DashboardStatus } from '../src/status.js'

function fakeStatus(overrides: Partial<DashboardStatus> = {}): DashboardStatus {
  return {
    generatedAt: '2026-08-24T12:00:00.000Z',
    role: { isHubHost: false, isNode: false },
    hub: { hubOk: false, nodeCount: 0, nodes: [], error: 'no hub' },
    tunnel: {
      running: false,
      ready: false,
      live: false,
      version: null,
      tunnelIdRedacted: null,
      mcpTargetUrl: null,
      workspaceBinding: 'NEED_MANUAL_CHECK',
    },
    tailscale: { installed: false },
    services: [],
    self: { hostname: 'test-host', platform: 'darwin' },
    ...overrides,
  }
}

const servers: Server[] = []

function track(opts: DashboardServerOptions) {
  return startDashboard(opts).then((started) => {
    servers.push(started.server)
    return started
  })
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
})

describe('startDashboard', () => {
  it('serves /api/status as JSON with generatedAt via the injected fetcher', async () => {
    const calls: string[] = []
    const { port } = await track({
      port: 0,
      host: '127.0.0.1',
      statusFetcher: async () => {
        calls.push('fetched')
        return fakeStatus({ role: { isHubHost: true, isNode: true, displayName: '测试节点' } })
      },
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/status`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as DashboardStatus
    expect(body.generatedAt).toBe('2026-08-24T12:00:00.000Z')
    expect(body.role.isHubHost).toBe(true)
    expect(body.role.isNode).toBe(true)
    expect(calls).toEqual(['fetched'])
  })

  it('serves the dashboard page at /', async () => {
    const { port } = await track({ port: 0, statusFetcher: async () => fakeStatus() })
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('dsh-helm Control Plane Dashboard')
    expect(html).toContain('只读控制台')
  })

  it('rejects paths outside the index.html whitelist', async () => {
    const { port } = await track({ port: 0, statusFetcher: async () => fakeStatus() })
    for (const p of ['/etc/passwd', '/../secret', '/favicon.ico', '/api/other']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`)
      expect(res.status, `path ${p}`).toBe(404)
    }
  })

  it('binds to 127.0.0.1 by default and returns the actual port', async () => {
    const { server, port } = await track({ port: 0, statusFetcher: async () => fakeStatus() })
    expect(port).toBeGreaterThan(0)
    expect(server.address()).toMatchObject({ address: '127.0.0.1' })
  })

  it('returns 500 when the status fetcher throws', async () => {
    const { port } = await track({
      port: 0,
      statusFetcher: async () => {
        throw new Error('boom')
      },
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/status`)
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('boom')
  })
})