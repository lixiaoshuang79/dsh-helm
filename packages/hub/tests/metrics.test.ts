import { describe, expect, it } from 'vitest'
import { McpMetrics } from '../src/index.js'

describe('McpMetrics（P3 hub 侧计数器）', () => {
  it('快照：计数 / 均值 / 最大值 / perTool 聚合正确', () => {
    const m = new McpMetrics()
    m.recordRequest('sessions_list', 100, false)
    m.recordRequest('sessions_list', 200, true)
    m.recordRequest('code_read_file', 50, false, 'boom')
    const s = m.snapshot(2, '0.1.0', 12_345)
    expect(s.status).toBe('degraded') // 出现过错误
    expect(s.version).toBe('0.1.0')
    expect(s.uptimeMs).toBe(12_345)
    expect(s.requestCount).toBe(3)
    expect(s.avgResponseBytes).toBe(117) // round((100+200+50)/3)
    expect(s.maxResponseBytes).toBe(200)
    expect(s.truncationCount).toBe(1)
    expect(s.errorCount).toBe(1)
    expect(s.activeConnections).toBe(2)
    const byTool = Object.fromEntries(s.perTool.map((t) => [t.tool, t]))
    expect(byTool.sessions_list).toEqual({ tool: 'sessions_list', count: 2, avgBytes: 150, maxBytes: 200, truncated: 1, errors: 0 })
    expect(byTool.code_read_file).toEqual({ tool: 'code_read_file', count: 1, avgBytes: 50, maxBytes: 50, truncated: 0, errors: 1 })
  })

  it('无请求时快照零值安全（无 NaN）', () => {
    const s = new McpMetrics().snapshot(0, '0.1.0')
    expect(s.status).toBe('ok')
    expect(s.requestCount).toBe(0)
    expect(s.avgResponseBytes).toBe(0)
    expect(s.maxResponseBytes).toBe(0)
    expect(s.truncationCount).toBe(0)
    expect(s.errorCount).toBe(0)
    expect(s.perTool).toEqual([])
    expect(typeof s.uptimeMs).toBe('number')
    expect(s.uptimeMs).toBeGreaterThanOrEqual(0)
  })

  it('recordError 并入请求与错误计数', () => {
    const m = new McpMetrics()
    m.recordError('sessions_prompt', 'timeout')
    const s = m.snapshot(0, '0.1.0')
    expect(s.requestCount).toBe(1)
    expect(s.errorCount).toBe(1)
    expect(s.status).toBe('degraded')
    expect(s.perTool[0]).toMatchObject({ tool: 'sessions_prompt', count: 1, errors: 1, truncated: 0 })
  })

  it('perTool 按 count 降序；空 error 串不算错误', () => {
    const m = new McpMetrics()
    m.recordRequest('a', 10, false)
    m.recordRequest('b', 20, false, '')
    m.recordRequest('a', 30, false)
    const s = m.snapshot(0, '0.1.0')
    expect(s.perTool.map((t) => t.tool)).toEqual(['a', 'b'])
    expect(s.errorCount).toBe(0)
    expect(s.status).toBe('ok')
    expect(s.avgResponseBytes).toBe(20) // round(60/3)
  })
})
