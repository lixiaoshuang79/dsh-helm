/**
 * A tiny, dependency-free JSON-RPC 2.0 layer over a message-passing peer.
 *
 * The peer abstraction is transport-agnostic: WebSocket frames in production,
 * in-memory pipes in tests. This keeps protocol semantics unit-testable
 * without sockets.
 */

import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './envelope.js'
import { PROTOCOL_ERROR } from './constants.js'

export interface MessagePeer {
  /** Send one raw message (string or object). */
  send(msg: unknown): void
  onMessage?: (msg: unknown) => void
  onClose?: () => void
}

export interface RpcCallOptions {
  /** Timeout before the pending request rejects. */
  timeoutMs?: number
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** JSON-RPC 2.0 client + server glued onto one MessagePeer. */
export class RpcPeer {
  private nextId = 1
  private pending = new Map<string | number, Pending>()
  /** method -> handler. Return value or throw are sent back. */
  private handlers = new Map<string, (params: unknown, ctx: RpcContext) => Promise<unknown> | unknown>()
  /** Notification handlers (no reply). */
  private notifyHandlers = new Map<string, (params: unknown) => void | Promise<void>>()

  constructor(
    private peer: MessagePeer,
    private log?: (line: string) => void,
  ) {
    this.peer.onMessage = (msg) => this.dispatch(msg)
    this.peer.onClose = () => this.close()
  }

  /** Register a method handler (server side). */
  on(method: string, handler: (params: unknown, ctx: RpcContext) => Promise<unknown> | unknown): void {
    this.handlers.set(method, handler)
  }

  /** Register a notification handler (server side, no response). */
  onNotify(method: string, handler: (params: unknown) => void | Promise<void>): void {
    this.notifyHandlers.set(method, handler)
  }

  /** Send a request and await the response. */
  request<T = unknown>(method: string, params?: unknown, opts: RpcCallOptions = {}): Promise<T> {
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? 30_000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
      this.peer.send(req)
    })
  }

  /** Send a notification (fire-and-forget). */
  notify(method: string, params?: unknown): void {
    const n: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.peer.send(n)
  }

  /** Close all pending requests with an error. */
  close(err?: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err ?? new Error('peer closed'))
    }
    this.pending.clear()
  }

  /** Test bridge: dispatch a raw message as if it arrived from the peer. */
  dispatchPublic(msg: unknown): void {
    this.dispatch(msg)
  }

  private dispatch(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as Record<string, unknown>
    if (m.jsonrpc !== '2.0') return
    const method = typeof m.method === 'string' ? m.method : undefined
    const id = m.id !== undefined && m.id !== null ? (m.id as string | number) : undefined

    // Response to one of our requests: resolve/reject the pending call.
    if (method === undefined && id !== undefined) {
      const p = this.pending.get(id)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(id)
        const err = m.error as { message?: string } | undefined
        if (err) p.reject(new Error(err.message ?? 'rpc error'))
        else p.resolve(m.result)
      }
      return
    }

    const params = m.params
    if (method === undefined) return

    // Request with id -> respond
    if (id !== undefined) {
      const handler = this.handlers.get(method)
      if (!handler) {
        this.respond(id, undefined, { code: PROTOCOL_ERROR.METHOD_NOT_FOUND, message: `method not found: ${method}` })
        return
      }
      const ctx: RpcContext = { peer: this, method }
      Promise.resolve()
        .then(() => handler(params, ctx))
        .then(
          (result) => this.respond(id, result, undefined),
          (err: unknown) => {
            const e = err instanceof Error ? err : new Error(String(err))
            this.respond(id, undefined, { code: PROTOCOL_ERROR.INTERNAL_ERROR, message: e.message })
          },
        )
      return
    }

    // Notification
    const nh = this.notifyHandlers.get(method)
    if (nh) void Promise.resolve(nh(params))
  }

  private respond(id: string | number, result: unknown, error?: { code: number; message: string }): void {
    const res: JsonRpcResponse = { jsonrpc: '2.0', id }
    if (error) res.error = error
    else res.result = result
    this.peer.send(res)
  }
}

export interface RpcContext {
  peer: RpcPeer
  method: string
}

/** Test helper: pair two RpcPeers over an in-memory pipe. */
export function pairRpcPeers(log?: (line: string) => void): { a: RpcPeer; b: RpcPeer } {
  const mkPeer = (sendTo: (msg: unknown) => void): MessagePeer => ({ send: (m) => sendTo(m) })
  let aToB: (msg: unknown) => void = () => {}
  let bToA: (msg: unknown) => void = () => {}
  const pa = mkPeer((m) => aToB(m))
  const pb = mkPeer((m) => bToA(m))
  const ra = new RpcPeer(pa, log)
  const rb = new RpcPeer(pb, log)
  aToB = (m) => rb.dispatchPublic(m)
  bToA = (m) => ra.dispatchPublic(m)
  return { a: ra, b: rb }
}

// allow test-only dispatch injection
declare module './jsonrpc.js' {}
