import { describe, expect, it } from 'vitest'
import { McpLocalHelmBackend, readTokenFile, defaultHelmTokenFile } from '../src/bridge.js'
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Fake daemon: minimal MCP streamable HTTP server over a fake fetch.
 * Responds to initialize / tools/list / tools/call with session-id management.
 * `restartAtCall` simulates a daemon restart: from that fetch count onward the
 * in-memory session registry is empty, so any request carrying a stale
 * `Mcp-Session-Id` (except initialize) gets 404 unknown MCP session, while a
 * fresh initialize issues a brand-new session id.
 */
function fakeDaemon(opts: { failTool?: string; status?: number; requireAuth?: boolean; restartAtCall?: number } = {}) {
  const calls: Array<{ method: string; params: unknown; auth?: string }> = []
  let sessionId: string | undefined
  let callCount = 0
  /** Daemon-side in-memory session registry (lost on restart). */
  let registry: Record<string, boolean> = {}
  /** One-shot restart flag (stays true after the simulated restart). */
  let restarted = false
  const fetchImpl = async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    const body = JSON.parse(init.body ?? '{}')
    const auth = init.headers?.['Authorization'] ?? init.headers?.['authorization']
    calls.push({ method: body.method, params: body.params, auth })
    callCount++
    if (opts.restartAtCall && !restarted && callCount >= opts.restartAtCall) {
      // One daemon restart: in-memory registry AND all issued session ids are lost.
      restarted = true
      registry = {}
      sessionId = undefined
    }
    if (opts.requireAuth && !auth) {
      return new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } })
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (!sessionId && body.method === 'initialize') {
      sessionId = `sess-${callCount}`
      registry[sessionId] = true
      headers['mcp-session-id'] = sessionId
    }
    const mcpSid = init.headers?.['Mcp-Session-Id'] ?? init.headers?.['mcp-session-id']
    if (mcpSid && !registry[mcpSid] && body.method !== 'initialize') {
      // Stale session id after a restart: 404 like the real daemon, no new id in the response.
      return new Response(JSON.stringify({ error: 'unknown MCP session' }), { status: 404, headers: { 'content-type': 'application/json' } })
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
        } else if (name === 'supervisor_health') {
          result = { structuredContent: { status: 'ok', serena: { connected: true } } }
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

describe('McpLocalHelmBackend (LocalHelmBackend default)', () => {
  it('connect performs initialize and stores server info + session id', async () => {
    const { fetchImpl } = fakeDaemon()
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    const info = await b.connect()
    expect(info.name).toBe('helm-daemon')
    expect(b.connected).toBe(true)
  })

  it('sends Bearer token on every request', async () => {
    const { fetchImpl, calls } = fakeDaemon({ requireAuth: true })
    const b = new McpLocalHelmBackend({ token: 'secret-tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    const info = await b.connect()
    expect(info.name).toBe('helm-daemon')
    expect(calls[0]!.auth).toBe('Bearer secret-tok')
  })

  it('rejects with 401 when auth missing and daemon requires it', async () => {
    const { fetchImpl } = fakeDaemon({ requireAuth: true })
    const b = new McpLocalHelmBackend({ token: '', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(b.connect()).rejects.toThrow(/401/)
  })

  it('reads token from the local token file when token omitted (never argv/log)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-tok-'))
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'file-secret\n', { mode: 0o600 })
    try {
      const { fetchImpl, calls } = fakeDaemon({ requireAuth: true })
      const b = new McpLocalHelmBackend({ tokenFile, fetchImpl: fetchImpl as unknown as typeof fetch })
      await b.connect().catch(() => {})
      expect(calls[0]!.auth).toBe('Bearer file-secret')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('calls tools and returns structuredContent', async () => {
    const { fetchImpl, calls } = fakeDaemon()
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    const res = await b.callTool('sessions_list', {})
    expect(res.structuredContent).toEqual({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    expect(calls.some((c) => c.method === 'tools/call')).toBe(true)
  })

  it('throws on isError tool results', async () => {
    const { fetchImpl } = fakeDaemon({ failTool: 'sessions_create' })
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    await expect(b.callTool('sessions_create', {})).rejects.toThrow(/boom/)
  })

  it('re-establishes the MCP session after a daemon restart (404 unknown MCP session)', async () => {
    // Daemon restarts after the 3rd fetch (initialize + one call + one call).
    const { fetchImpl, calls } = fakeDaemon({ restartAtCall: 3 })
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    // Both calls succeed transparently: the first 404 triggers a fresh
    // initialize and the original call is retried on the new session.
    const res = await b.callTool('sessions_list', {})
    expect(res.structuredContent).toEqual({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    // Two initialize handshakes happened: the original and the re-establishment.
    expect(calls.filter((c) => c.method === 'initialize')).toHaveLength(2)
    // The retried call carried the new session id (sess-3+), not the stale one.
    expect(b.connected).toBe(true)
  })

  it('recovery is shared: concurrent calls after a restart re-establish only once', async () => {
    const { fetchImpl, calls } = fakeDaemon({ restartAtCall: 3 })
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    const [a, c] = await Promise.all([b.callTool('sessions_list', {}), b.callTool('sessions_list', {})])
    expect(a.structuredContent).toEqual({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    expect(c.structuredContent).toEqual({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    // initialize twice: original session + one shared re-establishment.
    expect(calls.filter((c) => c.method === 'initialize')).toHaveLength(2)
  })

  it('throws when daemon is unreachable', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3457')
    }
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(b.connect()).rejects.toThrow(/unreachable/)
  })

  it('lists tools dynamically', async () => {
    const { fetchImpl } = fakeDaemon()
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    const tools = await b.listTools()
    expect(tools.map((t) => t.name)).toContain('sessions_list')
  })

  it('probeHealth maps supervisor_health into structured {ok, detail}', async () => {
    const { fetchImpl } = fakeDaemon()
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    expect(await b.probeHealth()).toEqual({ ok: true })
  })

  it('probeHealth reports failure when daemon down', async () => {
    const { fetchImpl } = fakeDaemon({ failTool: 'supervisor_health' })
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    const h = await b.probeHealth()
    expect(h.ok).toBe(false)
    expect(h.detail).toContain('boom')
  })

  it('reconcile returns structured sessions/workspaces', async () => {
    const { fetchImpl } = fakeDaemon()
    const b = new McpLocalHelmBackend({ token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch })
    await b.connect()
    const r = await b.reconcile()
    expect(r.sessions).toHaveLength(1)
    expect(r.workspaces).toEqual([])
  })

  it('readTokenFile trims; missing file returns empty string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-tok-'))
    try {
      const f = join(dir, 'token')
      writeFileSync(f, '  abc  \n')
      expect(readTokenFile(f)).toBe('abc')
      expect(readTokenFile(join(dir, 'missing'))).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('default token file prefers ~/.agent-helm/token (agent-helm >=0.1.2), falls back to legacy path', () => {
    const realHome = process.env.HOME
    const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-helm-token-'))
    const legacy = join(fakeHome, '.agent-chatgpt-helm', 'token')
    const modern = join(fakeHome, '.agent-helm', 'token')
    try {
      process.env.HOME = fakeHome
      // Neither exists: returns modern path as default candidate.
      expect(defaultHelmTokenFile()).toBe(modern)
      // Legacy exists only: returns legacy path.
      mkdirSync(join(fakeHome, '.agent-chatgpt-helm'), { recursive: true })
      writeFileSync(legacy, 'legacy-token\n', { mode: 0o600 })
      expect(defaultHelmTokenFile()).toBe(legacy)
      // Both exist: prefers modern path.
      mkdirSync(join(fakeHome, '.agent-helm'), { recursive: true })
      writeFileSync(modern, 'modern-token\n', { mode: 0o600 })
      expect(defaultHelmTokenFile()).toBe(modern)
    } finally {
      process.env.HOME = realHome
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})