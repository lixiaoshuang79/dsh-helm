/**
 * 单机兼容模式（1 hub + 1 agent，node_id == hub defaultNodeId）：
 * 单个 ChatGPT connector（旧形态 tunnel → daemon 3457 直连）升级到
 * dsh-helm 单机形态（tunnel → hub MCP 3471）后，验证升级能力在单节点
 * 收敛拓扑下真实生效：
 *   ① 内容瘦身 —— sessions_get 默认返回摘要（无 messages，~KB 级）
 *   ② 插队机制 —— sessions_prompt mode=steer 经 DSH 宿主 API 注入
 *   ③ 响应守卫 —— 完整历史超限（>50KB）被截断且输出仍为合法 JSON
 *   ④ 路由收敛 —— 无 target_node 时全部落到唯一节点，回复带 _route
 *
 * 拓扑与 agent.integration.test.ts 一致（内存 hub + FakeWebSocket +
 * FakeBackend），额外挂上 HubMcpServer 扮演 ChatGPT 隧道入口（3471）。
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../packages/store/src/index.js'
import { ControlPlane, HubConnection, HubMcpServer } from '../../packages/hub/src/index.js'
import { MAX_RESPONSE_BYTES } from '../../packages/hub/src/mcp/guard.js'
import { HelmNodeAgent } from '../../packages/node-agent/src/index.js'
import { FakeBackend } from '../../packages/node-agent/tests/backend-fixtures.js'
import { FakeWebSocket } from './fake-websocket.js'

const NODE_ID = 'n-local'
const NODE_NAME = 'mac-single'

/** 1000 条填充消息 + 窗口内（最后 20 条）注入明确 next_action，~100KB。 */
function bigSession(): Record<string, unknown> {
  const messages: Array<{ seq: number; time: string; role: string; text: string }> = []
  for (let i = 0; i < 1000; i++) {
    if (i % 2 === 0) {
      messages.push({ seq: i + 1, time: '2026-08-24T00:00:00Z', role: 'user', text: '收到' })
    } else {
      messages.push({ seq: i + 1, time: '2026-08-24T00:00:00Z', role: 'assistant', text: `好的（第 ${i + 1} 轮）` })
    }
  }
  // 最后 20 条窗口内：唯一有实质内容的 user 指令
  messages[998] = { seq: 999, time: '2026-08-24T00:00:00Z', role: 'user', text: '下一步：先跑 lint 和测试，通过后再提交' }
  return {
    id: 's-big',
    title: 'big session',
    status: 'idle',
    workspace: 'w-local',
    created_at: '',
    updated_at: '2026-08-24T00:00:00Z',
    messages,
  }
}

