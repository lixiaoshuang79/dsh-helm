import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { AddressInfo } from 'node:net'
import { fetchHaStatus } from '../src/status.js'

interface MockRecord {
  path: string | undefined
  response: string
  status: number
}

const servers: Server[] = []

function startMockServer(records: MockRecord[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = createServer((req: IncomingMessage, res) => {
      const rec = records.find((r) => r.path === req.url)
      if (!rec) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(rec.status, { 'content-type': 'application/json' }).end(rec.response)
    })
    srv.on('error', reject)
    servers.push(srv)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

afterEach(() => {
  while (servers.length) servers.pop()?.close()
})

const HA_OK = JSON.stringify({
  cpId: 'cp-node-aaaa11112222',
  role: 'leader',
  phase: 'leader-leased',
  term: 7,
  leaderId: 'cp-node-aaaa11112222',
  writeMode: 'readwrite',
  quorum: true,
  leaseEpoch: 7,
  peers: [{ cpId: 'cp-node-bbbb33334444', url: 'ws://100.64.0.1:3470', connected: true, lastSeen: 0, role: 'follower' }],
  syncOk: true,
  failoverCount: 1,
})

describe('fetchHaStatus', () => {
  it('parses a healthy dual-CP /cp-status payload', async () => {
    const base = await startMockServer([{ path: '/cp-status', response: HA_OK, status: 200 }])
    const ha = await fetchHaStatus(base)
    expect(ha.role).toBe('leader')
    expect(ha.phase).toBe('leader-leased')
    expect(ha.writeMode).toBe('readwrite')
    expect(ha.quorum).toBe(true)
    expect(ha.term).toBe(7)
    expect(ha.leaseEpoch).toBe(7)
    expect(ha.syncOk).toBe(true)
    expect(ha.failoverCount).toBe(1)
    expect(ha.peers).toHaveLength(1)
    expect(ha.peers![0].cpId).toBe('cp-node-bbbb33334444')
    expect(ha.error).toBeUndefined()
  })

  it('carries the readonly / no-quorum state through', async () => {
    const body = JSON.stringify({
      cpId: 'cp-node-aaaa11112222',
      role: 'follower',
      phase: 'read-only-no-quorum',
      term: 6,
      leaderId: 'cp-node-aaaa11112222',
      writeMode: 'readonly',
      quorum: false,
      leaseEpoch: 0,
      peers: [],
      syncOk: false,
      failoverCount: 1,
    })
    const base = await startMockServer([{ path: '/cp-status', response: body, status: 200 }])
    const ha = await fetchHaStatus(base)
    expect(ha.phase).toBe('read-only-no-quorum')
    expect(ha.writeMode).toBe('readonly')
    expect(ha.quorum).toBe(false)
    expect(ha.syncOk).toBe(false)
  })

  it('never throws on HTTP errors', async () => {
    const base = await startMockServer([{ path: '/cp-status', response: 'oops', status: 500 }])
    const ha = await fetchHaStatus(base)
    expect(ha.error).toMatch(/cp-status http 500/)
  })

  it('never throws when the endpoint is missing (standalone old hub)', async () => {
    const base = await startMockServer([{ path: '/healthz', response: '{"ok":true}', status: 200 }])
    const ha = await fetchHaStatus(base)
    expect(ha.error).toMatch(/404/)
  })

  it('never throws when the hub is down', async () => {
    const ha = await fetchHaStatus('http://127.0.0.1:1', 500)
    expect(ha.error).toMatch(/unreachable/)
  })
})
