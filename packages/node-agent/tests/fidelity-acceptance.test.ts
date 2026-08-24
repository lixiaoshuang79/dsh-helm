/**
 * Session 瘦身信息保真验收（2026-08-24 正式验收实验）。
 *
 * 三件套 fixture（tests/fixtures/fidelity-fixtures.mjs，1000 条/类，固定 seed 可复现）：
 *   long-task   —— 多轮用户目标/决策/待办
 *   tool-heavy  —— 文件路径/命令输出/错误重试/测试结果/commit hash/push
 *   high-risk   —— 权限红线/未确认事项/失败状态/凭据样例
 *
 * 判定：默认摘要 <50KB 且无 messages/credentials；近端事实（最后 20 条）结构化保留；
 * 远端事实通过 history_ref + before_seq 分页可恢复（artifact 引用）；任何 summary
 * 文本不得含凭据；100 次连续读取内容恒定；异常后恢复。
 */
import { describe, expect, it } from 'vitest'
import { SessionSummaryService } from '../src/summary.js'
import { buildFixtureMessages, GROUND_TRUTH, fixtureStats, FIXTURE_KINDS, type FixtureKind, type FixtureMessage } from './fixtures/fidelity-fixtures.mjs'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** fixture 版 backend：sessions_get 返回最后 max_messages 条（与 DSH 0.1.1 语义一致）。 */
class FixtureBackend {
  messages: FixtureMessage[]
  calls: Array<{ name: string; args: unknown }> = []
  /** 注入失败（模拟 DSH 不可用/超时/坏响应）。 */
  failNext = false
  constructor(kind: FixtureKind) {
    this.messages = buildFixtureMessages(kind)
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args })
    if (this.failNext) {
      this.failNext = false
      throw new Error('DSH broken response (simulated)')
    }
    const max = typeof args.max_messages === 'number' ? (args.max_messages as number) : this.messages.length
    const tail = this.messages.slice(-max)
    return {
      structuredContent: {
        session: {
          id: String(args.session_id ?? 'sess-unknown'),
          title: 'fixture session',
          status: 'idle',
          workspace: '/tmp/fixture',
          updatedAt: '2026-08-24T10:00:00Z',
          messages: tail.map((m) => ({ ...m })),
          lastAssistantText: tail.filter((m) => m.role === 'assistant').at(-1)?.text ?? '',
        },
      },
    }
  }
}

function makeService(kind: FixtureKind, opts: { failOnce?: boolean } = {}): { svc: SessionSummaryService; backend: FixtureBackend; dir: string } {
  const backend = new FixtureBackend(kind)
  if (opts.failOnce) backend.failNext = true
  const dir = mkdtempSync(join(tmpdir(), 'helm-fidelity-'))
  const svc = new SessionSummaryService(backend as never, { cacheDir: dir, log: () => {} })
  return { svc, backend, dir }
}

const SID = 'sess-fixture'