/** DSH 宿主 API mock：按 /api/<method> 返回标准 envelope。 */
function makeSteerFetch(log: (line: string) => void = () => {}) {
  const calls: string[] = []
  const mk = (opts: { list?: Array<{ sessionId?: string; running?: boolean }>; fail?: boolean; failProbe?: boolean }) => {
    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const href = String(url)
      const method = href.split('/api/')[1]?.split('?')[0] ?? '?'
      calls.push(method)
      log(`[mock-host] ${method}`)
      void init
      if (opts.fail) throw new Error('host api unreachable (mocked)')
      if (opts.failProbe && method === 'session.list') throw new Error('probe failed (mocked)')
      const value =
        method === 'session.list' ? { items: opts.list ?? [] } : method === 'session.prompt' ? { accepted: true } : {}
      return new Response(JSON.stringify({ type: 'server-response', result: { ok: true, value } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
  return { mk, calls }
}

interface Rig {
  store: DshHelmStore
  cp: ControlPlane
  mcp: HubMcpServer
  backend: FakeBackend
  agent: HelmNodeAgent
  socket: FakeWebSocket
  sessions: SessionCatalog
  cleanup: () => void
}

function buildRig(steerFetch?: typeof fetch): Rig {
  const store = new DshHelmStore({ file: ':memory:' })
  const nodes = new NodeRegistry(store.db)
  const sessions = new SessionCatalog(store.db)
  const workspaces = new WorkspaceCatalog(store.db)
  const presence = new PresenceRegistry(store.db)
  const conns = new Map<string, HubConnection>()
  const cp = new ControlPlane({
    store,
    nodes,
    sessions,
    workspaces,
    presence,
    hubId: 'hub-single',
    schemaVersion: 1,
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    defaultNodeId: NODE_ID,
    tokenLookup: (id) => (id === NODE_ID ? 'local-token' : undefined),
    connections: conns,
    log: () => {},
  })
  const mcp = new HubMcpServer({ cp, log: () => {} })
  const backend = new FakeBackend({
    sessions: [{ session_id: 's-local', title: 't', status: 'idle', live: false }],
    workspaces: [{ workspace_id: 'w-local', path: '/Users/me/proj' }],
    overrides: { sessions_get: bigSession() },
  })
  const socket = new FakeWebSocket()
  const agent = new HelmNodeAgent({
    config: {
      node_id: NODE_ID,
      hub_url: 'ws://test/',
      token: 'local-token',
      local_mcp_url: 'http://127.0.0.1:3457/mcp',
      local_mcp_token: 'local-tok',
      host_api_url: 'http://127.0.0.1:3080',
      display_name: NODE_NAME,
      local_probe_ms: 10_000,
      reconcile_ms: 10_000,
    },
    backend,
    wsFactory: () => socket,
    steerFetch,
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    log: () => {},
  })
  const conn = new HubConnection({
    cp,
    send: (m) => socket.serverSend(m),
    onClose: (id) => id && conns.delete(id),
  })
  socket.setHubSink((m) => conn.inbound(m))
  agent.start()
  socket.open()
  return {
    store,
    cp,
    mcp,
    backend,
    agent,
    socket,
    sessions,
    cleanup: () => {
      agent.stop()
      conn.close()
      store.close()
    },
  }
}

async function settle(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

beforeEach(async () => {
  // connect/register/reconcile 心跳前移至每个用例开始前（共享 rig 由用例自行构建）
})

describe('single-node connector upgrade (hub + one agent, node_id == defaultNodeId)', () => {
  it('MCP 工具面完整（19 兼容 + 5 新增）', () => {
    const rig = buildRig()
    try {
      const names = rig.mcp.listTools().map((t) => t.name)
      for (const essential of ['sessions_get', 'sessions_prompt', 'sessions_list', 'code_read_file', 'supervisor_health']) {
        expect(names).toContain(essential)
      }
      for (const added of ['nodes_list', 'node_get', 'route_explain', 'presence_claim', 'presence_release']) {
        expect(names).toContain(added)
      }
      expect(names.length).toBeGreaterThanOrEqual(24)
    } finally {
      rig.cleanup()
    }
  })

  it('路由收敛：无 target_node 时全部落到唯一节点，回复带 _route.node_name', async () => {
    const rig = buildRig()
    try {
      await settle()
      const out = await rig.mcp.callTool({
        name: 'sessions_prompt',
        arguments: { session_id: 's-local', message: '列出当前工作区' },
      })
      expect(out.isError).not.toBe(true)
      const text = String(out.content?.[0]?.text ?? '')
      const parsed = JSON.parse(text) as Record<string, unknown>
      const route = (parsed._route ?? {}) as Record<string, unknown>
      expect(route.node_name).toBe(NODE_NAME)
      // 摘要缓存因 prompt 失效后重建；reply 来自本地 backend
      expect(JSON.stringify(parsed)).toContain('processed')
    } finally {
      rig.cleanup()
    }
  })

  it('内容瘦身：默认 sessions_get 返回摘要（~KB），不落 messages，current_goal 取窗口内行动指令', async () => {
    const rig = buildRig()
    try {
      await settle()
      const out = await rig.mcp.callTool({ name: 'sessions_get', arguments: { session_id: 's-big' } })
      expect(out.isError).not.toBe(true)
      const text = String(out.content?.[0]?.text ?? '')
      expect(text.length).toBeGreaterThan(0)
      // 摘要是 JSON 文本（HubMcpServer 统一 text 块）
      const parsed = JSON.parse(text) as Record<string, unknown>
      expect('messages' in parsed).toBe(false)
      expect(typeof parsed.current_goal).toBe('string')
      expect(String(parsed.current_goal)).toContain('lint')
      expect(parsed.current_goal_seq).toBe(999)
      expect(String(parsed.last_user_message)).toContain('lint')
      expect((parsed.history_ref as Record<string, unknown>).reachable_max_messages).toBe(100)
      // 瘦身倍数：1000 条 ~100KB → 摘要 <2KB
      expect(Buffer.byteLength(text)).toBeLessThan(2_000)
    } finally {
      rig.cleanup()
    }
  })

  it('插队机制：mode=steer 经 DSH 宿主 API 注入（session_was_running=true），不落 backend', async () => {
    const steer = makeSteerFetch()
    const rig = buildRig(steer.mk({ list: [{ sessionId: 's-local', running: true }] }))
    try {
      await settle()
      const out = await rig.mcp.callTool({
        name: 'sessions_prompt',
        arguments: { session_id: 's-local', message: '先跑 lint 再提交', mode: 'steer' },
      })
      const parsed = JSON.parse(String(out.content?.[0]?.text ?? '')) as Record<string, unknown>
      expect(parsed.status).toBe('steered')
      expect(parsed.session_was_running).toBe(true)
      expect(parsed.accepted).toBe(true)
      // steer 走宿主 API：session.list 探测 + session.prompt 注入
      expect(steer.calls).toEqual(['session.list', 'session.prompt'])
      // 未落本地 backend（FakeBackend.sessions_prompt 未被调用）
      expect(rig.backend.calls.map((c) => c.name)).not.toContain('sessions_prompt')
      // 摘要在 steer 后失效：下一次 sessions_get 重建（backend 被再次访问）
    } finally {
      rig.cleanup()
    }
  })

  it('插队降级：宿主 API 不可达 → 结构化 unavailable，不 throw、连接不毒化', async () => {
    const steer = makeSteerFetch()
    const rig = buildRig(steer.mk({ fail: true }))
    try {
      await settle()
      const out = await rig.mcp.callTool({
        name: 'sessions_prompt',
        arguments: { session_id: 's-local', message: '先跑 lint', mode: 'steer' },
      })
      const parsed = JSON.parse(String(out.content?.[0]?.text ?? '')) as Record<string, unknown>
      expect(parsed.status).toBe('unavailable')
      expect(String(parsed.reason ?? '')).toContain('unreachable')
      // 随后 queue 调用（默认 mode）经 backend 正常处理
      const next = await rig.mcp.callTool({
        name: 'sessions_prompt',
        arguments: { session_id: 's-local', message: '继续' },
      })
      expect(JSON.parse(String(next.content?.[0]?.text ?? ''))).toMatchObject({ ok: true })
    } finally {
      rig.cleanup()
    }
  })

  it('响应守卫：完整历史（~100KB）超限被截断，输出仍为合法 JSON 且 ≤MAX_RESPONSE_BYTES', async () => {
    const rig = buildRig()
    try {
      await settle()
      const out = await rig.mcp.callTool({
        name: 'sessions_get',
        arguments: { session_id: 's-big', include_messages: true },
      })
      const text = String(out.content?.[0]?.text ?? '')
      // 1000 条 -> 截断在 50KB 以内
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 64)
      const parsed = JSON.parse(text) as Record<string, unknown>
      // guard 的 truncated 元数据：{original_size, returned_size, tool}
      const truncated = parsed.truncated as Record<string, unknown>
      expect(truncated).toBeTruthy()
      expect(Number(truncated.returned_size)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
      expect(Number(truncated.original_size)).toBeGreaterThan(MAX_RESPONSE_BYTES)
      // 完整历史路径同时生效：头部字段保留（截断从最宽的 messages 字段下手）
      expect(typeof parsed.id).toBe('string')
    } finally {
      rig.cleanup()
    }
  })
})