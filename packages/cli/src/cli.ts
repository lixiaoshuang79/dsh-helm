/**
 * dsh-helm CLI: operator interface to the control plane.
 *
 * Commands:
 *   init                 Generate node identity (node_id + token, 0600)
 *   agent                Run the node agent (foreground)
 *   hub                  Run the hub (mesh + MCP, foreground)
 *   status               Local config + connection status
 *   doctor               Run local diagnostics (read-only report)
 *   dashboard            Start the web dashboard (port 3480)
 *   install              Check prerequisites + installation guide
 *   nodes list           List nodes (from hub store)
 *   node get <id>        One node detail
 *   route-explain        Explain routing for an op
 *   presence claim/release <node>
 *   target <node>        Set an explicit session-scoped target (in-memory)
 *   rotate-token         Generate a new node token
 *   handoff <session> <to-node>   (v1: returns unsupported — spec exists)
 *   verify               Self-check config and local daemon reachability
 *
 * The CLI is deliberately thin: it reads/writes the same node.json config the
 * agent uses and talks to the hub through its RPC surface.
 */

import { loadConfig } from '@dsh-helm/node-agent'
import { findTailscaleCli, getTailscaleIp, getTailscaleVersion } from '@dsh-helm/platform'
import { spawnSync } from 'node:child_process'
import { runDoctor } from './doctor.js'
import { runDashboard } from './dashboard.js'
import { runInstall } from './install.js'

export type CliCommand =
  | 'init'
  | 'agent'
  | 'hub'
  | 'status'
  | 'doctor'
  | 'dashboard'
  | 'install'
  | 'nodes'
  | 'node'
  | 'route-explain'
  | 'presence'
  | 'target'
  | 'rotate-token'
  | 'handoff'
  | 'verify'
  | 'help'

export interface CliArgs {
  command: CliCommand
  args: string[]
  flags: Record<string, string | boolean>
}

/** Parse argv into a CliArgs (no subprocess; pure function, unit-testable). */
export function parseArgs(argv: string[]): CliArgs {
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}
  let command: CliCommand = 'help'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const key = a.slice(2)
        // Consume the next token as the flag value when it is not a flag.
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next
          i++
        } else {
          flags[key] = true
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      flags[a.slice(1)] = true
    } else if (command === 'help') {
      const c = a as CliCommand
      if (isCommand(c)) command = c
    } else {
      args.push(a)
    }
  }
  return { command, args, flags }
}

function isCommand(c: string): c is CliCommand {
  return ['init', 'agent', 'hub', 'status', 'doctor', 'dashboard', 'install', 'nodes', 'node', 'route-explain', 'presence', 'target', 'rotate-token', 'handoff', 'verify', 'help'].includes(c)
}

export const HELP_TEXT = `dsh-helm — DSH ChatGPT Helm multi-node control plane

Usage: dsh-helm <command> [args]

Commands:
  init                     Create node identity (~/.dsh/helm/node.json, 0600)
  agent                    Run the node agent (connects to hub)
  hub                      Run the hub (mesh WS + MCP server)
  status                   Show local config and hub connection status
  doctor [--hub URL] [--tunnel-health URL]
                           Run local diagnostics (read-only report)
  dashboard [--port N]    Start the web dashboard (default port 3480)
  install                  Check prerequisites + installation guide
  nodes list               List nodes known to the hub
  node get <node_id>       Show one node with health
  route-explain <op> [--session-id X] [--workspace W] [--target-node N]
                           Explain how an op would be routed
  presence claim <node>    Pin presence on a node (10min)
  presence release <node>  Release a manual presence claim
  target <node>            Set explicit target node for this CLI session
  rotate-token             Generate a new node token
  handoff <session> <to>   Request session handoff (v1: unsupported)
  verify                   Self-check config + local daemon reachability
  help                     This help
`

