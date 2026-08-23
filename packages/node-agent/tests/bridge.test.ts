import { describe, expect, it } from 'vitest'
import { LocalDshBridge } from '../src/bridge.js'

/**
 * Fake daemon: minimal MCP streamable HTTP server over a fake fetch.
 * Responds to initialize / tools/call with session-id management.
 */
function fakeDaemon(opts: { failTool?: string; status?: number } = {}) {
  const calls: Array<{ method: string; params: unknown }> = []
  let sessionId: string | undefined
  const fetchImpl = async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    const body = JSON.parse(init.body ?? '{}')
    calls.push({ method: body.method, params: body.params })
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (!sessionId) {
      sessionId = 'sess-123'
      headers['mcp-session-id'] = sessionId
    }
    if (opts.status && opts.status >= 400) {
      return new Response('daemon error', { status: opts.status, headers })
    }
    let result: unknown
    switch (body.method) {
      case 'initialize':
        result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'helm-daemon', version: '0.1.1' } }
        break
      case 'tools/list':
        result = { tools: [{ name: 'sessions_list', description: 'x' }] }
        break
      case 'tools/call': {
        const name = body.params.name
        if (name === opts.failTool) {
          result = { content: [{ type: 'text', text: 'boom' }], isError: true }
        } else if (name === 'sessions_list') {
          result = { structuredContent: { sessions: [{ session_id: 's-1', status: 'idle', live: false }] } }
        } else {
          result = { structuredContent: { ok: true } }
        }
        break
      }
      default:
        result = {}
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers })
  }
  return { fetchImpl, calls }
}

describe('LocalDshBridge', () => {
  it('connect performs initialize and stores server info + session id', async () => {
    const { fetchImpl } = fakeDaemon()
    const b = new LocalDshBridge({ url: 'http://127.0.0.1:3457/mcp', token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    const info = await b.connect()
    expect(info.name).toBe('helm-daemon')
    expect(b.connected).toBe(true)
  })

  it('rejects missing bearer token with 401 from daemon', async () => {
    const { fetchImpl } = fakeDaemon({ status: 401 })
    const b = new LocalDshBridge({ url: 'http://127.0.0.1:3457/mcp', token: 'bad', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(b.connect()).rejects.toThrow(/401/)
  })

  it('calls tools and returns structuredContent', async () => {
    const { fetchImpl, calls } = fakeDaemon()
    const b = new LocalDshBridge({ url: 'http://127.0.0.1:3457/mcp', token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    const res = await b.callTool('sessions_list', {})
    expect(res.structuredContent).toEqual({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    expect(calls.some((c) => c.method === 'tools/call')).toBe(true)
  })

  it('throws on isError tool results', async () => {
    const { fetchImpl } = fakeDaemon({ failTool: 'sessions_create' })
    const b = new LocalDshBridge({ url: 'http://127.0.0.1:3457/mcp', token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    await expect(b.callTool('sessions_create', {})).rejects.toThrow(/boom/)
  })

  it('throws when daemon is unreachable', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3457')
    }
    const b = new LocalDshBridge({ url: 'http://127.0.0.1:3457/mcp', token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(b.connect()).rejects.toThrow(/unreachable/)
  })

  it('lists tools', async () => {
    const { fetchImpl } = fakeDaemon()
    const b = new LocalDshBridge({ url: 'http://127.0.0.1:3457/mcp', token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    const tools = await b.listTools()
    expect(tools.map((t) => t.name)).toContain('sessions_list')
  })
})