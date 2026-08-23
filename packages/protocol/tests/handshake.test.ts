import { describe, expect, it, vi } from 'vitest'
import { HandshakeServer, HandshakeClient } from '../src/handshake.js'
import { generateNodeToken } from '../src/crypto.js'
import { PROTOCOL_ERROR } from '../src/constants.js'
import type { WireMessage } from '../src/envelope.js'

function link(serverSide: HandshakeServer, clientSide: HandshakeClient) {
  let toClient: (m: WireMessage) => void = () => {}
  const serverSender = { send: (m: WireMessage) => toClient(m) }
  // Rebuild server with the routed sender to avoid double-binding;
  // simpler: client sends to server directly, server sends via toClient.
  return { serverSender, setToClient: (f: (m: WireMessage) => void) => (toClient = f) }
}

describe('handshake', () => {
  it('full handshake succeeds with correct token', () => {
    const token = generateNodeToken()
    const nodeId = '8f7b6a2e-1c3d-4e5f-9a8b-7c6d5e4f3a2b'
    const onWelcome = vi.fn()
    const onError = vi.fn()
    let toClient: (m: WireMessage) => void = () => {}
    const ss = new HandshakeServer(
      { send: (m) => toClient(m) },
      {
        hubId: 'hub-1',
        schemaVersion: 1,
        heartbeatMs: 15000,
        leaseMs: 45000,
        lookupToken: (id) => (id === nodeId ? token : undefined),
      },
      { onWelcome, onError },
    )
    const c = new HandshakeClient({ send: (m) => ss.inbound(m) }, nodeId, token, 1, { onOutcome: vi.fn() })
    toClient = (m) => c.inbound(m)
    c.start()
    expect(onError).not.toHaveBeenCalled()
    expect(onWelcome).toHaveBeenCalledTimes(1)
  })

  it('rejects wrong token with AUTH_FAILED', () => {
    const nodeId = '8f7b6a2e-1c3d-4e5f-9a8b-7c6d5e4f3a2b'
    const onError = vi.fn()
    let toClient: (m: WireMessage) => void = () => {}
    const ss = new HandshakeServer(
      { send: (m) => toClient(m) },
      { hubId: 'hub-1', schemaVersion: 1, heartbeatMs: 15000, leaseMs: 45000, lookupToken: () => generateNodeToken() },
      { onWelcome: vi.fn(), onError },
    )
    const outcome = vi.fn()
    const c = new HandshakeClient({ send: (m) => ss.inbound(m) }, nodeId, 'wrong-token', 1, { onOutcome: outcome })
    toClient = (m) => c.inbound(m)
    c.start()
    expect(onError).toHaveBeenCalledWith(PROTOCOL_ERROR.AUTH_FAILED, expect.any(String))
    expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: PROTOCOL_ERROR.AUTH_FAILED }))
  })

  it('rejects unknown node with AUTH_FAILED', () => {
    const onError = vi.fn()
    let toClient: (m: WireMessage) => void = () => {}
    const ss = new HandshakeServer(
      { send: (m) => toClient(m) },
      { hubId: 'hub-1', schemaVersion: 1, heartbeatMs: 15000, leaseMs: 45000, lookupToken: () => undefined },
      { onWelcome: vi.fn(), onError },
    )
    const c = new HandshakeClient({ send: (m) => ss.inbound(m) }, 'some-id', 'tok', 1, { onOutcome: vi.fn() })
    toClient = (m) => c.inbound(m)
    c.start()
    expect(onError).toHaveBeenCalledWith(PROTOCOL_ERROR.AUTH_FAILED, expect.any(String))
  })

  it('rejects version mismatch with VERSION_MISMATCH (no silent downgrade)', () => {
    const onError = vi.fn()
    let toClient: (m: WireMessage) => void = () => {}
    const ss = new HandshakeServer(
      { send: (m) => toClient(m) },
      { hubId: 'hub-1', schemaVersion: 2, heartbeatMs: 15000, leaseMs: 45000, lookupToken: () => 'tok' },
      { onWelcome: vi.fn(), onError },
    )
    const outcome = vi.fn()
    const c = new HandshakeClient({ send: (m) => ss.inbound(m) }, 'id', 'tok', 1, { onOutcome: outcome })
    toClient = (m) => c.inbound(m)
    c.start()
    expect(onError).toHaveBeenCalledWith(PROTOCOL_ERROR.VERSION_MISMATCH, expect.stringContaining('version mismatch'))
    expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: PROTOCOL_ERROR.VERSION_MISMATCH }))
  })

  it('rejects auth when token lookup disagrees (single attempt, no retry loop)', () => {
    // Server holds a different token than the client -> auth fails once and terminates.
    const onError = vi.fn()
    let toClient: (m: WireMessage) => void = () => {}
    const ss = new HandshakeServer(
      { send: (m) => toClient(m) },
      { hubId: 'hub-1', schemaVersion: 1, heartbeatMs: 15000, leaseMs: 45000, lookupToken: () => 'server-token' },
      { onWelcome: vi.fn(), onError },
    )
    const outcome = vi.fn()
    const c = new HandshakeClient({ send: (m) => ss.inbound(m) }, 'id', 'client-token', 1, { onOutcome: outcome })
    toClient = (m) => c.inbound(m)
    c.start()
    expect(onError).toHaveBeenCalledWith(PROTOCOL_ERROR.AUTH_FAILED, expect.any(String))
    expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: PROTOCOL_ERROR.AUTH_FAILED }))
    // Handshake terminated: a second hello must not produce a second outcome.
    c.start()
    expect(outcome).toHaveBeenCalledTimes(1)
  })

  it('ignores stray messages after completion', () => {
    const token = generateNodeToken()
    const nodeId = '8f7b6a2e-1c3d-4e5f-9a8b-7c6d5e4f3a2b'
    const onWelcome = vi.fn()
    let toClient: (m: WireMessage) => void = () => {}
    const ss = new HandshakeServer(
      { send: (m) => toClient(m) },
      { hubId: 'hub-1', schemaVersion: 1, heartbeatMs: 15000, leaseMs: 45000, lookupToken: () => token },
      { onWelcome, onError: vi.fn() },
    )
    const c = new HandshakeClient({ send: (m) => ss.inbound(m) }, nodeId, token, 1, { onOutcome: vi.fn() })
    toClient = (m) => c.inbound(m)
    c.start()
    expect(onWelcome).toHaveBeenCalledTimes(1)
    // After completion, a duplicate hello must not re-trigger
    c.start()
    expect(onWelcome).toHaveBeenCalledTimes(1)
  })
})

