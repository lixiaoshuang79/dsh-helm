import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isPortListening,
  nodeVersionSatisfies,
  parseTunnelIdFromPlist,
  readLocalNodeConfig,
  redactNodeId,
  redactToken,
  redactTunnelId,
  runDoctor,
  type RunFn,
} from '../src/doctor.js'

describe('redactToken', () => {
  it('redacts sk-proj-* tokens keeping a readable prefix', () => {
    const token = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
    const out = redactToken(`token=${token}`)
    expect(out).not.toContain(token)
    expect(out).toContain('sk-proj-abcd')
    expect(out).toContain('…')
  })

  it('redacts Authorization: Bearer tokens', () => {
    const out = redactToken('Authorization: Bearer abc.def.ghi-123')
    expect(out).toContain('Authorization: Bearer <redacted>')
    expect(out).not.toContain('abc.def.ghi-123')
  })

  it('leaves ordinary text untouched and handles empty input', () => {
    expect(redactToken('plain text')).toBe('plain text')
    expect(redactToken('')).toBe('')
  })
})

describe('redactNodeId / redactTunnelId', () => {
  it('keeps first+last 8 chars for long ids', () => {
    expect(redactNodeId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400…55440000')
  })
  it('keeps short ids as-is', () => {
    expect(redactNodeId('short-id')).toBe('short-id')
  })
  it('tunnel id keeps first 8 chars only', () => {
    expect(redactTunnelId('tun-abcdef1234567890')).toBe('tun-abcd…')
    expect(redactTunnelId('tun-1')).toBe('tun-1')
  })
})

describe('parseTunnelIdFromPlist', () => {
  const plist = (args: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
</dict>
</plist>`

  it('extracts the value after --control-plane.tunnel-id', () => {
    const id = parseTunnelIdFromPlist(plist(['node', 'tunnel.mjs', '--control-plane.tunnel-id', 'tun-abcdef1234567890']))
    expect(id).toBe('tun-abcdef1234567890')
  })

  it('returns null when the flag or its value is missing', () => {
    expect(parseTunnelIdFromPlist(plist(['node', 'tunnel.mjs']))).toBeNull()
    expect(parseTunnelIdFromPlist(plist(['node', '--control-plane.tunnel-id']))).toBeNull()
    expect(parseTunnelIdFromPlist('not a plist')).toBeNull()
  })

  it('returns null for an empty value', () => {
    expect(parseTunnelIdFromPlist(plist(['node', '--control-plane.tunnel-id', '']))).toBeNull()
  })
})

describe('nodeVersionSatisfies', () => {
  it('compares major.minor against the engine floor', () => {
    expect(nodeVersionSatisfies('22.11.0', 22, 5)).toBe(true)
    expect(nodeVersionSatisfies('22.5.0', 22, 5)).toBe(true)
    expect(nodeVersionSatisfies('22.4.3', 22, 5)).toBe(false)
    expect(nodeVersionSatisfies('23.0.0', 22, 5)).toBe(true)
    expect(nodeVersionSatisfies('21.9.0', 22, 5)).toBe(false)
    expect(nodeVersionSatisfies('garbage', 22, 5)).toBe(false)
  })
})

describe('readLocalNodeConfig', () => {
  it('reports missing files without creating anything', () => {
    const cfg = readLocalNodeConfig(join(tmpdir(), 'definitely-not-there-node.json'))
    expect(cfg.found).toBe(false)
    expect(cfg.hasToken).toBe(false)
  })

  it('reads whitelisted fields and only flags token presence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-doctor-'))
    try {
      const path = join(dir, 'node.json')
      writeFileSync(
        path,
        JSON.stringify({
          node_id: '550e8400-e29b-41d4-a716-446655440000',
          display_name: 'fixture-node',
          hub_url: 'http://127.0.0.1:3471',
          token: 'sk-test-fake-token-0123456789abcdef',
        }),
      )
      const cfg = readLocalNodeConfig(path)
      expect(cfg.found).toBe(true)
      expect(cfg.display_name).toBe('fixture-node')
      expect(cfg.node_id).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(cfg.hub_url).toBe('http://127.0.0.1:3471')
      expect(cfg.hasToken).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags missing token and unparseable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-doctor-'))
    try {
      const path = join(dir, 'node.json')
      writeFileSync(path, JSON.stringify({ node_id: 'n-1' }))
      expect(readLocalNodeConfig(path).hasToken).toBe(false)
      writeFileSync(path, '{broken json')
      expect(readLocalNodeConfig(path).found).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isPortListening', () => {
  const fakeRun = (stdout: string, ok = true): RunFn => () => ({ ok, stdout })

  it('macOS: lsof output means listening', () => {
    expect(isPortListening(3471, fakeRun('node 123 LISTEN\n'), 'darwin')).toBe(true)
    expect(isPortListening(3471, fakeRun('', false), 'darwin')).toBe(false)
    expect(isPortListening(3471, fakeRun(''), 'darwin')).toBe(false)
  })

  it('macOS: tries /usr/sbin/lsof when lsof is not on PATH', () => {
    const run: RunFn = (cmd, args) => {
      if (cmd === 'lsof') return { ok: false, stdout: '' } // ENOENT
      expect(cmd).toBe('/usr/sbin/lsof')
      expect(args).toContain('-iTCP:3471')
      return { ok: true, stdout: 'node 1234 TCP 127.0.0.1:3471 (LISTEN)\n' }
    }
    expect(isPortListening(3471, run, 'darwin')).toBe(true)
  })

  it('macOS: falls back to netstat when no lsof is available', () => {
    const run: RunFn = (cmd, args) => {
      if (cmd === 'lsof' || cmd === '/usr/sbin/lsof') return { ok: false, stdout: '' }
      expect(cmd).toBe('/usr/sbin/netstat')
      expect(args).toEqual(['-an', '-p', 'tcp'])
      return { ok: true, stdout: 'tcp4 0 0 127.0.0.1.3471 *.* LISTEN\ntcp4 0 0 127.0.0.1.3470 *.* LISTEN\n' }
    }
    expect(isPortListening(3471, run, 'darwin')).toBe(true)
    expect(isPortListening(9999, run, 'darwin')).toBe(false)
  })

  it('linux: matches the port in ss output', () => {
    expect(isPortListening(3471, fakeRun('LISTEN 0 128 *:3471 *:*\n'), 'linux')).toBe(true)
    expect(isPortListening(3471, fakeRun('LISTEN 0 128 *:3470 *:*\n'), 'linux')).toBe(false)
  })

  it('win32: unsupported', () => {
    expect(isPortListening(3471, fakeRun('anything'), 'win32')).toBe(false)
  })
})

// ---- runDoctor 端到端（全部注入，不碰真实环境/子进程） ----

const FAKE_NODE_ID = '550e8400-e29b-41d4-a716-446655440000'
const FAKE_TOKEN = 'sk-test-fake-token-0123456789abcdef'
const FAKE_TUNNEL_ID = 'tun-abcdef1234567890'

const PLIST_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh-helm.tunnel-client</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/x/tunnel-client.mjs</string>
    <string>--control-plane.tunnel-id</string>
    <string>${FAKE_TUNNEL_ID}</string>
  </array>
</dict>
</plist>`

function fakeFetchFactory(opts: { hubHealthzStatus?: number } = {}) {
  const { hubHealthzStatus = 200 } = opts
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.includes(':3471') && url.endsWith('/healthz') && method === 'GET') {
      return hubHealthzStatus === 200
        ? new Response(JSON.stringify({ ok: true, nodes: 2 }), { status: 200 })
        : new Response('{}', { status: hubHealthzStatus })
    }
    if (url.endsWith('/readyz') && method === 'GET') {
      return new Response('', { status: 200 })
    }
    if (url.includes(':3468') && url.endsWith('/healthz') && method === 'GET') {
      return new Response('', { status: 200 })
    }
    if (url.endsWith('/mcp') && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { method?: string; params?: { name?: string } }
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'hub-fixture-1' },
        })
      }
      if (body.method === 'tools/call' && body.params?.name === 'nodes_list') {
        const text = JSON.stringify({
          nodes: [
            { node_id: 'n-1', display_name: 'node-a', connected: true },
            { node_id: 'n-2', display_name: 'node-b', connected: false },
          ],
        })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"method not found"}}', { status: 400 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

