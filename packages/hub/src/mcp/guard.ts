/**
 * Response size guard for hub MCP tool responses（P1）。
 *
 * 每条工具响应在离开 hub 前都经过 applyGuard()：
 * - text ≤ MAX_RESPONSE_BYTES（UTF-8 字节数）→ 原样直通（返回原引用，
 *   调用方可凭引用同一性判断是否发生截断）；
 * - 超限且 text 是合法 JSON → smart truncate：优先收窄最大的字符串字段
 *   （content/text 类字段同量级时优先），宽度型载荷（超大数组）按比例砍
 *   尾部元素，并在对象上挂 `truncated: { original_size, returned_size,
 *   tool }` 元数据——返回的 text 必须仍是合法 JSON（硬要求：connector 要
 *   能 JSON.parse）；
 * - 超限且 text 不可解析（纯文本）→ UTF-8 边界安全截断 + 追加
 *   `\n... [truncated original=NN returned=MM]` 标记。
 *
 * 本 guard 是兜底防线：node-agent 侧对 sessions_get 等做默认摘要瘦身是
 * 第一道防线，任何工具响应超限最终都会在这里被处理。
 */

import type { McpCallResult } from './server.js'

/** 单条 MCP 工具响应文本的字节上限（UTF-8）。 */
export const MAX_RESPONSE_BYTES = 50_000

/** 截断元数据：挂在 JSON 对象上的 `truncated` 键。 */
export interface TruncationMeta {
  original_size: number
  returned_size: number
  tool: string
}

/** JSON 载荷里语义上"内容类"的字段名（同量级大小时优先截这些，而不是 ID/元数据）。 */
const CONTENT_KEYS = new Set(['text', 'content', 'message', 'summary', 'output', 'body', 'description', 'reply', 'error', 'title', 'name', 'path'])

/** 字符串字段截断后的内联后缀（纯 ASCII，JSON 转义无额外开销）。 */
const FIELD_SUFFIX = '...[truncated]'

/** 每次收窄预留的余量：回填 returned_size 时数字位数变化最多 ~9 字节，必须留足。 */
const SLACK_BYTES = 64

/** 结构化截断最大迭代次数（防病态形状空转；正常载荷 1-3 轮收敛）。 */
const MAX_ITERATIONS = 24

/**
 * 对一条 MCP 调用结果应用尺寸护栏。未超限返回原对象引用；超限返回截断后
 * 的新对象（content[0].text 为最终文本）。可传 log 回调打印截断日志。
 */
export function applyGuard(result: McpCallResult, tool: string, log?: (line: string) => void): McpCallResult {
  const content = result.content
  const text = content[0]?.text
  // hub 的所有响应都只有一条 text content；缺失时无物可护。
  if (text === undefined) return result
  const original = Buffer.byteLength(text)
  if (original <= MAX_RESPONSE_BYTES) return result

  let finalText: string
  const parsed = safeParse(text)
  if (parsed.ok) {
    // 原 text 是合法 JSON：截断后必须仍是合法 JSON（connector 硬依赖）。
    finalText = smartTruncateJson(parsed.value, tool, original)
  } else {
    finalText = truncatePlainText(text, original)
  }
  const returned = Buffer.byteLength(finalText)
  log?.(`[mcp-guard] ${tool} original=${original} returned=${returned} truncated`)
  return { ...result, content: [{ ...content[0]!, text: finalText }] }
}

// ---------------------------------------------------------------------------
// JSON smart truncate
// ---------------------------------------------------------------------------

/**
 * JSON 结构化截断，返回序列化文本（indent=2），保证：
 * 1) 字节数 ≤ MAX_RESPONSE_BYTES；2) 可 JSON.parse；3) 带 truncated 元数据。
 * 策略（每轮重算、最多 MAX_ITERATIONS 轮）：
 * - 单个大字符串主导（缺口 ≤ 最大字符串 × 4）：把它直接收到剩余预算内；
 * - 宽度型载荷（缺口远大于最大字符串）：按比例砍最大数组的尾部元素；
 * - 无数组可砍：把最大字符串收到最小标记；
 * - 没有字符串也没有数组（全数字/布尔）且仍超限：删根对象序列化最大的子键。
 */
