import { afterEach, describe, expect, it, vi } from 'vitest'
import { delimiter } from 'node:path'
import {
  findTailscaleCli,
  getTailscaleIp,
  getTailscaleStatus,
  getTailscaleVersion,
  isTailscaleInstalled,
  parseTailscaleStatusJson,
  runTailscale,
  type TailscaleExec,
} from '../src/tailscale.js'

/** Fixture shaped like real `tailscale status --json`, salted with key fields
 *  that must never survive parsing. */
const STATUS_FIXTURE = {
  Version: 1,
  BackendState: 'Running',
  Self: {
    HostName: 'alice-mbp',
    DNSName: 'alice-mbp.tailnet-abc123.ts.net',
    TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0:ab12::1'],
    OS: 'macOS',
    Online: true,
    PublicKey: 'nodekey:abcd1234',
    MachineKey: 'mkey:efgh5678',
    KeyExpiry: '2026-09-01T00:00:00Z',
    AuthKey: 'tskey-auth-fake-0123456789',
    UserID: 42,
  },
  Peers: [
    {
      HostName: 'home-nas',
      DNSName: 'home-nas.tailnet-abc123.ts.net',
      TailscaleIPs: ['100.64.0.2'],
      OS: 'linux',
      Online: false,
      LastSeen: '2026-08-24T00:00:00Z',
      PublicKey: 'nodekey:peer-one',
      KeyExpiry: '2026-09-01T00:00:00Z',
    },
    {
      HostName: 'office-pc',
      DNSName: 'office-pc.tailnet-abc123.ts.net',
      TailscaleIPs: ['100.64.0.3'],
      OS: 'windows',
      Online: true,
      PublicKey: 'nodekey:peer-two',
    },
  ],
}

describe('parseTailscaleStatusJson', () => {
  it('extracts whitelisted Self fields', () => {
    const s = parseTailscaleStatusJson(JSON.stringify(STATUS_FIXTURE))
    expect(s.self).not.toBeNull()
    expect(s.self?.hostName).toBe('alice-mbp')
    expect(s.self?.dnsName).toBe('alice-mbp.tailnet-abc123.ts.net')
    expect(s.self?.tailscaleIPs).toEqual(['100.64.0.1', 'fd7a:115c:a1e0:ab12::1'])
    expect(s.self?.online).toBe(true)
    expect(s.self?.os).toBe('macOS')
  })

  it('extracts whitelisted Peer fields and tolerates missing lastSeen', () => {
    const s = parseTailscaleStatusJson(JSON.stringify(STATUS_FIXTURE))
    expect(s.peers).toHaveLength(2)
    expect(s.peers[0]).toEqual({
      hostName: 'home-nas',
      tailscaleIPs: ['100.64.0.2'],
      online: false,
      lastSeen: '2026-08-24T00:00:00Z',
      os: 'linux',
    })
    expect(s.peers[1]?.lastSeen).toBeNull()
  })

  it('never leaks any key field (PublicKey/AuthKey/KeyExpiry/…), by value or name', () => {
    const s = parseTailscaleStatusJson(JSON.stringify(STATUS_FIXTURE))
    const dumped = JSON.stringify(s)
    expect(dumped).not.toMatch(/key/i)
    expect(dumped).not.toContain('nodekey:')
    expect(dumped).not.toContain('tskey-auth-fake-0123456789')
    expect(dumped).not.toContain('mkey:efgh5678')
  })

  it('handles empty peers and missing Self', () => {
    const s = parseTailscaleStatusJson('{"Version":1}')
    expect(s.self).toBeNull()
    expect(s.peers).toEqual([])
  })

  it('throws on invalid JSON', () => {
    expect(() => parseTailscaleStatusJson('not json')).toThrow()
  })
})

describe('runTailscale', () => {
  const fakeExec: TailscaleExec = (file, args, _opts) => {
    expect(file).toBe('/opt/homebrew/bin/tailscale')
    expect(args).toEqual(['version'])
    return '1.80.0\n'
  }

  it('returns stdout on success', () => {
    const r = runTailscale('/opt/homebrew/bin/tailscale', ['version'], 5000, fakeExec)
    expect(r).toEqual({ ok: true, stdout: '1.80.0\n' })
  })

  it('captures errors instead of throwing (stderr preferred)', () => {
    const failing: TailscaleExec = () => {
      const e = new Error('Command failed: tailscale status')
      ;(e as Error & { stderr: string }).stderr = 'tailscale: not logged in\n'
      throw e
    }
    const r = runTailscale('/x', ['status'], 5000, failing)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('not logged in')
  })

  it('falls back to the error message when stderr is empty', () => {
    const failing: TailscaleExec = () => {
      throw new Error('ETIMEDOUT')
    }
    const r = runTailscale('/x', ['version'], 100, failing)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('ETIMEDOUT')
  })
})

describe('getTailscaleVersion / getTailscaleIp', () => {
  it('returns the first trimmed line', () => {
    const exec: TailscaleExec = (_f, args) => (args[0] === 'version' ? '1.80.0\n' : '100.64.0.1\n100.64.0.2\n')
    expect(getTailscaleVersion('/ts', exec)).toBe('1.80.0')
    expect(getTailscaleIp('/ts', exec)).toBe('100.64.0.1')
  })

  it('returns null on failure or empty output', () => {
    const exec: TailscaleExec = () => {
      throw new Error('boom')
    }
    expect(getTailscaleVersion('/ts', exec)).toBeNull()
    expect(getTailscaleIp('/ts', exec)).toBeNull()
    expect(getTailscaleVersion('/ts', () => '')).toBeNull()
  })
})

describe('getTailscaleStatus', () => {
  it('combines run + parse', () => {
    const exec: TailscaleExec = (_f, args) => {
      expect(args).toEqual(['status', '--json'])
      return JSON.stringify(STATUS_FIXTURE)
    }
    const r = getTailscaleStatus('/ts', exec)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.status.peers).toHaveLength(2)
  })

  it('reports parse failures as ok:false', () => {
    const exec: TailscaleExec = () => 'garbage'
    const r = getTailscaleStatus('/ts', exec)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('解析')
  })
})

describe('findTailscaleCli', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('finds tailscale on PATH first', () => {
    vi.stubEnv('PATH', ['/usr/bin', '/opt/homebrew/bin'].join(delimiter))
    const exists = (p: string) => p === '/opt/homebrew/bin/tailscale'
    expect(findTailscaleCli(exists)).toBe('/opt/homebrew/bin/tailscale')
  })

  it('falls back to the macOS app bundle path', () => {
    vi.stubEnv('PATH', ['/usr/bin'].join(delimiter))
    const exists = (p: string) => p === '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    expect(findTailscaleCli(exists)).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  })

  it('checks /opt/homebrew and /usr/local last', () => {
    vi.stubEnv('PATH', ['/usr/bin'].join(delimiter))
    const exists = (p: string) => p === '/usr/local/bin/tailscale'
    expect(findTailscaleCli(exists)).toBe('/usr/local/bin/tailscale')
  })

  it('returns null when nothing matches', () => {
    vi.stubEnv('PATH', ['/usr/bin'].join(delimiter))
    expect(findTailscaleCli(() => false)).toBeNull()
  })

  it('isTailscaleInstalled is a boolean wrapper around discovery', () => {
    expect(typeof isTailscaleInstalled()).toBe('boolean')
  })
})
