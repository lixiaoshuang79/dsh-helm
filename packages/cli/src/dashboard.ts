/**
 * dsh-helm dashboard — 启动 Web dashboard。
 *
 * dashboard 包通过动态 import 加载（不影响 CLI 本体启动）；包未构建时给出
 * 友好提示而不是堆栈。服务监听后进程常驻（事件循环不退出）。
 */

export const DEFAULT_DASHBOARD_PORT = 3480
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1'

export async function runDashboard(_argv: string[], flags: Record<string, string | boolean>): Promise<void> {
  const rawPort = typeof flags.port === 'string' ? flags.port : undefined
  const port = rawPort === undefined ? DEFAULT_DASHBOARD_PORT : Number(rawPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`无效端口: ${rawPort ?? ''}`)
    console.error(`用法: dsh-helm dashboard [--port <1-65535>]`)
    process.exitCode = 1
    return
  }

  try {
    const mod = await import('@dsh-helm/dashboard')
    const start = (mod as { startDashboard?: (opts: { port: number; host: string }) => unknown }).startDashboard
    if (typeof start !== 'function') {
      throw new Error('@dsh-helm/dashboard 未导出 startDashboard')
    }
    await start({ port, host: DEFAULT_DASHBOARD_HOST })
    console.log(`dashboard 已启动: http://${DEFAULT_DASHBOARD_HOST}:${port}（Ctrl-C 退出）`)
    // 前台常驻：server 监听已保持事件循环，这里永久挂起，
    // 让 main() 不再 resolve → 不会执行 process.exit 把 server 杀掉。
    await new Promise<void>(() => {})
  } catch (err) {
    console.error('无法启动 dashboard：')
    console.error(`  ${err instanceof Error ? err.message : String(err)}`)
    console.error('dashboard 包未构建，请先运行: pnpm build')
    process.exitCode = 1
  }
}
