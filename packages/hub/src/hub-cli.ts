#!/usr/bin/env node
/**
 * dsh-helm hub entry: starts the control plane hub (mesh WS + MCP server).
 *
 * Usage:
 *   dsh-helm-hub --mesh-port 3470 --mcp-port 3471 --store ~/.dsh/helm/store.sqlite3
 *
 * Token lookup is delegated to the DSH_HELM_TOKEN environment variable:
 * `node_id=token` comma-separated (production would use a secrets manager).
 * Loopback only by default; set DSH_HELM_BIND=0.0.0.0 for WSS behind a proxy.
 */

import { createServer } from 'node:http'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '@dsh-helm/store'
import { ControlPlane, HubConnection, MeshServer, HubMcpServer } from '@dsh-helm/hub'
import { DEFAULT_PORTS } from '@dsh-helm/platform'

interface HubCliOptions {
  meshPort: number
  mcpPort: number
  storeFile: string
  hubId: string
  defaultNodeId: string
  bind: string
  /** Optional separate listen address for the (unauthenticated) MCP server;
   *  defaults to `bind`. Keep loopback unless you know why not. */
  mcpBind?: string
  heartbeatMs: number
  leaseMs: number
}

export function parseHubArgs(argv: string[]): HubCliOptions {
  const opts: HubCliOptions = {
    meshPort: DEFAULT_PORTS.mesh,
    mcpPort: DEFAULT_PORTS.mcp,
    storeFile: process.env.DSH_HELM_STORE ?? `${process.env.HOME ?? '.'}/.dsh/helm/store.sqlite3`,
    hubId: 'hub-1',
    defaultNodeId: process.env.DSH_HELM_DEFAULT_NODE ?? '',
    bind: '127.0.0.1',
    heartbeatMs: 15_000,
    leaseMs: 45_000,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    switch (a) {
      case '--mesh-port': opts.meshPort = Number(next()); break
      case '--mcp-port': opts.mcpPort = Number(next()); break
      case '--store': opts.storeFile = next(); break
      case '--hub-id': opts.hubId = next(); break
      case '--default-node': opts.defaultNodeId = next(); break
      case '--bind': opts.bind = next(); break
      case '--mcp-bind': opts.mcpBind = next(); break
      case '--heartbeat-ms': opts.heartbeatMs = Number(next()); break
      case '--lease-ms': opts.leaseMs = Number(next()); break
      default: throw new Error(`unknown hub option: ${a}`)
    }
  }
  return opts
}

/** Parse DSH_HELM_TOKEN "node_id=token,..." into a lookup. */
export function tokenLookupFromEnv(env: string | undefined): (nodeId: string) => string | undefined {
  const map = new Map<string, string>()
  for (const pair of (env ?? '').split(',').filter(Boolean)) {
    const eq = pair.indexOf('=')
    if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  return (id) => map.get(id)
}

export function startHub(opts: HubCliOptions, log: (l: string) => void = console.log): { cp: ControlPlane; mesh: MeshServer; mcp: HubMcpServer; mcpHttp: ReturnType<typeof createServer>; store: DshHelmStore } {
  const store = new DshHelmStore({ file: opts.storeFile })
  const nodes = new NodeRegistry(store.db)
  const sessions = new SessionCatalog(store.db)
  const workspaces = new WorkspaceCatalog(store.db)
  const presence = new PresenceRegistry(store.db)
  const connections = new Map<string, HubConnection>()
  const cp = new ControlPlane({
    store, nodes, sessions, workspaces, presence,
    hubId: opts.hubId,
    schemaVersion: 1,
    heartbeatMs: opts.heartbeatMs,
    leaseMs: opts.leaseMs,
    defaultNodeId: opts.defaultNodeId,
    tokenLookup: tokenLookupFromEnv(process.env.DSH_HELM_TOKEN),
    connections,
    log,
  })
  const mesh = new MeshServer({ cp, port: opts.meshPort, host: opts.bind })
  const mcp = new HubMcpServer({ cp, log })
  // Streamable HTTP transport for the MCP surface (same shape as the daemon).
  const mcpHttp = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        void (async () => {
          try {
            const call = JSON.parse(body) as { method?: string; id?: number; params?: { name?: string; arguments?: Record<string, unknown> } }
            if (call.method === 'initialize') {
              res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `hub-${Date.now()}` })
              res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dsh-helm-hub', version: '0.1.0' } } }))
              return
            }
            if (call.method === 'tools/list') {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { tools: mcp.listTools() } }))
              return
            }
            if (call.method === 'tools/call' && call.params?.name) {
              const out = await mcp.callTool({ name: call.params.name, arguments: call.params.arguments ?? {} })
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: out }))
              return
            }
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `method not found: ${call.method}` } }))
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err) } }))
          }
        })()
      })
      return
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, nodes: cp.nodeCatalog().length }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const mcpAddr = opts.mcpBind ?? opts.bind
  mcpHttp.listen(opts.mcpPort, mcpAddr, () => log(`hub MCP listening on ${mcpAddr}:${opts.mcpPort}`))
  log(`hub mesh listening on ${opts.bind}:${opts.meshPort} (hubId=${opts.hubId})`)
  return { cp, mesh, mcp, mcpHttp, store }
}

// CLI entry (only when run directly)
const isMain = process.argv[1] && (process.argv[1].endsWith('hub.js') || process.argv[1].endsWith('hub.mjs') || process.argv[1].endsWith('hub-cli.js') || process.argv[1].endsWith('dsh-helm-hub'))
if (isMain) {
  try {
    const opts = parseHubArgs(process.argv.slice(2))
    const { mesh, mcpHttp, store, cp } = startHub(opts)
    const shutdown = () => {
      void mesh.close()
      mcpHttp.close()
      cp.stop()
      store.close()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (err) {
    console.error(`hub failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
