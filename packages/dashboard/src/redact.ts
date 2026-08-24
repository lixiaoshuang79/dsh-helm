/**
 * Redaction helpers for the dashboard.
 *
 * The dashboard is a read-only console: it must never print full tunnel ids
 * or API secrets. These helpers are the single gate through which sensitive
 * strings are rendered.
 */

/**
 * Redact an opaque id (tunnel id, node id) to its first 8 characters.
 * Ids that are already short (<= 8 chars) are not revealing, so they are
 * replaced by a fixed placeholder instead of shown. Empty input stays empty.
 */
export function redactTunnelId(id: string): string {
  if (!id) return ''
  if (id.length <= 8) return '<short>'
  return `${id.slice(0, 8)}…`
}

const SK_PROJ_RE = /\bsk-proj-[A-Za-z0-9_-]+/g
const AUTH_BEARER_RE = /(Authorization\s*:\s*Bearer\s+)\S+/gi

/**
 * Redact API secrets inside free text (log tails, error messages):
 * - `sk-proj-<base64>` style OpenAI project keys -> `[REDACTED]`
 * - `Authorization: Bearer <token>` -> `Authorization: Bearer [REDACTED]`
 *
 * Ordinary text passes through untouched.
 */
export function redactSecrets(text: string): string {
  return text.replace(SK_PROJ_RE, '[REDACTED]').replace(AUTH_BEARER_RE, '$1[REDACTED]')
}