function smartTruncateJson(data: unknown, tool: string, originalBytes: number): string {
  let root: unknown = data
  if (!isObject(data) && !Array.isArray(data)) {
    // 顶层标量（如一个超大 JSON 字符串）：包一层对象以便挂 truncated 元数据。
    root = { value: data }
  } else if (Array.isArray(data)) {
    // 顶层数组无法携带额外键：对象化包装。
    root = { data }
  }
  const rootObj = root as Record<string, unknown>
  const meta: TruncationMeta = { original_size: originalBytes, returned_size: 0, tool }
  rootObj.truncated = meta
  let serialized = JSON.stringify(rootObj, null, 2)

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const cur = Buffer.byteLength(serialized)
    if (cur <= MAX_RESPONSE_BYTES) break
    const fields = collectStringFields(rootObj, 'truncated')
    const largest = pickStringField(fields)
    const arrays = collectArrays(rootObj, 'truncated')
    const widest = arrays.length > 0 ? [...arrays].sort((a, b) => b.size - a.size)[0]! : undefined
    const deficit = cur - MAX_RESPONSE_BYTES

    if (largest && largest.size >= 64 && deficit <= largest.size * 4) {
      // 单字符串主导：一次收到预算内（留 SLACK 给 returned_size 回填）。
      const target = Math.max(0, largest.size - deficit - SLACK_BYTES)
      setStringField(rootObj, largest.path, target > FIELD_SUFFIX.length ? byteSlice(largest.value, target) + FIELD_SUFFIX : FIELD_SUFFIX)
    } else if (widest && widest.arr.length > 1) {
      // 宽度型载荷：按比例砍数组，一轮通常就能落到目标附近。
      const keep = Math.max(1, Math.floor(widest.arr.length * (MAX_RESPONSE_BYTES / cur)))
      widest.arr.length = keep
    } else if (largest) {
      // 数组已收到底（或没有数组）：继续收字符串；已是最小标记则无法再收窄。
      if (largest.size <= FIELD_SUFFIX.length) break
      setStringField(rootObj, largest.path, FIELD_SUFFIX)
    } else {
      // 全数字/布尔的结构化载荷：删根对象最大的子键（保持 JSON 合法）。
      const biggestKey = largestKeyBySize(rootObj, 'truncated')
      if (!biggestKey) break
      delete rootObj[biggestKey]
    }
    serialized = JSON.stringify(rootObj, null, 2)
  }

  // 回填 truncated.returned_size：数字位数变化 ≤ 9 字节，SLACK 余量保证不超限。
  let s = JSON.stringify(rootObj, null, 2)
  for (let i = 0; i < 4 && meta.returned_size !== Buffer.byteLength(s); i++) {
    meta.returned_size = Buffer.byteLength(s)
    s = JSON.stringify(rootObj, null, 2)
  }
  if (Buffer.byteLength(s) > MAX_RESPONSE_BYTES) {
    // 病态兜底（理论上极难触达）：任何可截结构都不够用，退化为合法小 JSON。
    const fb: Record<string, unknown> = { error: 'response too large to truncate within guard budget', truncated: meta }
    const fbText = JSON.stringify(fb)
    meta.returned_size = Buffer.byteLength(fbText)
    return fbText
  }
  return s
}

interface StringField {
  path: string[]
  value: string
  size: number
}

/** 选择要截断的字符串字段：默认最大的；content/text 类字段达到最大字段
 *  一半以上大小时优先（截内容比截 ID/元数据语义损失小）。 */
