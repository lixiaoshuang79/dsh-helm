/**
 * MCP Context Isolation（P0+P2）：sessions_get 响应瘦身。
 *
 * 病灶：ChatGPT→hub MCP(3471)→node-agent→本地 DSH daemon MCP 的 sessions_get
 * 原样返回 DSH 的完整 structuredContent（messages/runtime 全量），大 session
 * 单次响应可达几十上百 KB（实测 75KB+）。
 *
 * 本模块提供两层隔离：
 * - P0：默认只返回结构化摘要（~1KB），include_messages=true 时才走完整历史
 *   路径（透传 DSH，max_messages 限条数）。
 * - P2：摘要按 ~/.dsh/helm/summaries/<session_id>.json 缓存（0600，TTL 60s），
 *   命中直接返回、不调 DSH；PROMPT/RESUME/CANCEL/CREATE 后由 agent 失效。
 *
 * ── 本机 DSH daemon（agent-chatgpt-helm 0.1.1）sessions_get 探测结论（2026-08-24）──
 * 1. inputSchema 仅支持 { agent?, session_id, max_messages?(1..100) }，
 *    additionalProperties:false；但实测传入未知键（如 beforeSeq）不回 400，
 *    被服务器静默忽略（validator 未严格拒绝）。
 * 2. 返回结构：structuredContent.session = {
 *      id, agent, status('running'|'idle'|...), workspace, title, updatedAt,
 *      messages: [{ seq, time, role, text }], lastAssistantText,
 *      native: { live, sessionId } }
 * 3. max_messages 参数有效：不传时默认返回最后 10 条（大 session 75KB+），
 *    传 2 只返回最后 2 条（~1.7KB，大幅瘦身）。
 * 4. messages 元素含数字 seq（页面升序），但 beforeSeq 参数无效：传
 *    beforeSeq=9000 仍返回最后 N 条（未被过滤）→ DSH 0.1.1 无真实翻页。
 *    因此 next_before_seq 仅在响应里附带（供未来 DSH 支持时翻页），
 *    不能依赖它做真实分页。
 * 5. 返回中没有任何 token/usage 统计字段（全文检索 tokenUsage/usage/tokens
 *    只命中 messages 文本内容）→ token_estimate 只能估算（字符数/4）。
 * 6. 无 createdAt 字段，只有 updatedAt（created_at 映射为空串兜底）。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalHelmBackend } from './bridge.js'

/** 摘要文本截断上限（字符）。 */
export const MAX_SUMMARY_CHARS = 300
/** 摘要缓存 TTL（毫秒）。 */
export const SUMMARY_TTL_MS = 60_000
/** 摘要信息来源窗口：向 DSH 取最后 N 条消息（信息保真验收定值；
   *  更早事实经 history_ref + include_messages 显式获取，DSH 0.1.1 上限 100）。 */
export const SUMMARY_WINDOW = 20

/** GET_SESSION 请求参数（hub schema 透传；未传按默认处理）。 */
export interface GetSessionParams {
  session_id: string
  /** true=完整历史路径（兼容旧用户）；缺省=false 走摘要。 */
  include_messages?: boolean
  /** 完整路径下返回的最大消息条数（默认 20；DSH 上限 100）。 */
  max_messages?: number
  /** 分页游标：取 seq 小于该值的更早消息（DSH 0.1.1 尚未实现，原样透传）。 */
  before_seq?: number
}

