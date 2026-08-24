/**
 * Dashboard status aggregate: local role (node config + hub reachability),
 * hub / tunnel / tailscale probes and service listing. Every probe is
 * individually failure-tolerant — a dead subsystem shows its own `error`
 * field instead of failing the whole /api/status response.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import { configPaths, currentOs } from '@dsh-helm/platform'
import { DEFAULT_HUB_URL, fetchHubStatus, type HubStatus } from './hub.js'
import { redactTunnelId } from './redact.js'
import { collectServices, type ServiceInfo } from './services.js'
import { collectTailscaleStatus, type TailscaleStatus } from './tailscale.js'
import { collectTunnelStatus, TUNNEL_PLIST_PATH_DEFAULT, type TunnelStatus } from './tunnel.js'

export interface DashboardRole {
  /** This machine serves the hub (hub probe succeeded). */
  isHubHost: boolean
  /** This machine has a node config (~/.dsh/helm/node.json). */
  isNode: boolean
  nodeIdRedacted?: string
  displayName?: string
  hubUrl?: string
}

export interface DashboardStatus {
  generatedAt: string
  role: DashboardRole
  hub: HubStatus
  tunnel: TunnelStatus
  tailscale: TailscaleStatus
  services: ServiceInfo[]
  self: { hostname: string; platform: string }
}

export interface CollectStatusOptions {
  hubUrl?: string
  tunnelBaseUrl?: string
  plistPath?: string
  nodeFile?: string
  logDir?: string
}

interface NodeConfig {
  node_id?: string
  display_name?: string
  hub_url?: string
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** Read only the whitelisted fields of node.json (token stays untouched). */
async function readNodeConfig(file: string): Promise<NodeConfig | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    return {
      node_id: typeof raw['node_id'] === 'string' ? raw['node_id'] : undefined,
      display_name: typeof raw['display_name'] === 'string' ? raw['display_name'] : undefined,
      hub_url: typeof raw['hub_url'] === 'string' ? raw['hub_url'] : undefined,
    }
  } catch {
    return null
  }
}

/** Aggregate the full dashboard status. Never throws. */
export async function collectStatus(opts: CollectStatusOptions = {}): Promise<DashboardStatus> {
  const nodeFile = opts.nodeFile ?? configPaths(currentOs(), os.homedir()).nodeFile
  const hasNodeConfig = await pathExists(nodeFile)
  const node = hasNodeConfig ? await readNodeConfig(nodeFile) : null
  // Hub probing always targets the local loopback control plane (the hub's
  // MCP endpoint is 127.0.0.1:3471 by default). node.json's hub_url is the
  // *mesh* WebSocket URL (ws://<hub>:3470) the agent connects out to — it is
  // not an HTTP origin and must never be reused as the probe target.
  const hubUrl = opts.hubUrl ?? DEFAULT_HUB_URL

  const [hub, tunnel, tailscale, services] = await Promise.all([
    fetchHubStatus(hubUrl),
    collectTunnelStatus({ baseUrl: opts.tunnelBaseUrl, plistPath: opts.plistPath }),
    collectTailscaleStatus(),
    collectServices({ logDir: opts.logDir }),
  ])

  return {
    generatedAt: new Date().toISOString(),
    role: {
      isHubHost: hub.hubOk,
      isNode: hasNodeConfig,
      nodeIdRedacted: node?.node_id ? redactTunnelId(node.node_id) : undefined,
      displayName: node?.display_name,
      hubUrl,
    },
    hub,
    tunnel,
    tailscale,
    services,
    self: { hostname: os.hostname(), platform: process.platform },
  }
}

export { TUNNEL_PLIST_PATH_DEFAULT }
