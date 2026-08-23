import { describe, expect, it } from 'vitest'
import { ManualPresenceProvider, CompositePresenceProvider } from '../src/providers.js'
import { DesktopSidecarPresenceProvider } from '../src/desktop.js'
import { WindowsDesktopPresenceProvider, WINDOWS_FOREGROUND_PS } from '../src/windows.js'
import { browserExtensionFiles, BROWSER_EXTENSION_MANIFEST } from '../src/browser.js'
import { PresenceListener } from '../src/listener.js'
import type { PresenceClaim } from '../../protocol/src/index.js'

describe('ManualPresenceProvider', () => {
  it('produces a pinned high-confidence claim with default TTL', async () => {
    const p = new ManualPresenceProvider({ nodeId: 'n-1' })
    const claim = (await p.probe())!
    expect(claim.node_id).toBe('n-1')
    expect(claim.source).toBe('manual')
    expect(claim.confidence).toBe(1.0)
    expect(claim.pinned).toBe(true)
    expect(claim.ttl_ms).toBe(10 * 60_000)
  })
})

describe('CompositePresenceProvider', () => {
  it('returns the first non-undefined claim', async () => {
    const a = { source: 'a', probe: async () => undefined }
    const b = { source: 'b', probe: async () => ({ node_id: 'n', source: 'b', confidence: 0.5, observed_at: new Date().toISOString(), ttl_ms: 1000 }) }
    const c = { source: 'c', probe: async () => ({ node_id: 'n', source: 'c', confidence: 0.9, observed_at: new Date().toISOString(), ttl_ms: 1000 }) }
    const comp = new CompositePresenceProvider([a, b, c])
    const claim = await comp.probe()
    expect(claim?.source).toBe('b')
  })

  it('skips providers that throw', async () => {
    const a = { source: 'a', probe: async () => { throw new Error('boom') } }
    const b = { source: 'b', probe: async () => ({ node_id: 'n', source: 'b', confidence: 0.9, observed_at: new Date().toISOString(), ttl_ms: 1000 }) }
    const comp = new CompositePresenceProvider([a, b])
    expect((await comp.probe())?.source).toBe('b')
  })
})

describe('DesktopSidecarPresenceProvider (macOS)', () => {
  it('reports high confidence when ChatGPT is frontmost', async () => {
    const p = new DesktopSidecarPresenceProvider({ nodeId: 'n-1', exec: async () => 'ChatGPT\n' })
    const claim = (await p.probe())!
    expect(claim.confidence).toBeGreaterThanOrEqual(0.9)
    expect(claim.source).toBe('desktop')
  })

  it('reports low confidence for unrelated frontmost app', async () => {
    const p = new DesktopSidecarPresenceProvider({ nodeId: 'n-1', exec: async () => 'Finder\n' })
    const claim = (await p.probe())!
    expect(claim.confidence).toBeLessThan(0.5)
  })

  it('returns undefined when probe fails', async () => {
    const p = new DesktopSidecarPresenceProvider({ nodeId: 'n-1', exec: async () => { throw new Error('osascript denied') } })
    expect(await p.probe()).toBeUndefined()
  })
})

describe('WindowsDesktopPresenceProvider (scaffold)', () => {
  it('reports high confidence when ChatGPT process is foreground', async () => {
    const p = new WindowsDesktopPresenceProvider({ nodeId: 'n-1', exec: async () => 'ChatGPT\n' })
    const claim = (await p.probe())!
    expect(claim.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('uses a stable, static PowerShell snippet (no interpolation)', () => {
    expect(WINDOWS_FOREGROUND_PS).toContain('GetForegroundWindow')
    expect(WINDOWS_FOREGROUND_PS).not.toContain('${')
    expect(WINDOWS_FOREGROUND_PS).not.toContain('nodeId')
  })
})

describe('browser extension scaffold', () => {
  it('emits manifest restricted to loopback', () => {
    const files = browserExtensionFiles(3470)
    const manifest = JSON.parse(files['manifest.json']!)
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1:3470/*'])
    expect(manifest.content_scripts[0].matches).toEqual(['https://chatgpt.com/*'])
    expect(manifest.background.service_worker).toBe('background.js')
  })

  it('manifest helper matches', () => {
    const m = BROWSER_EXTENSION_MANIFEST(3470)
    expect(m.host_permissions).toContain('http://127.0.0.1:3470/*')
  })

  it('background script heartbeats every 20s while active', () => {
    const bg = browserExtensionFiles(3470)
    expect(bg['background.js']).toContain('setInterval')
    expect(bg['background.js']).toContain('chatgpt.com')
  })
})

describe('PresenceListener', () => {
  it('accepts browser reports and forwards claims (loopback only)', async () => {
    const claims: PresenceClaim[] = []
    const listener = new PresenceListener({ nodeId: 'n-1', port: 0, onClaim: (c) => claims.push(c) })
    await listener.listen()
    const port = (listener as unknown as { server: { address: () => { port: number } } }).server.address().port
    const res = await fetch(`http://127.0.0.1:${port}/presence/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'browser', confidence: 0.95 }),
    })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(claims).toHaveLength(1)
    expect(claims[0]!.source).toBe('browser')
    expect(claims[0]!.confidence).toBe(0.95)
    await listener.close()
  })
})