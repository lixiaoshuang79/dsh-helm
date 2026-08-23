import { describe, expect, it } from 'vitest'
import { DshHelmStore } from '../src/db.js'
import { NodeRegistry } from '../src/registry.js'
import type { NodeInfo } from '@dsh-helm/protocol'

function makeNode(id: string, name = id): NodeInfo {
  return {
    node_id: id,
    display_name: name,
    platform: { os: 'darwin', arch: 'arm64', release: '24.0.0', nodeVersion: 'v22.19.0' },
    versions: { agent: '0.1.0', protocol: 1, helmCore: '0.1.1' },
    capabilities: { sessions: true, serena: true, tunnel: false, presenceProvider: true, defaultNode: name === 'mac-mini' },
    config_home: '/tmp/dsh-helm-test',
  }
}

describe('NodeRegistry', () => {
  it('registers and reads a node back with hydrated JSON fields', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const r = new NodeRegistry(s.db)
    r.register(makeNode('n1'))
    const n = r.get('n1')!
    expect(n.node_id).toBe('n1')
    expect(n.platform.os).toBe('darwin')
    expect(n.versions.protocol).toBe(1)
    expect(n.capabilities.sessions).toBe(true)
    expect(n.status).toBe('online')
    s.close()
  })

  it('re-register preserves status/last_seen but refreshes metadata', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const r = new NodeRegistry(s.db)
    r.register(makeNode('n1', 'first'))
    r.heartbeat('n1', { seq: 1, ts: new Date().toISOString(), health: { channel: { status: 'ok' }, adapter: { status: 'ok' }, datapath: { status: 'ok' }, serena: { status: 'unknown' } }, workspace_count: 1, session_count: 1 })
    r.markOffline('n1', 'lease expired')
    r.register(makeNode('n1', 'second'))
    const n = r.get('n1')!
    expect(n.display_name).toBe('second')
    expect(n.status).toBe('offline') // re-register doesn't resurrect status
    s.close()
  })

  it('heartbeat updates seq and status, and onlineNodes respects lease', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const r = new NodeRegistry(s.db)
    r.register(makeNode('n1'))
    r.register(makeNode('n2'))
    r.heartbeat('n1', { seq: 7, ts: new Date().toISOString(), health: { channel: { status: 'ok' }, adapter: { status: 'ok' }, datapath: { status: 'ok' }, serena: { status: 'unknown' } }, workspace_count: 1, session_count: 1 })
    const n1 = r.get('n1')!
    expect(n1.heartbeat_seq).toBe(7)
    expect(n1.status).toBe('online')
    // n2 never heartbeated but registered: registered_at used as last_seen -> within lease
    const online = r.onlineNodes(45_000)
    expect(online.map((n) => n.node_id).sort()).toEqual(['n1', 'n2'].sort())
    s.close()
  })

  it('onlineNodes excludes nodes whose last_seen is older than the lease', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const r = new NodeRegistry(s.db)
    r.register(makeNode('n1'))
    r.register(makeNode('n2'))
    r.heartbeat('n1', { seq: 1, ts: new Date(Date.now() - 60_000).toISOString(), health: { channel: { status: 'ok' }, adapter: { status: 'ok' }, datapath: { status: 'ok' }, serena: { status: 'unknown' } }, workspace_count: 0, session_count: 0 })
    const online = r.onlineNodes(45_000)
    expect(online.map((n) => n.node_id)).not.toContain('n1')
    s.close()
  })

  it('block/unblock and channelHealth layering', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const r = new NodeRegistry(s.db)
    r.register(makeNode('n1'))
    expect(r.channelHealth('n1', 45_000).status).toBe('ok')
    r.block('n1', 'incompatible protocol')
    expect(r.channelHealth('n1', 45_000)).toMatchObject({ status: 'down', code: 'node-blocked' })
    r.unblock('n1')
    expect(r.get('n1')!.status).toBe('offline')
    expect(r.channelHealth('n1', 45_000).status).toBe('down')
    r.heartbeat('n1', { seq: 2, ts: new Date().toISOString(), health: { channel: { status: 'ok' }, adapter: { status: 'ok' }, datapath: { status: 'ok' }, serena: { status: 'unknown' } }, workspace_count: 0, session_count: 0 })
    expect(r.channelHealth('n1', 45_000).status).toBe('ok')
    s.close()
  })

  it('remove deletes the node', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const r = new NodeRegistry(s.db)
    r.register(makeNode('n1'))
    r.remove('n1')
    expect(r.get('n1')).toBeUndefined()
    expect(r.channelHealth('n1', 45_000)).toMatchObject({ status: 'unknown' })
    s.close()
  })
})