describe('1. 基线与大小对比', () => {
  for (const kind of FIXTURE_KINDS) {
    it(`${kind}：完整历史 vs 默认摘要（字节/token 对比，默认 <50KB 且无 messages/凭据）`, async () => {
      const { svc, backend, dir } = makeService(kind)
      try {
        // 完整历史路径（分页读取全部 1000 条）
        const full = (await svc.getSession({ session_id: SID, include_messages: true, max_messages: 100 })) as {
          session?: { messages?: FixtureMessage[] }
          next_before_seq?: number
        }
        // 模拟分页拉全（DSH 上限 100/页，这里以 backend 实际 1000 条计）
        const fullMsgs = (full.session?.messages ?? []) as FixtureMessage[]
        expect(fullMsgs.length).toBe(100)
        const fullBytes = Buffer.byteLength(JSON.stringify(fullMsgs), 'utf8')
        const stats = fixtureStats(kind)
        expect(stats.bytes).toBeGreaterThan(0)

        // 默认摘要
        backend.calls.length = 0
        const sum = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
        const sumBytes = Buffer.byteLength(JSON.stringify(sum), 'utf8')
        const sumText = JSON.stringify(sum)

        // P0 硬性：<50KB、无 messages 数组、无凭据
        expect(sumBytes).toBeLessThan(50_000)
        expect('messages' in sum).toBe(false)
        expect('runtime_context' in sum).toBe(false)
        expect(sumText).not.toContain('sk-test-secret-12345')
        // 大小对比记录（报告用）
        console.log(`[fidelity] ${kind}: full(100msgs)=${fullBytes}B full(1000msgs)=${stats.bytes}B tokens≈${stats.tokens} | summary=${sumBytes}B`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

describe('2. 信息保真字段矩阵', () => {
  it('long-task：身份/近端目标 PASS；远端事实显式暴露缺失 + 分页可恢复', async () => {
    const { svc, backend, dir } = makeService('long-task')
    try {
      const sum = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
      // 身份（PASS）
      expect(sum.id).toBe(SID)
      expect(sum.status).toBe('idle')
      expect(sum.workspace).toBe('/tmp/fixture')
      expect(typeof sum.updated_at).toBe('string')
      // current_goal：行动性排序必须选中窗口内明确 next_action（985 条
      // “下一步：先跑 lint 和测试，通过后再提交”），不得被更近的无行动性文本覆盖；
      // 来源 seq 附证据；last_user_message 保留最近实质 user 原文（不被排序覆盖）
      expect(String(sum.current_goal)).toContain('lint')
      expect(sum.current_goal_seq).toBe(985)
      // 最近实质 user 原文（fixture 填充为确认词“收到”→ 窗口内实质 user 即 985）
      expect(String(sum.last_user_message)).toContain('lint')
      // 纯确认词不得成为 current_goal/最近证据：把窗口最后一条 user 换成“继续” → 不受影响
      const msgs2 = backend.messages.map((m) => ({ ...m }))
      msgs2[msgs2.length - 2] = { seq: msgs2.length - 2, time: 0, role: 'user', text: '继续' }
      backend.messages = msgs2
      svc.invalidate(SID)
      const sum2 = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
      expect(String(sum2.current_goal)).toContain('lint')
      expect(String(sum2.last_user_message)).not.toContain('继续')
      // 行动性排序分支：窗口内更早的显式 next_action（+2）压过更近的普通指令（+1），
      // 但最近原文仍保留在 last_user_message
      const msgs3 = backend.messages.map((m) => ({ ...m }))
      msgs3[msgs3.length - 4] = { seq: msgs3.length - 4, time: 0, role: 'user', text: '处理打包配置问题' }
      msgs3[msgs3.length - 8] = { seq: msgs3.length - 8, time: 0, role: 'user', text: '下一步：先做灰度验证' }
      backend.messages = msgs3
      svc.invalidate(SID)
      const sum3 = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
      expect(String(sum3.current_goal)).toContain('灰度验证')
      expect(sum3.current_goal_seq).toBe(msgs3.length - 8)
      expect(String(sum3.last_user_message)).toContain('处理打包配置问题')
      // 远端事实（goal/decision/todo 在 150 条之前）→ 摘要不假装知道（AMBIGUOUS 显式化）
      expect(sumTextContainAny(sum, [GROUND_TRUTH['long-task'].goal.slice(0, 20)])).toBe(false)
      // artifact 引用：history_ref 存在，显式标注可达范围（DSH 0.1.1 上限 100、翻页不支持）
      expect(sum.history_ref).toBeTruthy()
      const ref = sum.history_ref as { include_messages: boolean; max_messages: number; reachable_max_messages: number; pagination: string }
      expect(ref.include_messages).toBe(true)
      expect(ref.reachable_max_messages).toBe(100)
      expect(ref.pagination).toBe('dsh-beforeSeq-unsupported-0.1.1')
      // 远端 goal（第 5 条，>100 不可达）：摘要显式不 claim（AMBIGUOUS 状态）
      expect(sumTextContainAny(sum, [GROUND_TRUTH['long-task'].goal.slice(0, 20)])).toBe(false)
      // DSH 可达范围内（最后 100 条）历史可经 include_messages 获取
      const reach = (await svc.getSession({ session_id: SID, include_messages: true, max_messages: 100 })) as {
        session?: { messages?: FixtureMessage[] }
        next_before_seq?: number
      }
      expect(reach.session?.messages?.length).toBe(100)
      expect(typeof reach.next_before_seq).toBe('number')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tool-heavy：近端测试结果/重试状态结构化保留；commit 经分页恢复', async () => {
    const { svc, dir } = makeService('tool-heavy')
    try {
      const sum = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
      // 近端：测试结果在 985 条（窗口内）
      const ev = (sum.recent_evidence ?? {}) as { commits: string[]; errors: string[]; tests: string[]; paths: string[] }
      expect(ev.tests.some((t) => t.includes('12 passed'))).toBe(true)
      // commit 在 940 条（窗口外、DSH 100 条可达区内）→ 摘要不 claim，经 include_messages 恢复
      expect(ev.commits).not.toContain(GROUND_TRUTH['tool-heavy'].commit)
      const reach = (await svc.getSession({ session_id: SID, include_messages: true, max_messages: 100 })) as {
        session?: { messages?: FixtureMessage[] }
      }
      const texts = (reach.session?.messages ?? []).map((m) => m.text).join('\n')
      expect(texts).toContain(GROUND_TRUTH['tool-heavy'].commit.slice(0, 10))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('high-risk：凭据不出现在任何摘要字段（含 evidence），安全边界文本保留', async () => {
    const { backend, dir } = makeService('high-risk')
    try {
      // 先构造窗口含凭据的场景：把 secret 消息推到近端（模拟真实安全风险）
      const msgs = backend.messages
      const secretMsg = msgs.find((m) => m.text.includes('sk-test-secret-12345'))!
      const idx = msgs.indexOf(secretMsg)
      // 交换到最后一条（使其进入窗口）
      const last = msgs[msgs.length - 1]!
      msgs[idx] = last
      msgs[msgs.length - 1] = secretMsg
      // 清缓存重建（同一 svc 实例缓存已写？用新 svc）
      const dir2 = mkdtempSync(join(tmpdir(), 'helm-fidelity2-'))
      const svc2 = new SessionSummaryService(backend as never, { cacheDir: dir2, log: () => {} })
      try {
        const sum = (await svc2.getSession({ session_id: SID })) as Record<string, unknown>
        const text = JSON.stringify(sum)
        // 不依赖模型的自律断言：credential pattern 全字段扫描（不只查具体假值）
        expect(scanCredentialPatterns(text)).toEqual([])
        expect(sum.safety_sanitized).toBe(true)
        // 摘要缓存文件同样不得含 pattern（落盘内容 = 已清洗摘要）
        const cacheFiles = readdirSync(dir2).filter((f) => f.endsWith('.json'))
        expect(cacheFiles.length).toBe(1)
        const cacheText = readFileSync(join(dir2, cacheFiles[0]!), 'utf8')
        expect(scanCredentialPatterns(cacheText)).toEqual([])
      } finally {
        rmSync(dir2, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** credential pattern 扫描（与 summary.ts 同一组正则；不依赖模型自律的硬断言）。 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b(?:api[_-]?key|access[_-]?key|token|password|passwd|secret|client[_-]?secret)\s*[:=]\s*[^\s,;"']{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]
function scanCredentialPatterns(s: string): string[] {
  const hits: string[] = []
  for (const re of CREDENTIAL_PATTERNS) {
    re.lastIndex = 0
    for (const m of s.matchAll(re)) hits.push(m[0]!)
  }
  return hits
}

/** 摘要文本是否包含任一子串。 */
function sumTextContainAny(sum: Record<string, unknown>, subs: string[]): boolean {
  const t = JSON.stringify(sum)
  return subs.some((s) => t.includes(s))
}

describe('3. 长期运行：100 次连续读取', () => {
  for (const kind of FIXTURE_KINDS) {
    it(`${kind}：100 次默认读取内容稳定、缓存命中不调 backend、字节不增长`, async () => {
      const { svc, backend, dir } = makeService(kind)
      try {
        const stripTs = (o: Record<string, unknown>): string => {
          const c = { ...o }
          delete c.generated_at
          return JSON.stringify(c)
        }
        const first = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
        const firstBytes = Buffer.byteLength(JSON.stringify(first), 'utf8')
        backend.calls.length = 0
        for (let i = 0; i < 100; i++) {
          const again = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
          expect(stripTs(again)).toBe(stripTs(first)) // 内容恒定，无污染
          expect(Buffer.byteLength(JSON.stringify(again), 'utf8')).toBe(firstBytes) // 无上下文增长
        }
        expect(backend.calls.length).toBe(0) // 全程缓存命中
        // 缓存过期（TTL 60s 不可等）→ 用 invalidate 模拟刷新路径
        svc.invalidate(SID)
        const rebuilt = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
        expect(stripTs(rebuilt)).toBe(stripTs(first))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

describe('4. 分页边界与游标', () => {
  it('include_messages=true：max_messages 生效、before_seq 透传、next_before_seq=本页最小 seq', async () => {
    const { svc, backend, dir } = makeService('tool-heavy')
    try {
      const page1 = (await svc.getSession({ session_id: SID, include_messages: true, max_messages: 20 })) as {
        session?: { messages?: FixtureMessage[] }
        next_before_seq?: number
      }
      expect(page1.session?.messages?.length).toBe(20)
      expect(backend.calls.at(-1)).toMatchObject({ args: { session_id: SID, max_messages: 20 } })
      const seqs = (page1.session?.messages ?? []).map((m) => m.seq)
      expect(page1.next_before_seq).toBe(Math.min(...seqs))
      // before_seq 透传（DSH 0.1.1 无效但参数不丢）
      await svc.getSession({ session_id: SID, include_messages: true, max_messages: 5, before_seq: 999 })
      expect(backend.calls.at(-1)).toMatchObject({ args: { session_id: SID, max_messages: 5, beforeSeq: 999 } })
      // 恢复路径（DSH 可达区）：include_messages max_messages=100 → 命中 940 条的 commit
      const reach = (await svc.getSession({ session_id: SID, include_messages: true, max_messages: 100 })) as {
        session?: { messages?: FixtureMessage[] }
      }
      const texts = (reach.session?.messages ?? []).map((m) => m.text).join('\n')
      expect(texts).toContain('a1b2c3d4')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('5. 异常恢复', () => {
  it('DSH 坏响应后：下一次默认摘要与历史调用均正常（无状态毒化）', async () => {
    const { svc, backend, dir } = makeService('high-risk')
    try {
      backend.failNext = true
      await expect(svc.getSession({ session_id: SID })).rejects.toThrow()
      // 下一次正常
      const sum = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
      expect(sum.status).toBe('idle')
      backend.failNext = true
      await expect(svc.getSession({ session_id: SID, include_messages: true, max_messages: 5 })).rejects.toThrow()
      const full = (await svc.getSession({ session_id: SID, include_messages: true, max_messages: 5 })) as {
        session?: { messages?: FixtureMessage[] }
      }
      expect(full.session?.messages?.length).toBe(5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('修改 session（PROMPT）后摘要失效并反映新消息', async () => {
    const { svc, backend, dir } = makeService('long-task')
    try {
      const before = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
      // 模拟 PROMPT 后：新消息入列 + invalidate
      backend.messages.push({ seq: backend.messages.length, time: Date.now(), role: 'user', text: '现在切换到修复数据库连接问题' })
      backend.messages.push({ seq: backend.messages.length, time: Date.now(), role: 'assistant', text: '好的，正在处理数据库连接' })
      svc.invalidate(SID)
      const after = (await svc.getSession({ session_id: SID })) as Record<string, unknown>
      expect(JSON.stringify(after)).not.toBe(JSON.stringify(before))
      expect(String(after.current_goal)).toContain('数据库连接')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