describe('handshake direct wire helper', () => {
  it('routes both directions', () => {
    const token = generateNodeToken()
    const nodeId = '8f7b6a2e-1c3d-4e5f-9a8b-7c6d5e4f3a2b'
    let toClient: (m: WireMessage) => void = () => {}
    const onWelcome = vi.fn()
    const ss = new HandshakeServer(
      { send: (m) => toClient(m) },
      {
        hubId: 'hub-1',
        schemaVersion: 1,
        heartbeatMs: 15000,
        leaseMs: 45000,
        lookupToken: (id) => (id === nodeId ? token : undefined),
      },
      { onWelcome, onError: vi.fn() },
    )
    const c = new HandshakeClient({ send: (m) => ss.inbound(m) }, nodeId, token, 1, { onOutcome: vi.fn() })
    toClient = (m) => c.inbound(m)
    c.start()
    expect(onWelcome).toHaveBeenCalledTimes(1)
  })

  it('link helper is usable', () => {
    const token = generateNodeToken()
    const nodeId = '8f7b6a2e-1c3d-4e5f-9a8b-7c6d5e4f3a2b'
    let toClient: (m: WireMessage) => void = () => {}
    const ss = new HandshakeServer(
      { send: (m) => toClient(m) },
      { hubId: 'hub-1', schemaVersion: 1, heartbeatMs: 15000, leaseMs: 45000, lookupToken: () => token },
      { onWelcome: vi.fn(), onError: vi.fn() },
    )
    const c = new HandshakeClient({ send: (m) => ss.inbound(m) }, nodeId, token, 1, { onOutcome: vi.fn() })
    const l = link(ss, c)
    l.setToClient((m) => c.inbound(m))
    void l.serverSender
    c.start()
  })
})