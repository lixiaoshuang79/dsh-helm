import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { AddressInfo } from 'node:net'
import { fetchHubStatus } from '../src/hub.js'

const FIXTURE_NODES = [
  {
    node_id: 'node_aaaaaaaa11112222',
    display_name: '控制面节点 A',
    platform: { os: 'darwin', arch: 'arm64', release: '24.0.0', nodeVersion: 'v22.22.1' },
    versions: { agent: '0.1.0', protocol: '1.0' },
    capabilities: { sessions: true, serena: true, presenceProvider: 'manual', defaultNode: true },
    status: 'ok',
    connected: true,
    last_seen: '2026-08-24T00:00:00.000Z',
  },
  {
    node_id: 'node_bbbbbbbb33334444',
    display_name: '控制面节点 B',
    platform: { os: 'linux', arch: 'x64', release: '6.6.0', nodeVersion: 'v22.10.0' },
    versions: { agent: '0.1.0', protocol: '1.0' },
    capabilities: { sessions: true, serena: false, tunnel: false, presenceProvider: 'hub', defaultNode: false },
    status: 'degraded',
    connected: false,
    last_seen: '2026-08-23T20:00:00.000Z',
  },
]

interface MockRecord {
  path: string | undefined
  method: string | undefined
  headers: IncomingMessage['headers']
  body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null
}

interface MockHub {
  server: Server
  port: number
  records: MockRecord[]
  close: () => Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function startMockHub(opts: {
  failHealthz?: boolean
  failInitialize?: boolean
  failNodes?: boolean
  nodesError?: boolean
} = {}): Promise<MockHub> {
  const records: MockRecord[] = []
  const server = createServer(async (req, res) => {
    const bodyText = req.method === 'POST' ? await readBody(req) : ''
    let body: MockRecord['body'] = null
    try {
      body = bodyText ? (JSON.parse(bodyText) as MockRecord['body']) : null
    } catch {
      body = null
    }
    records.push({ path: req.url, method: req.method, headers: req.headers, body })
    if (req.method === 'GET' && req.url === '/healthz') {
      if (opts.failHealthz) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, nodes: FIXTURE_NODES.length }))
      return
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      const call = (body ?? {}) as { method?: string; id?: number }
      if (call.method === 'initialize') {
        if (opts.failInitialize) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'boom' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session-1' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: call.id,
            result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dsh-helm-hub', version: '0.1.0' } },
          }),
        )
        return
      }
      if (call.method?.startsWith('notifications/')) {
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end()
        return
      }
      if (call.method === 'tools/call') {
        if (opts.failNodes) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'boom' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        const result = opts.nodesError
          ? { content: [{ type: 'text', text: 'error: nodes_store failed' }], isError: true }
          : { content: [{ type: 'text', text: JSON.stringify({ nodes: FIXTURE_NODES }, null, 2) }] }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
        return
      }
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'method not found' } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    port,
    records,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const hubs: MockHub[] = []

function track(h: MockHub): MockHub {
  hubs.push(h)
  return h
}

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.close()))
})

describe('fetchHubStatus', () => {
  it('parses healthz + initialize + nodes_list into a full status', async () => {
    const hub = track(await startMockHub())
    const status = await fetchHubStatus(`http://127.0.0.1:${hub.port}`)
    expect(status.hubOk).toBe(true)
    expect(status.error).toBeUndefined()
    expect(status.nodeCount).toBe(2)
    expect(status.nodes).toHaveLength(2)
    const [a, b] = status.nodes
    expect(a.node_id).toBe('node_aaaaaaaa11112222')
    expect(a.display_name).toBe('控制面节点 A')
    expect(a.platform).toEqual({ os: 'darwin', arch: 'arm64', release: '24.0.0', nodeVersion: 'v22.22.1' })
    expect(a.versions).toEqual({ agent: '0.1.0', protocol: '1.0' })
    expect(a.capabilities).toEqual({ sessions: true, serena: true, presenceProvider: 'manual', defaultNode: true })
    expect(a.connected).toBe(true)
    expect(a.last_seen).toBe('2026-08-24T00:00:00.000Z')
    expect(b.connected).toBe(false)
  })

  it('sends the mcp-session-id header on tools/call', async () => {
    const hub = track(await startMockHub())
    await fetchHubStatus(`http://127.0.0.1:${hub.port}`)
    const calls = hub.records.filter((r) => r.body?.method === 'tools/call')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers['mcp-session-id']).toBe('test-session-1')
    expect(calls[0]?.body?.params?.name).toBe('nodes_list')
  })

  it('returns hubOk:false with a clear error when healthz fails', async () => {
    const hub = track(await startMockHub({ failHealthz: true }))
    const status = await fetchHubStatus(`http://127.0.0.1:${hub.port}`)
    expect(status.hubOk).toBe(false)
    expect(status.nodeCount).toBe(0)
    expect(status.error).toContain('healthz')
  })

  it('returns hubOk:false when initialize fails', async () => {
    const hub = track(await startMockHub({ failInitialize: true }))
    const status = await fetchHubStatus(`http://127.0.0.1:${hub.port}`)
    expect(status.hubOk).toBe(false)
    expect(status.error).toContain('initialize')
  })

  it('returns hubOk:false when nodes_list fails', async () => {
    const hub = track(await startMockHub({ failNodes: true }))
    const status = await fetchHubStatus(`http://127.0.0.1:${hub.port}`)
    expect(status.hubOk).toBe(false)
    expect(status.error).toContain('tools/call')
  })

  it('returns hubOk:false when the tool result is an error', async () => {
    const hub = track(await startMockHub({ nodesError: true }))
    const status = await fetchHubStatus(`http://127.0.0.1:${hub.port}`)
    expect(status.hubOk).toBe(false)
    expect(status.error).toBeTruthy()
  })

  it('does not throw when the hub is unreachable', async () => {
    const hub = track(await startMockHub())
    await hub.close()
    const status = await fetchHubStatus(`http://127.0.0.1:${hub.port}`, 1000)
    expect(status.hubOk).toBe(false)
    expect(status.error).toBeTruthy()
  })
})