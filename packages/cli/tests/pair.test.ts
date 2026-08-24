import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocketLike } from '@dsh-helm/node-agent'
import { parseArgs } from '../src/cli.js'
import { runJoin, runPair } from '../src/pair.js'

const CODE = 'dshp-0123456789abcdefghij'
const TOKEN = 'test-long-term-token-0123456789abcdef'
const WS_URL = 'ws://100.64.0.1:3470'

// ---- fake WebSocket (server side of the enrollment handshake) ----

interface ServeContext {
  helloNodeId?: string
  consumeParams?: Array<Record<string, unknown>>
  /** When set, enrollment.consume answers { ok: false, reason }. */
  failConsume?: string
}

function serveHub(ctx: ServeContext) {
  const rpc = (id: unknown, result: unknown): unknown => ({ type: 'rpc', v: 1, body: { jsonrpc: '2.0', id, result } })
  return (msg: unknown): unknown => {
    const m = msg as Record<string, unknown>
    if (m.type === 'hello') {
      ctx.helloNodeId = String(m.node_id)
      return { type: 'welcome', v: 1, hub_id: 'hub-test', schema_version: 1, heartbeat_ms: 15_000, lease_ms: 45_000 }
    }
    // Wire format: RPC frames ride the {type:'rpc', v, body} envelope.
    if (m.type === 'rpc' && m.body?.jsonrpc === '2.0' && m.body.method === 'enrollment.consume') {
      const body = m.body as { id: unknown; params?: unknown }
      const params = (body.params ?? {}) as Record<string, unknown>
      ctx.consumeParams = ctx.consumeParams ?? []
      ctx.consumeParams.push(params)
      if (ctx.failConsume) {
        return rpc(body.id, { ok: false, reason: ctx.failConsume })
      }
      return rpc(body.id, { ok: true, token: TOKEN })
    }
    return undefined
  }
}

class FakeSocket implements WebSocketLike {
  readyState = 1
  OPEN = 1
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  closed = false

  constructor(private serve: (msg: unknown) => unknown) {
    // simulate the socket opening shortly after construction
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.()
    })
  }

  send(data: string): void {
    const reply = this.serve(JSON.parse(data))
    if (reply !== undefined) this.onmessage?.({ data: JSON.stringify(reply) })
  }

  close(): void {
    this.closed = true
    this.onclose?.()
  }
}

function makeWsFactory(ctx: ServeContext) {
  return (_url: string): WebSocketLike => new FakeSocket(serveHub(ctx))
}

const tmpDirs: string[] = []

function tmpNodeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-pair-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const quietLog = (): void => {}

describe('parseArgs', () => {
  it('parses pair', () => {
    expect(parseArgs(['pair'])).toMatchObject({ command: 'pair', args: [] })
    expect(parseArgs(['pair', '--json']).flags['json']).toBe(true)
    expect(parseArgs(['pair', '--hub', 'http://127.0.0.1:9999']).flags['hub']).toBe('http://127.0.0.1:9999')
  })

  it('parses join with control-plane and code', () => {
    const a = parseArgs(['join', '--control-plane', WS_URL, '--code', CODE, '--force'])
    expect(a.command).toBe('join')
    expect(a.flags['control-plane']).toBe(WS_URL)
    expect(a.flags['code']).toBe(CODE)
    expect(a.flags['force']).toBe(true)
  })
})

describe('runPair', () => {
  it('prints the code and a join command template on success', async () => {
    const out: string[] = []
    const origLog = console.log
    console.log = (l: string) => out.push(l)
    try {
      const code = await runPair({
        hubUrl: 'http://127.0.0.1:3471',
        tailscaleIpFetcher: () => '100.64.0.1',
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: CODE, expiresAt: '2026-08-24T13:00:00.000Z' }) }) as never,
      })
      expect(code).toBe(0)
      expect(out.join('\n')).toContain(CODE)
      expect(out.join('\n')).toContain('dsh-helm join --control-plane ws://100.64.0.1:3470 --code ' + CODE)
    } finally {
      console.log = origLog
    }
  })

  it('supports --json output', async () => {
    const out: string[] = []
    const origLog = console.log
    console.log = (l: string) => out.push(l)
    try {
      const code = await runPair({
        json: true,
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: CODE, expiresAt: '2026-08-24T13:00:00.000Z' }) }) as never,
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(out.join('\n')) as { code: string }
      expect(parsed.code).toBe(CODE)
    } finally {
      console.log = origLog
    }
  })

  it('fails when the hub endpoint is unreachable or errors', async () => {
    const fail = await runPair({ fetchImpl: async () => {
      throw new Error('connection refused')
    } })
    expect(fail).toBe(1)
    const httpFail = await runPair({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) as never })
    expect(httpFail).toBe(1)
  })
})

