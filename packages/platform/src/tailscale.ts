/**
 * Tailscale integration: CLI discovery, safe subprocess wrappers and a
 * whitelist-only status parser.
 *
 * Security rule: parseTailscaleStatusJson only ever reads the whitelisted
 * fields below. Any field whose name contains "key" (PublicKey, MachineKey,
 * AuthKey, KeyExpiry, …) is never touched, so no key material can leak into
 * parsed output. Nothing in this module writes to disk or mutates tailscale
 * state — every call is read-only.
 */

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { delimiter, join } from 'node:path'

/** Injectable exec shape so tests never spawn a real subprocess. */
export interface TailscaleExec {
  (file: string, args: string[], opts: { encoding: 'utf8'; timeout: number }): string
}

const defaultExec: TailscaleExec = (file, args, opts) => execFileSync(file, args, opts)

export type TailscaleRunResult = { ok: true; stdout: string } | { ok: false; error: string }

/** Fixed candidate paths checked after PATH (macOS app bundle + common brew/usr). */
const FIXED_PATHS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
] as const

/**
 * Locate the tailscale CLI: PATH first, then the well-known fixed paths.
 * `exists` is injectable for tests.
 */
export function findTailscaleCli(exists: (p: string) => boolean = existsSync): string | null {
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0)
  for (const dir of pathEntries) {
    const candidate = join(dir, 'tailscale')
    if (exists(candidate)) return candidate
  }
  for (const p of FIXED_PATHS) {
    if (exists(p)) return p
  }
  return null
}

/** Run a read-only tailscale subcommand; errors are captured, never thrown. */
export function runTailscale(cli: string, args: string[], timeoutMs: number = 5000, exec: TailscaleExec = defaultExec): TailscaleRunResult {
  try {
    const stdout = exec(cli, args, { encoding: 'utf8', timeout: timeoutMs })
    return { ok: true, stdout }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { stderr?: unknown; stdout?: unknown }
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : ''
    if (stderr !== '') return stderr
    const stdout = typeof e.stdout === 'string' ? e.stdout.trim() : ''
    if (stdout !== '') return stdout
    return err.message
  }
  return String(err)
}

/** First non-empty line of `tailscale version`, or null. */
export function getTailscaleVersion(cli: string, exec?: TailscaleExec): string | null {
  return firstLine(runTailscale(cli, ['version'], 5000, exec))
}

/** First non-empty line of `tailscale ip -4`, or null. */
export function getTailscaleIp(cli: string, exec?: TailscaleExec): string | null {
  return firstLine(runTailscale(cli, ['ip', '-4'], 5000, exec))
}

function firstLine(r: TailscaleRunResult): string | null {
  if (!r.ok) return null
  const line = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ?? null
}

// ---- whitelisted status shapes ----

export interface TailscaleSelf {
  hostName: string
  tailscaleIPs: string[]
  online: boolean
  os: string
  dnsName: string
}

export interface TailscalePeer {
  hostName: string
  tailscaleIPs: string[]
  online: boolean
  lastSeen: string | null
  os: string
}

export interface ParsedStatus {
  self: TailscaleSelf | null
  peers: TailscalePeer[]
}

/**
 * Parse `tailscale status --json` output. Pure function; throws on invalid
 * JSON. Only whitelisted fields are read — see the module header.
 */
export function parseTailscaleStatusJson(json: string): ParsedStatus {
  const data = JSON.parse(json) as { Self?: unknown; Peers?: unknown }
  return {
    self: data.Self === undefined ? null : pickSelf(data.Self),
    peers: Array.isArray(data.Peers) ? data.Peers.map(pickPeer) : [],
  }
}

/** `tailscale status --json` via the CLI, parsed into the whitelist shapes. */
export function getTailscaleStatus(cli: string, exec?: TailscaleExec): { ok: true; status: ParsedStatus } | { ok: false; error: string } {
  const r = runTailscale(cli, ['status', '--json'], 5000, exec)
  if (!r.ok) return { ok: false, error: r.error }
  try {
    return { ok: true, status: parseTailscaleStatusJson(r.stdout) }
  } catch (err) {
    return { ok: false, error: `解析 tailscale status --json 输出失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** True when a tailscale CLI can be found on this machine. */
export function isTailscaleInstalled(): boolean {
  return findTailscaleCli() !== null
}

function pickSelf(v: unknown): TailscaleSelf {
  const o = v as Record<string, unknown>
  return {
    hostName: pickStr(o.HostName),
    tailscaleIPs: pickIpList(o.TailscaleIPs),
    online: pickBool(o.Online),
    os: pickStr(o.OS),
    dnsName: pickStr(o.DNSName),
  }
}

function pickPeer(v: unknown): TailscalePeer {
  const o = v as Record<string, unknown>
  return {
    hostName: pickStr(o.HostName),
    tailscaleIPs: pickIpList(o.TailscaleIPs),
    online: pickBool(o.Online),
    lastSeen: typeof o.LastSeen === 'string' ? o.LastSeen : null,
    os: pickStr(o.OS),
  }
}

function pickStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function pickBool(v: unknown): boolean {
  return v === true || v === 'true'
}

function pickIpList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
