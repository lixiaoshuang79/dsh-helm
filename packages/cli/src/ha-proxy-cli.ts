/**
 * `dsh-helm ha-proxy` — run the tunnel entry HA front proxy.
 *
 * Listens on 127.0.0.1:<port> (default 3481) and forwards the MCP surface
 * (/mcp, /healthz, /readyz) to the currently healthy control plane:
 * primary (local, default http://127.0.0.1:3471) preferred, secondary
 * (remote CP) on failover. Point the tunnel-client's --mcp.server-url at
 * http://127.0.0.1:3481/mcp to keep a single ChatGPT connector working
 * across control-plane failover.
 */

import { createServer, type Server } from 'node:http'
import { HaProxyController, toWebRequest, type HaBackend } from './ha-proxy.js'

export interface HaProxyCommandArgs {
  port?: number
  primaryUrl?: string
  secondaryUrl?: string
  secondaryLabel?: string
  probeIntervalMs?: number
  failThreshold?: number
  recoverThreshold?: number
  healthPath?: string
}

const DEFAULTS = {
  port: 3481,
  primaryUrl: 'http://127.0.0.1:3471',
}

function parseFlagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

export function parseHaProxyArgs(argv: string[]): HaProxyCommandArgs {
  const args: HaProxyCommandArgs = {}
  const port = parseFlagValue(argv, '--port')
  if (port) {
    const n = Number(port)
    if (Number.isFinite(n) && n > 0 && n < 65536) args.port = n
  }
  args.primaryUrl = parseFlagValue(argv, '--primary') ?? DEFAULTS.primaryUrl
  args.secondaryUrl = parseFlagValue(argv, '--secondary')
  args.secondaryLabel = parseFlagValue(argv, '--secondary-label')
  const probe = parseFlagValue(argv, '--probe-interval-ms')
  if (probe) args.probeIntervalMs = Number(probe)
  const fail = parseFlagValue(argv, '--fail-threshold')
  if (fail) args.failThreshold = Number(fail)
  const recover = parseFlagValue(argv, '--recover-threshold')
  if (recover) args.recoverThreshold = Number(recover)
  args.healthPath = parseFlagValue(argv, '--health-path')
  return args
}

/**
 * Start the HA proxy HTTP server. Stays resident until the process exits.
 * Returns the server (for tests) — the CLI path awaits a never-resolving
 * promise so the process keeps serving.
 */
export async function startHaProxy(args: HaProxyCommandArgs): Promise<{ server: Server; proxy: HaProxyController; port: number }> {
  const port = args.port ?? DEFAULTS.port
  const primary: HaBackend = { id: 'primary', label: 'local', baseUrl: args.primaryUrl ?? DEFAULTS.primaryUrl }
  if (!args.secondaryUrl) {
    throw new Error('ha-proxy: --secondary <url> is required (remote control plane URL, e.g. http://100.64.0.1:3471)')
  }
  const secondary: HaBackend = { id: 'secondary', label: args.secondaryLabel ?? 'remote', baseUrl: args.secondaryUrl }
  const proxy = new HaProxyController(
    {
      primary,
      secondary,
      probeIntervalMs: args.probeIntervalMs,
      failThreshold: args.failThreshold,
      recoverThreshold: args.recoverThreshold,
      healthPath: args.healthPath,
    },
    true,
  )
  const server = createServer((req, res) => {
    // HA status endpoint for dashboard/doctor (loopback only).
    if (req.method === 'GET' && req.url?.startsWith('/ha-status')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(proxy.status()))
      return
    }
    void (async () => {
      try {
        const webReq = await toWebRequest(req)
        const out = await proxy.handle(webReq)
        res.writeHead(out.status, Object.fromEntries(out.headers.entries()))
        res.end(await out.text())
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: `ha-proxy: ${String(err)}` } }))
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return { server, proxy, port }
}

export async function runHaProxy(argv: string[]): Promise<number> {
  let args: HaProxyCommandArgs
  try {
    args = parseHaProxyArgs(argv)
    if (!args.secondaryUrl) throw new Error('missing --secondary')
  } catch (err) {
    console.error(`ha-proxy: ${String(err)}`)
    console.error('usage: dsh-helm ha-proxy --secondary <http://remote-cp:3471> [--port 3481] [--primary http://127.0.0.1:3471]')
    return 1
  }
  try {
    const { proxy, port } = await startHaProxy(args)
    console.log(`dsh-helm ha-proxy listening on http://127.0.0.1:${port} (primary=${args.primaryUrl} secondary=${args.secondaryUrl})`)
    // Stay resident; main() must not process.exit before this resolves.
    await new Promise(() => {
      void proxy // keep reference
    })
    return 0
  } catch (err) {
    console.error(`ha-proxy: failed to start: ${String(err)}`)
    return 1
  }
}