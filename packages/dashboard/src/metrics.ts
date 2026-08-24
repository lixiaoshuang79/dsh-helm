/**
 * MCP 控制面指标探测：GET /metrics（hub 的 Streamable-HTTP 服务运行指标，
 * 含请求量、响应体积、截断/错误计数与按工具明细）。
 *
 * 与 fetchHaStatus 同款容错风格：永不抛出——hub 未就绪、HTTP 非 200、
 * 响应不是合法 JSON 等任何失败都收敛为 `{ error }` 对象，由页面渲染成
 * 独立的错误行，而不是让整个仪表盘挂掉。
 */

import { DEFAULT_HUB_TIMEOUT_MS } from './hub.js'

/** 单个 MCP 工具的运行指标（数值字段缺失时按 0/— 渲染）。 */
export interface McpToolMetrics {
  tool: string
  count?: number
  avgBytes?: number
  maxBytes?: number
  truncated?: number
  errors?: number
}

/**
 * GET /metrics 的响应形状：整体状态 + 控制面级计数器 + perTool 明细。
 * 所有字段都可选：hub 侧尚未完成或中途升级时，缺字段按 0/— 展示。
 */
export interface McpMetrics {
  /** 控制面整体健康：ok / degraded。 */
  status?: 'ok' | 'degraded'
  version?: string
  /** 进程运行时长（毫秒）。 */
  uptimeMs?: number
  /** 累计处理请求数。 */
  requestCount?: number
  /** 平均响应体积（字节）。 */
  avgResponseBytes?: number
  /** 最大响应体积（字节）。 */
  maxResponseBytes?: number
  /** 响应超限被截断的次数。 */
  truncationCount?: number
  /** 请求处理失败次数。 */
  errorCount?: number
  /** 当前活跃连接数。 */
  activeConnections?: number
  /** 按工具拆分的调用明细。 */
  perTool?: McpToolMetrics[]
  /** 探测本身失败时填充（hub 不可达 / 非 200 / JSON 解析失败）。 */
  error?: string
}

/**
 * 探测 hub 的 MCP 控制面指标。`baseUrl` 是 hub 的 HTTP origin
 * （默认 http://127.0.0.1:3471），`/metrics` 由它派生。
 */
export async function fetchMcpMetrics(baseUrl: string, timeoutMs: number = DEFAULT_HUB_TIMEOUT_MS): Promise<McpMetrics> {
  try {
    const res = await fetch(new URL('/metrics', baseUrl), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { error: `metrics http ${res.status}` }
    return (await res.json()) as McpMetrics
  } catch (err) {
    return { error: `metrics unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
}