/** Output helpers (JSON mode with --json). */
export function render(data: unknown, json: boolean): string {
  if (json) return JSON.stringify(data, null, 2)
  if (typeof data === 'string') return data
  return JSON.stringify(data, null, 2)
}

export function defaultOutput(): string {
  const cfg = tryLoad()
  if (!cfg) return 'no node config found — run: dsh-helm init'
  return [
    `node_id:   ${cfg.node_id}`,
    `name:      ${cfg.display_name}`,
    `hub_url:   ${cfg.hub_url || '(not set)'}`,
    `local mcp: ${cfg.local_mcp_url}`,
  ].join('\n')
}

/** status 增强：tailscale 版本/IP（已安装时），只读、无失败路径。 */
export function statusTailscaleLines(): string[] {
  const cli = findTailscaleCli()
  if (!cli) return []
  const ver = getTailscaleVersion(cli)
  const ip = getTailscaleIp(cli)
  return [`tailscale: ${ver ? `v${ver}` : '已安装'}${ip ? ` ip=${ip}` : ''}`]
}

function tryLoad() {
  try {
    return loadConfig()
  } catch {
    return undefined
  }
}

/** Handoff is a documented no-op in v1: explicit interface, honest unsupported. */
export function handoffV1(sessionId: string, toNode: string): { supported: false; reason: string; session_id: string; to_node: string } {
  return {
    supported: false,
    reason: 'session handoff is specified in the control-plane design but not implemented in protocol v1; no lossless migration exists yet',
    session_id: sessionId,
    to_node: toNode,
  }
}

/** Main dispatch: dsh-helm <command>. (Agent/hub commands are thin executors
 *  that shell out to the runtimes via their package bins.) */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  switch (parsed.command) {
    case 'help':
      console.log(HELP_TEXT)
      return 0
    case 'init': {
      const cfg = loadConfig()
      console.log(`node identity ready: ${cfg.node_id}`)
      console.log(`config: ~/.dsh/helm/node.json (0600)`)
      console.log(`hub_url: ${cfg.hub_url || '(set via --hub / DSH_HELM_HUB at agent start)'}`)
      return 0
    }
    case 'status': {
      console.log([defaultOutput(), ...statusTailscaleLines()].join('\n'))
      return 0
    }
    case 'doctor':
      return runDoctor(parsed.args, {
        hubUrl: flagString(parsed.flags['hub']),
        tunnelHealthUrl: flagString(parsed.flags['tunnel-health']),
      })
    case 'dashboard':
      await runDashboard(parsed.args, parsed.flags)
      // 成功时 runDashboard 永久挂起（前台常驻）；失败时保留 process.exitCode
      return Number(process.exitCode ?? 0)
    case 'install':
      return runInstall(parsed.args, { hubUrl: flagString(parsed.flags['hub']) })
    case 'handoff': {
      const [sessionId, toNode] = parsed.args
      if (!sessionId || !toNode) {
        console.error('usage: dsh-helm handoff <session_id> <to_node>')
        return 1
      }
      const r = handoffV1(sessionId, toNode)
      console.log(JSON.stringify(r, null, 2))
      return r.supported ? 0 : 1
    }
    case 'agent':
      // delegate to the node-agent package bin
      return execBin('dsh-helm-agent', parsed.args)
    case 'hub':
      return execBin('dsh-helm-hub', parsed.args)
    case 'nodes':
    case 'node':
    case 'route-explain':
    case 'presence':
    case 'target':
    case 'rotate-token':
    case 'verify':
      console.error(`command '${parsed.command}' requires a live hub connection (RPC) — available in the next milestone; run 'dsh-helm hub' first.`)
      return 1
    default:
      console.log(HELP_TEXT)
      return 0
  }
}

function execBin(name: string, args: string[]): number {
  const res = spawnSync(name, args, { stdio: 'inherit', shell: true })
  return res.status ?? 1
}

function flagString(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

const isMain = process.argv[1] && (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('dsh-helm'))
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
