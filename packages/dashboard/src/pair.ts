/**
 * Pairing client for the dashboard: talks to the hub's loopback pairing
 * endpoints (GET /pair/new, GET /pair/list) and renders the operator-facing
 * join command tip. Never touches code plaintext beyond the response body.
 */

import { DEFAULT_PORTS, findTailscaleCli, getTailscaleIp } from '@dsh-helm/platform'

export const DEFAULT_PAIR_HUB_URL = 'http://127.0.0.1:3471'
export const DEFAULT_PAIR_TIMEOUT_MS = 5000

export interface HubPairCode {
  code: string
  expiresAt: string
}

export interface HubPairListEntry {
  codeHashPrefix: string
  status: 'pending' | 'consumed' | 'locked'
  createdAt: string
  expiresAt: string
  consumedAt?: string
}

async function hubGet<T>(hubUrl: string, path: string, timeoutMs: number): Promise<T> {
  const res = await fetch(new URL(path, hubUrl), { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`hub ${path} http ${res.status}`)
  return (await res.json()) as T
}

/** Create a pairing code on the hub (plaintext returned exactly once). */
export async function fetchHubPairCode(hubUrl: string = DEFAULT_PAIR_HUB_URL, timeoutMs = DEFAULT_PAIR_TIMEOUT_MS): Promise<HubPairCode> {
  const body = await hubGet<{ code?: unknown; expiresAt?: unknown }>(hubUrl, '/pair/new', timeoutMs)
  if (typeof body.code !== 'string' || typeof body.expiresAt !== 'string') {
    throw new Error('hub /pair/new: malformed response')
  }
  return { code: body.code, expiresAt: body.expiresAt }
}

/** Recent pairing codes (hash prefix only) for the dashboard table. */
export async function fetchHubPairList(hubUrl: string = DEFAULT_PAIR_HUB_URL, timeoutMs = DEFAULT_PAIR_TIMEOUT_MS): Promise<HubPairListEntry[]> {
  const body = await hubGet<{ codes?: unknown }>(hubUrl, '/pair/list', timeoutMs)
  if (!Array.isArray(body.codes)) throw new Error('hub /pair/list: malformed response')
  return body.codes as HubPairListEntry[]
}

/**
 * Build the operator-facing join command template. The control-plane URL is
 * derived from this machine's tailscale IPv4 (the hub host's tailnet IP);
 * when tailscale is unavailable a placeholder is shown instead.
 */
export async function buildJoinTip(code: string, tailscaleIpFetcher: () => Promise<string | null> = defaultTailscaleIpFetcher): Promise<string> {
  const ip = await tailscaleIpFetcher().catch(() => null)
  const host = ip ?? '<tailscale-ip>'
  return `dsh-helm join --control-plane ws://${host}:${DEFAULT_PORTS.mesh} --code ${code}`
}

async function defaultTailscaleIpFetcher(): Promise<string | null> {
  const cli = findTailscaleCli()
  if (!cli) return null
  return getTailscaleIp(cli)
}
