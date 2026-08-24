import { describe, expect, it } from 'vitest'
import { HaProxyController, type HaBackend } from '../src/ha-proxy.js'
import { parseHaProxyArgs } from '../src/ha-proxy-cli.js'
import { parseArgs } from '../src/cli.js'

const PRIMARY: HaBackend = { id: 'primary', label: 'local', baseUrl: 'http://127.0.0.1:13471' }
const SECONDARY: HaBackend = { id: 'secondary', label: 'remote', baseUrl: 'http://10.0.0.2:3471' }

function fakeFetch(ok: boolean, body = '{"ok":true}', extraHeaders: Record<string, string> = {}): typeof fetch {
  return (async (_input: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders }
    const res = new Response(body, { status: ok ? 200 : 502, headers })
    return res
  }) as typeof fetch
}

function makeProxy(opts: { primaryOk?: boolean; secondaryOk?: boolean; fetchImpl?: typeof fetch } = {}) {
  const primaryOk = opts.primaryOk ?? true
  const secondaryOk = opts.secondaryOk ?? true
  const probe = async (url: string) => {
    if (url.includes('13471')) return primaryOk
    return secondaryOk
  }
  const proxy = new HaProxyController(
    {
      primary: PRIMARY,
      secondary: SECONDARY,
      probe,
      fetchImpl: opts.fetchImpl ?? fakeFetch(true, '{"ok":true}', { 'mcp-session-id': 'hub-abc123' }),
      probeIntervalMs: 60000,
    },
    false,
  )
  return proxy
}

describe('HaProxyController', () => {
  it('starts on primary when both healthy', async () => {
    const p = makeProxy()
    await p.probeTick()
    expect(p.status().active).toBe('primary')
    expect(p.status().backends.primary.healthy).toBe(true)
    p.close()
  })

  it('switches to secondary after failThreshold consecutive primary failures', async () => {
    const p = makeProxy({ primaryOk: false, secondaryOk: true })
    await p.probeTick() // fail 1
    expect(p.status().active).toBe('primary')
    await p.probeTick() // fail 2
    expect(p.status().active).toBe('primary')
    await p.probeTick() // fail 3 → switch
    expect(p.status().active).toBe('secondary')
    expect(p.status().failoverCount).toBe(1)
    expect(p.status().switchedAt).not.toBeNull()
    p.close()
  })

  it('switches back to primary after recovery', async () => {
    let primaryOk = false
    const probe = async (url: string) => (url.includes('13471') ? primaryOk : true)
    const p = new HaProxyController({ primary: PRIMARY, secondary: SECONDARY, probe, probeIntervalMs: 60000, recoverThreshold: 2 }, false)
    await p.probeTick()
    await p.probeTick()
    await p.probeTick()
    expect(p.status().active).toBe('secondary')
    primaryOk = true
    await p.probeTick() // recover 1
    expect(p.status().active).toBe('secondary')
    await p.probeTick() // recover 2 → back
    expect(p.status().active).toBe('primary')
    p.close()
  })

  it('does not switch when secondary is also down', async () => {
    const p = makeProxy({ primaryOk: false, secondaryOk: false })
    for (let i = 0; i < 5; i++) await p.probeTick()
    expect(p.status().active).toBe('primary')
    p.close()
  })

  it('forwards /mcp to the active backend with session header pass-through', async () => {
    const p = makeProxy()
    await p.probeTick()
    const req = new Request('http://127.0.0.1:3481/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'hub-abc123' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nodes_list', arguments: {} } }),
    })
    const out = await p.handle(req)
    expect(out.status).toBe(200)
    const text = await out.text()
    expect(text).toContain('ok')
    // Response keeps MCP session header of the backend.
    expect(out.headers.get('mcp-session-id')).toBe('hub-abc123')
    p.close()
  })

  it('returns 502 when the active backend fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const p = new HaProxyController(
      { primary: PRIMARY, secondary: SECONDARY, probe: async () => true, fetchImpl, probeIntervalMs: 60000 },
      false,
    )
    const req = new Request('http://127.0.0.1:3481/mcp', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    const out = await p.handle(req)
    expect(out.status).toBe(502)
    p.close()
  })

  it('404s non-MCP paths', async () => {
    const p = makeProxy()
    const out = await p.handle(new Request('http://127.0.0.1:3481/other'))
    expect(out.status).toBe(404)
    p.close()
  })
})

describe('parseHaProxyArgs', () => {
  it('parses flags', () => {
    const args = parseHaProxyArgs(['--secondary', 'http://10.0.0.2:3471', '--port', '3482', '--fail-threshold', '2'])
    expect(args.secondaryUrl).toBe('http://10.0.0.2:3471')
    expect(args.port).toBe(3482)
    expect(args.failThreshold).toBe(2)
    expect(args.primaryUrl).toBe('http://127.0.0.1:3471')
  })
  it('defaults primary when absent', () => {
    const args = parseHaProxyArgs(['--secondary', 'http://10.0.0.2:3471'])
    expect(args.primaryUrl).toBe('http://127.0.0.1:3471')
  })
})

describe('cli registration', () => {
  it('parses ha-proxy command', () => {
    const parsed = parseArgs(['ha-proxy', '--secondary', 'http://10.0.0.2:3471'])
    expect(parsed.command).toBe('ha-proxy')
    expect(parsed.flags['secondary']).toBe('http://10.0.0.2:3471')
  })
})