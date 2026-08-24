/**
 * MCP Context Isolation（P0+P2）验证：sessions_get 摘要 + 缓存 + 分页。
 *
 * FakeRichBackend 模拟 DSH 返回 1000 条消息的大 session（每条 ~200 字符，
 * 每 5 条含一条 ~4.8KB 的大 tool output），完整响应 ~250KB；断言：
 * 1. 默认 sessions_get → 序列化后 < 10KB（远低于 50KB 红线）
 * 2. 摘要字段齐全且值正确（最后一条消息截断、continuation_available 等）
 * 3. include_messages=true&max_messages=20 → 20 条且响应 > 摘要路径
 * 4. before_seq 原样透传 backend + next_before_seq 附带
 * 5. 缓存：60s 内第二次调用不调 backend（计数）、TTL 过期重建、PROMPT 后失效
 * 6. 缓存读写容错：目录不可写 / 缓存文件损坏均不抛错
 * 7. agent 集成：GET_SESSION RPC 与 MCP_CALL(sessions_get)（线上实际路径）
 *    都返回摘要，PROMPT 后缓存失效
 */

import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection } from '../../hub/src/index.js'
import { NODE_METHODS, type WireMessage } from '../../protocol/src/index.js'
import { HelmNodeAgent, SessionSummaryService, MAX_SUMMARY_CHARS, type WebSocketLike } from '../src/index.js'
import { FakeBackend } from './backend-fixtures.js'
import type { LocalHelmBackend, McpToolCallResult } from '../src/bridge.js'

/** 模拟 DSH 大 session：1000 条消息，含大 tool output（完整响应 ~250KB）。 */
class FakeRichBackend extends FakeBackend {
  messages: Array<Record<string, unknown>>
  /** sessions_get 被调用的次数（缓存命中不应增加）。 */
  getCalls = 0
  /** 最近一次 sessions_get 收到的 args（断言透传）。 */
  lastGetArgs: unknown
  private sessionStatus: string
  private tokenUsage?: number

  constructor(opts: { status?: string; tokenUsage?: number } = {}) {
    super({ sessions: [{ session_id: 's-big', status: opts.status ?? 'idle', live: false, title: 'big session' }] })
    this.sessionStatus = opts.status ?? 'idle'
    this.tokenUsage = opts.tokenUsage
    this.messages = buildMessages(1000)
  }

  override async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    if (name === 'sessions_get') {
      this.getCalls++
      this.lastGetArgs = args
      const { session_id, max_messages } = args as { session_id?: string; max_messages?: number }
      // 与真实 DSH 语义一致：max_messages 取最后 N 条，不传返回全部
      const msgs = typeof max_messages === 'number' ? this.messages.slice(-max_messages) : this.messages
      const session: Record<string, unknown> = {
        id: session_id ?? 's-big',
        agent: 'dsh',
        status: this.sessionStatus,
        workspace: '/Users/me/work',
        title: 'big session',
        updatedAt: '2026-08-24T10:00:00.000Z',
        messages: msgs,
        // 与真实 DSH 一致：始终带最后一条 assistant 文本（摘要兜底字段）
        lastAssistantText: (this.messages.filter((m) => m.role === 'assistant').at(-1) as { text: string })?.text ?? '',
      }
      if (this.tokenUsage !== undefined) session.tokenUsage = this.tokenUsage
      return { structuredContent: { session } }
    }
    return super.callTool(name, args)
  }
}

/** 构造 1000 条消息：每条 ~200 字符，5 的倍数位置为 ~4.8KB 大 tool 输出。
 *  最后两条：999=assistant、1000=tool（覆盖「最后一条消息截断」与
 *  「最后一条 assistant 消息」两条摘要路径）。 */
function buildMessages(n: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (let i = 1; i <= n; i++) {
    const role = i % 5 === 0 ? 'tool' : i % 2 === 1 ? 'assistant' : 'user'
    const text = role === 'tool' ? `TOOL_OUTPUT:${'x'.repeat(4800)}` : `message #${i}: ${'y'.repeat(180)}`
    out.push({ seq: i, time: `2026-08-24T10:00:${String(Math.floor(i / 60)).padStart(2, '0')}.000Z`, role, text })
  }
  return out
}

