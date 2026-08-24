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

  /** 现场构建摘要：向 DSH 取最后 2 条消息（max_messages 实测有效）。 */
  async buildSummary(sessionId: string): Promise<SessionSummary> {
    // 优先用 DSH 的 max_messages=2 限制响应体积（探测确认有效）；
    // 若未来 DSH 忽略该参数返回全部消息，extractTail 兜底只取最后 2 条。
    const res = await this.backend.callTool('sessions_get', { session_id: sessionId, max_messages: 2 })
    const payload = (res.structuredContent ?? {}) as Record<string, unknown>
    const session = (payload.session ?? payload) as Record<string, unknown>
    const rawMessages = Array.isArray(session.messages) ? (session.messages as Array<Record<string, unknown>>) : []
    const messages = rawMessages.length > 2 ? rawMessages.slice(-2) : rawMessages

    const status = stringOf(session, ['status']) ?? 'unknown'
    const last = messages[messages.length - 1]
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    const lastAssistantText = lastAssistant ? stringOf(lastAssistant, ['text']) ?? '' : stringOf(session, ['lastAssistantText']) ?? ''

    return {
      id: stringOf(session, ['id', 'session_id']) ?? sessionId,
      title: stringOf(session, ['title']) ?? '',
      status,
      workspace: stringOf(session, ['workspace']) ?? '',
      // DSH 无 createdAt（探测结论 6），映射为空串
      created_at: stringOf(session, ['createdAt', 'created_at']) ?? '',
      updated_at: stringOf(session, ['updatedAt', 'updated_at']) ?? '',
      last_message_summary: last ? truncate(stringOf(last, ['text']) ?? '') : '',
      last_assistant_summary: truncate(lastAssistantText),
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

/** 截断到 MAX_SUMMARY_CHARS 字符（保留省略号占位）。 */
function truncate(s: string, max = MAX_SUMMARY_CHARS): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
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