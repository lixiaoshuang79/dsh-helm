/**
 * Windows desktop adapter scaffold.
 *
 * Detects the foreground window's process name via a PowerShell snippet
 * (user32 GetForegroundWindow P/Invoke). The PowerShell command is a static
 * constant; the exec runner is injectable so the adapter logic is unit-testable
 * on any OS, and the exact PowerShell string is validated by tests.
 */

import type { PresenceClaim } from '@dsh-helm/protocol'
import type { PresenceProvider } from './providers.js'

export interface WindowsAdapterOptions {
  nodeId: string
  /** Process names that count as active (exe name without .exe, lowercase). */
  activeProcesses?: string[]
  activeConfidence?: number
  exec?: (_cmd: string) => Promise<string>
  log?: (line: string) => void
}

const DEFAULT_ACTIVE_PROCESSES = ['chatgpt', 'msedge', 'chrome', 'firefox', 'brave']

/**
 * Static PowerShell snippet: foreground window -> owning process name.
 * Uses P/Invoke on user32.GetForegroundWindow + GetWindowThreadProcessId.
 * Kept as a template so tests can assert it stays stable and shell-safe.
 */
export const WINDOWS_FOREGROUND_PS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
$h = [FG]::GetForegroundWindow()
$pid2 = 0
[void][FG]::GetWindowThreadProcessId($h, [ref]$pid2)
(Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName
`.trim()

export class WindowsDesktopPresenceProvider implements PresenceProvider {
  readonly source = 'desktop'
  private nodeId: string
  private activeProcesses: string[]
  private activeConfidence: number
  private exec: (_cmd: string) => Promise<string>
  private logFn?: (line: string) => void

  constructor(opts: WindowsAdapterOptions) {
    this.nodeId = opts.nodeId
    this.activeProcesses = opts.activeProcesses ?? DEFAULT_ACTIVE_PROCESSES
    this.activeConfidence = opts.activeConfidence ?? 0.9
    this.exec = opts.exec ?? defaultPsExec
    this.logFn = opts.log
  }

  async probe(): Promise<PresenceClaim | undefined> {
    let proc: string
    try {
      proc = (await this.exec(`powershell -NoProfile -NonInteractive -Command "${WINDOWS_FOREGROUND_PS}"`)).trim().toLowerCase()
    } catch (err) {
      this.logFn?.(`windows presence probe failed: ${err instanceof Error ? err.message : err}`)
      return undefined
    }
    if (!proc) return undefined
    const active = this.activeProcesses.some((p) => proc.includes(p.toLowerCase()))
    return {
      node_id: this.nodeId,
      source: 'desktop',
      confidence: active ? this.activeConfidence : 0.2,
      observed_at: new Date().toISOString(),
      ttl_ms: 60_000,
    }
  }
}

async function defaultPsExec(_cmd: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_FOREGROUND_PS], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}
