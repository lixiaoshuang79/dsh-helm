#!/usr/bin/env node
/**
 * dsh-helm hub entry: starts the control plane hub (mesh WS + MCP server).
 *
 * Usage:
 *   dsh-helm-hub --mesh-port 3470 --mcp-port 3471 --store ~/.dsh/helm/store.sqlite3
 *
 * Token lookup: DSH_HELM_TOKEN (`node_id=token` comma-separated) merged with
 * the persisted registration_tokens table (populated by device enrollment) —
 * freshly paired nodes authenticate without touching hub env vars.
 * Loopback only by default; set DSH_HELM_BIND=0.0.0.0 for WSS behind a proxy.
 *
 * Control-plane HA (dual CP, 2/2-quorum write lease):
 *   --cp-peer <ws-url>      dial this peer hub (repeatable; e.g. ws://host:3470)
 *   --cp-id <id>            this CP's identity (default: --default-node, else
 *                           ~/.dsh/helm/node.json node_id, else --hub-id)
 *   --cp-token <token>      token used when authenticating to peers (server
 *                           side looks up `cp:<cp_id>` in the same token table)
 *   --cp-token-env <ENV>    read the CP token from this environment variable
 *   --cp-priority <n>       election priority (smallest wins; default 0)
 *   --cp-failover-ms <ms>   write-lease TTL: after this long without peer
 *                           acks the hub demotes to read-only and refuses
 *                           writes (QUORUM_LOST). Default 45s. Followers
 *                           NEVER self-promote (no split-brain writes).
 *   --cp-lease-renew-ms <ms>
 *                           write-lease renew interval (must stay below the
 *                           TTL). Default 10s.
 *
 * Loopback pairing endpoints on the MCP HTTP server:
 *   GET /pair/new  -> { code, expiresAt }   (create a one-time pairing code)
 *   GET /pair/list -> { codes: [...] }      (recent codes, hash prefix only)
 * Both return 403 unless the MCP server binds a loopback address.
 *
 * HA status endpoint (loopback):
 *   GET /cp-status -> { cpId, role, term, leaderId, peers, syncOk, ... }
 *
 * Health/ops endpoints on the MCP HTTP server (P3):
 *   GET /healthz -> { ok, nodes }                  (existing liveness)
 *   GET /metrics -> McpMetrics snapshot            (size-guard + call counters)
 *   GET /readyz  -> { ok: true } | 503 { ok: false, reason }
 *   GET /version -> { name: 'dsh-helm-hub', version }
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { DshHelmStore, NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry, RegistrationTokenStore } from '@dsh-helm/store'
import { ControlPlane, HubConnection, MeshServer, HubMcpServer, PairingService, HubHa, McpMetrics } from '@dsh-helm/hub'
import { CP_NODE_PREFIX, DEFAULT_CP_LEASE_RENEW_MS, DEFAULT_CP_LEASE_TTL_MS, DEFAULT_CP_PRIORITY } from '@dsh-helm/protocol'
import { DEFAULT_PORTS } from '@dsh-helm/platform'

/** hub 包版本（packages/hub/package.json），供 /version 与 /metrics 使用。 */
const HUB_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

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
  /** Control-plane peer ws URLs (dual-CP; empty = standalone). */
  cpPeers: string[]
  cpId: string
  cpToken: string
  cpPriority: number
  cpFailoverMs: number
  /** Write-lease renew interval (ms); must stay below cpFailoverMs. */
  leaseRenewMs: number
}

/** cpId fallback: the local node.json node_id (same file the agent uses). */
export function readNodeIdFromNodeJson(): string {
  try {
    const raw = JSON.parse(readFileSync(`${process.env.HOME ?? '.'}/.dsh/helm/node.json`, 'utf8')) as { node_id?: string }
    return raw.node_id ?? ''
  } catch {
    return ''
  }
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
    cpPeers: [],
    cpId: '',
    cpToken: '',
    cpPriority: DEFAULT_CP_PRIORITY,
    cpFailoverMs: DEFAULT_CP_LEASE_TTL_MS,
    leaseRenewMs: DEFAULT_CP_LEASE_RENEW_MS,
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
      case '--cp-peer': opts.cpPeers.push(next()); break
      case '--cp-id': opts.cpId = next(); break
      case '--cp-token': opts.cpToken = next(); break
      case '--cp-token-env': opts.cpToken = process.env[next()] ?? ''; break
      case '--cp-priority': opts.cpPriority = Number(next()); break
      case '--cp-failover-ms': opts.cpFailoverMs = Number(next()); break
      case '--cp-lease-renew-ms': opts.leaseRenewMs = Number(next()); break
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

/** True when a listen address is loopback-only (pairing endpoints require it). */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '::ffff:127.0.0.1' || host.startsWith('127.')
}

