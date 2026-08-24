/**
 * Tailscale status: probe the tailscale CLI on the known macOS locations and
 * parse `status --json` with a strict whitelist — auth keys, node keys and
 * any other key material in the JSON are never read or forwarded.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const TAILSCALE_BIN_CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
] as const

export const TAILSCALE_TIMEOUT_MS = 5000

export interface TailscaleSelf {
  hostName: string
  ips: string[]
  online: boolean
  os?: string
}

export interface TailscalePeer {
  hostName: string
  ips: string[]
  online: boolean
  lastSeen?: string
  os?: string
}

export interface TailscaleStatus {
  installed: boolean
  version?: string
  ipv4?: string
  self?: TailscaleSelf | null
  peers?: TailscalePeer[]
  error?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function bool(v: unknown): boolean {
  return v === true
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Parse `tailscale status --json` output. Only whitelisted display fields
 * are extracted (HostName, TailscaleIPs, Online, LastSeen, OS); key fields
 * are never touched. Invalid input yields empty results, never a throw.
 */
export function parseTailscaleStatusJson(json: string): { self: TailscaleSelf | null; peers: TailscalePeer[] } {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { self: null, peers: [] }
  }
  if (!isRecord(raw)) return { self: null, peers: [] }

  const selfRaw = raw['Self']
  const self: TailscaleSelf | null = isRecord(selfRaw)
    ? {
        hostName: str(selfRaw['HostName']),
        ips: strArray(selfRaw['TailscaleIPs']),
        online: bool(selfRaw['Online']),
        os: optStr(selfRaw['OS']),
      }
    : null

  // Modern `tailscale status --json` puts peers under `Peer` as a map of
  // nodekey -> peer object; older builds used a `Peers` array. Accept both.
  const peers: TailscalePeer[] = []
  const peersArr = Array.isArray(raw['Peers']) ? raw['Peers'] : []
  for (const p of peersArr) {
    if (!isRecord(p)) continue
    peers.push({
      hostName: str(p['HostName']),
      ips: strArray(p['TailscaleIPs']),
      online: bool(p['Online']),
      lastSeen: optStr(p['LastSeen']),
      os: optStr(p['OS']),
    })
  }
  const peerMap = isRecord(raw['Peer']) ? raw['Peer'] : {}
  for (const key of Object.keys(peerMap)) {
    const p = peerMap[key]
    if (!isRecord(p)) continue
    peers.push({
      hostName: str(p['HostName']),
      ips: strArray(p['TailscaleIPs']),
      online: bool(p['Online']),
      lastSeen: optStr(p['LastSeen']),
      os: optStr(p['OS']),
    })
  }
  peers.sort((a, b) => a.hostName.localeCompare(b.hostName))
  return { self, peers }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function firstNonEmptyLine(stdout: string): string {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ?? ''
}

async function run(bin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, { timeout: TAILSCALE_TIMEOUT_MS })
  return stdout
}

/** Probe the tailscale CLI. Never throws — failures land in `error`. */
export async function collectTailscaleStatus(): Promise<TailscaleStatus> {
  let bin: string | null = null
  let version = ''
  let lastErr: string | undefined

  for (const candidate of TAILSCALE_BIN_CANDIDATES) {
    try {
      version = firstNonEmptyLine(await run(candidate, ['version']))
      bin = candidate
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      lastErr = `${candidate}: ${errMsg(err)}`
    }
  }

  if (bin === null) {
    return { installed: false, ...(lastErr ? { error: lastErr } : {}) }
  }

  const status: TailscaleStatus = { installed: true, version: version || undefined }
  try {
    const stdout = await run(bin, ['ip', '-4'])
    const ips = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (ips.length > 0) status.ipv4 = ips.join(', ')
  } catch (err) {
    status.error = `tailscale ip -4: ${errMsg(err)}`
  }
  try {
    const stdout = await run(bin, ['status', '--json'])
    const parsed = parseTailscaleStatusJson(stdout)
    status.self = parsed.self
    status.peers = parsed.peers
  } catch (err) {
    const prev = status.error ? `${status.error}; ` : ''
    status.error = `${prev}tailscale status: ${errMsg(err)}`
  }
  return status
}