function trunc(text: string, max = MAX_SUMMARY_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

const tmpDirs: string[] = []
function freshCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helm-summary-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 服务层

describe('SessionSummaryService（P0 摘要 + P2 缓存）', () => {
  it('默认 sessions_get 返回结构化摘要，序列化后 < 10KB（红线 50KB）', async () => {
    const backend = new FakeRichBackend()
    const svc = new SessionSummaryService(backend, { cacheDir: freshCacheDir() })
    const out = await svc.getSession({ session_id: 's-big' })
    const serialized = JSON.stringify(out)
    expect(serialized.length).toBeLessThan(10_000)
    expect(serialized.length).toBeLessThan(50_000)
    // 摘要路径只向 DSH 要最后 SUMMARY_WINDOW(20) 条消息（max_messages 参数确认生效）
    expect(backend.lastGetArgs).toEqual({ session_id: 's-big', max_messages: 20 })
  })

  it('摘要字段齐全且值正确（截断/时间/可继续/token 估算）', async () => {
    const backend = new FakeRichBackend()
    const svc = new SessionSummaryService(backend, { cacheDir: freshCacheDir() })
    const s = (await svc.getSession({ session_id: 's-big' })) as Record<string, unknown>
    // 最后一条消息 = i=1000 的 tool 输出（4.8KB → 截断 300）
    const lastMsg = backend.messages[backend.messages.length - 1] as { text: string }
    const lastAssistant = [...backend.messages].reverse().find((m) => m.role === 'assistant') as { text: string }
    expect(s.id).toBe('s-big')
    expect(s.title).toBe('big session')
    expect(s.status).toBe('idle')
    expect(s.workspace).toBe('/Users/me/work')
    // DSH 无 createdAt（探测结论）→ 空串
    expect(s.created_at).toBe('')
    expect(s.updated_at).toBe('2026-08-24T10:00:00.000Z')
    expect(s.last_message_summary).toBe(trunc(lastMsg.text))
    expect(s.last_assistant_summary).toBe(trunc(lastAssistant.text))
    expect(s.token_estimate).toBeGreaterThan(0)
    expect(s.token_estimate_estimated).toBe(true)
    expect(s.continuation_available).toBe(true)
    expect(typeof s.generated_at).toBe('number')
  })

  it('status=running 时 continuation_available=false；DSH 有真实 token 字段时优先使用', async () => {
    const running = new FakeRichBackend({ status: 'running' })
    const svcRunning = new SessionSummaryService(running, { cacheDir: freshCacheDir() })
    expect((await svcRunning.getSession({ session_id: 's-big' })).continuation_available).toBe(false)

    const tok = new FakeRichBackend({ tokenUsage: 12_345 })
    const svcTok = new SessionSummaryService(tok, { cacheDir: freshCacheDir() })
    const s = await svcTok.getSession({ session_id: 's-big' })
    expect(s.token_estimate).toBe(12_345)
    expect(s.token_estimate_estimated).toBe(false)
  })

  it('include_messages=true&max_messages=20 → 返回 20 条且响应大于摘要路径', async () => {
    const backend = new FakeRichBackend()
    const svc = new SessionSummaryService(backend, { cacheDir: freshCacheDir() })
    const summary = JSON.stringify(await svc.getSession({ session_id: 's-big' }))
    const out = (await svc.getSession({ session_id: 's-big', include_messages: true, max_messages: 20 })) as {
      session: { messages: unknown[] }
    }
    expect(out.session.messages.length).toBe(20)
    const serialized = JSON.stringify(out)
    expect(serialized.length).toBeGreaterThan(summary.length)
  })

  it('before_seq 原样透传 backend，响应附带 next_before_seq', async () => {
    const backend = new FakeRichBackend()
    const svc = new SessionSummaryService(backend, { cacheDir: freshCacheDir() })
    const out = (await svc.getSession({ session_id: 's-big', include_messages: true, max_messages: 5, before_seq: 999 })) as {
      session: { messages: Array<{ seq: number }> }
      next_before_seq?: number
    }
    // 透传参数正确（beforeSeq camelCase，与任务约定一致）
    expect(backend.lastGetArgs).toEqual({ session_id: 's-big', max_messages: 5, beforeSeq: 999 })
    expect(out.session.messages.length).toBe(5)
    // next_before_seq = 本页最小 seq（供下次翻页）
    expect(out.next_before_seq).toBe(out.session.messages[0]?.seq)
    // 摘要路径不带 next_before_seq
    const sum = await svc.getSession({ session_id: 's-big' })
    expect(sum).not.toHaveProperty('next_before_seq')
  })

  it('缓存：60s 内第二次调用不调 backend；invalidate 后重建', async () => {
    const backend = new FakeRichBackend()
    const svc = new SessionSummaryService(backend, { cacheDir: freshCacheDir() })
    await svc.getSession({ session_id: 's-big' })
    expect(backend.getCalls).toBe(1)
    await svc.getSession({ session_id: 's-big' })
    expect(backend.getCalls).toBe(1) // 缓存命中，未再调 DSH
    svc.invalidate('s-big')
    await svc.getSession({ session_id: 's-big' })
    expect(backend.getCalls).toBe(2) // 失效后重建
  })

  it('缓存超 TTL（60s）后自动刷新', async () => {
    const dir = freshCacheDir()
    const backend = new FakeRichBackend()
    const svc = new SessionSummaryService(backend, { cacheDir: dir })
    await svc.getSession({ session_id: 's-big' })
    expect(backend.getCalls).toBe(1)
    // 把缓存文件的 generated_at 改到 120s 前（模拟 TTL 过期）
    writeFileSync(join(dir, 's-big.json'), JSON.stringify({ ...(await svc.getSession({ session_id: 's-big' })), generated_at: Date.now() - 120_000 }))
    await svc.getSession({ session_id: 's-big' })
    expect(backend.getCalls).toBe(2) // 过期 → 重建
  })

  it('缓存读写失败必须容错（坏 JSON / 目录不可写均不抛错）', async () => {
    const dir = freshCacheDir()
    const backend = new FakeRichBackend()
    const svc = new SessionSummaryService(backend, { cacheDir: dir })
    // 坏 JSON 缓存文件：读失败 → 现场重建
    writeFileSync(join(dir, 's-big.json'), '{not-json!!')
    const s1 = await svc.getSession({ session_id: 's-big' })
    expect(s1.id).toBe('s-big')
    expect(backend.getCalls).toBe(1)
    // 缓存目录不可写（用普通文件顶替目录路径 → mkdir/write 失败）：仍正常返回
    const file = join(freshCacheDir(), 'as-file')
    writeFileSync(file, 'x')
    const svc2 = new SessionSummaryService(new FakeRichBackend(), { cacheDir: file })
    const s2 = await svc2.getSession({ session_id: 's-big' })
    expect(s2.id).toBe('s-big')
    // invalidate 失败也不抛错
    expect(() => svc2.invalidate('s-big')).not.toThrow()
  })
})

// ---------------------------------------------------------------- agent 集成

/** 与 agent.integration.test.ts 相同的进程内双工 socket。 */
class FakeWebSocket implements WebSocketLike {
  readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  private toHub: (msg: WireMessage) => void = () => {}
  constructor() {}
  setHubSink(fn: (msg: WireMessage) => void): void {
    this.toHub = fn
  }
  send(data: string): void {
    try {
      this.toHub(JSON.parse(data) as WireMessage)
    } catch {
      /* ignore */
    }
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
  serverSend(msg: WireMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

async function buildAgentRig(backend: LocalHelmBackend): Promise<{ conn: HubConnection; agent: HelmNodeAgent; socket: FakeWebSocket; close: () => void }> {
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
    hubId: 'hub-test',
    schemaVersion: 1,
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    defaultNodeId: 'n-agent',
    tokenLookup: (id) => (id === 'n-agent' ? 'agent-token' : undefined),
    connections: conns,
    log: () => {},
  })
  const socket = new FakeWebSocket()
  const agent = new HelmNodeAgent({
    config: {
      node_id: 'n-agent',
      hub_url: 'ws://test/',
      token: 'agent-token',
      local_mcp_url: 'http://127.0.0.1:3457/mcp',
      local_mcp_token: 'local-tok',
      host_api_url: 'http://127.0.0.1:3080',
      display_name: 'agent-host',
      local_probe_ms: 10_000,
      reconcile_ms: 10_000,
    },
    backend,
    wsFactory: () => socket,
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    summaryCacheDir: freshCacheDir(),
    log: () => {},
  })
  const conn = new HubConnection({ cp, send: (m) => socket.serverSend(m), onClose: (id) => id && conns.delete(id) })
  socket.setHubSink((m) => conn.inbound(m))
  agent.start()
  socket.open()
  await settle()
  return {
    conn,
    agent,
    socket,
    close: () => {
      agent.stop()
      conn.close()
      store.close()
    },
  }
}

describe('HelmNodeAgent sessions_get 集成（GET_SESSION RPC 与 MCP_CALL 双路径）', () => {
  it('GET_SESSION RPC 返回摘要并缓存；PROMPT 后缓存失效', async () => {
    const backend = new FakeRichBackend()
    const rig = await buildAgentRig(backend)
    try {
      const s1 = (await rig.conn.request(NODE_METHODS.GET_SESSION, { session_id: 's-big' })) as { id: string; status: string }
      expect(JSON.stringify(s1).length).toBeLessThan(10_000)
      expect(s1.id).toBe('s-big')
      expect(backend.getCalls).toBe(1)
      // 缓存命中：第二次不再调 backend
      await rig.conn.request(NODE_METHODS.GET_SESSION, { session_id: 's-big' })
      expect(backend.getCalls).toBe(1)
      // PROMPT 成功后缓存失效 → 下次 GET_SESSION 重建
      await rig.conn.request(NODE_METHODS.PROMPT, { session_id: 's-big', message: 'hello' })
      await rig.conn.request(NODE_METHODS.GET_SESSION, { session_id: 's-big' })
      expect(backend.getCalls).toBe(2)
    } finally {
      rig.close()
    }
  })

  it('MCP_CALL sessions_get（线上 hub 实际转发路径）同样返回摘要，完整路径透传 max_messages', async () => {
    const backend = new FakeRichBackend()
    const rig = await buildAgentRig(backend)
    try {
      // 生产路径：hub cp.forward 统一走 NODE_METHODS.MCP_CALL，tool='sessions_get'
      const s1 = (await rig.conn.request(NODE_METHODS.MCP_CALL, { tool: 'sessions_get', args: { session_id: 's-big' } })) as {
        id: string
        last_message_summary?: string
      }
      expect(JSON.stringify(s1).length).toBeLessThan(10_000)
      expect(s1.id).toBe('s-big')
      expect(typeof s1.last_message_summary).toBe('string')
      // include_messages 完整路径：20 条消息 + next_before_seq
      const full = (await rig.conn.request(NODE_METHODS.MCP_CALL, {
        tool: 'sessions_get',
        args: { session_id: 's-big', include_messages: true, max_messages: 20 },
      })) as { session: { messages: Array<{ seq: number }> }; next_before_seq?: number }
      expect(full.session.messages.length).toBe(20)
      expect(full.next_before_seq).toBe(full.session.messages[0]?.seq)
      // 透传给本地 DSH 的参数正确（含 beforeSeq 翻页游标）
      expect(backend.lastGetArgs).toMatchObject({ session_id: 's-big', max_messages: 20 })
    } finally {
      rig.close()
    }
  })

  it('其他工具仍走 MCP_CALL 原样透传（不受 sessions_get 隔离影响）', async () => {
    const backend = new FakeRichBackend()
    const rig = await buildAgentRig(backend)
    try {
      const out = (await rig.conn.request(NODE_METHODS.MCP_CALL, {
        tool: 'code_read_file',
        args: { path: '/tmp/x.ts' },
      })) as { content: string }
      expect(out.content).toContain('/tmp/x.ts')
    } finally {
      rig.close()
    }
  })
})