function pickStringField(fields: StringField[]): StringField | undefined {
  if (fields.length === 0) return undefined
  const sorted = [...fields].sort((a, b) => b.size - a.size)
  const largest = sorted[0]!
  const key = (f: StringField): string => f.path[f.path.length - 1] ?? ''
  const contentLike = sorted.find((f) => CONTENT_KEYS.has(key(f)) && f.size * 2 >= largest.size)
  return contentLike ?? largest
}

/** 递归收集对象内所有字符串字段（跳过 skipKey 子树，即 truncated 元数据）。 */
function collectStringFields(node: unknown, skipKey: string, prefix: string[] = [], out: StringField[] = []): StringField[] {
  if (typeof node === 'string') {
    out.push({ path: prefix, value: node, size: Buffer.byteLength(node) })
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStringFields(v, skipKey, [...prefix, String(i)], out))
    return out
  }
  if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === skipKey) continue
      collectStringFields(v, skipKey, [...prefix, k], out)
    }
  }
  return out
}

interface ArrayField {
  path: string[]
  arr: unknown[]
  size: number
}

/** 递归收集对象内所有数组（跳过 truncated 元数据），size=序列化字节数。 */
function collectArrays(node: unknown, skipKey: string, prefix: string[] = [], out: ArrayField[] = []): ArrayField[] {
  if (Array.isArray(node)) {
    out.push({ path: prefix, arr: node, size: Buffer.byteLength(JSON.stringify(node)) })
    node.forEach((v, i) => collectArrays(v, skipKey, [...prefix, String(i)], out))
    return out
  }
  if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === skipKey) continue
      collectArrays(v, skipKey, [...prefix, k], out)
    }
  }
  return out
}

/** 按路径改写一个字符串字段的值（路径在收集后、本轮结构未变前有效）。 */
function setStringField(root: Record<string, unknown>, path: string[], value: string): void {
  let node: unknown = root
  for (const key of path.slice(0, -1)) {
    node = (node as Record<string, unknown>)[key]
  }
  ;(node as Record<string, unknown>)[path[path.length - 1]!] = value
}

/** 根对象里序列化字节数最大的子键（跳过 truncated 元数据）。 */
function largestKeyBySize(obj: Record<string, unknown>, skipKey: string): string | undefined {
  let best: string | undefined
  let bestSize = -1
  for (const [k, v] of Object.entries(obj)) {
    if (k === skipKey) continue
    const size = Buffer.byteLength(JSON.stringify(v))
    if (size > bestSize) {
      bestSize = size
      best = k
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// plain text truncate
// ---------------------------------------------------------------------------

/** 纯文本截断：UTF-8 边界安全截断 + 追加标记，总长 ≤ MAX_RESPONSE_BYTES。
 *  returned 数字位数影响标记长度，用固定点迭代收敛（几轮内稳定）。 */
function truncatePlainText(text: string, original: number): string {
  const fmt = (returned: number): string => `\n... [truncated original=${original} returned=${returned}]`
  let returned = MAX_RESPONSE_BYTES
  for (let i = 0; i < 8; i++) {
    const marker = fmt(returned)
    const budget = Math.max(0, MAX_RESPONSE_BYTES - Buffer.byteLength(marker))
    const body = byteSlice(text, budget)
    const next = Buffer.byteLength(body) + Buffer.byteLength(marker)
    if (next === returned) break
    returned = next
  }
  const marker = fmt(returned)
  return byteSlice(text, Math.max(0, MAX_RESPONSE_BYTES - Buffer.byteLength(marker))) + marker
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** 按字节预算截断字符串，不切断 UTF-8 多字节字符（尾部不完整序列被丢弃）。 */
function byteSlice(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  let s = buf.subarray(0, maxBytes).toString('utf8')
  // 切断点多字节字符时 Node 会补一个 U+FFFD（3 字节），逐字符回退保证不超预算。
  while (Buffer.byteLength(s) > maxBytes) s = s.slice(0, -1)
  return s
}

function safeParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
