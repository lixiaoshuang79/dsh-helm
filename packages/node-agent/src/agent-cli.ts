/**
 * dsh-helm node-agent entry: runs the node agent in the foreground.
 *
 * Usage:
 *   dsh-helm-agent --hub ws://127.0.0.1:3470
 *
 * Config: ~/.dsh/helm/node.json (created by `dsh-helm init`), plus
 * environment overrides: DSH_HELM_HUB (ws/wss URL), DSH_HELM_MCP_URL,
 * DSH_HELM_MCP_TOKEN, DSH_HELM_LOG.
 */

import { loadConfig } from './config.js'
import { HelmNodeAgent } from './agent.js'
import { McpLocalHelmBackend } from './bridge.js'
import { ManualPresenceProvider, CompositePresenceProvider, DesktopSidecarPresenceProvider, PresenceListener } from '@dsh-helm/presence'

export interface AgentCliOptions {
  hubUrl?: string
  logLines: boolean
}

export function parseAgentArgs(argv: string[]): AgentCliOptions {
  const opts: AgentCliOptions = { logLines: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    switch (a) {
      case '--hub': opts.hubUrl = next(); break
      case '--quiet': opts.logLines = false; break
      default: throw new Error(`unknown agent option: ${a}`)
    }
  }
  return opts
}

export function runAgent(opts: AgentCliOptions, log: (l: string) => void = console.log): { agent: HelmNodeAgent; listener?: PresenceListener } {
  const cfg = loadConfig()
  if (opts.hubUrl) cfg.hub_url = opts.hubUrl
  if (process.env.DSH_HELM_HUB) cfg.hub_url = process.env.DSH_HELM_HUB
  if (process.env.DSH_HELM_MCP_URL) cfg.local_mcp_url = process.env.DSH_HELM_MCP_URL
  if (process.env.DSH_HELM_MCP_TOKEN) cfg.local_mcp_token = process.env.DSH_HELM_MCP_TOKEN

  // Default backend: local Helm MCP. Token read from ~/.agent-chatgpt-helm/token
  // when node.json has no explicit local_mcp_token — never argv, never logs.
  const backend = new McpLocalHelmBackend({ url: cfg.local_mcp_url, token: cfg.local_mcp_token || undefined, log })

  // Presence chain: manual pin > desktop sidecar (macOS) > browser listener.
  let listener: PresenceListener | undefined
  let presenceProvider: { probe(): Promise<unknown> } | undefined
  const providers: Array<{ probe(): Promise<unknown> }> = []
  providers.push(new ManualPresenceProvider({ nodeId: cfg.node_id }))
  if (process.platform === 'darwin') {
    const sidecar = new DesktopSidecarPresenceProvider({ nodeId: cfg.node_id, log })
    providers.push(sidecar)
  }
  const chain = new CompositePresenceProvider(providers as never[])
  presenceProvider = chain

  const agent = new HelmNodeAgent({
    config: cfg,
    backend,
    presenceProvider: presenceProvider as never,
    log: opts.logLines ? log : () => {},
  })

  // Local presence listener for the browser helper (loopback only).
  try {
    listener = new PresenceListener({
      nodeId: cfg.node_id,
      port: 3472,
      onClaim: (claim) => {
        agent.reportPresence(claim)
      },
      log,
    })
    void listener.listen()
  } catch (err) {
    log(`presence listener skipped: ${err instanceof Error ? err.message : err}`)
  }

  agent.start()
  log(`node agent started (node_id=${cfg.node_id}, hub=${cfg.hub_url})`)
  return { agent, listener }
}

const isMain = process.argv[1] && (process.argv[1].endsWith('agent-cli.js') || process.argv[1].endsWith('dsh-helm-agent'))
if (isMain) {
  try {
    const opts = parseAgentArgs(process.argv.slice(2))
    const { agent, listener } = runAgent(opts)
    const shutdown = () => {
      agent.stop()
      listener?.close()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (err) {
    console.error(`agent failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
