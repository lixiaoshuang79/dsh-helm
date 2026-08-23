import { describe, expect, it } from 'vitest'
import { DshHelmStore } from '../src/db.js'
import { PresenceRegistry } from '../src/presence.js'

const now = Date.now()
const iso = (t: number) => new Date(t).toISOString()

function claim(nodeId: string, source: string, confidence: number, t: number, ttl = 60_000, pinned = false) {
  return { node_id: nodeId, source, confidence, observed_at: iso(t), ttl_ms: ttl, pinned }
}

describe('PresenceRegistry', () => {
  it('claims, reads, and expires a lease', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const p = new PresenceRegistry(s.db, { ttlMs: 60_000 })
    const rec = p.claim(claim('n1', 'desktop', 0.9, now))
    expect(rec.node_id).toBe('n1')
    expect(p.get('n1')).toBeDefined()
    // expired
    const p2 = new PresenceRegistry(s.db, { ttlMs: 60_000 })
    p2.claim(claim('n1', 'desktop', 0.9, now - 120_000, 60_000))
    expect(p2.get('n1')).toBeUndefined()
    s.close()
  })

  it('manual claims default to 10min TTL and pin', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const p = new PresenceRegistry(s.db)
    const rec = p.claim(claim('n1', 'manual', 1.0, now, 0, true))
    expect(rec.pinned).toBe(true)
    const expiresAt = Date.parse(rec.expires_at)
    expect(expiresAt - now).toBeGreaterThan(9 * 60_000)
    s.close()
  })

  it('activeNode prefers pinned manual claim', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const p = new PresenceRegistry(s.db)
    p.claim(claim('n1', 'desktop', 0.99, now))
    p.claim(claim('n2', 'manual', 1.0, now, 0, true))
    const active = p.activeNode(now)!
    expect(active.node_id).toBe('n2')
    s.close()
  })

  it('activeNode picks the freshest high-confidence claim (outside ambiguity window)', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const p = new PresenceRegistry(s.db, { ambiguityWindowMs: 15_000 })
    // n1 claimed 30s ago — outside the 15s ambiguity window, so no ambiguity.
    p.claim(claim('n1', 'desktop', 0.9, now - 30_000))
    p.claim(claim('n2', 'desktop', 0.95, now))
    const active = p.activeNode(now)!
    expect(active.node_id).toBe('n2')
    s.close()
  })

  it('two fresh high-confidence claims within ambiguity window -> ambiguous', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const p = new PresenceRegistry(s.db, { ambiguityWindowMs: 15_000 })
    p.claim(claim('n1', 'desktop', 0.9, now - 2_000))
    p.claim(claim('n2', 'desktop', 0.95, now))
    expect(p.activeNode(now)).toBeUndefined()
    s.close()
  })

  it('claims far apart in time are not ambiguous', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const p = new PresenceRegistry(s.db, { ambiguityWindowMs: 15_000 })
    p.claim(claim('n1', 'desktop', 0.9, now - 60_000))
    p.claim(claim('n2', 'desktop', 0.95, now))
    const active = p.activeNode(now)!
    expect(active.node_id).toBe('n2')
    s.close()
  })

  it('low-confidence claims do not trigger ambiguity; newest wins', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const p = new PresenceRegistry(s.db, { ambiguityWindowMs: 15_000 })
    p.claim(claim('n1', 'idle', 0.3, now - 1_000))
    p.claim(claim('n2', 'desktop', 0.9, now))
    const active = p.activeNode(now)!
    expect(active.node_id).toBe('n2')
    s.close()
  })

  it('explicit release clears the lease', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const p = new PresenceRegistry(s.db)
    p.claim(claim('n1', 'manual', 1.0, now, 0, true))
    p.release('n1')
    expect(p.get('n1')).toBeUndefined()
    expect(p.activeNode(now)).toBeUndefined()
    s.close()
  })

  it('sweep removes expired leases', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const p = new PresenceRegistry(s.db, { ttlMs: 60_000 })
    p.claim(claim('n1', 'desktop', 0.9, now - 120_000))
    const removed = p.sweep(now)
    expect(removed).toBe(1)
    expect(p.live(now)).toHaveLength(0)
    s.close()
  })
})