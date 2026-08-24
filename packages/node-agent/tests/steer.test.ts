/**
 * steerPrompt 单元测试：结构化状态机 steered/queued/rejected/unavailable。
 *
 * 协议（DSH 0.1.1 实测）：宿主 API POST /api/session.prompt，
 * envelope {type:'client-request', rpcId, method, payload:{sessionId, mode:'steer',
 * content:[{type:'text',text}]}} → {type:'server-response', result:{ok, value:{accepted}}};
 * ok=false 时 error.code 即 rpc_code（steer-unavailable/bad-request/...）。
 */
import { describe, expect, it } from 'vitest'
import { steerPrompt, hostApiRpc } from '../src/steer.js'

/** 造一个 mock fetch：按请求顺序响应（先 session.list，再 session.prompt）。 */
function mockFetch(script: Array<(body: unknown) => { ok: boolean; value?: unknown; code?: string } | { throw: Error }>): typeof fetch {
  let i = 0
  return (async (_url: unknown, init?: { body?: string }) => {
    const step = script[Math.min(i++, script.length - 1)]!
    if ('throw' in step) throw step.throw
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string; payload?: unknown }
    // 检查 envelope 形状
    if (body.type !== 'client-request' || !body.method) throw new Error('bad envelope')
    if (step.ok) {
      return { ok: true, status: 200, json: async () => ({ type: 'server-response', result: { ok: true, value: step.value } }) } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        type: 'server-response',
        result: { ok: false, error: { code: step.code ?? 'unknown', message: 'rejected by DSH' } },
      }),
    } as unknown as Response
  }) as unknown as typeof fetch
}

const BASE = 'http://127.0.0.1:3080'
const SID = 'session-test-1'

describe('steerPrompt（mode=steer 注入）', () => {
  it('运行中会话 + steer 成功 → steered + session_was_running=true', async () => {
    const fetchImpl = mockFetch([
      { ok: true, value: { items: [{ sessionId: SID, running: true }] } },
      { ok: true, value: { accepted: true } },
    ])
    const r = await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: '立即停止', fetchImpl })
    expect(r.status).toBe('steered')
    expect(r.session_was_running).toBe(true)
    expect(r.accepted).toBe(true)
  })

  it('空闲会话 + steer 成功 → steered + session_was_running=false（DSH 实测接受并直接开回合）', async () => {
    const fetchImpl = mockFetch([
      { ok: true, value: { items: [{ sessionId: SID, running: false }] } },
      { ok: true, value: { accepted: true } },
    ])
    const r = await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: 'x', fetchImpl })
    expect(r.status).toBe('steered')
    expect(r.session_was_running).toBe(false)
  })

  it('DSH 拒绝（steer-unavailable 窗口关闭）→ rejected + code', async () => {
    const fetchImpl = mockFetch([
      { ok: true, value: { items: [] } },
      { ok: false, code: 'steer-unavailable' },
    ])
    const r = await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: 'x', fetchImpl })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('steer-unavailable')
    expect(r.reason).toContain('rejected by DSH')
  })

  it('DSH 拒绝（session-not-found）→ rejected + code', async () => {
    const fetchImpl = mockFetch([
      { ok: true, value: { items: [] } },
      { ok: false, code: 'session-not-found' },
    ])
    const r = await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: 'x', fetchImpl })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('session-not-found')
  })

  it('宿主 API 不可达 → unavailable（不 throw）', async () => {
    const fetchImpl = mockFetch([{ throw: new Error('connect ECONNREFUSED 127.0.0.1:3080') }])
    const r = await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: 'x', fetchImpl })
    expect(r.status).toBe('unavailable')
    expect(r.session_was_running).toBe(false)
    expect(r.reason).toContain('unreachable')
  })

  it('session.list 探测失败 → 仍提交 steer（按空闲处理，probe_error 标注）', async () => {
    const fetchImpl = mockFetch([
      { throw: new Error('probe boom') },
      { ok: true, value: { accepted: true } },
    ])
    const r = await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: 'x', fetchImpl })
    expect(r.status).toBe('steered')
    expect(r.session_was_running).toBe(false)
    expect(r.probe_error).toContain('probe boom')
  })

  it('hostApiRpc 发送的 envelope/payload 形状正确（client-request + content blocks + mode=steer）', async () => {
    const seen: Array<{ method: string; payload: unknown }> = []
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string; payload?: unknown }
      seen.push({ method: body.method ?? '', payload: body.payload })
      return {
        ok: true,
        status: 200,
        json: async () => ({ type: 'server-response', result: { ok: true, value: { accepted: true } } }),
      } as unknown as Response
    }) as unknown as typeof fetch
    await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: '纠偏', fetchImpl })
    expect(seen[0]!.method).toBe('session.list')
    expect(seen[1]!.method).toBe('session.prompt')
    const payload = seen[1]!.payload as { sessionId: string; mode: string; content: Array<{ type: string; text: string }> }
    expect(payload.sessionId).toBe(SID)
    expect(payload.mode).toBe('steer')
    expect(payload.content).toEqual([{ type: 'text', text: '纠偏' }])
  })

  it('timeout 触发 → unavailable（abort 信号）', async () => {
    const fetchImpl = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as typeof fetch
    const r = await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: 'x', fetchImpl, timeoutMs: 30 })
    expect(r.status).toBe('unavailable')
  })

  it('非 server-response 信封 → unavailable', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ type: 'unexpected' }) })) as unknown as typeof fetch
    const r = await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: 'x', fetchImpl })
    expect(r.status).toBe('unavailable')
  })

  it('accepted=false 且无错误码 → rejected（not accepted）', async () => {
    const fetchImpl = mockFetch([
      { ok: true, value: { items: [] } },
      { ok: true, value: { accepted: false } },
    ])
    const r = await steerPrompt({ hostApiUrl: BASE, sessionId: SID, message: 'x', fetchImpl })
    expect(r.status).toBe('rejected')
    expect(r.accepted).toBe(false)
  })
})

