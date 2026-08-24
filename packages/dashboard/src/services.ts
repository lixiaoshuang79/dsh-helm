/**
 * Service collection: launchctl (macOS) / systemctl (Linux) listing of the
 * dsh-helm services, cross-checked with pgrep, plus a redacted tail of the
 * matching error log for each service.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configPaths, currentOs } from '@dsh-helm/platform'
import { redactSecrets } from './redact.js'

export interface ServiceInfo {
  label: string
  pid: number | null
  running: boolean
  lastExit: number | null
  /** Redacted tail of the service error log (null when no log file). */
  recentError: string | null
}

export const MAX_ERROR_CHARS = 2000

export interface LaunchctlRow {
  label: string
  pid: number | null
  lastExit: number | null
}

/** Parse `launchctl list` output, keeping only com.dsh-helm.* services. */
export function parseLaunchctlList(output: string): LaunchctlRow[] {
  const rows: LaunchctlRow[] = []
  for (const line of output.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m) continue
    const label = m[3] ?? ''
    if (!label.startsWith('com.dsh-helm.')) continue
    rows.push({ label, pid: m[1] === '-' ? null : Number(m[1]), lastExit: m[2] === '-' ? null : Number(m[2]) })
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label))
}

/** Parse `systemctl --no-pager list-units --all`, keeping dsh-helm units. */
export function parseSystemdListUnits(output: string): Array<{ unit: string; load: string; active: string; sub: string }> {
  const rows: Array<{ unit: string; load: string; active: string; sub: string }> = []
  for (const line of output.split('\n')) {
    const m = /^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+.*)?$/.exec(line)
    if (!m) continue
    const unit = m[1] ?? ''
    if (!unit.includes('dsh-helm')) continue
    rows.push({ unit, load: m[2] ?? '', active: m[3] ?? '', sub: m[4] ?? '' })
  }
  return rows.sort((a, b) => a.unit.localeCompare(b.unit))
}

function escapePgrepPattern(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** pgrep -f <label> succeeds -> a matching process exists. */
function pgrepMatches(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', escapePgrepPattern(pattern)], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/** Tail of a log file (up to maxLines non-empty lines), or null. */
function readLogTail(filePath: string, maxLines: number): string | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const CHUNK = 8192
      const start = Math.max(0, size - CHUNK)
      const buf = Buffer.alloc(size - start)
      if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, start)
      const lines = buf
        .toString('utf8')
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
      if (lines.length === 0) return null
      const tail = lines.slice(-maxLines).join('\n')
      if (tail.length > MAX_ERROR_CHARS) return `…${tail.slice(-MAX_ERROR_CHARS)}`
      return tail
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Tail of the service error log (`.err.log` preferred, `.log` fallback). */
function readRecentError(logDir: string, label: string): string | null {
  const suffix = label.replace(/^com\.dsh-helm\./, '').replace(/\.service$/, '')
  for (const name of [`${suffix}.err.log`, `${suffix}.log`]) {
    const tail = readLogTail(path.join(logDir, name), 5)
    if (tail !== null) return redactSecrets(tail)
  }
  return null
}

export interface CollectServicesOptions {
  logDir?: string
}

/**
 * Collect dsh-helm service states. Never throws: on a platform failure an
 * empty list is returned (per-service failures surface in `recentError`).
 */
export async function collectServices(opts: CollectServicesOptions = {}): Promise<ServiceInfo[]> {
  const logDir = opts.logDir ?? configPaths(currentOs(), os.homedir()).logDir
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 5000 })
      return parseLaunchctlList(output).map((r) => ({
        label: r.label,
        pid: r.pid,
        running: r.pid !== null || pgrepMatches(r.label),
        lastExit: r.lastExit,
        recentError: readRecentError(logDir, r.label),
      }))
    }
    const output = execFileSync('systemctl', ['--no-pager', 'list-units', '--all'], { encoding: 'utf8', timeout: 5000 })
    return parseSystemdListUnits(output).map((u) => ({
      label: u.unit,
      pid: null,
      running: u.active === 'active' || pgrepMatches(u.unit),
      lastExit: null,
      recentError: readRecentError(logDir, u.unit),
    }))
  } catch {
    return []
  }
}
