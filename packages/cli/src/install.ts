/**
 * dsh-helm install — 安装前检查与指引（只读）。
 *
 * 不做任何静默危险操作：tailscale 安装 / `tailscale up` 登录 / `dsh-helm init`
 * 都只提示用户手动执行，脚本一律不代为执行。退出码恒为 0（本命令是向导，
 * 不因环境未就绪而报错）。
 */

import { isTailscaleInstalled } from '@dsh-helm/platform'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface InstallOptions {
  /** hub 基础 URL，默认 http://127.0.0.1:3471 */
  hubUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export async function runInstall(_argv: string[], opts: InstallOptions = {}): Promise<number> {
  const hubUrl = opts.hubUrl ?? 'http://127.0.0.1:3471'
  const timeoutMs = opts.timeoutMs ?? 5000
  const fetchImpl = opts.fetchImpl ?? fetch

  console.log('dsh-helm install — 环境检查与安装指引（只读，不自动执行任何安装）')
  console.log('')

  // 1. tailscale
  if (isTailscaleInstalled()) {
    console.log('[ok]   tailscale 已安装')
  } else {
    console.log('[warn] tailscale 未安装。节点机需要 tailscale 组网，请手动安装：')
    console.log('         macOS: brew install --cask tailscale')
    console.log('                或从 https://tailscale.com/download/mac 安装官方 App')
    console.log('         Linux:  按 https://tailscale.com/download 的发行版指引安装')
    console.log('         装好后：启动 Tailscale App 并手动执行 tailscale up 完成登录（脚本不代为执行）')
  }

  // 2. 节点配置
  const configPath = join(process.env.HOME ?? '.', '.dsh', 'helm', 'node.json')
  if (existsSync(configPath)) {
    console.log('[ok]   节点配置存在: ' + configPath)
  } else {
    console.log(`[warn] 未找到节点配置 ${configPath} —— 请先运行: dsh-helm init`)
  }

  // 3. hub 连通性
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const res = await fetchImpl(`${hubUrl}/healthz`, { signal: ac.signal })
    clearTimeout(timer)
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; nodes?: number }
      console.log(`[ok]   hub 可达: ${hubUrl}/healthz → ok=${body.ok === true}, nodes=${body.nodes ?? 0}`)
    } else {
      console.log(`[warn] hub 未就绪: ${hubUrl}/healthz → HTTP ${res.status}（hub 机稍后启动 hub 即可）`)
    }
  } catch (err) {
    console.log(`[warn] hub 不可达: ${err instanceof Error ? err.message : String(err)}（节点机可稍后连接）`)
  }

  // 4. 下一步
  console.log('')
  console.log('下一步：')
  console.log('  hub 机（控制面）:  dsh-helm hub    （生产建议安装为 launchd/systemd 服务）')
  console.log('  节点机:            dsh-helm agent  （前台）或 ./scripts/install-service.sh（launchd 服务）')
  console.log('  自检:              dsh-helm doctor')
  return 0
}