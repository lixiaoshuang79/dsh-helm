import { describe, expect, it, vi } from 'vitest'
import { pairRpcPeers } from '../src/jsonrpc.js'

describe('RpcPeer', () => {
  it('request/response round trip', async () => {
    const { a, b } = pairRpcPeers()
    b.on('ping', (params) => ({ pong: params }))
    const res = await a.request('ping', { x: 1 })
    expect(res).toEqual({ pong: { x: 1 } })
  })

  it('propagates handler errors as rpc error', async () => {
    const { a, b } = pairRpcPeers()
    b.on('boom', () => {
      throw new Error('kaboom')
    })
    await expect(a.request('boom')).rejects.toThrow('kaboom')
  })

  it('method not found error', async () => {
    const { a, b } = pairRpcPeers()
    void b
    await expect(a.request('nope')).rejects.toThrow('method not found: nope')
  })

  it('supports notifications (no reply)', async () => {
    const { a, b } = pairRpcPeers()
    const fn = vi.fn()
    b.onNotify('evt', (p) => fn(p))
    a.notify('evt', { n: 1 })
    await new Promise((r) => setTimeout(r, 10))
    expect(fn).toHaveBeenCalledWith({ n: 1 })
  })

  it('rejects on timeout', async () => {
    const { a, b } = pairRpcPeers()
    b.on('slow', () => new Promise((r) => setTimeout(r, 200)))
    await expect(a.request('slow', undefined, { timeoutMs: 20 })).rejects.toThrow('rpc timeout: slow')
  })

  it('rejects pending requests on close', async () => {
    const { a, b } = pairRpcPeers()
    b.on('never', () => new Promise(() => {}))
    const p = a.request('never')
    a.close(new Error('closed'))
    await expect(p).rejects.toThrow('closed')
  })

  it('concurrent requests keep ids distinct', async () => {
    const { a, b } = pairRpcPeers()
    b.on('echo', (p) => p)
    const [r1, r2, r3] = await Promise.all([a.request('echo', 1), a.request('echo', 2), a.request('echo', 3)])
    expect([r1, r2, r3]).toEqual([1, 2, 3])
  })
})
