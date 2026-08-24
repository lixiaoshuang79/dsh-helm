/**
 * MeshServer: production WebSocket transport for the control plane.
 *
 * Listens on DEFAULT_HUB_MESH_PORT (3470). Each socket runs a HubConnection
 * (handshake + RPC). TLS is the caller's responsibility (reverse proxy or
 * `https` server passed in); plain ws is only for loopback/dev/test.
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Server } from 'node:http'
import { ControlPlane } from './control-plane.js'
import { HubConnection } from './connection.js'
import type { WireMessage } from '@dsh-helm/protocol'
import { DEFAULT_HUB_MESH_PORT, type RpcPeer } from '@dsh-helm/protocol'

export interface MeshServerOptions {
  cp: ControlPlane
  port?: number
  /** Bind host (default: all interfaces; loopback for dev). */
  host?: string
  /** Optional pre-existing http server (for TLS / reverse-proxy setups). */
  server?: Server
  /** Path prefix to filter (default '/'). */
  path?: string
  /** Optional extra RPC handlers registered after the hub handlers on each
   *  authenticated connection (used for the HA `cp.*` peer surface). */
  rpcExtras?: (peer: RpcPeer, nodeId: string) => void
  /** Optional callback when a connection fully closes (nodeId when it had authenticated). */
  connectionClosed?: (nodeId?: string) => void
  log?: (line: string) => void
}

export class MeshServer {
  private opts: MeshServerOptions
  private wss: WebSocketServer
  private logFn?: (line: string) => void
  private cp: ControlPlane
  readonly port: number

  constructor(opts: MeshServerOptions) {
    this.opts = opts
    this.logFn = opts.log
    this.cp = opts.cp
    this.port = opts.port ?? DEFAULT_HUB_MESH_PORT
    this.wss = new WebSocketServer({ port: opts.server ? undefined : this.port, host: opts.host, server: opts.server, path: opts.path ?? '/' })
    this.wss.on('connection', (socket, req) => this.onSocket(socket, req))
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.wss.clients) client.close()
      this.wss.close(() => resolve())
    })
  }

  private onSocket(socket: WebSocket, req: IncomingMessage): void {
    this.logFn?.(`ws connection from ${req.socket.remoteAddress}`)
    const conn = new HubConnection({
      cp: this.cp,
      send: (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
      },
      rpcExtras: this.opts.rpcExtras,
      onClose: (nodeId) => {
        if (nodeId) this.logFn?.(`node disconnected: ${nodeId}`)
        this.opts.connectionClosed?.(nodeId)
      },
    })
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WireMessage
        conn.inbound(msg)
      } catch {
        this.logFn?.('dropping unparseable ws frame')
      }
    })
    socket.on('close', () => conn.close())
    socket.on('error', () => conn.close())
  }
}