describe('hostApiRpc 边界', () => {
  it('HTTP 非 200 → throw（unavailable 语义由调用方转换）', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
    await expect(hostApiRpc({ hostApiUrl: BASE, fetchImpl }, 'session.list', {})).rejects.toThrow(/http 503/)
  })
})

// ---- agent 集成：PROMPT handler mode:'steer' 分流（复用 summary.test.ts 的 rig 模式）----

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection } from '../../hub/src/index.js'
import { NODE_METHODS, type WireMessage } from '../../protocol/src/index.js'
import { HelmNodeAgent, type WebSocketLike } from '../src/index.js'
import { FakeBackend } from './backend-fixtures.js'
import type { LocalHelmBackend } from '../src/bridge.js'

class FakeWebSocket implements WebSocketLike {
  readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  private toHub: (msg: WireMessage) => void = () => {}
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

function freshCacheDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'helm-summary-'))
  return d
}

async function buildSteerRig(backend: LocalHelmBackend): Promise<{ conn: HubConnection; agent: HelmNodeAgent; close: () => void }> {
  const store = new DshHelmStore({ file: ':memory:' })
  const nodes = new NodeRegistry(store.db)
  const sessions = new SessionCatalog(store.db)
  const workspaces = new WorkspaceCatalog(store.db)
  const presence = new PresenceRegistry(store.db)
  const conns = new Map<string, HubConnection>()
  const cp = new ControlPlane({
    store, nodes, sessions, workspaces, presence,
    hubId: 'hub-test', schemaVersion: 1, heartbeatMs: 15_000, leaseMs: 45_000,
    defaultNodeId: 'n-agent',
    tokenLookup: (id) => (id === 'n-agent' ? 'agent-token' : undefined),
    connections: conns,
    log: () => {},
  })
  const socket = new FakeWebSocket()
  const agent = new HelmNodeAgent({
    config: {
      node_id: 'n-agent', hub_url: 'ws://test/', token: 'agent-token',
      local_mcp_url: 'http://127.0.0.1:3457/mcp', local_mcp_token: 'local-tok',
      host_api_url: 'http://127.0.0.1:3080', display_name: 'agent-host',
      local_probe_ms: 10_000, reconcile_ms: 10_000,
    },
    backend, wsFactory: () => socket, heartbeatMs: 15_000, leaseMs: 45_000,
    summaryCacheDir: freshCacheDir(), log: () => {},
  })
  const conn = new HubConnection({ cp, send: (m) => socket.serverSend(m), onClose: (id) => id && conns.delete(id) })
  socket.setHubSink((m) => conn.inbound(m))
  agent.start()
  socket.open()
  await settle()
  return {
    conn, agent,
    close: () => {
      agent.stop()
      conn.close()
      store.close()
      rmSync(freshCacheDir(), { recursive: true, force: true })
    },
  }
}