/** 结构化摘要（默认返回）。 */
export interface SessionSummary {
  id: string
  title: string
  status: string
  workspace: string
  created_at: string
  updated_at: string
  last_message_summary: string
  last_assistant_summary: string
  /** 当前目标：窗口内行动性最高的 user 消息（DSH 无 goal 字段；行动性排序见 actionScore）。 */
  current_goal: string
  /** current_goal 来源消息的 seq（追溯证据）。 */
  current_goal_seq?: number
  /** 窗口内最后一条有实质内容的 user 消息原文（证据保留，不被行动性排序覆盖）。 */
  last_user_message: string
  /** 窗口内启发式提取的工程证据（正则；每类 ≤3 条；extracted=true 表示启发式）。 */
  recent_evidence: {
    commits: string[]
    paths: string[]
    errors: string[]
    tests: string[]
    extracted: true
  }
  /** 完整历史/更早事实的 artifact 引用（P1 修复：远端事实经此显式获取）。 */
  history_ref: {
    include_messages: true
    max_messages: number
    before_seq?: number
    /** DSH 0.1.1 实际可达的消息条数上限（max_messages≤100 且 beforeSeq 无效）。 */
    reachable_max_messages: number
    pagination: 'dsh-beforeSeq-unsupported-0.1.1'
  }
  /** true=窗口内检测到疑似凭据并被清洗（摘要文本已剔除）。 */
  safety_sanitized: boolean
  /** 数字令牌数：有 DSH 真实统计用真实值，否则为估算值。 */
  token_estimate: number
  /** true=token_estimate 为估算值（无真实统计字段时）。 */
  token_estimate_estimated: boolean
  continuation_available: boolean
  /** 缓存生成时间（epoch ms），仅在返回给调用方时附带。 */
  generated_at?: number
}

export interface SessionSummaryServiceOptions {
  /** 摘要缓存目录（默认 ~/.dsh/helm/summaries）。 */
  cacheDir: string
  log?: (line: string) => void
}

/**
 * sessions_get 响应隔离服务：摘要构建 + 完整历史透传 + 摘要缓存。
 * agent 的 GET_SESSION 与 MCP_CALL(sessions_get) 两个入口都复用本服务，
 * 保证无论 hub 转发走哪条 RPC 都生效。
 */
export class SessionSummaryService {
  private backend: LocalHelmBackend
  private cacheDir: string
  private logFn?: (line: string) => void

  constructor(backend: LocalHelmBackend, opts: SessionSummaryServiceOptions) {
    this.backend = backend
    this.cacheDir = opts.cacheDir
    this.logFn = opts.log
  }

  private log(line: string): void {
    this.logFn?.(line)
  }

  /** 统一入口：include_messages=true 走完整历史，否则走摘要（缓存优先）。 */
  async getSession(params: GetSessionParams): Promise<unknown> {
    const { session_id, include_messages, max_messages, before_seq } = params
    if (!session_id) throw new Error('sessions_get: missing session_id')
    if (include_messages === true) {
      // 完整历史路径（兼容旧用户）：透传 DSH，限制条数 + 分页参数原样透传
      const res = await this.backend.callTool('sessions_get', {
        session_id,
        max_messages: max_messages ?? 20,
        beforeSeq: before_seq,
      })
      const base = (res.structuredContent ?? (res.content ? { content: res.content } : {})) as Record<string, unknown>
      // 分页：DSH messages 元素含 seq（探测确认），附带 next_before_seq 供翻页
      const msgs = extractMessages(base)
      if (msgs.length > 0 && msgs.every((m) => typeof m.seq === 'number')) {
        return { ...base, next_before_seq: Math.min(...(msgs.map((m) => m.seq as number))) }
      }
      return base
    }
    // 默认：摘要路径（缓存命中直接返回，不调 DSH）
    const cached = this.readCache(session_id)
    if (cached) return cached
    const summary = await this.buildSummary(session_id)
    const enriched: SessionSummary = { ...summary, generated_at: Date.now() }
    this.writeCache(session_id, enriched)
    return enriched
  }

