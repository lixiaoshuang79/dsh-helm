/**
 * Crypto helpers for node authentication.
 *
 * Uses node:crypto only — no bespoke cryptography. HMAC-SHA256 challenge
 * response over TLS (WSS) transport; plain ws is allowed only on loopback or
 * in tests. Token comparison is constant-time.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { HMAC_ALGORITHM, NODE_TOKEN_BYTES } from './constants.js'

/** Generate a new node secret token (base64url). */
export function generateNodeToken(bytes: number = NODE_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url')
}

/** Generate a random nonce (base64url). */
export function generateNonce(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}

/** Compute HMAC-SHA256 over the concatenated challenge material. */
export function computeMac(token: string, clientNonce: string, serverNonce: string): string {
  const mac = createHmac(HMAC_ALGORITHM, token)
  mac.update(clientNonce)
  mac.update(serverNonce)
  return mac.digest('base64url')
}

/** Constant-time MAC verification. */
export function verifyMac(token: string, clientNonce: string, serverNonce: string, mac: string): boolean {
  const expected = computeMac(token, clientNonce, serverNonce)
  const a = Buffer.from(expected)
  const b = Buffer.from(mac)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Validate a node_id is a plausible UUID (identity hygiene). */
export function isValidNodeId(nodeId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)
}
