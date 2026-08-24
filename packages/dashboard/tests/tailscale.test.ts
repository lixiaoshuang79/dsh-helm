import { describe, expect, it } from 'vitest'
import { parseTailscaleStatusJson } from '../src/tailscale.js'

/** Fixture mirrors the real `tailscale status --json` shape, including key
 *  material that must never leak through the parser. */
const FIXTURE = JSON.stringify({
  Version: '1.80.2-tb8e80f2b0',
  Self: {
    ID: 'self-id',
    PublicKey: 'pubkey:self:aaaa',
    HostName: 'mac-mini',
    DNSName: 'mac-mini.tailnet.ts.net.',
    TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
    Online: true,
    OS: 'macOS',
    AuthKey: 'tskey-auth-AAAA',
    KeyExpiry: '2030-01-01T00:00:00Z',
  },
  Peers: [
    {
      ID: 'peer-1',
      PublicKey: 'pubkey:peer:bbbb',
      HostName: 'nas',
      DNSName: 'nas.tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.2'],
      Online: false,
      LastSeen: '2026-08-24T01:00:00Z',
      OS: 'linux',
      AuthKey: 'tskey-auth-BBBB',
    },
    {
      ID: 'peer-2',
      PublicKey: 'pubkey:peer:cccc',
      HostName: 'router',
      TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'],
      Online: true,
      OS: 'openbsd',
      AuthKey: 'tskey-auth-CCCC',
    },
  ],
})

describe('parseTailscaleStatusJson', () => {
  it('extracts self and peers with whitelisted fields only', () => {
    const { self, peers } = parseTailscaleStatusJson(FIXTURE)
    expect(self).toEqual({
      hostName: 'mac-mini',
      ips: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
      online: true,
      os: 'macOS',
    })
    expect(peers).toHaveLength(2)
    expect(peers[0]).toEqual({
      hostName: 'nas',
      ips: ['100.64.0.2'],
      online: false,
      lastSeen: '2026-08-24T01:00:00Z',
      os: 'linux',
    })
    expect(peers[1]?.online).toBe(true)
  })

  it('sorts peers by host name', () => {
    const { peers } = parseTailscaleStatusJson(FIXTURE)
    expect(peers.map((p) => p.hostName)).toEqual(['nas', 'router'])
  })

  it('never forwards key material (auth keys, public keys, secrets)', () => {
    const serialized = JSON.stringify(parseTailscaleStatusJson(FIXTURE))
    expect(serialized).not.toContain('tskey')
    expect(serialized).not.toContain('AuthKey')
    expect(serialized).not.toContain('PublicKey')
    expect(serialized).not.toContain('pubkey')
  })

  it('returns empty results for invalid JSON', () => {
    expect(parseTailscaleStatusJson('not json')).toEqual({ self: null, peers: [] })
  })

  it('returns empty results for non-object JSON', () => {
    expect(parseTailscaleStatusJson('42')).toEqual({ self: null, peers: [] })
  })

  it('tolerates missing Self/Peers', () => {
    expect(parseTailscaleStatusJson('{}')).toEqual({ self: null, peers: [] })
  })

  it('drops malformed peer entries', () => {
    const { peers } = parseTailscaleStatusJson(JSON.stringify({ Peers: ['nope', null, 42, { HostName: 'ok', TailscaleIPs: 'not-array' }] }))
    expect(peers).toEqual([{ hostName: 'ok', ips: [], online: false }])
  })

  it('parses the modern Peer map form (nodekey -> peer object)', () => {
    const json = JSON.stringify({
      Self: { HostName: 'self', TailscaleIPs: ['100.1.2.3'], Online: true, OS: 'macOS' },
      Peer: {
        'nodekey:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
          HostName: 'home',
          TailscaleIPs: ['100.88.219.39'],
          Online: true,
          LastSeen: '2026-08-24T00:00:00Z',
          OS: 'macOS',
          PublicKey: 'nodekey:should-not-leak',
          AuthKey: 'tskey-xxx',
        },
      },
    })
    const { self, peers } = parseTailscaleStatusJson(json)
    expect(self?.hostName).toBe('self')
    expect(peers).toEqual([{ hostName: 'home', ips: ['100.88.219.39'], online: true, lastSeen: '2026-08-24T00:00:00Z', os: 'macOS' }])
    expect(JSON.stringify(peers)).not.toMatch(/tskey|PublicKey|AuthKey|nodekey:/)
  })
})