  /** 现场构建摘要：向 DSH 取最后 20 条消息（max_messages 实测有效；更早事实
   *  经 history_ref 显式获取——DSH 0.1.1 beforeSeq 无效，最大可达 100 条）。 */
  async buildSummary(sessionId: string): Promise<SessionSummary> {
    const res = await this.backend.callTool('sessions_get', { session_id: sessionId, max_messages: SUMMARY_WINDOW })
    const payload = (res.structuredContent ?? {}) as Record<string, unknown>
    const session = (payload.session ?? payload) as Record<string, unknown>
    const rawMessages = Array.isArray(session.messages) ? (session.messages as Array<Record<string, unknown>>) : []
    const messages = rawMessages.length > SUMMARY_WINDOW ? rawMessages.slice(-SUMMARY_WINDOW) : rawMessages
    const status = stringOf(session, ['status']) ?? 'unknown'
    const last = messages[messages.length - 1]
    // current_goal：窗口内「有实质内容」的 user 消息中按行动性排序取最高者
    // （显式 next_action/计划信号 > 命令式动词 > 其余；同分取更近），
    // 避免无行动性的模板/确认文本覆盖明确目标；附来源 seq 供追溯。
    const users = messages.filter((m) => m.role === 'user' && isSubstantiveUserMessage(stringOf(m, ['text']) ?? ''))
    const goalMsg = users.reduce<{ m: Record<string, unknown>; score: number; seq: number } | undefined>((best, m) => {
      const score = actionScore(stringOf(m, ['text']) ?? '')
      const seq = typeof m.seq === 'number' ? (m.seq as number) : -1
      if (!best || score > best.score || (score === best.score && seq >= best.seq)) return { m, score, seq }
      return best
    }, undefined)
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && isSubstantiveUserMessage(stringOf(m, ['text']) ?? ''))
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    const lastAssistantText = lastAssistant ? stringOf(lastAssistant, ['text']) ?? '' : stringOf(session, ['lastAssistantText']) ?? ''
    const evidence = extractEvidence(messages)
    // 凭据清洗标记：任一窗口消息文本被剔除疑似凭据行（摘要字段统一经 sanitize）
    const sanitized = messages.some((m) => sanitizeSecretLines(stringOf(m, ['text']) ?? '') !== stringOf(m, ['text']))

