/**
 * FakeWebSocket: in-memory duplex that satisfies WebSocketLike (agent side)
 * and pipes JSON strings to/from a HubConnection.
 *
 * Shared by node-agent and root integration tests.
 */

import type { WireMessage } from '../../packages/protocol/src/index.js'
import type { WebSocketLike } from '../../packages/node-agent/src/index.js'

export class FakeWebSocket implements WebSocketLike {
  readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  private toHub: (msg: WireMessage) => void = () => {}
  private opened = false

  constructor() {}
  setHubSink(fn: (msg: WireMessage) => void): void {
    this.toHub = fn
  }
  send(data: string): void {
    try {
      this.toHub(JSON.parse(data) as WireMessage)
    } catch {
      /* ignore */
    }
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
  /** Test helper: simulate server -> client message. */
  serverSend(msg: WireMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  /** Test helper: open the socket (like ws onopen). */
  open(): void {
    this.readyState = 1
    this.opened = true
    this.onopen?.()
  }
}
