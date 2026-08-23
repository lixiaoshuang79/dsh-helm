import { describe, expect, it } from 'vitest'
import { DshHelmStore } from '../src/db.js'
import { SessionCatalog, WorkspaceCatalog, sessionGlobalKey, splitGlobalKey } from '../src/catalogs.js'
import type { SessionInfo, WorkspaceInfo } from '@dsh-helm/protocol'

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  native_session_id: id,
  status: 'idle',
  live: false,
  ...extra,
})

const workspace = (id: string, path: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  native_workspace_id: id,
  path,
  ...extra,
})

describe('global keys', () => {
  it('composes and splits node_id:native_id', () => {
    const key = sessionGlobalKey('n1', 'session-abc')
    expect(key).toBe('n1:session-abc')
    expect(splitGlobalKey(key)).toEqual({ node_id: 'n1', native_id: 'session-abc' })
  })

  it('rejects malformed keys', () => {
    expect(() => splitGlobalKey('noseparator')).toThrow()
    expect(() => splitGlobalKey(':leading')).toThrow()
  })
})

describe('SessionCatalog', () => {
  it('upserts and resolves by global key and by native id', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const c = new SessionCatalog(s.db)
    c.upsert('n1', session('session-1', { title: 'hello', status: 'running', live: true }))
    const byGlobal = c.get('n1:session-1')!
    expect(byGlobal.native_session_id).toBe('session-1')
    expect(byGlobal.live).toBe(1)
    const byNative = c.get('session-1')!
    expect(byNative.node_id).toBe('n1')
    expect(c.ownerOf('session-1')).toBe('n1')
    s.close()
  })

  it('bare native id is ambiguous across nodes (resolves only when unique)', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const c = new SessionCatalog(s.db)
    c.upsert('n1', session('session-x'))
    c.upsert('n2', session('session-x'))
    expect(c.get('session-x')).toBeUndefined()
    expect(c.get('n1:session-x')).toBeDefined()
    s.close()
  })

  it('reconcile replaces a node catalog atomically', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const c = new SessionCatalog(s.db)
    c.upsert('n1', session('s1'))
    c.upsert('n1', session('s2'))
    c.upsert('n2', session('s3'))
    c.reconcile('n1', [session('s4')])
    expect(c.list('n1').map((r) => r.native_session_id)).toEqual(['s4'])
    expect(c.list('n2').map((r) => r.native_session_id)).toEqual(['s3'])
    s.close()
  })

  it('removeNode cleans catalog when a node disconnects', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const c = new SessionCatalog(s.db)
    c.upsert('n1', session('s1'))
    c.removeNode('n1')
    expect(c.count()).toBe(0)
    s.close()
  })
})

describe('WorkspaceCatalog', () => {
  it('upserts and resolves by native id or path within a node', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const c = new WorkspaceCatalog(s.db)
    c.upsert('n1', workspace('w1', '/Users/me/proj'))
    expect(c.resolve('w1', 'n1')!.path).toBe('/Users/me/proj')
    expect(c.resolve('/Users/me/proj', 'n1')!.node_id).toBe('n1')
    expect(c.ownerOf('w1')).toBe('n1')
    s.close()
  })

  it('same path on two nodes is two distinct workspaces (path is not identity)', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const c = new WorkspaceCatalog(s.db)
    c.upsert('n1', workspace('w-a', '/Users/me/proj'))
    c.upsert('n2', workspace('w-b', 'C:\\Users\\me\\proj'))
    // global keys differ even though display paths could coincide conceptually
    expect(c.resolve('w-a', 'n1')!.global_key).toBe('n1:w-a')
    expect(c.resolve('w-b', 'n2')!.global_key).toBe('n2:w-b')
    s.close()
  })

  it('reconcile replaces node workspaces', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    const c = new WorkspaceCatalog(s.db)
    c.upsert('n1', workspace('w1', '/a'))
    c.reconcile('n1', [workspace('w2', '/b')])
    expect(c.list('n1').map((r) => r.native_workspace_id)).toEqual(['w2'])
    s.close()
  })
})