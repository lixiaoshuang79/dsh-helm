import { describe, expect, it } from 'vitest'
import { parseHubArgs, startHub } from '../src/hub-cli.js'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 起一个真实 hub（port 0 = OS 分配），等待 MCP HTTP 监听就绪。 */
async function startTestHub(extra: string[] = []): Promise<{ hub: ReturnType<typeof startHub>; port: number; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-health-'))
  const storeFile = join(dir, 'store.sqlite3')
  const opts = parseHubArgs(['--mesh-port', '0', '--mcp-port', '0', '--store', storeFile, ...extra])
  const hub = startHub(opts, () => {})
  let mcpAddr: { port: number } | null = null
  for (let i = 0; i < 20 && !mcpAddr; i++) {
    await new Promise((r) => setTimeout(r, 25))
    mcpAddr = hub.mcpHttp.address()
  }
  return { hub, port: mcpAddr?.port ?? 0, dir }
}

async function stopTestHub(hub: ReturnType<typeof startHub>, dir: string): Promise<void> {
  await hub.mesh.close()
  hub.mcpHttp.close()
  hub.cp.stop()
  hub.ha.stop()
  hub.store.close()
  rmSync(dir, { recursive: true, force: true })
}

describe('hub 健康监控端点（P3）', () => {
  it('GET /version 返回包名与 package.json 版本', async () => {
    const { hub, port, dir } = await startTestHub()
    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
      const res = await fetch(`http://127.0.0.1:${port}/version`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ name: 'dsh-helm-hub', version: pkg.version })
    } finally {
      await stopTestHub(hub, dir)
    }
  })

  it('GET /metrics 返回完整快照形状（初始零值）', async () => {
    const { hub, port, dir } = await startTestHub()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toMatchObject({
        status: 'ok',
        requestCount: 0,
        avgResponseBytes: 0,
        maxResponseBytes: 0,
        truncationCount: 0,
        errorCount: 0,
        activeConnections: 0,
      })
      expect(typeof body.version).toBe('string')
      expect(body.version).not.toBe('')
      expect(typeof body.uptimeMs).toBe('number')
      expect(Array.isArray(body.perTool)).toBe(true)
      expect(body.perTool).toEqual([])
    } finally {
      await stopTestHub(hub, dir)
    }
  })

  it('GET /readyz standalone 返回 { ok: true }', async () => {
    const { hub, port, dir } = await startTestHub()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await stopTestHub(hub, dir)
    }
  })

  it('HA 模式 quorum=false 时 /readyz 返回 503 + reason', async () => {
    // ws://127.0.0.1:9 无人监听：peer 永远连不上 → quorum()=false
    const { hub, port, dir } = await startTestHub(['--cp-peer', 'ws://127.0.0.1:9'])
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`)
      expect(res.status).toBe(503)
      const body = (await res.json()) as { ok: boolean; reason: string }
      expect(body.ok).toBe(false)
      expect(body.reason).toMatch(/quorum/)
    } finally {
      await stopTestHub(hub, dir)
    }
  })

  it('真实 MCP 调用进入 /metrics（错误响应同样计数）', async () => {
    const { hub, port, dir } = await startTestHub()
    try {
      // 无节点连接：code_read_file 路由被拒 → isError 响应，仍计数
      const call = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'code_read_file', arguments: { path: '/x' } } }),
      })
      expect(call.status).toBe(200)
      const callBody = (await call.json()) as { result?: { isError?: boolean } }
      expect(callBody.result?.isError).toBe(true)

      const metrics = (await (await fetch(`http://127.0.0.1:${port}/metrics`)).json()) as {
        requestCount: number
        errorCount: number
        status: string
        perTool: Array<{ tool: string; count: number; errors: number }>
      }
      expect(metrics.requestCount).toBe(1)
      expect(metrics.errorCount).toBe(1)
      expect(metrics.status).toBe('degraded')
      expect(metrics.perTool.find((t) => t.tool === 'code_read_file')).toMatchObject({ count: 1, errors: 1 })
    } finally {
      await stopTestHub(hub, dir)
    }
  })
})
