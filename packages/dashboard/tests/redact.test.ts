import { describe, expect, it } from 'vitest'
import { redactSecrets, redactTunnelId } from '../src/redact.js'

describe('redactTunnelId', () => {
  it('keeps the first 8 characters and appends an ellipsis', () => {
    expect(redactTunnelId('tunnel_aaaa1111bbbbcccc')).toBe('tunnel_a…')
  })

  it('hides short ids with a placeholder (length <= 8)', () => {
    expect(redactTunnelId('tun_1234')).toBe('<short>')
    expect(redactTunnelId('12345678')).toBe('<short>')
  })

  it('returns an empty string for empty input', () => {
    expect(redactTunnelId('')).toBe('')
  })
})

describe('redactSecrets', () => {
  it('replaces sk-proj-* tokens with [REDACTED]', () => {
    const text = 'config key=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_ab, live'
    expect(redactSecrets(text)).toBe('config key=[REDACTED], live')
  })

  it('redacts multiple sk-proj tokens', () => {
    const text = 'a=sk-proj-AAAA b=sk-proj-BBBB end'
    expect(redactSecrets(text)).toBe('a=[REDACTED] b=[REDACTED] end')
  })

  it('redacts Authorization: Bearer values', () => {
    expect(redactSecrets('Authorization: Bearer sk-abc123def456xyz')).toBe('Authorization: Bearer [REDACTED]')
  })

  it('redacts lowercase authorization headers too', () => {
    expect(redactSecrets('authorization: bearer token123')).toBe('authorization: bearer [REDACTED]')
  })

  it('leaves ordinary text untouched', () => {
    const text = 'ordinary log line: node online, port 3471, path /Users/me/.dsh/helm'
    expect(redactSecrets(text)).toBe(text)
  })
})
