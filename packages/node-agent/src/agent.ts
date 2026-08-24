/**
 * HelmNodeAgent: the node-side process.
 *
 * Responsibilities:
 * - dial OUT to the hub (ws:// loopback/test, wss:// production),
 * - HMAC handshake (client side),
 * - after welcome: register node metadata, reconcile sessions/workspaces,
 * - periodic heartbeat (with health report from the local backend probe),
 * - serve hub-initiated RPCs (health/tools.list/tools.call/...) mapped onto
 *   the LocalHelmBackend (default: McpLocalHelmBackend -> local Helm MCP),
 * - reconnect with exponential backoff + jitter; full re-register + reconcile
 *   after every reconnect (no partial state),
 * - expose presence reports to the hub (delegated to presence providers).
 */

import type { WireMessage, NodeInfo, NodeStatus, HealthReport, SessionInfo, WorkspaceInfo, PresenceClaim } from '@dsh-helm/protocol'
import { HandshakeClient, NODE_METHODS, HUB_METHODS, RpcPeer, type MessagePeer } from '@dsh-helm/protocol'
import { DEFAULT_HEARTBEAT_MS, DEFAULT_NODE_LEASE_MS, RECONNECT_BACKOFF_BASE_MS, RECONNECT_BACKOFF_MAX_MS } from '@dsh-helm/protocol'
import type { LocalHelmBackend } from './bridge.js'
import type { NodeAgentConfig } from './config.js'

export interface NodeAgentOptions {
  config: NodeAgentConfig
  /** Backend to the local helm daemon (default McpLocalHelmBackend; FakeBackend in tests). */
  backend: LocalHelmBackend
  /** WebSocket factory (defaults to global WebSocket; injectable for tests). */
  wsFactory?: (url: string) => WebSocketLike
  /** Presence provider hook: returns the current claim or undefined. */
  presenceProvider?: () => Promise<PresenceClaim | undefined>
  log?: (line: string) => void
  heartbeatMs?: number
  leaseMs?: number
}

/** Minimal WebSocket surface used by the agent (compatible with undici/ws). */
export interface WebSocketLike {
  readyState: number
  OPEN: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: ((err: unknown) => void) | null
}

type AgentState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'

export class HelmNodeAgent {
  private cfg: NodeAgentConfig
  private backend: LocalHelmBackend
  private wsFactory: (url: string) => WebSocketLike
  private presenceProvider?: () => Promise<PresenceClaim | undefined>
  private logFn?: (line: string) => void
  private heartbeatMs: number
  private leaseMs: number
  private state: AgentState = 'idle'
  private socket?: WebSocketLike
  private peer?: RpcPeer
  private heartbeatTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private stopped = false
  private backoff = RECONNECT_BACKOFF_BASE_MS
  private seq = 0
  private health: HealthReport = {
    channel: { status: 'unknown' },
    adapter: { status: 'unknown' },
    datapath: { status: 'unknown' },
    serena: { status: 'unknown' },
  }
  private hubNodeId?: string

  constructor(opts: NodeAgentOptions) {
    this.cfg = opts.config
    this.backend = opts.backend
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
    this.presenceProvider = opts.presenceProvider
    this.logFn = opts.log
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.leaseMs = opts.leaseMs ?? DEFAULT_NODE_LEASE_MS
  }

  get stateLabel(): AgentState {
    return this.state
  }

