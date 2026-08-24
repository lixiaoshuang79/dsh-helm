/**
 * Tunnel status: probe the local tunnel-client health endpoints and read its
 * launchd plist for the tunnel id and MCP target. The plist parser is a
 * small regex-based XML scan (no dependency) targeted at ProgramArguments.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactTunnelId } from './redact.js'

/** Default loopback base URL of the tunnel-client HTTP endpoints. */
export const TUNNEL_BASE_URL_DEFAULT = 'http://127.0.0.1:3468'
/** Default launchd plist of the tunnel client (with ~ expanded). */
export const TUNNEL_PLIST_PATH_DEFAULT = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.dsh-helm.tunnel-client.plist')

export const TUNNEL_PROBE_TIMEOUT_MS = 3000

export interface TunnelStatus {
  /** Any health endpoint answered (a tunnel process is listening). */
  running: boolean
  /** GET /readyz returned ok. */
  ready: boolean
  /** GET /healthz returned ok. */
  live: boolean
  /** Tunnel client version — not exposed by the local endpoints, always null. */
  version: string | null
  /** Redacted tunnel id from the plist (null when not configured). */
  tunnelIdRedacted: string | null
  /** MCP target URL from the plist --mcp.server-url (null when absent). */
  mcpTargetUrl: string | null
  /**
   * ChatGPT workspace binding cannot be checked from this machine; the UI
   * must show "需在 OpenAI Platform 检查" instead of inventing a state.
   */
  workspaceBinding: 'NEED_MANUAL_CHECK'
  error?: string
}

export interface TunnelPlistInfo {
  tunnelId: string | null
  mcpServerUrl: string | null
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

/** Extract the string values of the ProgramArguments array of a plist XML. */
function programArguments(xml: string): string[] {
  const keyIdx = xml.indexOf('<key>ProgramArguments</key>')
  if (keyIdx === -1) return []
  const arrStart = xml.indexOf('<array>', keyIdx)
  if (arrStart === -1) return []
  const arrEnd = xml.indexOf('</array>', arrStart)
  if (arrEnd === -1) return []
  const out: string[] = []
  const re = /<string>([\s\S]*?)<\/string>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml.slice(arrStart, arrEnd))) !== null) {
    out.push(unescapeXml(m[1] ?? ''))
  }
  return out
}

/** Value of a `--flag value` / `--flag=value` argument pair. */
function flagValue(args: string[], flag: string): string | null {
  const eq = `${flag}=`
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === flag) {
      const next = args[i + 1]
      if (next && !next.startsWith('--')) return next
      return null
    }
    if (a.startsWith(eq)) return a.slice(eq.length)
  }
  return null
}

/** Parse a plist XML document for tunnel configuration (pure, testable). */
export function parseTunnelPlist(xml: string): TunnelPlistInfo {
  const args = programArguments(xml)
  return { tunnelId: flagValue(args, '--control-plane.tunnel-id'), mcpServerUrl: flagValue(args, '--mcp.server-url') }
}

/** Read and parse the tunnel plist from disk. Returns nulls on any failure. */
export function readTunnelPlist(plistPath: string = TUNNEL_PLIST_PATH_DEFAULT): TunnelPlistInfo {
  try {
    return parseTunnelPlist(fs.readFileSync(plistPath, 'utf8'))
  } catch {
    return { tunnelId: null, mcpServerUrl: null }
  }
}

/** Tunnel id from the plist, or null when absent/unreadable. */
export function readTunnelIdFromPlist(plistPath?: string): string | null {
  return readTunnelPlist(plistPath).tunnelId
}

async function probeOk(url: URL, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export interface CollectTunnelOptions {
  baseUrl?: string
  plistPath?: string
  timeoutMs?: number
}

/** Probe the tunnel-client endpoints and plist. Never throws. */
export async function collectTunnelStatus(opts: CollectTunnelOptions = {}): Promise<TunnelStatus> {
  const baseUrl = opts.baseUrl ?? TUNNEL_BASE_URL_DEFAULT
  const timeoutMs = opts.timeoutMs ?? TUNNEL_PROBE_TIMEOUT_MS
  const base = new URL(baseUrl)
  const readyUrl = new URL('/readyz', base)
  const liveUrl = new URL('/healthz', base)

  const [ready, live] = await Promise.all([probeOk(readyUrl, timeoutMs), probeOk(liveUrl, timeoutMs)])
  const plist = readTunnelPlist(opts.plistPath ?? TUNNEL_PLIST_PATH_DEFAULT)

  const status: TunnelStatus = {
    running: ready || live,
    ready,
    live,
    version: null,
    tunnelIdRedacted: plist.tunnelId ? redactTunnelId(plist.tunnelId) : null,
    mcpTargetUrl: plist.mcpServerUrl,
    workspaceBinding: 'NEED_MANUAL_CHECK',
  }
  if (!ready && !live) {
    status.error = `tunnel endpoints unreachable: ${baseUrl}/readyz, ${baseUrl}/healthz`
  }
  return status
}
