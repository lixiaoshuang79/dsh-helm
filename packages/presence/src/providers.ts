/**
 * Presence providers: answer "is the human actively using this machine?"
 *
 * Each provider produces a PresenceClaim the node agent forwards to the hub.
 * Sources: 'manual' (CLI/MCP pin), 'desktop' (macOS sidecar / Windows
 * adapter), 'browser' (extension helper), 'idle' (explicitly low confidence).
 */

import type { PresenceClaim } from '@dsh-helm/protocol'

export interface PresenceProvider {
  readonly source: string
  /** Produce the current claim, or undefined when no signal. */
  probe(): Promise<PresenceClaim | undefined>
  /** Start background probing (optional). */
  start?(onClaim?: (claim: PresenceClaim) => void): void
  stop?(): void
}

export interface ManualPresenceOptions {
  nodeId: string
  /** Default manual TTL ms (hub clamps anyway). */
  ttlMs?: number
}

/**
 * Manual presence: the operator explicitly claims a node.
 * Confidence 1.0, pinned, 10min default TTL.
 */
export class ManualPresenceProvider implements PresenceProvider {
  readonly source = 'manual'
  private nodeId: string
  private ttlMs: number

  constructor(opts: ManualPresenceOptions) {
    this.nodeId = opts.nodeId
    this.ttlMs = opts.ttlMs ?? 10 * 60_000
  }

  async probe(): Promise<PresenceClaim | undefined> {
    return {
      node_id: this.nodeId,
      source: 'manual',
      confidence: 1.0,
      observed_at: new Date().toISOString(),
      ttl_ms: this.ttlMs,
      pinned: true,
    }
  }
}

/** Compose multiple providers; first non-undefined claim wins. */
export class CompositePresenceProvider implements PresenceProvider {
  readonly source = 'composite'
  private providers: PresenceProvider[]

  constructor(providers: PresenceProvider[]) {
    this.providers = providers
  }

  async probe(): Promise<PresenceClaim | undefined> {
    for (const p of this.providers) {
      try {
        const claim = await p.probe()
        if (claim) return claim
      } catch {
        // provider failure -> try next
      }
    }
    return undefined
  }
}
