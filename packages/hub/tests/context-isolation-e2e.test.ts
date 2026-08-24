/**
 * MCP Context Isolation 端到端验收（P0/P1 在真实 hub + HTTP /mcp 全链路的保证）。
 *
 * 链路：HTTP POST /mcp tools/call → HubMcpServer.callTool → guard middleware →
 * cp.forward → FakeNode（模拟 node agent）→ 响应回程同样过 guard。
 *
 * 覆盖用户验收口径：
 *  - 大响应默认被收窄（guard 兜底，≤ MAX_RESPONSE_BYTES，仍为合法 JSON）；
 *  - include_messages / max_messages / before_seq 透传到节点；
 *  - timeout/broken 响应后下一次 MCP 调用仍正常（无状态毒化）；
 *  - /metrics 如实记录（截断计数、perTool）。
 * （node-agent 摘要路径的 1000 消息 <10KB 断言在 node-agent/tests/summary.test.ts。）
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHubArgs, startHub } from '../src/hub-cli.js'
import { HubConnection, MAX_RESPONSE_BYTES } from '../src/index.js'
import { FakeNode } from './fake-node.js'
import type { NodeInfo, WireMessage } from '../../protocol/src/index.js'
import type { HubConnection as HubConnectionType } from '../src/connection.js'

const HUB_TOKEN = 'e2etoken'
const NODE_ID = 'n-e2e'

function makeNodeInfo(id: string, name: string): NodeInfo {
  return {
    node_id: id,
    display_name: name,
    platform: { os: 'darwin', arch: 'arm64', release: 'test', nodeVersion: 'v22' },
    versions: { agent: '0.1.0', protocol: 1 },
    capabilities: { sessions: true, serena: true, tunnel: false, presenceProvider: true, defaultNode: true },
  }
}

interface E2E {
  hub: ReturnType<typeof startHub>
  port: number
  dir: string
  node: FakeNode
  /** 节点→hub 方向管道（发 catalog.reconcile 等 RPC 用）。 */
  toHub: (m: WireMessage) => void
  reconcileSession: (nativeSessionId: string, status?: string) => void
  cleanup: () => Promise<void>
}

async function startE2E(nodeSessions: Array<{ native_session_id: string; title: string; status: string; live?: boolean }>): Promise<E2E> {
  process.env.DSH_HELM_TOKEN = `${NODE_ID}=${HUB_TOKEN}`
  const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-e2e-'))
  const storeFile = join(dir, 'store.sqlite3')
  const opts = parseHubArgs(['--mesh-port', '0', '--mcp-port', '0', '--store', storeFile])
  const hub = startHub(opts, () => {})
  // 等 MCP HTTP 监听就绪
  let port = 0
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise((r) => setTimeout(r, 20))
    port = hub.mcpHttp.address()?.port ?? 0
  }
  const node = new FakeNode({ node: makeNodeInfo(NODE_ID, 'e2e-node'), token: HUB_TOKEN, schemaVersion: 1 })
  node.sessions = nodeSessions
  let toHub: (m: WireMessage) => void = () => {}
  const conn: HubConnectionType = new HubConnection({
    cp: hub.cp,
    send: (m) => node.inbound(m),
    onClose: (id) => id && hub.cp.connections.delete(id),
  })
  node.attach((m) => toHub(m))
  toHub = (m) => conn.inbound(m)
  node.start()
  // 等节点注册（轮询，避免时序 flake）
  for (let i = 0; i < 100 && hub.cp.connections.size === 0; i++) await new Promise((r) => setTimeout(r, 20))
  expect(hub.cp.connections.size).toBe(1)
  // 经节点侧管道上报 catalog.reconcile，建立 session owner 记录（等同真实 agent 的注册后同步）
  const reconcileSession = (nativeSessionId: string, status = 'idle'): void => {
    toHub({
      type: 'rpc',
      v: 1,
      body: {
        jsonrpc: '2.0',
        id: 99,
        method: 'catalog.reconcile',
        params: { node_id: NODE_ID, sessions: [{ native_session_id: nativeSessionId, status, title: 'x', live: false }] },
      },
    })
  }
  return {
    hub,
    port,
    dir,
    node,
    toHub,
    reconcileSession,
    cleanup: async () => {
      await hub.mesh.close()
      hub.mcpHttp.close()
      hub.cp.stop()
      hub.ha.stop()
      hub.store.close()
      rmSync(dir, { recursive: true, force: true })
      delete process.env.DSH_HELM_TOKEN
    },
  }
}

/** 经真实 HTTP /mcp 调一个工具。 */
async function mcpCall(port: number, name: string, args: Record<string, unknown>): Promise<{ result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: { message?: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: { message?: string } }
}

afterEach(() => {
  delete process.env.DSH_HELM_TOKEN
})

