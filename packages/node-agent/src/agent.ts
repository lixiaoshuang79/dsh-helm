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
import { defaultConfigDir, type NodeAgentConfig } from './config.js'
import { join } from 'node:path'
import { SessionSummaryService, type GetSessionParams } from './summary.js'
import { steerPrompt } from './steer.js'

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
  /** 摘要缓存目录（默认 ~/.dsh/helm/summaries；测试注入临时目录）。 */
  summaryCacheDir?: string
  /** DSH 宿主 API 的 fetch 实现（默认全局 fetch；测试注入 mock）。 */
  steerFetch?: typeof fetch
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
  /** sessions_get 响应隔离（P0 摘要 + P2 缓存），GET_SESSION 与 MCP_CALL 共用。 */
  private summaries: SessionSummaryService
  private state: AgentState = 'idle'
  private socket?: WebSocketLike
  private peer?: RpcPeer
  private heartbeatTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private stopped = false
  private backoff = RECONNECT_BACKOFF_BASE_MS
  /** Index of the control-plane endpoint currently being dialed. Advances one
   *  step per reconnect (round-robin over [hub_url, ...fallback_urls]) and
   *  sticks to the endpoint that last connected until it drops. */
  private endpointIndex = 0
  private seq = 0
  private health: HealthReport = {
    channel: { status: 'unknown' },
    adapter: { status: 'unknown' },
    datapath: { status: 'unknown' },
    serena: { status: 'unknown' },
  }
  private hubNodeId?: string
  /** DSH 宿主 API fetch 注入（测试 mock；缺省=全局 fetch）。 */
  private steerFetch?: typeof fetch

  constructor(opts: NodeAgentOptions) {
    this.cfg = opts.config
    this.backend = opts.backend
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
    this.presenceProvider = opts.presenceProvider
    this.logFn = opts.log
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.leaseMs = opts.leaseMs ?? DEFAULT_NODE_LEASE_MS
    this.steerFetch = opts.steerFetch
    this.summaries = new SessionSummaryService(opts.backend, {
      cacheDir: opts.summaryCacheDir ?? join(defaultConfigDir(), 'summaries'),
      log: (l) => this.log(l),
    })
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

  /** Control-plane endpoints in dial order: [hub_url, ...fallback_urls]. */
  private endpoints(): string[] {
    return [this.cfg.hub_url, ...(this.cfg.fallback_urls ?? [])].filter((u) => u !== '')
  }

  /** Current endpoint (round-robin; fixed after a successful connect). */
  private currentEndpoint(): string {
    const eps = this.endpoints()
    if (eps.length === 0) return ''
    return eps[this.endpointIndex % eps.length]!
  }

  /** Advance to the next endpoint; wraps around the list. */
  private advanceEndpoint(): void {
    const eps = this.endpoints()
    if (eps.length > 1) this.endpointIndex = (this.endpointIndex + 1) % eps.length
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.state = 'connecting'
    // Close any previous socket, suppressing its onclose so an intentional
    // close never schedules a reconnect. Half-open sockets (the hub accepted
    // the TCP connection but never completed the WS handshake — e.g. while
    // the hub itself is restarting) would otherwise pile up as leaked
    // ESTABLISHED connections, one per reconnect attempt.
    if (this.socket) {
      const old = this.socket
      this.socket = undefined
      old.onclose = null
      try {
        old.close()
      } catch {
        /* ignore */
      }
    }
    // Ensure the local helm MCP session gets initialized; must NOT delay socket
    // event wiring below (ws.onopen must be set synchronously for tests/edge),
    // so fire-and-forget here and guarantee readiness in registerAndReconcile.
    if (!this.backend.connected) {
      this.backend
        .connect()
        .then(() => this.log('local helm connected'))
        .catch((err) => this.log(`local helm connect failed: ${err instanceof Error ? err.message : err} (datapath degraded)`))
    }
    const url = this.currentEndpoint()
    if (url === '') {
      this.log('no control plane endpoint configured (hub_url empty)')
      this.scheduleReconnect('no-endpoint')
      return
    }
    this.log(`connecting to control plane ${url}`)
    let ws: WebSocketLike
    try {
      ws = this.wsFactory(url)
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
      // Reconnect on unexpected close AND on connections that never opened
      // (e.g. an endpoint that is down — refusal surfaces as error+close
      // while still 'connecting').
      if (!this.stopped && (this.state === 'connected' || this.state === 'connecting')) {
        this.log('socket closed unexpectedly')
        this.scheduleReconnect('socket-close')
      }
    }
    ws.onerror = (err) => {
      this.log(`ws error: ${err instanceof Error ? err.message : String(err)}`)
      // Some ws implementations do not guarantee a close event after a
      // failed connection attempt (refused/reset while still 'connecting');
      // without this the agent would hang forever. scheduleReconnect is
      // idempotent (no-op while a timer is pending), and a later onclose
      // would just hit the same guard.
      if (!this.stopped && (this.state === 'connecting' || this.state === 'connected')) {
        this.scheduleReconnect('socket-error')
      }
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

  /** True while a return-to-primary probe is in flight. */
  private primaryProbeInFlight = false

  /**
   * Return to the primary control plane when it comes back. A reconnect during
   * a hub restart round-robins to a fallback and pins it (the fallback stays
   * stable), leaving this node invisible to the primary's catalog until the
   * agent restarts. While pinned on a fallback, probe the primary on every
   * heartbeat; a live primary triggers a clean switch back.
   */
  private async tryReturnToPrimary(): Promise<void> {
    const eps = this.endpoints()
    if (this.stopped || this.state !== 'connected' || eps.length < 2 || this.endpointIndex === 0) return
    if (this.primaryProbeInFlight) return
    const primary = eps[0]!
    this.primaryProbeInFlight = true
    const alive = await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      let ws: WebSocketLike | undefined
      const timer = setTimeout(() => {
        try {
          ws?.close()
        } catch {
          /* ignore */
        }
        done(false)
      }, 3000)
      try {
        ws = this.wsFactory(primary)
      } catch {
        clearTimeout(timer)
        done(false)
        return
      }
      ws.onopen = () => {
        clearTimeout(timer)
        // Resolve BEFORE closing the probe socket: close() fires onclose
        // synchronously in some ws implementations, and done(false) must not
        // win the settled race against the successful probe.
        done(true)
        try {
          ws?.close()
        } catch {
          /* ignore */
        }
      }
      ws.onerror = () => {
        clearTimeout(timer)
        done(false)
      }
      ws.onclose = () => {
        clearTimeout(timer)
        done(false)
      }
    })
    this.primaryProbeInFlight = false
    if (!alive) return
    this.log('primary hub reachable again; switching back')
    this.endpointIndex = 0
    this.scheduleReconnect('return-to-primary', false)
    // Close the pinned fallback socket so the old connection does not linger.
    // Its onclose fires scheduleReconnect('socket-close'), which no-ops while
    // the return-to-primary timer above is pending.
    try {
      this.socket?.close()
    } catch {
      /* socket already gone */
    }
  }

  private async heartbeat(): Promise<void> {
    if (!this.peer) return
    this.seq++
    void this.tryReturnToPrimary()
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
      await this.peer?.request('node.heartbeat', { node_id: this.cfg.node_id, status }, { timeoutMs: 10_000 })
    } catch (err) {
      // Half-open socket (hub died without a close frame, network blip, ...):
      // the request times out and nothing ever fires onclose, so without this
      // the agent would sit on a dead connection forever. Reconnect is idempotent
      // (scheduleReconnect no-ops while a timer is already pending).
      this.log(`heartbeat failed: ${err instanceof Error ? err.message : err}`)
      this.scheduleReconnect('heartbeat-failed')
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
      // 新建会话后无缓存可失效，但统一清一下对应缓存（幂等 no-op）
      const created = (res.structuredContent ?? {}) as { session_id?: unknown; id?: unknown }
      const sid = String(created.session_id ?? created.id ?? '')
      if (sid) this.summaries.invalidate(sid)
      return res.structuredContent ?? res.content ?? {}
    })
    this.peer.on(NODE_METHODS.GET_SESSION, async (p) => {
      // P0：默认只返回结构化摘要（~1KB）；include_messages=true 才透传完整
      // 历史（max_messages 限条数 + before_seq 分页游标，原样透传 DSH）
      return this.summaries.getSession(p as GetSessionParams)
    })
    this.peer.on(NODE_METHODS.RESUME_SESSION, async (p) => {
      const { session_id } = p as { session_id: string }
      const res = await this.backend.callTool('sessions_resume', { session_id })
      // 会话被激活（状态变更会改变 continuation_available）→ 摘要缓存失效
      if (session_id) this.summaries.invalidate(session_id)
      return res.structuredContent ?? res.content ?? {}
    })
    this.peer.on(NODE_METHODS.PROMPT, async (p) => {
      const { session_id, message, mode } = p as { session_id: string; message: string; mode?: string }
      if (mode === 'steer') {
        // 立即插队/纠偏：经 DSH 宿主 API 注入运行中回合（MCP 工具层不透传 mode，
        // 见 steer.ts 协议注释）。返回结构化状态 steered/queued/rejected/unavailable。
        const result = await steerPrompt({
          hostApiUrl: this.cfg.host_api_url,
          sessionId: session_id,
          message,
          fetchImpl: this.steerFetch,
          log: (l) => this.log(l),
        })
        if (result.status === 'steered') this.summaries.invalidate(session_id)
        return result
      }
      const res = await this.backend.callTool('sessions_prompt', { session_id, message })
      // 新消息落地 → 摘要（last_message_summary 等）过期，立即失效
      if (session_id) this.summaries.invalidate(session_id)
      return res.structuredContent ?? res.content ?? {}
    })
    this.peer.on(NODE_METHODS.CANCEL, async (p) => {
      const { session_id } = p as { session_id: string }
      const res = await this.backend.callTool('sessions_cancel', { session_id })
      // 打断后状态变化（running→idle 等）→ 摘要缓存失效
      if (session_id) this.summaries.invalidate(session_id)
      return res.structuredContent ?? res.content ?? {}
    })
    // Generic passthrough: hub routes any MCP tool here.
    this.peer.on(NODE_METHODS.MCP_CALL, async (p) => {
      const { tool, args } = p as { tool: string; args?: unknown }
      // 线上 hub 目前经 mcp.call 转发 sessions_get（cp.forward 统一走 MCP_CALL），
      // 必须在这里也走隔离逻辑，否则 P0 摘要不生效（GET_SESSION RPC 仅为直连路径）。
      if (tool === 'sessions_get') {
        return this.summaries.getSession((args ?? {}) as GetSessionParams)
      }
      // sessions_prompt 线上同样经 mcp.call 转发（非 PROMPT RPC）：mode=steer 时
      // 走宿主 API 立即注入（MCP 工具层不透传 mode），返回结构化状态。
      if (tool === 'sessions_prompt' && (args as { mode?: string } | undefined)?.mode === 'steer') {
        const { session_id, message } = args as { session_id: string; message: string }
        const result = await steerPrompt({
          hostApiUrl: this.cfg.host_api_url,
          sessionId: session_id,
          message,
          fetchImpl: this.steerFetch,
          log: (l) => this.log(l),
        })
        if (result.status === 'steered') this.summaries.invalidate(session_id)
        return result
      }
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

  private scheduleReconnect(reason: string, advance = true): void {
    if (this.stopped) return
    if (this.reconnectTimer) return
    // Try the next control-plane endpoint on every reconnect (round-robin
    // over [hub_url, ...fallback_urls]); a successful connect pins the index.
    // advance=false keeps the current index (used by return-to-primary, which
    // has already reset the index to the primary).
    if (advance) this.advanceEndpoint()
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