export function startHub(opts: HubCliOptions, log: (l: string) => void = console.log): { cp: ControlPlane; mesh: MeshServer; mcp: HubMcpServer; mcpHttp: ReturnType<typeof createServer>; store: DshHelmStore; pairing: PairingService; ha: HubHa; metrics: McpMetrics } {
  const store = new DshHelmStore({ file: opts.storeFile })
  const nodes = new NodeRegistry(store.db)
  const sessions = new SessionCatalog(store.db)
  const workspaces = new WorkspaceCatalog(store.db)
  const presence = new PresenceRegistry(store.db)
  const connections = new Map<string, HubConnection>()
  // Token lookup: env DSH_HELM_TOKEN first, then the persisted enrollment
  // registration_tokens table — freshly paired nodes authenticate without
  // any hub env var changes. Peer hubs authenticate with `cp:<cp_id>` keys
  // in the same table (or env).
  const envTokenLookup = tokenLookupFromEnv(process.env.DSH_HELM_TOKEN)
  const registrationTokens = new RegistrationTokenStore(store.db)
  const tokenLookup = (nodeId: string): string | undefined => envTokenLookup(nodeId) ?? registrationTokens.get(nodeId)
  const cp = new ControlPlane({
    store, nodes, sessions, workspaces, presence,
    hubId: opts.hubId,
    schemaVersion: 1,
    heartbeatMs: opts.heartbeatMs,
    leaseMs: opts.leaseMs,
    defaultNodeId: opts.defaultNodeId,
    tokenLookup,
    connections,
    log,
  })
  const pairing = new PairingService({ cp, store, log })
  cp.pairing = pairing
  // Control-plane HA: identity defaults to --default-node, else the local
  // node.json node_id, else the hub id.
  const cpId = opts.cpId || opts.defaultNodeId || readNodeIdFromNodeJson() || opts.hubId
  const ha = new HubHa({
    cpId,
    priority: opts.cpPriority,
    peerUrls: opts.cpPeers,
    cpToken: opts.cpToken,
    tokenLookup,
    store,
    nodes,
    connections,
    leaseMs: opts.leaseMs,
    leaseTtlMs: opts.cpFailoverMs,
    leaseRenewMs: opts.leaseRenewMs,
    log,
  })
  cp.attachHa(ha)
  const mesh = new MeshServer({
    cp,
    port: opts.meshPort,
    host: opts.bind,
    rpcExtras: (peer, nodeId) => {
      if (nodeId.startsWith(CP_NODE_PREFIX)) ha.registerInboundPeer(nodeId.slice(CP_NODE_PREFIX.length), peer)
    },
    connectionClosed: (nodeId) => {
      if (nodeId?.startsWith(CP_NODE_PREFIX)) ha.onPeerDisconnected(nodeId.slice(CP_NODE_PREFIX.length), 'inbound')
    },
  })
  // MCP 调用指标（P3）：注入 MCP server，/metrics 端点从这里出数据。
  const metrics = new McpMetrics()
  const mcp = new HubMcpServer({ cp, ha, log, metrics })
  const mcpAddr = opts.mcpBind ?? opts.bind
  const pairEligible = isLoopbackHost(mcpAddr)
  // Streamable HTTP transport for the MCP surface (same shape as the daemon).
  const mcpHttp = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/cp-status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ha.statusPayload()))
      return
    }
    if (req.method === 'GET' && (req.url === '/pair/new' || req.url === '/pair/list')) {
      void (async () => {
        try {
          if (!pairEligible) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'pairing endpoints require the hub MCP to bind loopback (127.0.0.1)' }))
            return
          }
          if (req.url === '/pair/new') {
            const pair = await pairing.createPairingCode()
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(pair))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ codes: pairing.listCodes(20) }))
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })()
      return
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        void (async () => {
          try {
            const call = JSON.parse(body) as { method?: string; id?: number; params?: { name?: string; arguments?: Record<string, unknown> } }
            if (call.method === 'initialize') {
              res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `hub-${Date.now()}` })
              res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dsh-helm-hub', version: HUB_VERSION } } }))
              return
            }
            if (call.method?.startsWith('notifications/')) {
              // Streamable HTTP notifications (e.g. notifications/initialized):
              // 202 Accepted, no body — required by standard MCP clients
              // (tunnel-client probes with initialize + notifications/initialized).
              res.writeHead(202, { 'content-type': 'application/json' })
              res.end()
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
    if (req.method === 'GET' && req.url === '/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'dsh-helm-hub', version: HUB_VERSION }))
      return
    }
    if (req.method === 'GET' && req.url === '/metrics') {
      // activeConnections = 直接连接的节点数 + 已连接的 CP peer 数。
      // cp.connections 不含 cp peer（peer 走 onPeerAuthenticated 分支，
      // 不进入节点路由表），因此从 ha.statusPayload().peers 补统计。
      const activeConnections = cp.connections.size + ha.statusPayload().peers.filter((p) => p.connected).length
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(metrics.snapshot(activeConnections, HUB_VERSION)))
      return
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      // 就绪判定：standalone 直接就绪；HA 模式要求 quorum=true 且本地
      // MCP 可用（工具表非空），否则 503 并说明原因。
      const mcpOk = mcp.listTools().length > 0
      if (!mcpOk) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, reason: 'mcp server not ready' }))
        return
      }
      if (opts.cpPeers.length > 0 && !ha.quorum()) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, reason: `no control-plane quorum (phase=${ha.phaseValue()})` }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  mcpHttp.listen(opts.mcpPort, mcpAddr, () => log(`hub MCP listening on ${mcpAddr}:${opts.mcpPort}`))
  log(`hub mesh listening on ${opts.bind}:${opts.meshPort} (hubId=${opts.hubId})`)
  ha.start()
  if (opts.cpPeers.length > 0) log(`hub HA enabled: cpId=${cpId} peers=${opts.cpPeers.join(',')} priority=${opts.cpPriority} failover=${opts.cpFailoverMs}ms`)
  return { cp, mesh, mcp, mcpHttp, store, pairing, ha, metrics }
}

// CLI entry (only when run directly)
const isMain = process.argv[1] && (process.argv[1].endsWith('hub.js') || process.argv[1].endsWith('hub.mjs') || process.argv[1].endsWith('hub-cli.js') || process.argv[1].endsWith('dsh-helm-hub'))
if (isMain) {
  try {
    const opts = parseHubArgs(process.argv.slice(2))
    const { mesh, mcpHttp, store, cp, ha } = startHub(opts)
    const shutdown = () => {
      ha.stop()
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
