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

import type { WireMessage } from '@dsh-helm/protocol'
import { HandshakeServer, RpcPeer, type MessagePeer } from '@dsh-helm/protocol'
import { ControlPlane, hubRpcHandlers, type NodeConnection } from './control-plane.js'

export interface HubConnectionOptions {
  cp: ControlPlane
  /** Send a WireMessage to the node. */
  send: (msg: WireMessage) => void
  /** Called when the connection is fully closed (auth failed or socket closed). */
  onClose?: (nodeId?: string) => void
}

export class HubConnection implements NodeConnection {
  nodeId = ''
  private cp: ControlPlane
  private sendFn: (msg: WireMessage) => void
  private peer!: RpcPeer
  private handshake!: HandshakeServer
  private closed = false
  private onCloseCb?: (nodeId?: string) => void

  constructor(opts: HubConnectionOptions) {
    this.cp = opts.cp
    this.sendFn = opts.send
    this.onCloseCb = opts.onClose
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
        onWelcome: (hello) => this.authenticated(hello.node_id),
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

  private authenticated(nodeId: string): void {
    this.nodeId = nodeId
    const peer: MessagePeer = {
      send: (m) => this.sendFn({ type: 'rpc', v: this.cp.schemaVersion, body: m } as WireMessage),
    }
    this.peer = new RpcPeer(peer, (l) => this.cp.log(`[node ${nodeId}] ${l}`))
    const handlers = hubRpcHandlers(this.cp, nodeId)
    for (const [method, handler] of Object.entries(handlers)) {
      this.peer.on(method, handler)
    }
    this.cp.onNodeAuthenticated(nodeId, this)
  }
}