describe('MCP Context Isolation 端到端（真实 hub + HTTP /mcp 全链路）', () => {
  it('超大 sessions_get 响应经全链路被 guard 收窄：合法 JSON + truncated + ≤50KB', async () => {
    const e = await startE2E([{ native_session_id: 'sess-big', title: 'y'.repeat(200_000), status: 'idle' }])
    try {
      e.reconcileSession('sess-big')
      const call = await mcpCall(e.port, 'sessions_get', { session_id: 'sess-big' })
      expect(call.result?.isError).toBeFalsy()
      const text = call.result!.content![0]!.text
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
      // 硬要求：截断后仍是合法 JSON
      const parsed = JSON.parse(text) as { truncated?: { tool: string; original_size: number; returned_size: number }; _route?: { node_id: string } }
      expect(parsed.truncated).toBeDefined()
      expect(parsed.truncated!.tool).toBe('sessions_get')
      expect(parsed.truncated!.original_size).toBeGreaterThan(MAX_RESPONSE_BYTES)
      expect(parsed._route?.node_id).toBe(NODE_ID)
      // /metrics 已记录截断
      const metrics = (await (await fetch(`http://127.0.0.1:${e.port}/metrics`)).json()) as {
        requestCount: number; truncationCount: number
        perTool: Array<{ tool: string; count: number; truncated: number; maxBytes: number }>
      }
      expect(metrics.requestCount).toBeGreaterThanOrEqual(1)
      expect(metrics.truncationCount).toBeGreaterThanOrEqual(1)
      expect(metrics.perTool.find((t) => t.tool === 'sessions_get')).toMatchObject({ truncated: 1 })
    } finally {
      await e.cleanup()
    }
  })

  it('include_messages/max_messages/before_seq 透传到节点（lastMcpCall 断言）', async () => {
    const e = await startE2E([{ native_session_id: 'sess-p', title: 'T', status: 'idle' }])
    try {
      e.reconcileSession('sess-p')
      const call = await mcpCall(e.port, 'sessions_get', { session_id: 'sess-p', include_messages: true, max_messages: 5, before_seq: 999 })
      expect(call.result?.isError).toBeFalsy()
      expect(e.node.lastMcpCall).toMatchObject({ tool: 'sessions_get', args: { session_id: 'sess-p', include_messages: true, max_messages: 5, before_seq: 999 } })
      // 缺省（不传 include_messages）→ 参数原样透传，节点自行摘要（node-agent 摘要层；此处仅断言透传）
      await mcpCall(e.port, 'sessions_get', { session_id: 'sess-p' })
      expect(e.node.lastMcpCall).toMatchObject({ args: { session_id: 'sess-p' } })
    } finally {
      await e.cleanup()
    }
  })

  it('broken 响应后下一次 MCP 调用仍正常（无状态毒化）', async () => {
    const e = await startE2E([{ native_session_id: 'sess-ok', title: 'T', status: 'idle' }])
    try {
      e.reconcileSession('sess-ok')
      // 注入失败：节点的 MCP_CALL sessions_get 抛错 → hub 捕获 → isError 响应
      e.node.failMethods.add('mcp.call:sessions_get')
      const broken = await mcpCall(e.port, 'sessions_get', { session_id: 'sess-ok' })
      expect(broken.result?.isError).toBe(true)
      // 解除注入后立即再调：必须正常（连接/路由未被毒化）
      e.node.failMethods.delete('mcp.call:sessions_get')
      const ok = await mcpCall(e.port, 'sessions_get', { session_id: 'sess-ok' })
      expect(ok.result?.isError).toBeFalsy()
      expect(JSON.parse(ok.result!.content![0]!.text)).toMatchObject({ native_session_id: 'sess-ok' })
    } finally {
      await e.cleanup()
    }
  })

  it('sessions_prompt mode 透传到节点（queue 默认 / steer 显式）', async () => {
    const e = await startE2E([{ native_session_id: 'sess-p2', title: 'T', status: 'idle' }])
    try {
      e.reconcileSession('sess-p2')
      // mode=steer 显式透传
      const steer = await mcpCall(e.port, 'sessions_prompt', { session_id: 'sess-p2', message: '立即停止', mode: 'steer' })
      expect(steer.result?.isError).toBeFalsy()
      expect(e.node.lastMcpCall).toMatchObject({ tool: 'sessions_prompt', args: { session_id: 'sess-p2', message: '立即停止', mode: 'steer' } })
      // 缺省（不带 mode）→ 参数原样透传（agent 按 queue 处理）
      e.node.lastMcpCall = undefined
      const plain = await mcpCall(e.port, 'sessions_prompt', { session_id: 'sess-p2', message: 'hello' })
      expect(plain.result?.isError).toBeFalsy()
      expect(e.node.lastMcpCall).toMatchObject({ args: { session_id: 'sess-p2', message: 'hello' } })
    } finally {
      await e.cleanup()
    }
  })
})