  /** Forward a presence claim to the hub (from providers/listener). */
  reportPresence(claim: PresenceClaim): void {
    if (!this.peer) return
    void this.peer.request(HUB_METHODS.PRESENCE_REPORT, { node_id: this.cfg.node_id, claim }).catch(() => {
      /* transient; next report retries */
    })
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.state = 'stopped'
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        /* ignore */
      }
      this.socket = undefined
    }
    this.peer?.close()
    this.peer = undefined
  }

  private log(line: string): void {
    this.logFn?.(line)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.state = 'connecting'
    // Ensure the local helm MCP session gets initialized; must NOT delay socket
    // event wiring below (ws.onopen must be set synchronously for tests/edge),
    // so fire-and-forget here and guarantee readiness in registerAndReconcile.
    if (!this.backend.connected) {
      this.backend
        .connect()
        .then(() => this.log('local helm connected'))
        .catch((err) => this.log(`local helm connect failed: ${err instanceof Error ? err.message : err} (datapath degraded)`))
    }
    let ws: WebSocketLike
    try {
      ws = this.wsFactory(this.cfg.hub_url)
    } catch (err) {
      this.log(`ws factory failed: ${err instanceof Error ? err.message : err}`)
      this.scheduleReconnect('ws-factory-failed')
      return
    }
    this.socket = ws

    // Handshake state machine (client side)
    const sender = {
      send: (m: WireMessage) => {
        try {
          ws.send(JSON.stringify(m))
        } catch {
          /* socket gone */
        }
      },
    }
    const handshake = new HandshakeClient(
      sender,
      this.cfg.node_id,
      this.cfg.token,
      1, // schemaVersion
      {
        onOutcome: (outcome) => {
          if (outcome.ok) {
            this.backoff = RECONNECT_BACKOFF_BASE_MS // reset on successful connect
            this.hubNodeId = outcome.welcome.hub_id
            this.onConnected(ws, outcome.welcome.heartbeat_ms ?? this.heartbeatMs, outcome.welcome.lease_ms ?? this.leaseMs)
          } else {
            this.log(`handshake failed: ${outcome.message}`)
            this.scheduleReconnect(`handshake:${outcome.code}`)
          }
        },
      },
    )
    this.handshakeClient = handshake

    ws.onopen = () => handshake?.start()
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WireMessage
        this.onWire(msg)
      } catch {
        this.log('dropping unparseable ws frame')
      }
    }
    ws.onclose = () => {
      if (!this.stopped && this.state === 'connected') {
        this.log('socket closed unexpectedly')
        this.scheduleReconnect('socket-close')
      }
    }
    ws.onerror = (err) => {
      this.log(`ws error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private onWire(msg: WireMessage): void {
    if (msg.type === 'rpc') {
      this.peer?.dispatchPublic(msg.body)
      return
    }
    // handshake messages are handled by HandshakeClient instance — but we
    // create it per connection; store it on this
    this.handshakeClient?.inbound(msg)
  }

  private handshakeClient?: HandshakeClient

  private onConnected(ws: WebSocketLike, heartbeatMs: number, _leaseMs: number): void {
    this.state = 'connected'
    this.log(`connected to hub ${this.hubNodeId}`)
    // Upgrade ws object: keep socket reference current
    const peer: MessagePeer = {
      send: (m) => {
        try {
          ws.send(JSON.stringify({ type: 'rpc', v: 1, body: m } as WireMessage))
        } catch {
          /* ignore */
        }
      },
    }
    this.peer = new RpcPeer(peer, (l) => this.log(l))
    this.registerRpcHandlers()
    void this.registerAndReconcile()
    // Heartbeat loop
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), heartbeatMs)
  }

  private async registerAndReconcile(): Promise<void> {
    // Guarantee the local helm session before serving hub RPCs / reconcile.
    if (!this.backend.connected) {
      try {
        await this.backend.connect()
      } catch {
        /* datapath degraded; hub connectivity unaffected */
      }
    }
    try {
      await this.peer?.request(HUB_METHODS.NODE_REGISTER, { node: this.nodeInfo() })
    } catch (err) {
      this.log(`register failed: ${err instanceof Error ? err.message : err}`)
      return
    }
    // reconcile after register (fresh catalog)
    try {
      const { sessions, workspaces } = await this.collectLocalCatalog()
      await this.peer?.request('catalog.reconcile', { node_id: this.cfg.node_id, sessions, workspaces })
    } catch (err) {
      this.log(`reconcile failed: ${err instanceof Error ? err.message : err}`)
    }
    // periodic reconcile
    void this.scheduleReconcile()
  }

  /** tools/call sessions_list → flat array (tolerates structuredContent {sessions:[...]} or bare array). */
  private async listSessionsRaw(): Promise<Array<Record<string, unknown>>> {
    const res = await this.backend.callTool('sessions_list', {})
    const sc = res.structuredContent as Record<string, unknown> | undefined
    if (Array.isArray(sc)) return sc as Array<Record<string, unknown>>
    if (sc && Array.isArray(sc.sessions)) return sc.sessions as Array<Record<string, unknown>>
    return []
  }

  /** tools/call workspaces_list → flat array (tolerates structuredContent {workspaces:[...]} or bare array). */
  private async listWorkspacesRaw(): Promise<Array<Record<string, unknown>>> {
    const res = await this.backend.callTool('workspaces_list', {})
    const sc = res.structuredContent as Record<string, unknown> | undefined
    if (Array.isArray(sc)) return sc as Array<Record<string, unknown>>
    if (sc && Array.isArray(sc.workspaces)) return sc.workspaces as Array<Record<string, unknown>>
    return []
  }

  /** Map raw helm session rows (real daemon uses `id`/`workspace`/`updatedAt`/`native.live`). */
  private toSessionInfos(raw: Array<Record<string, unknown>>): SessionInfo[] {
    return raw.map((s) => {
      const native = (s as { native?: { live?: boolean } }).native
      return {
        native_session_id: String(s.session_id ?? s.id ?? s.native_session_id ?? ''),
        title: s.title ? String(s.title) : undefined,
        status: (String(s.status ?? 'unknown') as SessionInfo['status']),
        live: Boolean((s as { live?: boolean }).live ?? native?.live ?? false),
        updated_at: String(s.updatedAt ?? s.updated_at ?? ''),
        workspace_id: s.workspace_id ? String(s.workspace_id) : s.workspace ? String(s.workspace) : undefined,
      }
    })
  }

  /** Map raw helm workspace rows (real daemon uses `id`). */
  private toWorkspaceInfos(raw: Array<Record<string, unknown>>): WorkspaceInfo[] {
    return raw.map((w) => ({
      native_workspace_id: String(w.workspace_id ?? w.id ?? w.native_workspace_id ?? ''),
      path: String(w.path ?? ''),
      title: w.title ? String(w.title) : undefined,
    }))
  }

  private async collectLocalCatalog(): Promise<{ sessions: SessionInfo[]; workspaces: WorkspaceInfo[] }> {
    const { sessions: rawSessions, workspaces: rawWorkspaces } = await this.backend.reconcile()
    return {
      sessions: this.toSessionInfos(rawSessions as Array<Record<string, unknown>>),
      workspaces: this.toWorkspaceInfos(rawWorkspaces as Array<Record<string, unknown>>),
    }
  }

  private scheduleReconcile(): void {
    const t = setTimeout(() => {
      void (async () => {
        try {
          const { sessions, workspaces } = await this.collectLocalCatalog()
          await this.peer?.request('catalog.reconcile', { node_id: this.cfg.node_id, sessions, workspaces })
        } catch {
          /* transient */
        }
        this.scheduleReconcile()
      })()
    }, this.cfg.reconcile_ms)
    t.unref?.()
  }

  private lastProbeAt = 0

  private async heartbeat(): Promise<void> {
    if (!this.peer) return
    this.seq++
    // Periodic local datapath probe (local_probe_ms) so hub health aggregations
    // see real adapter/datapath/serena layers instead of the initial unknown.
    if (Date.now() - this.lastProbeAt >= this.cfg.local_probe_ms) {
      try {
        await this.probeLocal()
      } catch {
        /* probeLocal updates this.health itself; transient errors tolerated */
      }
      this.lastProbeAt = Date.now()
    }
    const status: NodeStatus = {
      seq: this.seq,
      ts: new Date().toISOString(),
      health: this.health,
      workspace_count: 0,
      session_count: 0,
    }
    try {
      await this.peer?.request('node.heartbeat', { node_id: this.cfg.node_id, status })
    } catch (err) {
      this.log(`heartbeat failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  private registerRpcHandlers(): void {
    if (!this.peer) return
    this.peer.on(NODE_METHODS.HEALTH, async () => this.healthPayload())
    this.peer.on(NODE_METHODS.LIST_WORKSPACES, async () => this.toWorkspaceInfos(await this.listWorkspacesRaw()))
    this.peer.on(NODE_METHODS.LIST_SESSIONS, async () => this.toSessionInfos(await this.listSessionsRaw()))
    this.peer.on(NODE_METHODS.CREATE_SESSION, async (p) => {
      const params = p as { workspace?: string; title?: string; initial_message?: string }
      const res = await this.backend.callTool('sessions_create', {
        workspace: params.workspace,
        title: params.title,
        initial_message: params.initial_message,
      })
      return res.structuredContent ?? res.content ?? {}
    })
    this.peer.on(NODE_METHODS.GET_SESSION, async (p) => {
      const { session_id } = p as { session_id: string }
      const res = await this.backend.callTool('sessions_get', { session_id })
      return res.structuredContent ?? res.content ?? {}
    })
    this.peer.on(NODE_METHODS.RESUME_SESSION, async (p) => {
      const { session_id } = p as { session_id: string }
      const res = await this.backend.callTool('sessions_resume', { session_id })
      return res.structuredContent ?? res.content ?? {}
    })
    this.peer.on(NODE_METHODS.PROMPT, async (p) => {
      const { session_id, message } = p as { session_id: string; message: string }
      const res = await this.backend.callTool('sessions_prompt', { session_id, message })
      return res.structuredContent ?? res.content ?? {}
    })
    this.peer.on(NODE_METHODS.CANCEL, async (p) => {
      const { session_id } = p as { session_id: string }
      const res = await this.backend.callTool('sessions_cancel', { session_id })
      return res.structuredContent ?? res.content ?? {}
    })
    // Generic passthrough: hub routes any MCP tool here.
    this.peer.on(NODE_METHODS.MCP_CALL, async (p) => {
      const { tool, args } = p as { tool: string; args?: unknown }
      const res = await this.backend.callTool(tool, args ?? {})
      // Surface structured content to the hub (fall back to content blocks).
      return res.structuredContent ?? (res.content ? { content: res.content } : res)
    })
    // Generic capability discovery: the hub can list this node's tools.
    this.peer.on(NODE_METHODS.TOOLS_LIST, async () => {
      const tools = await this.backend.listTools()
      return { node_id: this.cfg.node_id, tools }
    })
    this.peer.on(NODE_METHODS.PRESENCE_REPORT, async (p) => {
      this.log(`presence report: ${JSON.stringify(p).slice(0, 120)}`)
      return { ok: true }
    })
  }

  private async healthPayload(): Promise<unknown> {
    await this.probeLocal()
    return {
      node_id: this.cfg.node_id,
      health: this.health,
      versions: { agent: '0.1.0', protocol: 1 },
    }
  }

  /** Probe the local bridge; update layered health. */
  async probeLocal(): Promise<HealthReport> {
    const now = new Date().toISOString()
    this.health.channel = { status: 'ok', checked_at: now }
    try {
      const res = await this.backend.callTool('supervisor_health', {})
      const sc = (res.structuredContent ?? {}) as {
        status?: string
        serena?: { connected?: boolean }
        adapters?: Array<{ id: string; health?: string }>
        tunnel?: unknown
      }
      this.health.adapter = { status: 'ok', checked_at: now }
      this.health.datapath = { status: 'ok', checked_at: now }
      this.health.serena = sc.serena?.connected ? { status: 'ok', checked_at: now } : { status: 'degraded', code: 'serena-disconnected', checked_at: now }
      if (sc.tunnel !== undefined) this.health.tunnel = { status: 'ok', checked_at: now }
      this.log(`local probe ok (serena ${sc.serena?.connected ? 'connected' : 'disconnected'})`)
    } catch (err) {
      this.health.adapter = { status: 'down', code: 'adapter-unreachable', detail: err instanceof Error ? err.message.slice(0, 120) : String(err), checked_at: now }
      this.health.datapath = { status: 'down', code: 'datapath-unreachable', checked_at: now }
      this.health.serena = { status: 'unknown', checked_at: now }
      this.log(`local probe failed: ${err instanceof Error ? err.message : err}`)
    }
    return this.health
  }

  private nodeInfo(): NodeInfo {
    return {
      node_id: this.cfg.node_id,
      display_name: this.cfg.display_name,
      platform: {
        os: platformOs(),
        arch: process.arch,
        release: process.platform === 'darwin' ? 'macOS' : process.platform,
        nodeVersion: process.version,
      },
      versions: { agent: '0.1.0', protocol: 1 },
      capabilities: {
        sessions: true,
        serena: true,
        tunnel: false,
        presenceProvider: !!this.presenceProvider,
        defaultNode: false,
      },
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return
    if (this.reconnectTimer) return
    const delay = this.backoff + Math.random() * 500
    this.backoff = Math.min(this.backoff * 2, RECONNECT_BACKOFF_MAX_MS)
    this.state = 'reconnecting'
    this.log(`reconnect in ${Math.round(delay)}ms (${reason})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.peer?.close()
      this.peer = undefined
      void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }
}

function platformOs(): 'darwin' | 'win32' | 'linux' {
  switch (process.platform) {
    case 'darwin':
      return 'darwin'
    case 'win32':
      return 'win32'
    default:
      return 'linux'
  }
}