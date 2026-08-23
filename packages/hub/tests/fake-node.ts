/**
 * FakeNode: an in-process node agent for integration tests.
 *
 * Implements the node side of node-protocol v1 (handshake client + RPC server
 * for the methods a real node agent serves) with in-memory sessions and
 * workspaces. Lets tests drive two "machines" against one hub without sockets
 * or a real DSH.
 */

import type { WireMessage, NodeInfo, SessionInfo, WorkspaceInfo, PresenceClaim, HealthReport } from '@dsh-helm/protocol'
import { HandshakeClient, NODE_METHODS, HUB_METHODS, computeMac, generateNonce } from '@dsh-helm/protocol'
import { RpcPeer, type MessagePeer } from '@dsh-helm/protocol'

export interface FakeNodeOptions {
  node: NodeInfo
  token: string
  schemaVersion: number
  /** Sessions served by this fake node. */
  sessions?: SessionInfo[]
  workspaces?: WorkspaceInfo[]
  /** Failure injection. */
  failMethods?: Set<string>
  log?: (line: string) => void
}

export class FakeNode {
  readonly node: NodeInfo
  readonly token: string
  private schemaVersion: number
  sessions: SessionInfo[]
  workspaces: WorkspaceInfo[]
  failMethods: Set<string>
  private logFn?: (line: string) => void
  private peer!: RpcPeer
  private handshake?: HandshakeClient
  private outbound!: (msg: WireMessage) => void
  connected = false
  welcome?: { hub_id: string; schema_version: number }

  constructor(opts: FakeNodeOptions) {
    this.node = opts.node
    this.token = opts.token
    this.schemaVersion = opts.schemaVersion
    this.sessions = opts.sessions ?? []
    this.workspaces = opts.workspaces ?? []
    this.failMethods = opts.failMethods ?? new Set()
    this.logFn = opts.log
  }

  /** Attach to a hub sender (in-memory pipe). Call start() after attach. */
  attach(outbound: (msg: WireMessage) => void): void {
    this.outbound = outbound
    const peer: MessagePeer = {
      send: (m) => this.outbound({ type: 'rpc', v: this.schemaVersion, body: m } as WireMessage),
    }
    this.peer = new RpcPeer(peer, this.logFn)
    this.handshake = new HandshakeClient(
      { send: (m) => this.outbound(m) },
      this.node.node_id,
      this.token,
      this.schemaVersion,
      {
        onOutcome: async (outcome) => {
          if (outcome.ok) {
            this.connected = true
            this.welcome = { hub_id: outcome.welcome.hub_id, schema_version: outcome.welcome.schema_version }
            this.logFn?.(`fake node ${this.node.node_id} connected`)
            // Real node agents register after a successful handshake.
            try {
              await this.peer.request(HUB_METHODS.NODE_REGISTER, { node: this.node })
            } catch (err) {
              this.logFn?.(`fake node ${this.node.node_id} register failed: ${err instanceof Error ? err.message : err}`)
            }
          } else {
            this.logFn?.(`fake node ${this.node.node_id} handshake failed: ${outcome.message}`)
          }
        },
      },
    )
    this.registerHandlers()
  }

  /** Start the handshake. */
  start(): void {
    this.handshake?.start()
  }

  /** Feed an inbound wire message (from hub). */
  inbound(msg: WireMessage): void {
    if (msg.type === 'rpc') {
      this.peer.dispatchPublic(msg.body)
      return
    }
    this.handshake?.inbound(msg)
  }

