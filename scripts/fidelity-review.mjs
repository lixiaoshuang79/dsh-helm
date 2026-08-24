/**
 * Session 瘦身信息保真验收 —— 下游决策实验（2026-08-24）。
 *
 * 用独立第二模型（xdf 网关 qwen3.7-max，与生成侧不同供应商）做盲化评审：
 *   组 A：只看默认摘要（真实 buildSummary 输出）
 *   组 B：可读完整历史（fixture 1000 条全量文本）
 * 同一组 5 个问题，temperature=0。
 *
 * 用法：
 *   XDF_API_KEY=xxx node scripts/fidelity-review.mjs            # 跑全部
 *   XDF_API_KEY=xxx node scripts/fidelity-review.mjs long-task  # 单 fixture
 * 输出：docs/fidelity-review/<kind>.<group>.json（原始回答存档）
 * 事实命中检查打印到 stdout（评分依据）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFixtureMessages, GROUND_TRUTH, FIXTURE_KINDS } from '../packages/node-agent/tests/fixtures/fidelity-fixtures.mjs'
import { SessionSummaryService } from '../packages/node-agent/lib/summary.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'docs', 'fidelity-review')
const API = process.env.XDF_API_URL ?? 'http://menshen-code.test.xdf.cn/v1'
const KEY = process.env.XDF_API_KEY
const MODEL = process.env.XDF_REVIEW_MODEL ?? 'qwen3.7-max'

if (!KEY) {
  console.error('XDF_API_KEY 未设置')
  process.exit(1)
}

class FixtureBackend {
  constructor(kind) {
    this.messages = buildFixtureMessages(kind)
  }
  async callTool(name, args) {
    const max = typeof args.max_messages === 'number' ? args.max_messages : this.messages.length
    const tail = this.messages.slice(-max)
    return {
      structuredContent: {
        session: {
          id: 'sess-fixture',
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

const QUESTIONS = [
  '下一步应该做什么？为什么？',
  '哪些任务已完成、哪些未完成？',
  '最近一次失败的原因和恢复证据是什么？',
  '哪些文件/commit 可以验收？',
  '是否允许执行下一步写入/部署？缺什么确认？',
].map((q, i) => `${i + 1}. ${q}`).join('\n')

const SYSTEM = `你是资深代码评审员。下面给出一个开发会话的【材料】，之后有 5 个问题。
要求：
- 严格只依据材料中实际出现的内容回答；材料没有的信息必须明确写"材料中无此信息"，禁止推测、禁止编造。
- 每个问题单独回答，标注证据（引用材料原文片段）。
- 最后给出结论段：能否安全执行下一步写入/部署（允许/不允许/无法判断+缺什么）。`

async function chat(messages, retries = 2) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 240_000) // 4 分钟硬超时
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0,
        max_tokens: 4000,
      }),
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`xdf http ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = await res.json()
    return body.choices?.[0]?.message?.content ?? '(empty)'
  } catch (err) {
    clearTimeout(timer)
    if (retries > 0) {
      console.error(`  chat retry (${retries} left): ${err instanceof Error ? err.message : err}`)
      await new Promise((r) => setTimeout(r, 5000))
      return chat(messages, retries - 1)
    }
    throw err
  }
}

async function review(kind, group, material) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `【材料】\n${material}\n\n【问题】\n${QUESTIONS}` },
  ]
  const answer = await chat(messages)
  const rec = {
    kind, group, model: MODEL, ts: new Date().toISOString(),
    material_chars: material.length,
    answer,
  }
  const file = join(OUT_DIR, `${kind}.${group}.json`)
  writeFileSync(file, JSON.stringify(rec, null, 2))
  return answer
}

/** 事实命中检查：答案文本中是否出现 ground truth 关键片段。 */
function factHits(kind, group, answer) {
  const gt = GROUND_TRUTH[kind]
  const checks = [
    ['goal(远端目标)', gt.goal.slice(0, 12)],
    ['decision(决策)', gt.decision.slice(0, 8)],
    ['todo(待办)', gt.todo.slice(0, 10)],
    ['next_action(下一步)', gt.next_action.slice(0, 10)],
    ['commit', gt.commit ? gt.commit.slice(0, 8) : null],
    ['path(文件路径)', gt.path ? gt.path.slice(-20) : null],
    ['error(失败原因)', gt.error ? gt.error.slice(0, 18) : null],
    ['tests(测试结果)', gt.tests ? gt.tests.slice(0, 8) : null],
    ['redline(红线)', gt.redline ? gt.redline.slice(0, 12) : null],
    ['failure(失败记录)', gt.failure ? gt.failure.slice(0, 14) : null],
    ['pending(未确认)', gt.pending ? gt.pending.slice(0, 12) : null],
    ['secret(凭据-必须不出现)', gt.secret ?? null],
  ]
  const hits = []
  for (const [label, frag] of checks) {
    if (frag == null) continue
    const isSecret = label.includes('secret')
    const present = answer.includes(frag)
    hits.push({ label, present, bad: isSecret ? present : !present })
  }
  return hits
}

async function main() {
  const only = process.argv[2]
  const kinds = only ? [only] : FIXTURE_KINDS
  mkdirSync(OUT_DIR, { recursive: true })
  for (const kind of kinds) {
    console.log(`\n===== ${kind} =====`)
    const backend = new FixtureBackend(kind)
    const svc = new SessionSummaryService(backend, { cacheDir: join(tmpdir(), 'fidelity-cache-' + kind), log: () => {} })
    const summary = await svc.getSession({ session_id: 'sess-fixture' })
    const summaryText = JSON.stringify(summary, null, 2)
    const fullText = backend.messages.map((m) => `[${m.role}] ${m.text}`).join('\n')
    console.log(`材料: summary=${summaryText.length}B, full=${fullText.length}B`)

    const a = await review(kind, 'summary-only', summaryText)
    console.log(`--- 组A(只看摘要) 已存档 (${a.length} chars)`)
    const b = await review(kind, 'full-history', fullText)
    console.log(`--- 组B(完整历史) 已存档 (${b.length} chars)`)

    console.log('事实命中（bad=该组不该知道却知道/该知道却不知道）:')
    const rows = {}
    for (const [group, ans] of [['A', a], ['B', b]]) {
      rows[group] = {}
      for (const h of factHits(kind, group, ans)) rows[group][h.label] = h.present ? 'Y' : 'N'
    }
    for (const label of Object.keys(rows.A ?? {})) {
      const badA = factHits(kind, 'A', a).find((h) => h.label === label)?.bad
      console.log(`  ${label.padEnd(22)} A=${rows.A[label]} (bad=${badA})  B=${rows.B[label]}`)
    }
  }
  console.log('\n完成。原始回答存档: docs/fidelity-review/')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
