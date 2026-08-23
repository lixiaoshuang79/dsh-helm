import { describe, expect, it, beforeEach } from 'vitest'
import { DshHelmStore } from '@dsh-helm/store'
import { NodeRegistry, SessionCatalog, WorkspaceCatalog, PresenceRegistry } from '@dsh-helm/store'
import { Router } from '../src/router.js'
import { DANGER, ROUTE_OUTCOME } from '@dsh-helm/protocol'

const now = Date.now()
const iso = (t: number) => new Date(t).toISOString()

function makeNode(id: string, opts: Partial<Parameters<NodeRegistry['register']>[0]['capabilities']> = {}): Parameters<NodeRegistry['register']>[0] {
  return {
    node_id: id,
    display_name: id,
    platform: { os: 'darwin', arch: 'arm64', release: 'x', nodeVersion: 'v22' },
    versions: { agent: '0.1.0', protocol: 1 },
    capabilities: { sessions: true, serena: true, tunnel: false, presenceProvider: true, defaultNode: false, ...opts },
  }
}

function heartbeat(db: DshHelmStore, r: NodeRegistry, id: string, at = Date.now()) {
  r.heartbeat(id, { seq: 1, ts: iso(at), health: { channel: { status: 'ok' }, adapter: { status: 'ok' }, datapath: { status: 'ok' }, serena: { status: 'unknown' } }, workspace_count: 0, session_count: 0 })
}

describe('Router', () => {
  let store: DshHelmStore
  let nodes: NodeRegistry
  let sessions: SessionCatalog
  let workspaces: WorkspaceCatalog
  let presence: PresenceRegistry
  let router: Router

  beforeEach(() => {
    store = new DshHelmStore({ file: ':memory:' })
    nodes = new NodeRegistry(store.db)
    sessions = new SessionCatalog(store.db)
    workspaces = new WorkspaceCatalog(store.db)
    presence = new PresenceRegistry(store.db)
    nodes.register(makeNode('n-default', { defaultNode: true }))
    heartbeat(store, nodes, 'n-default')
    router = new Router({ nodes, sessions, workspaces, presence, leaseMs: 45_000, defaultNodeId: 'n-default' })
  })

  it('routes to explicit target_node even when not the default', () => {
    nodes.register(makeNode('n-remote'))
    heartbeat(store, nodes, 'n-remote')
    const res = router.route({ op: 'sessions_prompt', target_node: 'n-remote', danger: DANGER.DESTRUCTIVE })
    expect(res.action).toBe('forward')
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.EXPLICIT)
    expect(res.decision.node_id).toBe('n-remote')
    expect(res.decision.explicit).toBe(true)
  })

  it('rejects an unknown explicit target', () => {
    const res = router.route({ op: 'sessions_prompt', target_node: 'ghost', danger: DANGER.DESTRUCTIVE })
    expect(res.action).toBe('reject')
    expect(res.errorCode).toBe('unknown_node')
  })

  it('session owner affinity beats presence and default', () => {
    nodes.register(makeNode('n-remote'))
    heartbeat(store, nodes, 'n-remote')
    sessions.upsert('n-remote', { native_session_id: 'session-9', status: 'running', live: true })
    presence.claim({ node_id: 'n-default', source: 'desktop', confidence: 0.9, observed_at: iso(now), ttl_ms: 60_000 })
    const res = router.route({ op: 'sessions_prompt', session_id: 'session-9', danger: DANGER.DESTRUCTIVE })
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.SESSION_OWNER)
    expect(res.decision.node_id).toBe('n-remote')
  })

  it('workspace owner affinity routes code tools to the owning node', () => {
    nodes.register(makeNode('n-code'))
    heartbeat(store, nodes, 'n-code')
    workspaces.upsert('n-code', { native_workspace_id: 'w-42', path: '/Users/me/repo' })
    const res = router.route({ op: 'code_read_file', workspace: 'w-42', danger: DANGER.READ })
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.WORKSPACE_OWNER)
    expect(res.decision.node_id).toBe('n-code')
  })

  it('fresh unambiguous presence routes to the present node', () => {
    nodes.register(makeNode('n-present'))
    heartbeat(store, nodes, 'n-present')
    presence.claim({ node_id: 'n-present', source: 'desktop', confidence: 0.95, observed_at: iso(now), ttl_ms: 60_000 })
    const res = router.route({ op: 'sessions_prompt', danger: DANGER.DESTRUCTIVE })
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.PRESENCE)
    expect(res.decision.node_id).toBe('n-present')
  })

  it('ambiguous presence does not auto-pick; falls through to default', () => {
    nodes.register(makeNode('n-a'))
    nodes.register(makeNode('n-b'))
    heartbeat(store, nodes, 'n-a')
    heartbeat(store, nodes, 'n-b')
    presence.claim({ node_id: 'n-a', source: 'desktop', confidence: 0.9, observed_at: iso(now - 2_000), ttl_ms: 60_000 })
    presence.claim({ node_id: 'n-b', source: 'desktop', confidence: 0.95, observed_at: iso(now), ttl_ms: 60_000 })
    const res = router.route({ op: 'sessions_list', danger: DANGER.READ })
    expect(res.decision.evidence.presence_ambiguous).toBe(true)
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.DEFAULT_LOCAL)
    expect(res.decision.node_id).toBe('n-default')
  })

  it('read op with no route rejects with no_route', () => {
    nodes.markOffline('n-default', 'lease expired')
    const res = router.route({ op: 'nodes_list', danger: DANGER.READ })
    expect(res.action).toBe('reject')
    expect(res.errorCode).toBe('no_route')
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.NO_ROUTE)
  })

  it('destructive op with no route rejects fail-closed with confirmation required', () => {
    nodes.markOffline('n-default', 'lease expired')
    const res = router.route({ op: 'sessions_prompt', danger: DANGER.DESTRUCTIVE })
    expect(res.action).toBe('reject')
    expect(res.errorCode).toBe('route_confirmation_required')
    expect(res.decision.confirmation_required).toBe(true)
  })

  it('write op with no route also rejects with confirmation required', () => {
    nodes.markOffline('n-default', 'lease expired')
    const res = router.route({ op: 'sessions_create', danger: DANGER.WRITE })
    expect(res.action).toBe('reject')
    expect(res.errorCode).toBe('route_confirmation_required')
  })

  it('default healthy node is the fallback', () => {
    const res = router.route({ op: 'sessions_prompt', danger: DANGER.DESTRUCTIVE })
    expect(res.decision.outcome).toBe(ROUTE_OUTCOME.DEFAULT_LOCAL)
    expect(res.decision.node_id).toBe('n-default')
  })

  it('offline default node is not a valid fallback', () => {
    nodes.markOffline('n-default', 'lease expired')
    const res = router.route({ op: 'nodes_list', danger: DANGER.READ })
    expect(res.errorCode).toBe('no_route')
  })

  it('decisions carry evidence and candidates for route_explain', () => {
    nodes.register(makeNode('n-remote'))
    heartbeat(store, nodes, 'n-remote')
    sessions.upsert('n-remote', { native_session_id: 'session-1', status: 'idle' })
    const res = router.route({ op: 'sessions_get', session_id: 'session-1', danger: DANGER.READ })
    expect(res.decision.evidence.session_owner).toBe('n-remote')
    expect(res.decision.candidates.length).toBeGreaterThan(0)
    expect(res.decision.candidates[0]).toMatchObject({ node_id: 'n-remote' })
  })
})