    return {
      id: stringOf(session, ['id', 'session_id']) ?? sessionId,
      title: sanitizeSecretLines(stringOf(session, ['title']) ?? ''),
      status,
      workspace: sanitizeSecretLines(stringOf(session, ['workspace']) ?? ''),
      // DSH 无 createdAt（探测结论 6），映射为空串
      created_at: stringOf(session, ['createdAt', 'created_at']) ?? '',
      updated_at: sanitizeSecretLines(stringOf(session, ['updatedAt', 'updated_at']) ?? ''),
      last_message_summary: last ? sanitizeSecretLines(truncate(stringOf(last, ['text']) ?? '')) : '',
      last_assistant_summary: sanitizeSecretLines(truncate(lastAssistantText)),
      current_goal: goalMsg ? sanitizeSecretLines(truncate(stringOf(goalMsg.m, ['text']) ?? '')) : '',
      current_goal_seq: goalMsg && typeof goalMsg.m.seq === 'number' ? (goalMsg.m.seq as number) : undefined,
      last_user_message: lastUser ? sanitizeSecretLines(truncate(stringOf(lastUser, ['text']) ?? '')) : '',
      recent_evidence: evidence,
      history_ref: {
        include_messages: true,
        max_messages: SUMMARY_WINDOW,
        before_seq: messages.length > 0 && typeof messages[0]?.seq === 'number' ? (messages[0].seq as number) : undefined,
        reachable_max_messages: 100,
        pagination: 'dsh-beforeSeq-unsupported-0.1.1',
      },
      safety_sanitized: sanitized,
      // token：优先用 DSH 返回里的 token/usage 字段（探测：当前版本无），
      // 没有就估算（字符数/4，取整，标记 estimated）
      ...tokenEstimate(session, messages),
      // status 为 idle（或 DSH 返回可继续字段）→ 可继续对话
      continuation_available: status === 'idle' || truthy(session, ['continuation_available', 'canContinue', 'resumable']),
    }
  }

  /** 删除某会话的摘要缓存（PROMPT/RESUME/CANCEL/CREATE 成功后调用）。 */
  invalidate(sessionId: string): void {
    try {
      rmSync(this.cachePath(sessionId), { force: true })
    } catch (err) {
      this.log(`summary cache invalidate failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private cachePath(sessionId: string): string {
    return join(this.cacheDir, `${sessionId}.json`)
  }

  /** 读缓存；不存在/损坏/超 TTL 一律视为未命中（容错，不外抛）。 */
  private readCache(sessionId: string): SessionSummary | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath(sessionId), 'utf8')) as SessionSummary
      if (typeof parsed.generated_at !== 'number') return undefined
      if (Date.now() - parsed.generated_at > SUMMARY_TTL_MS) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  /** 写缓存（0600，目录自动创建）；失败仅记日志不抛错。 */
  private writeCache(sessionId: string, data: SessionSummary): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      writeFileSync(this.cachePath(sessionId), JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch (err) {
      this.log(`summary cache write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** 从 payload（structuredContent）提取消息数组：兼容 {session:{messages}} 与 {messages}。 */
function extractMessages(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const session = payload.session
  if (session && typeof session === 'object' && Array.isArray((session as Record<string, unknown>).messages)) {
    return (session as Record<string, unknown>).messages as Array<Record<string, unknown>>
  }
  if (Array.isArray(payload.messages)) return payload.messages as Array<Record<string, unknown>>
  return []
}

/** 按候选键名取首个字符串值（探测所得 DSH 字段名的兼容映射）。 */
function stringOf(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null) return String(v)
  }
  return undefined
}

function truthy(obj: Record<string, unknown>, keys: string[]): boolean {
  for (const k of keys) {
    const v = obj[k]
    if (v === true || v === 'true' || v === 1) return true
  }
  return false
}

/** 有实质内容的 user 消息（current_goal 来源过滤）：长度 >6 且非纯确认词。
 * 注意：确认词必须整串锚定（CJK 文本无 ASCII 词边界，\b 对中文无效）。
 */
function isSubstantiveUserMessage(text: string): boolean {
  const t = text.trim()
  if (t.length <= 6) return false
  if (/^(继续|好的?|好|OK|ok|嗯|是的?|对|收到|可以|行|知道了?|了解)[。.!！]?$/.test(t)) return false
  return true
}

/** 显式 next_action/计划信号（+2）：下一步/接下来/请/待办/记得/马上/立即/务必/请先/先做 */
const ACTION_HIGH = /(下一步|接下来|请|待办|记得|马上|立即|务必|优先|请先|先做|现在|马上)/
/** 命令式动词起始（+1）。 */
const ACTION_LOW = /^(实现|修复|处理|生成|检查|更新|补充|运行|跑|执行|创建|删除|改为|改成|继续写|写|调|查|测|测试|部署|提交|推送|合并|解决|优化|重构|清理|验证)/

/**
 * user 消息行动性打分（current_goal 选择依据）：显式 next_action > 命令式动词 > 其余。
 * 目标：无行动性的模板/确认文本不得覆盖明确目标/next_action；同分取更近消息。
 */
export function actionScore(text: string): number {
  const t = text.trim()
  if (ACTION_HIGH.test(t)) return 2
  if (ACTION_LOW.test(t)) return 1
  return 0
}

/** 截断到 MAX_SUMMARY_CHARS 字符（保留省略号占位）。 */
function truncate(s: string, max = MAX_SUMMARY_CHARS): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

/**
 * 凭据清洗：剔除疑似凭据的片段（Bearer token、API key/token/password/secret
 * 赋值、sk-* 形密钥、AKIA 形 AWS key）。用于所有摘要文本字段之前。
 * 注意：清洗的目的是"摘要不携带秘密"，不修改 DSH 原始消息。
 */
const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b(?:api[_-]?key|access[_-]?key|token|password|passwd|secret|client[_-]?secret)\s*[:=]\s*[^\s,;"']{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]
function sanitizeSecretLines(s: string): string {
  let out = s
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

/**
 * 窗口内启发式提取工程证据（正则去重，每类 ≤3 条）。
 * extracted:true 固定标注——这些不是 DSH 结构化字段，是文本正则提取。
 */
export interface RecentEvidence {
  commits: string[]
  paths: string[]
  errors: string[]
  tests: string[]
  extracted: true
}
export function extractEvidence(messages: Array<Record<string, unknown>>): RecentEvidence {
  const commits: string[] = []
  const paths: string[] = []
  const errors: string[] = []
  const tests: string[] = []
  const seen = new Set<string>()
  const pushIfNew = (arr: string[], v: string): void => {
    if (v && !seen.has(v) && arr.length < 3) {
      seen.add(v)
      arr.push(v)
    }
  }
  for (const m of messages) {
    const text = sanitizeSecretLines(stringOf(m, ['text']) ?? '')
    // commit hash：必须带 commit 前缀（避免误抓随机 hex）
    for (const mm of text.matchAll(/commit\s+([0-9a-f]{7,40})/g)) {
      pushIfNew(commits, mm[1]!)
    }
    // 文件/测试路径
    for (const mm of text.matchAll(/\/(?:[\w.-]+\/)*[\w.-]+\.(?:ts|js|py|go|rs|java|md|json|yaml|yml|sh|sql|conf)\b/g)) {
      pushIfNew(paths, mm[0]!)
    }
    // 错误行（跳过"修复…失败"这类指令文本，避免把修复要求当错误）
    for (const mm of text.matchAll(/(?:Error|error|ERROR|失败|错误)[^\n]{0,60}/g)) {
      const line = mm[0]!.trim().slice(0, 80)
      if (/^修复.{0,20}(失败|错误)/.test(line)) continue
      pushIfNew(errors, line)
    }
    // 测试结果
    for (const mm of text.matchAll(/\d+\s+passed[^\n]{0,40}|\d+\s+failed[^\n]{0,40}|PASS[^\n]{0,40}|FAIL[^\n]{0,40}/g)) {
      pushIfNew(tests, mm[0]!.trim().slice(0, 80))
    }
  }
  return { commits: commits.slice(0, 3), paths: paths.slice(0, 3), errors: errors.slice(0, 3), tests: tests.slice(0, 3), extracted: true }
}

/**
 * token 估算：优先 DSH 真实统计字段（tokenUsage/token_usage/usage/tokens/
 * tokenCount/totalTokens，支持 usage.total_tokens 嵌套），无则按
 * 消息文本字符数/4 估算（取整；中文约 2 字符/token，英文约 4 字符/token，
 * 4 字符/token 为偏保守基准）。
 */
function tokenEstimate(
  session: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
): Pick<SessionSummary, 'token_estimate' | 'token_estimate_estimated'> {
  for (const key of ['tokenUsage', 'token_usage', 'totalTokens', 'total_tokens', 'tokens', 'usage', 'tokenCount']) {
    const v = session[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      return { token_estimate: Math.round(v), token_estimate_estimated: false }
    }
    if (v && typeof v === 'object') {
      const nested = v as Record<string, unknown>
      for (const k of ['total_tokens', 'totalTokens', 'total']) {
        if (typeof nested[k] === 'number' && Number.isFinite(nested[k])) {
          return { token_estimate: Math.round(nested[k] as number), token_estimate_estimated: false }
        }
      }
    }
  }
  const chars = messages.reduce((acc, m) => acc + (typeof m.text === 'string' ? m.text.length : 0), 0)
  return { token_estimate: Math.max(1, Math.round(chars / 4)), token_estimate_estimated: true }
}