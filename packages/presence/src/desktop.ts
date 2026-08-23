/**
 * macOS desktop sidecar: detects whether ChatGPT or a browser is the frontmost
 * app and reports a desktop presence claim.
 *
 * Uses osascript + System Events (no extra permissions beyond Accessibility
 * for System Events, which the connector's watchdog already has patterns for).
 * The exec function is injectable for unit tests.
 */

import type { PresenceClaim } from '@dsh-helm/protocol'
import type { PresenceProvider } from './providers.js'

export interface DesktopSidecarOptions {
  nodeId: string
  /** App names (bundle-agnostic) that count as "human actively present". */
  activeApps?: string[]
  /** Confidence when an active app is frontmost. */
  activeConfidence?: number
  /** Interval to re-probe in background mode (ms). */
  intervalMs?: number
  /** Injectable command runner for tests. */
  exec?: (cmd: string) => Promise<string>
  log?: (line: string) => void
}

/** Default apps considered "active": ChatGPT client + common browsers. */
const DEFAULT_ACTIVE_APPS = ['chatgpt', 'arc', 'safari', 'chrome', 'edge', 'firefox', 'browser']

export class DesktopSidecarPresenceProvider implements PresenceProvider {
  readonly source = 'desktop'
  private nodeId: string
  private activeApps: string[]
  private activeConfidence: number
  private intervalMs: number
  private exec: (cmd: string) => Promise<string>
  private logFn?: (line: string) => void
  private timer?: NodeJS.Timeout
  private onClaim?: (claim: PresenceClaim) => void

  constructor(opts: DesktopSidecarOptions) {
    this.nodeId = opts.nodeId
    this.activeApps = opts.activeApps ?? DEFAULT_ACTIVE_APPS
    this.activeConfidence = opts.activeConfidence ?? 0.9
    this.intervalMs = opts.intervalMs ?? 10_000
    this.exec = opts.exec ?? defaultExec
    this.logFn = opts.log
  }

  /** Probe the frontmost app via osascript. */
  async probe(): Promise<PresenceClaim | undefined> {
    let front: string
    try {
      front = (await this.exec(FRONTMOST_SCRIPT)).trim().toLowerCase()
    } catch (err) {
      this.logFn?.(`desktop sidecar probe failed: ${err instanceof Error ? err.message : err}`)
      return undefined
    }
    if (!front) return undefined
    const active = this.activeApps.some((app) => front.includes(app.toLowerCase()))
    return {
      node_id: this.nodeId,
      source: 'desktop',
      confidence: active ? this.activeConfidence : 0.2,
      observed_at: new Date().toISOString(),
      ttl_ms: 60_000,
    }
  }

  /** Background probing with claim callback. */
  start(onClaim: (claim: PresenceClaim) => void): void {
    this.onClaim = onClaim
    this.timer = setInterval(() => {
      void this.probe().then((c) => c && this.onClaim?.(c))
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

const FRONTMOST_SCRIPT = `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null`

async function defaultExec(cmd: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    // cmd is a fixed internal constant; use execFile on /bin/sh for safety
    execFile('/bin/sh', ['-c', cmd], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}
