/**
 * Handshake state machines (server + client) for the node mesh.
 *
 * The server verifies HMAC challenge responses; the client drives
 * hello -> challenge -> auth and reports the outcome. Transport-agnostic:
 * both sides exchange WireMessage objects through a send function and a
 * callback for inbound messages.
 */

import { computeMac, generateNonce, verifyMac } from './crypto.js'
import type {
  AuthMessage,
  ChallengeMessage,
  HandshakeErrorMessage,
  HelloMessage,
  WelcomeMessage,
  WireMessage,
} from './envelope.js'
import { ENROLL_NODE_ID_PREFIX, PROTOCOL_ERROR } from './constants.js'

export interface HandshakeSender {
  send(msg: WireMessage): void
}

export interface HandshakeServerCallbacks {
  /**
   * Verified identity and socket nonce; token lookup returned the token.
   * `auth` is undefined on the unauthenticated enrollment path
   * (hello.node_id starts with ENROLL_NODE_ID_PREFIX) — the connection must
   * then be treated as enroll-only (one enrollment.consume RPC, then close).
   */
  onWelcome(hello: HelloMessage, auth: AuthMessage | undefined, hubId: string, schemaVersion: number, heartbeatMs: number, leaseMs: number): void
  onError(code: number, message: string): void
}

export interface HandshakeServerOptions {
  hubId: string
  schemaVersion: number
  heartbeatMs: number
  leaseMs: number
  /** Resolve the token for a node_id (undefined = unknown node). */
  lookupToken(nodeId: string): string | undefined
}

/**
 * Server-side handshake state machine. Feed every inbound WireMessage.
 * Issues challenge on hello; verifies auth; emits onWelcome/onError exactly once.
 */
export class HandshakeServer {
  private done = false
  private clientNonce?: string
  private serverNonce?: string
  private hello?: HelloMessage
  private authAttempts = 0

  constructor(
    private sender: HandshakeSender,
    private opts: HandshakeServerOptions,
    private cb: HandshakeServerCallbacks,
  ) {}

  inbound(msg: WireMessage): void {
    if (this.done) return
    switch (msg.type) {
      case 'hello': {
        if (msg.v !== this.opts.schemaVersion) {
          this.fail(PROTOCOL_ERROR.VERSION_MISMATCH, `protocol version mismatch: client ${msg.v}, server ${this.opts.schemaVersion}`)
          return
        }
        // Unauthenticated enrollment path: a device that has no token yet
        // connects with node_id = `enroll:<uuid>` (see docs/security.md).
        // No challenge/auth — the hub welcomes it and the connection is
        // restricted to one enrollment.consume RPC before it is closed.
        // This is an explicit opt-in path, not a downgrade: normal nodes
        // (UUID node_ids) still go through the HMAC challenge below.
        if (msg.node_id.startsWith(ENROLL_NODE_ID_PREFIX)) {
          this.hello = msg
          this.done = true
          this.cb.onWelcome(msg, undefined, this.opts.hubId, this.opts.schemaVersion, this.opts.heartbeatMs, this.opts.leaseMs)
          this.sender.send(this.welcomeMessage())
          return
        }
        this.clientNonce = msg.nonce
        this.serverNonce = generateNonce()
        this.hello = msg
        const challenge: ChallengeMessage = { type: 'challenge', v: this.opts.schemaVersion, node_id: msg.node_id, nonce: this.serverNonce }
        this.sender.send(challenge)
        return
      }
      case 'auth': {
        if (!this.hello || !this.clientNonce || !this.serverNonce) {
          this.fail(PROTOCOL_ERROR.INVALID_REQUEST, 'auth without hello')
          return
        }
        if (this.authAttempts >= 3) {
          this.fail(PROTOCOL_ERROR.AUTH_FAILED, 'too many auth attempts')
          return
        }
        this.authAttempts++
        const token = this.opts.lookupToken(msg.node_id)
        if (!token || !msg.mac || !verifyMac(token, this.clientNonce, this.serverNonce, msg.mac)) {
          this.fail(PROTOCOL_ERROR.AUTH_FAILED, 'authentication failed')
          return
        }
        this.done = true
        // Local auth callback first so the RPC peer is ready before the
        // client receives welcome and starts issuing requests.
        this.cb.onWelcome(this.hello, msg, this.opts.hubId, this.opts.schemaVersion, this.opts.heartbeatMs, this.opts.leaseMs)
        this.sender.send(this.welcomeMessage())
        return
      }
      default:
        return
    }
  }

  private welcomeMessage(): WelcomeMessage {
    return {
      type: 'welcome',
      v: this.opts.schemaVersion,
      hub_id: this.opts.hubId,
      schema_version: this.opts.schemaVersion,
      heartbeat_ms: this.opts.heartbeatMs,
      lease_ms: this.opts.leaseMs,
    }
  }

  private fail(code: number, message: string): void {
    if (this.done) return
    this.done = true
    const err: HandshakeErrorMessage = { type: 'error', v: this.opts.schemaVersion, code, message }
    this.sender.send(err)
    // Attach the client-declared node_id when known (auth stage) so hub logs
    // can tell "unknown node" apart from "known node, wrong token".
    this.cb.onError(code, this.hello ? `${message} (node=${this.hello.node_id})` : message)
  }
}

export type HandshakeClientOutcome =
  | { ok: true; welcome: WelcomeMessage }
  | { ok: false; code: number; message: string }

export interface HandshakeClientCallbacks {
  onOutcome(outcome: HandshakeClientOutcome): void
}

/**
 * Client-side handshake state machine. Call start() with node_id + token;
 * feed inbound messages; outcome delivered once.
 */
export class HandshakeClient {
  private done = false
  private serverNonce?: string
  private myNonce = generateNonce()

  constructor(
    private sender: HandshakeSender,
    private nodeId: string,
    private token: string,
    private schemaVersion: number,
    private cb: HandshakeClientCallbacks,
  ) {}

  /** Begin the handshake (send hello). */
  start(): void {
    const hello: HelloMessage = { type: 'hello', v: this.schemaVersion, node_id: this.nodeId, nonce: this.myNonce }
    this.sender.send(hello)
  }

  inbound(msg: WireMessage): void {
    if (this.done) return
    switch (msg.type) {
      case 'challenge': {
        this.serverNonce = msg.nonce
        const auth: AuthMessage = {
          type: 'auth',
          v: this.schemaVersion,
          node_id: this.nodeId,
          nonce: this.myNonce,
          mac: computeMac(this.token, this.myNonce, this.serverNonce),
        }
        this.sender.send(auth)
        return
      }
      case 'welcome': {
        this.done = true
        this.cb.onOutcome({ ok: true, welcome: msg })
        return
      }
      case 'error': {
        this.done = true
        this.cb.onOutcome({ ok: false, code: msg.code, message: msg.message })
        return
      }
      default:
        return
    }
  }
}