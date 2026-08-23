import { describe, expect, it } from 'vitest'
import {
  computeMac,
  generateNodeToken,
  generateNonce,
  verifyMac,
  isValidNodeId,
} from '../src/crypto.js'

describe('crypto', () => {
  it('generates base64url tokens of expected length', () => {
    const t = generateNodeToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes -> 43 base64url chars
  })

  it('generates unique nonces', () => {
    expect(generateNonce()).not.toBe(generateNonce())
  })

  it('computes and verifies MAC for the challenge material', () => {
    const token = generateNodeToken()
    const c = generateNonce()
    const s = generateNonce()
    const mac = computeMac(token, c, s)
    expect(verifyMac(token, c, s, mac)).toBe(true)
  })

  it('rejects wrong token / nonce / tampered mac', () => {
    const token = generateNodeToken()
    const c = generateNonce()
    const s = generateNonce()
    const mac = computeMac(token, c, s)
    expect(verifyMac(generateNodeToken(), c, s, mac)).toBe(false)
    expect(verifyMac(token, generateNonce(), s, mac)).toBe(false)
    expect(verifyMac(token, c, s, 'tampered')).toBe(false)
  })

  it('rejects mac of wrong length (timing-safe guard)', () => {
    const token = generateNodeToken()
    const mac = computeMac(token, 'a', 'b')
    expect(verifyMac(token, 'a', 'b', mac.slice(0, 10))).toBe(false)
  })

  it('validates UUID-shaped node ids only', () => {
    expect(isValidNodeId('8f7b6a2e-1c3d-4e5f-9a8b-7c6d5e4f3a2b')).toBe(true)
    expect(isValidNodeId('hostname')).toBe(false)
    expect(isValidNodeId('')).toBe(false)
    expect(isValidNodeId('8f7b6a2e1c3d4e5f9a8b7c6d5e4f3a2b')).toBe(false)
  })
})