describe('HelmNodeAgent PROMPT 集成（mode 分流）', () => {
  it('mode=steer → 经宿主 API 注入并返回结构化 steered（运行中会话）', async () => {
    const backend = new FakeBackend({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    const rig = await buildSteerRig(backend)
    try {
      // mock 宿主 API：session.list running=true + session.prompt accepted
      let promptPayload: unknown
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string; payload?: unknown }
        if (body.method === 'session.prompt') promptPayload = body.payload
        const value = body.method === 'session.list' ? { items: [{ sessionId: 's-1', running: true }] } : { accepted: true }
        return { ok: true, status: 200, json: async () => ({ type: 'server-response', result: { ok: true, value } }) } as unknown as Response
      }) as typeof fetch
      try {
        const out = (await rig.conn.request(NODE_METHODS.PROMPT, { session_id: 's-1', message: '立即停止', mode: 'steer' })) as {
          status: string
          session_was_running: boolean
        }
        expect(out.status).toBe('steered')
        expect(out.session_was_running).toBe(true)
        // 提交的 payload 形状正确
        const p = promptPayload as { sessionId: string; mode: string; content: Array<{ type: string; text: string }> }
        expect(p.sessionId).toBe('s-1')
        expect(p.mode).toBe('steer')
        expect(p.content).toEqual([{ type: 'text', text: '立即停止' }])
        // steer 成功 → 摘要缓存失效（后端 MCP sessions_get 未被调用过，纯断言不抛错）
        expect(backend.calls.length).toBe(0)
      } finally {
        globalThis.fetch = realFetch
      }
    } finally {
      rig.close()
    }
  })

  it('无 mode（默认 queue）→ 仍走原 MCP 路径（sessions_prompt 不带 mode）', async () => {
    const backend = new FakeBackend({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    const rig = await buildSteerRig(backend)
    try {
      const out = (await rig.conn.request(NODE_METHODS.PROMPT, { session_id: 's-1', message: 'hello' })) as Record<string, unknown>
      expect(out).toBeDefined()
      const promptCall = backend.calls.find((c) => c.name === 'sessions_prompt')
      expect(promptCall).toBeDefined()
      expect(promptCall?.args).toEqual({ session_id: 's-1', message: 'hello' })
    } finally {
      rig.close()
    }
  })

  it('宿主 API 不可达 + mode=steer → 结构化 unavailable（不 throw、不影响后续）', async () => {
    const backend = new FakeBackend({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    const rig = await buildSteerRig(backend)
    try {
      const realFetch = globalThis.fetch
      globalThis.fetch = (async () => {
        throw new Error('connect ECONNREFUSED')
      }) as typeof fetch
      try {
        const out = (await rig.conn.request(NODE_METHODS.PROMPT, { session_id: 's-1', message: 'x', mode: 'steer' })) as {
          status: string
        }
        expect(out.status).toBe('unavailable')
        // 之后普通 PROMPT（queue）不受影响
        const ok = (await rig.conn.request(NODE_METHODS.PROMPT, { session_id: 's-1', message: 'y' })) as Record<string, unknown>
        expect(ok).toBeDefined()
      } finally {
        globalThis.fetch = realFetch
      }
    } finally {
      rig.close()
    }
  })
})

describe('HelmNodeAgent MCP_CALL 集成（线上真实转发路径）', () => {
  it('MCP_CALL sessions_prompt + mode=steer → 宿主 API 注入 + 结构化 steered（不碰 MCP 工具层）', async () => {
    const backend = new FakeBackend({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    const rig = await buildSteerRig(backend)
    try {
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string; payload?: { sessionId?: string; mode?: string } }
        const value =
          body.method === 'session.list'
            ? { items: [{ sessionId: 's-1', running: true }] }
            : { accepted: true }
        return { ok: true, status: 200, json: async () => ({ type: 'server-response', result: { ok: true, value } }) } as unknown as Response
      }) as typeof fetch
      try {
        // 线上 hub 实际转发路径：cp.forward → NODE_METHODS.MCP_CALL {tool:'sessions_prompt', args}
        const out = (await rig.conn.request(NODE_METHODS.MCP_CALL, {
          tool: 'sessions_prompt',
          args: { session_id: 's-1', message: '立即停止', mode: 'steer' },
        })) as { status: string; session_was_running: boolean }
        expect(out.status).toBe('steered')
        expect(out.session_was_running).toBe(true)
        // MCP 工具层（本地 DSH MCP backend）绝不能被调用（steer 不经过它）
        expect(backend.calls.some((c) => c.name === 'sessions_prompt')).toBe(false)
      } finally {
        globalThis.fetch = realFetch
      }
    } finally {
      rig.close()
    }
  })

  it('MCP_CALL sessions_prompt 无 mode → 仍透传 MCP 工具层（queue 语义不变）', async () => {
    const backend = new FakeBackend({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    const rig = await buildSteerRig(backend)
    try {
      const out = (await rig.conn.request(NODE_METHODS.MCP_CALL, {
        tool: 'sessions_prompt',
        args: { session_id: 's-1', message: 'hello' },
      })) as Record<string, unknown>
      expect(out).toBeDefined()
      const call = backend.calls.find((c) => c.name === 'sessions_prompt')
      expect(call?.args).toEqual({ session_id: 's-1', message: 'hello' })
    } finally {
      rig.close()
    }
  })

  it('MCP_CALL sessions_prompt + mode=steer + 宿主 API 拒绝 → 结构化 rejected（error code 透出）', async () => {
    const backend = new FakeBackend({ sessions: [{ session_id: 's-1', status: 'idle', live: false }] })
    const rig = await buildSteerRig(backend)
    try {
      const realFetch = globalThis.fetch
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          type: 'server-response',
          result: { ok: false, error: { code: 'steer-unavailable', message: 'steer window closed' } },
        }),
      })) as unknown as typeof fetch
      try {
        const out = (await rig.conn.request(NODE_METHODS.MCP_CALL, {
          tool: 'sessions_prompt',
          args: { session_id: 's-1', message: 'x', mode: 'steer' },
        })) as { status: string; code?: string }
        expect(out.status).toBe('rejected')
        expect(out.code).toBe('steer-unavailable')
      } finally {
        globalThis.fetch = realFetch
      }
    } finally {
      rig.close()
    }
  })
})
