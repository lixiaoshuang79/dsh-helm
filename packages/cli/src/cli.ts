/**
 * dsh-helm CLI: operator interface to the control plane.
 *
 * Commands:
 *   init                 Generate node identity (node_id + token, 0600)
 *   agent                Run the node agent (foreground)
 *   hub                  Run the hub (mesh + MCP, foreground)
 *   status               Local config + connection status
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

export type CliCommand =
  | 'init'
  | 'agent'
  | 'hub'
  | 'status'
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
  return ['init', 'agent', 'hub', 'status', 'nodes', 'node', 'route-explain', 'presence', 'target', 'rotate-token', 'handoff', 'verify', 'help'].includes(c)
}

export const HELP_TEXT = `dsh-helm — DSH ChatGPT Helm multi-node control plane

Usage: dsh-helm <command> [args]

Commands:
  init                     Create node identity (~/.dsh/helm/node.json, 0600)
  agent                    Run the node agent (connects to hub)
  hub                      Run the hub (mesh WS + MCP server)
  status                   Show local config and hub connection status
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
