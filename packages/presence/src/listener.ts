/**
 * Local presence listener: tiny HTTP endpoint on 127.0.0.1 that accepts
 * presence reports from the browser helper (and anything loopback) and
 * forwards them as PresenceClaims. The node agent wires this into its
 * presenceProvider chain.
 */

import { createServer, type Server } from 'node:http'
import type { PresenceClaim } from '@dsh-helm/protocol'
import type { PresenceProvider } from './providers.js'

export interface PresenceListenerOptions {
  nodeId: string
  port?: number
  /** Called with each accepted claim. */
  onClaim(claim: PresenceClaim): void
  log?: (line: string) => void
}

export class PresenceListener {
  private server: Server
  private nodeId: string
  private onClaim: (claim: PresenceClaim) => void
  private logFn?: (line: string) => void
  readonly port: number

  constructor(opts: PresenceListenerOptions) {
    this.nodeId = opts.nodeId
    this.onClaim = opts.onClaim
    this.logFn = opts.log
    this.port = opts.port ?? 3472
    this.server = createServer((req, res) => this.handle(req, res))
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      // An async listen error (e.g. EADDRINUSE when another local agent is
      // already serving presence on 3472) must not crash the process: the
      // listener is an optional loopback helper. Swallow with a log line.
      this.server.on('error', (err) => {
        this.logFn?.(`presence listener error: ${err instanceof Error ? err.message : err}`)
        reject(err)
      })
      this.server.listen(this.port, '127.0.0.1', () => resolve())
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  private handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'POST' && req.url?.startsWith('/presence/')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const b = JSON.parse(body) as { source?: string; confidence?: number; pinned?: boolean }
          const claim: PresenceClaim = {
            node_id: this.nodeId,
            source: b.source ?? 'browser',
            confidence: typeof b.confidence === 'number' ? b.confidence : 0.9,
            observed_at: new Date().toISOString(),
            ttl_ms: 60_000,
            pinned: !!b.pinned,
          }
          this.onClaim(claim)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch {
          res.writeHead(400)
          res.end('bad json')
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  }
}

/** Adapter: PresenceListener -> PresenceProvider (for the agent's chain). */
export class ListenerPresenceProvider implements PresenceProvider {
  readonly source = 'listener'
  private listener: PresenceListener

  constructor(listener: PresenceListener) {
    this.listener = listener
  }

  async probe(): Promise<PresenceClaim | undefined> {
    return undefined // listener pushes claims directly; nothing to poll
  }
}
