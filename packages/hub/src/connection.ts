/**
 * HubConnection: server side of one node connection.
 *
 * Glues: raw wire channel <-> HandshakeServer <-> RpcPeer (with hub RPC
 * handlers) <-> ControlPlane. After a successful handshake the node_id is
 * registered as a live NodeConnection so the router can forward to it.
 *
 * Transport-agnostic: feed inbound WireMessages via inbound(), deliver hub
 * messages via the outbound callback.
 */

import type { AuthMessage, WireMessage } from '@dsh-helm/protocol'
import { ENROLL_NODE_ID_PREFIX, HUB_METHODS, HandshakeServer, RpcPeer, type MessagePeer } from '@dsh-helm/protocol'
import { ControlPlane, hubRpcHandlers, type NodeConnection } from './control-plane.js'

export interface HubConnectionOptions {
  cp: ControlPlane
  /** Send a WireMessage to the node. */
  send: (msg: WireMessage) => void
  /** Called when the connection is fully closed (auth failed or socket closed). */
  onClose?: (nodeId?: string) => void
  /** Optional extra RPC handlers registered after the hub handlers (e.g. the
   *  `cp.*` surface for control-plane peer connections). */
  rpcExtras?: (peer: RpcPeer, nodeId: string) => void
}

export class HubConnection implements NodeConnection {
  nodeId = ''
  private cp: ControlPlane
  private sendFn: (msg: WireMessage) => void
  private peer!: RpcPeer
  private handshake!: HandshakeServer
  private closed = false
  private onCloseCb?: (nodeId?: string) => void
  private rpcExtras?: (peer: RpcPeer, nodeId: string) => void

  constructor(opts: HubConnectionOptions) {
    this.cp = opts.cp
    this.sendFn = opts.send
    this.onCloseCb = opts.onClose
    this.rpcExtras = opts.rpcExtras
    this.handshake = new HandshakeServer(
      { send: (m) => this.sendFn(m) },
      {
        hubId: this.cp.hubId,
        schemaVersion: this.cp.schemaVersion,
        heartbeatMs: this.cp.heartbeatMs ?? 15_000,
        leaseMs: this.cp.leaseMs ?? 45_000,
        lookupToken: (id) => this.cp.lookupToken(id),
      },
      {
        onWelcome: (hello, auth) => this.authenticated(hello.node_id, auth),
        onError: (code, message) => {
          this.cp.log(`handshake error from ${this.nodeId || 'unknown'}: ${code} ${message}`)
          this.close()
        },
      },
    )
    // RPC peer is created lazily after auth; inbound rpc frames before auth are ignored.
  }

  get heartbeatMs(): number {
    return this.cp.heartbeatMs
  }

  get leaseMs(): number {
    return this.cp.leaseMs
  }

  /** Feed an inbound wire message from the node. */
  inbound(msg: WireMessage): void {
    if (this.closed) return
    if (msg.type === 'rpc') {
      this.peer?.dispatchPublic(msg.body)
      return
    }
    this.handshake.inbound(msg)
  }

  /** Node connection request forwarding (used by ControlPlane.forward). */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.peer) throw new Error('not authenticated')
    return this.peer.request(method, params, { timeoutMs })
  }

  notify(method: string, params?: unknown): void {
    this.peer?.notify(method, params)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.peer?.close()
    const nodeId = this.nodeId
    if (nodeId) {
      // Only remove THIS connection. A stale socket's close event can be
      // processed after a newer connection under the same node_id has
      // already registered (reconnect race); deleting unconditionally would
      // drop the live connection from the routing map.
      if (this.cp.connections.get(nodeId) === this) {
        this.cp.connections.delete(nodeId)
      }
    }
    this.onCloseCb?.(nodeId)
  }

  private authenticated(nodeId: string, auth?: AuthMessage): void {
    this.nodeId = nodeId
    const peer: MessagePeer = {
      send: (m) => this.sendFn({ type: 'rpc', v: this.cp.schemaVersion, body: m } as WireMessage),
    }
    this.peer = new RpcPeer(peer, (l) => this.cp.log(`[${nodeId}] ${l}`))
    if (auth === undefined) {
      // Unauthenticated enrollment connection (hello.node_id = enroll:<uuid>):
      // offers exactly ONE RPC (enrollment.consume), is never registered in
      // the routing table, and is closed after a successful exchange (or when
      // the peer exceeds its rate budget). See docs/security.md.
      this.cp.log(`enroll connection accepted: ${nodeId} (unauthenticated, enroll-only)`)
      if (!nodeId.startsWith(ENROLL_NODE_ID_PREFIX)) {
        this.cp.log(`enroll-mode connection with unexpected node_id: ${nodeId}`)
      }
      this.peer.on(HUB_METHODS.ENROLLMENT_CONSUME, (p) => this.handleEnrollConsume(p))
      return
    }
    const handlers = hubRpcHandlers(this.cp, nodeId)
    for (const [method, handler] of Object.entries(handlers)) {
      this.peer.on(method, handler)
    }
    this.rpcExtras?.(this.peer, nodeId)
    this.cp.onNodeAuthenticated(nodeId, this)
  }

  /** One-shot enrollment.consume on an unauthenticated enroll connection. */
  private async handleEnrollConsume(params: unknown): Promise<unknown> {
    const res = await this.cp.consumeEnrollment(params, this.nodeId)
    // Close once the exchange is done: after a successful consume (token
    // delivered) or when the per-connection rate budget is exhausted.
    if (res.ok || (!res.ok && res.reason === 'rate_limited')) {
      setTimeout(() => this.close(), 25)
    }
    return res
  }
}
