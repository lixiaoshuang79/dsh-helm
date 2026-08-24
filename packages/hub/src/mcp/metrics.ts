/**
 * McpMetrics: hub MCP 调用指标（P3，hub 侧）。
 *
 * 线程内计数器（单进程内存态，无锁）：HubMcpServer.callTool 的统一出口
 * 在过完 Response Size Guard 后调用 recordRequest()，记录每个工具调用的
 * 返回字节数、是否截断、是否出错。snapshot() 产出 /metrics 端点与
 * dashboard 渲染用的结构化快照。
 */

/** 单工具的聚合指标（内部形态）。 */
export interface PerToolMetrics {
  tool: string
  count: number
  bytesSum: number
  maxBytes: number
  truncatedCount: number
  errorCount: number
}

/** /metrics 端点返回的快照形状（dashboard 按此渲染）。 */
export interface McpMetricsSnapshot {
  /** 'ok' = 无错误；'degraded' = 出现过错误响应。 */
  status: 'ok' | 'degraded'
  /** hub 包版本（packages/hub/package.json 的 version）。 */
  version: string
  /** 进程/实例启动至今毫秒数。 */
  uptimeMs: number
  /** 累计工具调用次数。 */
  requestCount: number
  /** 平均响应字节数（总字节/请求数，四舍五入整数）。 */
  avgResponseBytes: number
  /** 单次响应最大字节数。 */
  maxResponseBytes: number
  /** 被 size guard 截断的次数。 */
  truncationCount: number
  /** 错误响应次数。 */
  errorCount: number
  /** mesh 活跃节点连接数（直接节点连接 + 已连接的 CP peer）。 */
  activeConnections: number
  /** 按工具聚合，count 降序。 */
  perTool: Array<{
    tool: string
    count: number
    /** 该工具平均响应字节（整数）。 */
    avgBytes: number
    maxBytes: number
    /** 该工具被截断的次数。 */
    truncated: number
    /** 该工具出错的次数。 */
    errors: number
  }>
}

export class McpMetrics {
  private startedAt = Date.now()
  private requestCount = 0
  private bytesSum = 0
  private maxBytes = 0
  private truncationCount = 0
  private errorCount = 0
  private tools = new Map<string, PerToolMetrics>()

  /**
   * 记录一次工具调用。
   * @param tool      工具名
   * @param bytes     返回文本的 UTF-8 字节数（guard 之后的值）
   * @param truncated 是否被 size guard 截断
   * @param error     错误信息（非空表示本次是错误响应）
   */
  recordRequest(tool: string, bytes: number, truncated: boolean, error?: string): void {
    this.requestCount++
    this.bytesSum += bytes
    if (bytes > this.maxBytes) this.maxBytes = bytes
    if (truncated) this.truncationCount++
    if (error !== undefined && error !== '') this.errorCount++
    let t = this.tools.get(tool)
    if (!t) {
      t = { tool, count: 0, bytesSum: 0, maxBytes: 0, truncatedCount: 0, errorCount: 0 }
      this.tools.set(tool, t)
    }
    t.count++
    t.bytesSum += bytes
    if (bytes > t.maxBytes) t.maxBytes = bytes
    if (truncated) t.truncatedCount++
    if (error !== undefined && error !== '') t.errorCount++
  }

  /** 记录一次错误（并入请求计数；bytes=0、不记截断）。 */
  recordError(tool: string, message: string): void {
    this.recordRequest(tool, 0, false, message)
  }

  /**
   * 生成快照。
   * @param activeConnections mesh 活跃连接数（由调用方从 cp.connections +
   *                          HA peers 统计）
   * @param version           hub 包版本
   * @param uptimeMs          可选；缺省用本实例存活时长
   */
  snapshot(activeConnections: number, version: string, uptimeMs?: number): McpMetricsSnapshot {
    const requestCount = this.requestCount
    const perTool = [...this.tools.values()]
      .map((t) => ({
        tool: t.tool,
        count: t.count,
        avgBytes: t.count > 0 ? Math.round(t.bytesSum / t.count) : 0,
        maxBytes: t.maxBytes,
        truncated: t.truncatedCount,
        errors: t.errorCount,
      }))
      .sort((a, b) => b.count - a.count)
    return {
      status: this.errorCount > 0 ? 'degraded' : 'ok',
      version,
      uptimeMs: uptimeMs ?? Date.now() - this.startedAt,
      requestCount,
      avgResponseBytes: requestCount > 0 ? Math.round(this.bytesSum / requestCount) : 0,
      maxResponseBytes: this.maxBytes,
      truncationCount: this.truncationCount,
      errorCount: this.errorCount,
      activeConnections,
      perTool,
    }
  }
}
