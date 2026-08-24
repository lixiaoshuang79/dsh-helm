import { describe, expect, it } from 'vitest'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '../../store/src/index.js'
import { ControlPlane, HubConnection, HubMcpServer, applyGuard, MAX_RESPONSE_BYTES } from '../src/index.js'
import { FakeNode } from '../tests/fake-node.js'
import type { NodeInfo, WireMessage } from '../../protocol/src/index.js'
import type { McpCallResult } from '../src/mcp/server.js'

const result = (text: string, isError = false): McpCallResult => ({ content: [{ type: 'text', text }], isError })

describe('applyGuard（Response Size Guard）', () => {
  it('小响应原样返回（同一引用，不截断、不记日志）', () => {
    const r = result(JSON.stringify({ ok: true, n: 1 }))
    const logs: string[] = []
    const out = applyGuard(r, 'test_tool', (l) => logs.push(l))
    expect(out).toBe(r)
    expect(out.content[0]!.text).toBe(r.content[0]!.text)
    expect(logs).toHaveLength(0)
  })

  it('大 JSON 对象（messages 数组超大）→ 合法 JSON + truncated 元数据 + returned ≤ MAX', () => {
    const big = {
      messages: Array.from({ length: 2000 }, (_, i) => ({ role: 'user', content: `message ${i}: ` + 'x'.repeat(400) })),
      _route: { node_id: 'n-1', node_name: 'main' },
    }
    const r = result(JSON.stringify(big, null, 2))
    const original = Buffer.byteLength(r.content[0]!.text)
    expect(original).toBeGreaterThan(MAX_RESPONSE_BYTES)
    const out = applyGuard(r, 'sessions_get')
    const text = out.content[0]!.text
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
    const parsed = JSON.parse(text) as { messages?: unknown[]; truncated: { original_size: number; returned_size: number; tool: string } }
    expect(parsed.truncated).toBeDefined()
    expect(parsed.truncated.original_size).toBe(original)
    expect(parsed.truncated.returned_size).toBe(Buffer.byteLength(text))
    expect(parsed.truncated.tool).toBe('sessions_get')
    // 结构仍在：messages 数组被按比例砍尾
    expect(Array.isArray(parsed.messages)).toBe(true)
    expect(parsed.messages!.length).toBeGreaterThan(1)
    expect(parsed.messages!.length).toBeLessThan(2000)
  })

  it('单个超大字符串字段 → 该字段被截断、其余字段保留、JSON 合法', () => {
    const r = result(JSON.stringify({ title: 'T', body: 'b'.repeat(200_000), _route: { node_id: 'n-1' } }))
    const out = applyGuard(r, 'code_read_file')
    const text = out.content[0]!.text
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
    const parsed = JSON.parse(text) as { title: string; body: string; truncated: { tool: string } }
    expect(parsed.truncated.tool).toBe('code_read_file')
    expect(parsed.body.length).toBeLessThan(100_000)
    expect(parsed.body).toMatch(/\[truncated\]$/)
    expect(parsed.title).toBe('T')
  })

  it('纯文本超长 → UTF-8 边界截断 + 标记，returned ≤ MAX', () => {
    // 中文多字节内容：确保截断不切坏 UTF-8 序列
    const r = result('plain-中文-'.repeat(20_000))
    const out = applyGuard(r, 'some_tool')
    const text = out.content[0]!.text
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
    expect(text).toMatch(/\[truncated original=\d+ returned=\d+\]$/)
    expect(text).not.toBe(r.content[0]!.text)
    // 解码无 U+FFFD（没有切断的多字节字符）
    expect(text).not.toContain('\uFFFD')
  })

  it('isError 响应同样过 guard', () => {
    const r = result('err ' + 'e'.repeat(200_000), true)
    const out = applyGuard(r, 'sessions_prompt')
    expect(out.isError).toBe(true)
    expect(Buffer.byteLength(out.content[0]!.text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
  })

  it('截断时输出日志行 [mcp-guard] <tool> original=.. returned=.. truncated', () => {
    const logs: string[] = []
    applyGuard(result('x'.repeat(MAX_RESPONSE_BYTES + 10)), 'tool_x', (l) => logs.push(l))
    expect(logs.some((l) => /^\[mcp-guard\] tool_x original=\d+ returned=\d+ truncated$/.test(l))).toBe(true)
    applyGuard(result('ok'), 'tool_y', (l) => logs.push(l))
    expect(logs.some((l) => l.includes('tool_y'))).toBe(false)
  })

  it('顶层 JSON 标量超长 → 包装对象 + truncated 元数据，仍合法 JSON', () => {
    const r = result(JSON.stringify('s'.repeat(MAX_RESPONSE_BYTES + 100)))
    const out = applyGuard(r, 'tool_s')
    const text = out.content[0]!.text
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
    const parsed = JSON.parse(text) as { value: string; truncated: { tool: string } }
    expect(parsed.truncated.tool).toBe('tool_s')
    expect(typeof parsed.value).toBe('string')
  })
})

describe('guard 集成：HubMcpServer 转发 node 超大响应', () => {
  function makeNodeInfo(id: string, name: string): NodeInfo {
    return {
      node_id: id,
      display_name: name,
      platform: { os: 'darwin', arch: 'arm64', release: 'test', nodeVersion: 'v22' },
      versions: { agent: '0.1.0', protocol: 1 },
      capabilities: { sessions: true, serena: true, tunnel: false, presenceProvider: true, defaultNode: name === 'main' },
    }
  }

  it('超大 sessions_get 响应被截断且记录指标', async () => {
    const store = new DshHelmStore({ file: ':memory:' })
    const nodes = new NodeRegistry(store.db)
    const sessions = new SessionCatalog(store.db)
    const workspaces = new WorkspaceCatalog(store.db)
    const presence = new PresenceRegistry(store.db)
    const conns = new Map<string, HubConnection>()
    const cp = new ControlPlane({
      store, nodes, sessions, workspaces, presence,
      hubId: 'hub-guard',
      schemaVersion: 1,
      heartbeatMs: 15_000,
      leaseMs: 45_000,
      defaultNodeId: 'n-a',
      tokenLookup: (id) => (id === 'n-a' ? 'tok' : undefined),
      connections: conns,
      log: () => {},
    })
    const mcp = new HubMcpServer({ cp, log: () => {} })
    const node = new FakeNode({ node: makeNodeInfo('n-a', 'main'), token: 'tok', schemaVersion: 1 })
    let toHub: (m: WireMessage) => void = () => {}
    let toNode: (m: WireMessage) => void = () => {}
    const conn = new HubConnection({ cp, send: (m) => toNode(m), onClose: (id) => id && conns.delete(id) })
    node.attach((m) => toHub(m))
    toHub = (m) => conn.inbound(m)
    toNode = (m) => node.inbound(m)
    node.start()
    // 等待握手完成、节点注册进 cp（轮询而非固定 settle，避免满负载下 flake）
    for (let i = 0; i < 100 && conns.size === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(conns.size).toBe(1)
    sessions.upsert('n-a', { native_session_id: 'sess-1', status: 'idle' })
    node.sessions = [{ native_session_id: 'sess-1', title: 'y'.repeat(200_000), status: 'idle', live: false }]

    const res = await mcp.callTool({ name: 'sessions_get', arguments: { session_id: 'sess-1' } })
    expect(res.isError).toBeFalsy()
    const text = res.content[0]!.text
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
    const parsed = JSON.parse(text) as { truncated: { tool: string }; _route: { node_id: string } }
    expect(parsed.truncated.tool).toBe('sessions_get')
    expect(parsed._route.node_id).toBe('n-a')
    // 指标同步记录（guard 后字节数）
    const snap = mcp.metrics.snapshot(1, '0.1.0')
    expect(snap.requestCount).toBe(1)
    expect(snap.truncationCount).toBe(1)
    const pt = snap.perTool.find((t) => t.tool === 'sessions_get')
    expect(pt?.count).toBe(1)
    expect(pt?.truncated).toBe(1)
    expect(snap.maxResponseBytes).toBe(Buffer.byteLength(text))
  })
})