const fakeRun: RunFn = (cmd, args) => {
  if (cmd === 'sh' && args[0] === '-c') return { ok: true, stdout: '/usr/bin/curl\n' }
  if (cmd === 'launchctl') {
    return { ok: true, stdout: 'PID\tStatus\tLabel\n-\t0\tcom.dsh-helm.hub\n123\t0\tcom.dsh-helm.agent\n999\t0\tcom.apple.notours\n' }
  }
  if (cmd === 'lsof') {
    // 只有 3471 在监听
    const portArg = args[1] ?? ''
    const listening = portArg === '-iTCP:3471'
    return listening ? { ok: true, stdout: 'node 1234 ashuang 22u IPv4 0x1 TCP 127.0.0.1:3471 (LISTEN)\n' } : { ok: false, stdout: '' }
  }
  return { ok: false, stdout: '' }
}

describe('runDoctor', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let tmpDir: string

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    tmpDir = mkdtempSync(join(tmpdir(), 'dsh-helm-doctor-e2e-'))
  })

  afterEach(() => {
    logSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const baseOpts = () => ({
    hubUrl: 'http://127.0.0.1:3471',
    tunnelHealthUrl: 'http://127.0.0.1:3468',
    nodeConfigPath: join(tmpDir, 'node.json'),
    tunnelPlistPath: join(tmpDir, 'com.dsh-helm.tunnel-client.plist'),
    tailscaleCli: null,
    fetchImpl: fakeFetchFactory(),
    run: fakeRun,
    platform: 'darwin' as const,
    timeoutMs: 1000,
  })

  it('healthy setup: exit 0, all sections present, no secret material', async () => {
    writeFileSync(
      join(tmpDir, 'node.json'),
      JSON.stringify({ node_id: FAKE_NODE_ID, display_name: 'fixture-node', hub_url: 'http://127.0.0.1:3471', token: FAKE_TOKEN }),
    )
    writeFileSync(join(tmpDir, 'com.dsh-helm.tunnel-client.plist'), PLIST_FIXTURE)

    const code = await runDoctor([], baseOpts())
    expect(code).toBe(0)

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    for (const heading of ['## 依赖', '## 本机配置', '## hub 连通性', '## MCP', '## 控制面 HA', '## tunnel', '## 服务', '## 端口']) {
      expect(output).toContain(heading)
    }
    // node_id 只以 redact 形式出现；token 与完整 id 绝不出现
    expect(output).toContain('550e8400…55440000')
    expect(output).not.toContain(FAKE_NODE_ID)
    expect(output).not.toContain(FAKE_TOKEN)
    // tunnel id 只以 redact 形式出现
    expect(output).toContain('tun-abcd…')
    expect(output).not.toContain(FAKE_TUNNEL_ID)
    // 服务与 MCP 内容
    expect(output).toContain('com.dsh-helm.hub')
    expect(output).toContain('2 个节点：在线 1 / 离线 1')
    expect(output).toContain('0 项 fail')
  })

  it('hub down: exit 1 and FAIL lines reported', async () => {
    writeFileSync(join(tmpDir, 'node.json'), JSON.stringify({ node_id: FAKE_NODE_ID, token: FAKE_TOKEN }))
    writeFileSync(join(tmpDir, 'com.dsh-helm.tunnel-client.plist'), PLIST_FIXTURE)

    const code = await runDoctor([], { ...baseOpts(), fetchImpl: fakeFetchFactory({ hubHealthzStatus: 500 }) })
    expect(code).toBe(1)

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('[fail]')
    expect(output).toContain('HTTP 500')
    expect(output).toContain('1 项 fail')
  })

  it('missing node.json: warns and reports token 未配置', async () => {
    const code = await runDoctor([], baseOpts())
    expect(code).toBe(1)
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('不存在或无法解析')
    expect(output).toContain('token 未配置')
  })
})
