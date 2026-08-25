/**
 * Model declaration gate：ChatGPT 链路模型门禁（声明式）。
 *
 * 背景（2026-08-25 实测）：ChatGPT 网页版 → Secure MCP Tunnel → hub 的请求头
 * 不带任何模型信息（OpenAI tunnel 协议无 model 字段；实测 x-openai-session
 * 等头均为加密/诊断元数据），链路层无法感知调用方模型。因此采用声明式协议：
 * ChatGPT 总导演每次下发指令时，在消息文本里固定声明当前模型名（由 ChatGPT
 * 侧系统指令约束），hub 在路由前校验：
 *
 * - 消息含允许标识（gpt-5-6-thinking / gpt-5.6 thinking 等）→ 放行；
 * - 消息含 5.5-mini 标识 → 拒绝 `model_rejected`（附 received 原文）；
 * - 消息无任何模型声明 → 拒绝 `model_declaration_required`。
 *
 * 被拒响应为 MCP isError + JSON 文本 {code, required_model, received?, message}，
 * ChatGPT 可读原因并按提示切换模型后重试。
 */

/** 允许的模型标识（GPT-5.6 Thinking / GPT-5.6 Sol；宽松匹配各分隔符变体）。 */
const ALLOWED_RE = /gpt[\s_.-]*5[\s_.-]*6[\s_.-]*(thinking|sol)/i
/** 明确拒绝的模型标识（GPT-5.5 Mini 系）。 */
const REJECTED_RE = /5[\s_.-]*5[\s_.-]*mini/i

export const REQUIRED_MODEL = 'gpt-5-6-thinking / gpt-5-6-sol'

export type ModelGateResult =
  | { ok: true }
  | { ok: false; code: 'model_rejected'; received: string }
  | { ok: false; code: 'model_declaration_required' }

/** 校验一条待注入 DSH 的消息是否带允许的模型声明。 */
export function checkModelDeclaration(message: string): ModelGateResult {
  const text = String(message ?? '')
  if (ALLOWED_RE.test(text)) return { ok: true }
  const m = REJECTED_RE.exec(text)
  if (m) return { ok: false, code: 'model_rejected', received: m[0] }
  return { ok: false, code: 'model_declaration_required' }
}

/** 生成 MCP isError 响应文本（结构化，ChatGPT 可读）。 */
export function rejectionText(r: Extract<ModelGateResult, { ok: false }>): string {
  if (r.code === 'model_rejected') {
    return JSON.stringify({
      code: 'model_rejected',
      required_model: REQUIRED_MODEL,
      received: r.received,
      message: `[模型门禁拒绝] 本次指令未执行：ChatGPT 当前模型为「${r.received}」，不是要求的 ${REQUIRED_MODEL}（GPT-5.6 Thinking / GPT-5.6 Sol）。请切换到 GPT-5.6 Thinking 或 GPT-5.6 Sol 模型后，以 "[model-check] 当前模型是 <模型全名>" 开头重发同一指令。`,
    })
  }
  return JSON.stringify({
    code: 'model_declaration_required',
    required_model: REQUIRED_MODEL,
    message: `[模型门禁拒绝] 本次指令未执行：消息中未声明 ChatGPT 模型。请在消息第一行声明 "[model-check] 当前模型是 <模型全名>"（必须是 ${REQUIRED_MODEL} / GPT-5.6 Thinking、GPT-5.6 Sol）后重发同一指令。`,
  })
}

/** 需要模型声明门禁的工具（消息注入入口）。 */
export const MODEL_GATED_TOOLS: ReadonlySet<string> = new Set(['sessions_create', 'sessions_prompt'])