describe('runJoin', () => {
  it('joins end-to-end: enroll handshake -> token -> node.json (0600) with correct call sequence', async () => {
    const ctx: ServeContext = {}
    const dir = tmpNodeDir()
    const lines: string[] = []
    const code = await runJoin({
      controlPlane: WS_URL,
      code: CODE,
      nodeDir: dir,
      wsFactory: makeWsFactory(ctx),
      tailscaleProbe: () => ({ installed: true, online: true, detail: 'test-host 100.64.0.1' }),
      log: (l) => lines.push(l),
    })
    expect(code).toBe(0)

    // ① hello used the unauthenticated enroll node_id prefix
    expect(ctx.helloNodeId).toMatch(/^enroll:[0-9a-f-]{36}$/)
    // ② consume carried the code + the freshly generated node_id + display_name
    expect(ctx.consumeParams).toHaveLength(1)
    expect(ctx.consumeParams![0]).toMatchObject({ code: CODE, display_name: hostname() })
    const nodeId = String(ctx.consumeParams![0]!.node_id)
    expect(nodeId).toMatch(/^[0-9a-f-]{36}$/)

    // ③ node.json written with the right fields and 0600
    const target = join(dir, 'node.json')
    expect(existsSync(target)).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o600)
    const cfg = JSON.parse(readFileSync(target, 'utf8')) as { node_id: string; token: string; hub_url: string; display_name: string }
    expect(cfg.node_id).toBe(nodeId)
    expect(cfg.token).toBe(TOKEN)
    expect(cfg.hub_url).toBe(WS_URL)
    expect(cfg.display_name).toBe(hostname())
  })

  it('honors an explicit display name', async () => {
    const ctx: ServeContext = {}
    const dir = tmpNodeDir()
    const code = await runJoin({
      controlPlane: WS_URL,
      code: CODE,
      displayName: 'mac-mini-prod',
      nodeDir: dir,
      wsFactory: makeWsFactory(ctx),
      tailscaleProbe: () => ({ installed: true, online: true, detail: 'ok' }),
      log: quietLog,
    })
    expect(code).toBe(0)
    expect(ctx.consumeParams![0]).toMatchObject({ display_name: 'mac-mini-prod' })
    const cfg = JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8')) as { display_name: string }
    expect(cfg.display_name).toBe('mac-mini-prod')
  })

  it('refuses to overwrite an existing node.json without --force (and does not consume the code)', async () => {
    const ctx: ServeContext = {}
    const dir = tmpNodeDir()
    const target = join(dir, 'node.json')
    writeFileSync(target, JSON.stringify({ node_id: 'existing' }))
    chmodSync(target, 0o600)

    const code = await runJoin({
      controlPlane: WS_URL,
      code: CODE,
      nodeDir: dir,
      wsFactory: makeWsFactory(ctx),
      tailscaleProbe: () => ({ installed: true, online: true, detail: 'ok' }),
      log: quietLog,
    })
    expect(code).toBe(1)
    expect(ctx.consumeParams).toBeUndefined() // never connected
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ node_id: 'existing' })
  })

  it('overwrites with --force', async () => {
    const ctx: ServeContext = {}
    const dir = tmpNodeDir()
    const target = join(dir, 'node.json')
    writeFileSync(target, JSON.stringify({ node_id: 'existing' }))

    const code = await runJoin({
      controlPlane: WS_URL,
      code: CODE,
      nodeDir: dir,
      force: true,
      wsFactory: makeWsFactory(ctx),
      tailscaleProbe: () => ({ installed: true, online: true, detail: 'ok' }),
      log: quietLog,
    })
    expect(code).toBe(0)
    const cfg = JSON.parse(readFileSync(target, 'utf8')) as { node_id: string }
    expect(cfg.node_id).not.toBe('existing')
  })

  it('fails cleanly when the hub rejects the code (no node.json written)', async () => {
    const ctx: ServeContext = { failConsume: 'already_used' }
    const dir = tmpNodeDir()
    const out: string[] = []
    const origErr = console.error
    console.error = (l: string) => out.push(l)
    try {
      const code = await runJoin({
        controlPlane: WS_URL,
        code: CODE,
        nodeDir: dir,
        wsFactory: makeWsFactory(ctx),
        tailscaleProbe: () => ({ installed: true, online: true, detail: 'ok' }),
        log: quietLog,
      })
      expect(code).toBe(1)
    } finally {
      console.error = origErr
    }
    expect(out.join('\n')).toContain('配对失败')
    expect(existsSync(join(dir, 'node.json'))).toBe(false)
  })

  it('rejects invalid control-plane URLs and codes without connecting', async () => {
    const ctx: ServeContext = {}
    const dir = tmpNodeDir()
    const badUrl = await runJoin({ controlPlane: 'http://nope:3470', code: CODE, nodeDir: dir, wsFactory: makeWsFactory(ctx), log: quietLog })
    expect(badUrl).toBe(1)
    const badCode = await runJoin({ controlPlane: WS_URL, code: 'not-a-code', nodeDir: dir, wsFactory: makeWsFactory(ctx), log: quietLog })
    expect(badCode).toBe(1)
    expect(ctx.helloNodeId).toBeUndefined()
  })
})