  private registerHandlers(): void {
    this.peer.on(NODE_METHODS.HEALTH, () => ({
      status: 'ok',
      serena: { connected: true },
      adapters: [{ id: this.node.node_id, health: 'ok' }],
    }))
    this.peer.on(NODE_METHODS.LIST_WORKSPACES, () => this.workspaces)
    this.peer.on(NODE_METHODS.LIST_SESSIONS, () => this.sessions)
    this.peer.on(NODE_METHODS.CREATE_SESSION, (p) => {
      this.maybeFail(NODE_METHODS.CREATE_SESSION)
      const params = p as { workspace?: string; title?: string; initial_message?: string }
      const id = `session-${Math.random().toString(36).slice(2, 10)}`
      const s: SessionInfo = { native_session_id: id, title: params.title ?? 'fake', status: 'idle', live: false }
      this.sessions.push(s)
      return { session_id: id, native_session_id: id, workspace: params.workspace }
    })
    this.peer.on(NODE_METHODS.GET_SESSION, (p) => {
      this.maybeFail(NODE_METHODS.GET_SESSION)
      const { session_id } = p as { session_id: string }
      const s = this.sessions.find((x) => x.native_session_id === session_id)
      if (!s) throw new Error(`session not found: ${session_id}`)
      return s
    })
    this.peer.on(NODE_METHODS.RESUME_SESSION, (p) => {
      this.maybeFail(NODE_METHODS.RESUME_SESSION)
      const { session_id } = p as { session_id: string }
      const s = this.sessions.find((x) => x.native_session_id === session_id)
      if (!s) throw new Error(`session not found: ${session_id}`)
      s.status = 'running'
      s.live = true
      return { resumed: true, session_id }
    })
    this.peer.on(NODE_METHODS.PROMPT, async (p) => {
      this.maybeFail(NODE_METHODS.PROMPT)
      const { session_id, message } = p as { session_id: string; message: string }
      const s = this.sessions.find((x) => x.native_session_id === session_id)
      if (!s) throw new Error(`session not found: ${session_id}`)
      s.status = 'running'
      await new Promise((r) => setTimeout(r, 5))
      s.status = 'idle'
      return { ok: true, reply: `[${this.node.display_name}] processed: ${message}`, session_id }
    })
    this.peer.on(NODE_METHODS.CANCEL, (p) => {
      this.maybeFail(NODE_METHODS.CANCEL)
      const { session_id } = p as { session_id: string }
      const s = this.sessions.find((x) => x.native_session_id === session_id)
      if (!s) throw new Error(`session not found: ${session_id}`)
      s.status = 'cancelled'
      s.live = false
      return { cancelled: true, session_id }
    })
    this.peer.on(NODE_METHODS.MCP_CALL, async (p) => {
      const { tool, args } = p as { tool: string; args?: unknown }
      this.maybeFail(`${NODE_METHODS.MCP_CALL}:${tool}`)
      return this.handleMcp(tool, args)
    })
    this.peer.on(NODE_METHODS.PRESENCE_REPORT, (p) => p)
  }

  /** Simulate the node agent's own MCP call into its local helm daemon. */
  private async handleMcp(tool: string, args: unknown): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>
    switch (tool) {
      case 'supervisor_health':
        return {
          status: 'ok',
          serena: { connected: true },
          adapters: [{ id: this.node.node_id, health: 'ok' }],
          node_id: this.node.node_id,
        }
      case 'sessions_list':
        return this.sessions.map((s) => ({ session_id: s.native_session_id, title: s.title, status: s.status }))
      case 'sessions_get':
        return this.sessions.find((s) => s.native_session_id === a.session_id) ?? null
      case 'sessions_prompt':
        return { ok: true, reply: `[${this.node.display_name}] ${String(a.message ?? '')}` }
      case 'sessions_create':
        return { session_id: `session-${Math.random().toString(36).slice(2, 10)}` }
      case 'code_use_workspace':
        return { workspace: a.workspace, node: this.node.node_id }
      case 'code_read_file':
        return { path: a.path, content: `content of ${String(a.path)} on ${this.node.display_name}` }
      case 'projects_list':
        return this.workspaces.map((w) => ({ id: w.native_workspace_id, path: w.path }))
      case 'workspaces_list':
        return this.workspaces.map((w) => ({ workspace_id: w.native_workspace_id, path: w.path }))
      default:
        throw new Error(`fake node: unsupported tool ${tool}`)
    }
  }

  private maybeFail(method: string): void {
    if (this.failMethods.has(method)) {
      throw new Error(`injected failure: ${method}`)
    }
  }
}

export { computeMac, generateNonce }
