/**
 * HubHa: control-plane high availability (dual CP, active-active reads +
 * single writer leader guarded by a 2/2-quorum WRITE LEASE).
 *
 * Safety model (CAP-first; never a fake election, never split-brain writes):
 * - Only a majority can write. 2 Macs => majority = 2, so BOTH control planes
 *   must be mutually reachable for any WRITE_TOOLS call to succeed.
 * - The elected leader HOLDS a write lease and renews it to the peer every
 *   LEASE_RENEW_MS (10s). If the peer stops acknowledging (or any peer goes
 *   silent) for more than LEASE_TTL_MS (45s), the leader IMMEDIATELY demotes
 *   itself to read-only (quorum lost) and refuses writes with the structured
 *   error { code: 'QUORUM_LOST', message: 'no control-plane quorum: peer
 *   unreachable' }.
 * - A follower NEVER promotes on its own. When its leader disappears it stays
 *   read-only, does NOT bump the term, and does not elect itself.
 * - Recovery: when the peers are mutually reachable again, both sides do a
 *   full registry sync, then a fresh election (term+1, negotiated by both
 *   sides, winner = smallest --cp-priority, tie -> smaller cp_id), the winner
 *   takes the lease (both sides confirm), and writes resume. While a side is
 *   between "peer reconnected" and "lease granted" it refuses writes.
 * - Reads (nodes_list, code_* reads, healthz, cp-status, sessions_list, ...)
 *   are always served locally from the synced registry, on either CP.
 *
 * State machine (phase):
 *   nominating           - in election, no lease, read-only
 *   leader-leased        - elected + holding a confirmed lease: READWRITE
 *   read-only-no-quorum  - quorum lost (peer gone / lease expired): READONLY
 *   follower             - peer is the leased leader, quorum healthy:
 *                          READONLY locally, WRITE_TOOLS forwarded to leader
 *   standalone           - single-CP deployment (no --cp-peer): READWRITE,
 *                          term always 1, nothing persisted, no timers
 *
 * Wire protocol (over the node mesh, cp:<cp_id> "special node"):
 *   cp.sync         full registry + state on connect (both directions)
 *   cp.heartbeat    5s diff + state (both directions)
 *   cp.elect        election proposal { term, leader, candidates } -> ack
 *   cp.lease.renew  leader -> peer { term, epoch } -> { ok }
 *
 * Term fencing: term/leader/leaderTerm are persisted in the store kv table
 * (cp_term / cp_leader / cp_leader_term). A peer declaring a higher term wins
 * (we align); the same term with a different leader is a split-brain signal
 * (both sides bump the term and re-elect — the deterministic election always
 * converges, and the lease requirement means nobody can write during it).
 *
 * All decision logic lives in exported pure functions for unit testing.
 */

import type { ComponentVersions, CpPeerState, CpRole, CpSyncNode, HealthReport, NodeCapabilities, PlatformInfo, WireMessage } from '@dsh-helm/protocol'
import {
  CP_METHODS,
  CP_NODE_PREFIX,
  CP_TERM_KV,
  DEFAULT_CP_HEARTBEAT_MS,
  DEFAULT_CP_LEASE_RENEW_MS,
  DEFAULT_CP_LEASE_TTL_MS,
  DEFAULT_CP_PRIORITY,
  DEFAULT_HUB_MCP_PORT,
  DEFAULT_HUB_MESH_PORT,
  NODE_PROTOCOL_VERSION,
  RECONNECT_BACKOFF_BASE_MS,
  RECONNECT_BACKOFF_MAX_MS,
} from '@dsh-helm/protocol'
import { HandshakeClient, RpcPeer, type MessagePeer } from '@dsh-helm/protocol'
import type { DshHelmStore, NodeRegistry, StoredNode } from '@dsh-helm/store'
import type { NodeConnection } from './control-plane.js'
import type { McpCallResult } from './mcp/server.js'

// ---------------------------------------------------------------------------
// Pure decision logic (unit-testable, no sockets / no timers)
// ---------------------------------------------------------------------------

export interface Candidate {
  cpId: string
  priority: number
}

/**
 * Deterministic leader election among a CP set: smallest priority wins;
 * tie -> lexicographically smaller cp_id.
 */
export function electLeader(candidates: Candidate[]): string {
  if (candidates.length === 0) return ''
  return [...candidates].sort(
    (a, b) => a.priority - b.priority || (a.cpId < b.cpId ? -1 : a.cpId > b.cpId ? 1 : 0),
  )[0]!.cpId
}

export type TermJudgment = 'accept-peer' | 'split-brain' | 'stable'

/**
 * How to react to a peer's declared (term, leader) given our (term, leader):
 * - peer term > local term        -> accept the peer's term/leader (fencing)
 * - peer term < local term        -> stable (we are ahead)
 * - equal term, same leader       -> stable
 * - equal term, different leader  -> split-brain: both sides bump + re-elect
 * A peer with no declared leader (leader === '') never triggers a conflict.
 * Note: accepting a leader never grants write access — writes additionally
 * require the leader to hold a confirmed lease (see HubHa.writeMode).
 */
export function judgeTerm(local: { term: number; leader: string }, peer: { term: number; leader: string }): TermJudgment {
  if (peer.term > local.term) return 'accept-peer'
  if (peer.term < local.term) return 'stable'
  if (peer.leader === '' || local.leader === peer.leader) return 'stable'
  return 'split-brain'
}

/** A merged registry entry (local store + remote overlay). */
export interface HaNode {
  node_id: string
  display_name: string
  status: string
  last_seen?: string
  platform?: PlatformInfo
  versions?: ComponentVersions
  capabilities?: NodeCapabilities
  health?: HealthReport
  /** Whether the REPORTING peer claims a direct connection to this node. */
  connected: boolean
  /** Peer cp_id that last reported this node ('' when locally seen). */
  peer: string
}

export interface MergeResult {
  added: number
  updated: number
}

/**
 * Merge one peer's registry snapshot into the overlay map.
 * Rules: `last_seen` newer wins for metadata (display_name / status /
 * platform / versions / capabilities / health); `connected` is OR-ed with
 * our own direct connections (the direct CP is authoritative, the other side
 * marks derived at read time). Returns added/updated counts.
 */
export function mergeRegistryEntries(
  current: Map<string, HaNode>,
  incoming: CpSyncNode[],
  opts: { directConnections: ReadonlySet<string>; peerId: string },
): MergeResult {
  const { directConnections, peerId } = opts
  let added = 0
  let updated = 0
  for (const n of incoming) {
    const direct = directConnections.has(n.node_id)
    const existing = current.get(n.node_id)
    if (!existing) {
      current.set(n.node_id, {
        node_id: n.node_id,
        display_name: n.display_name,
        status: n.status,
        last_seen: n.last_seen,
        platform: n.platform,
        versions: n.versions,
        capabilities: n.capabilities,
        health: n.health,
        connected: direct || n.connected,
        peer: peerId,
      })
      added++
      continue
    }
    const incomingNewer = (n.last_seen ?? '') > (existing.last_seen ?? '')
    if (incomingNewer) {
      existing.display_name = n.display_name
      existing.status = n.status
      existing.platform = n.platform
      existing.versions = n.versions
      existing.capabilities = n.capabilities
      existing.health = n.health
      existing.last_seen = n.last_seen
      existing.peer = peerId
      existing.connected = direct || n.connected
      updated++
    } else if (n.connected && !existing.connected) {
      existing.connected = true
      existing.peer = peerId
      updated++
    }
    if (direct) existing.connected = true
  }
  return { added, updated }
}

/**
 * Compute the entries of `next` that differ from the last-sent snapshot
 * `prev` (mutated in place). Same serialized entry -> omitted.
 */
export function registryDiff(prev: Map<string, string>, next: CpSyncNode[]): CpSyncNode[] {
  const out: CpSyncNode[] = []
  for (const n of next) {
    const key = JSON.stringify(n)
    if (prev.get(n.node_id) !== key) {
      out.push(n)
      prev.set(n.node_id, key)
    }
  }
  return out
}

/**
 * Derive the peer's HTTP MCP base URL from its mesh ws URL:
 * ws://host:3470 -> http://host:3471 (defaults), otherwise the mesh port + 1
 * (matches the "mcp port sits right above the mesh port" convention used in
 * dev/dual-CP deployments). wss -> https.
 */
export function derivePeerMcpUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl)
    const scheme = u.protocol === 'wss:' ? 'https' : 'http'
    const port = u.port === '' ? (scheme === 'https' ? 443 : 80) : Number(u.port)
    const mcpPort = port === DEFAULT_HUB_MESH_PORT ? DEFAULT_HUB_MCP_PORT : port + 1
    return `${scheme}://${u.hostname}:${mcpPort}`
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// HubHa
// ---------------------------------------------------------------------------

/** Minimal WebSocket surface used by the outbound peer dialer. */
export interface WebSocketLike {
  readyState: number
  OPEN: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: ((err: unknown) => void) | null
}

/** HA phase (see module doc for the full state machine). */
export type HaPhase = 'nominating' | 'leader-leased' | 'read-only-no-quorum' | 'follower' | 'standalone'

export type HaWriteMode = 'readwrite' | 'readonly'

/** Structured write-refusal error returned when quorum is lost. */
export const QUORUM_LOST_ERROR = JSON.stringify({ code: 'QUORUM_LOST', message: 'no control-plane quorum: peer unreachable' })

interface PeerState {
  cpId: string
  /** ws URL we dialed ('' when only known inbound). */
  url: string
  /** Derived HTTP MCP base of the peer ('' when url unknown). */
  mcpUrl: string
  /** Inbound pipe: the peer dialed us and authenticated as cp:<cpId>. */
  inbound?: RpcPeer
  /** Outbound pipe: we dialed the peer. */
  outbound?: { peer: RpcPeer; url: string }
  connected: boolean
  lastSeen: number
  priority: number
  term: number
  leader: string
  leaderTerm: number
  /** Peer's own phase as last declared. */
  phase?: HaPhase
}

export interface HubHaDeps {
  cpId: string
  /** Election priority (smallest wins; default 0). */
  priority?: number
  /** Peer control-plane ws URLs to dial (empty = standalone). */
  peerUrls: string[]
  /** Our CP token used when authenticating to peers. */
  cpToken: string
  /** Server-side token lookup for inbound `cp:<id>` connections. */
  tokenLookup: (nodeId: string) => string | undefined
  /** Store for term/leader persistence (kv table). */
  store: DshHelmStore
  /** Local node registry (source of the local snapshot). */
  nodes: NodeRegistry
  /** Live node connections (direct-connection reporting). */
  connections: Map<string, NodeConnection>
  leaseMs: number
  /** Write-lease TTL: after this long without peer acks we lose quorum (45s). */
  leaseTtlMs?: number
  /** Write-lease renew interval for the leader (default 10s). */
  leaseRenewMs?: number
  /** Peer heartbeat interval (default 5s). */
  heartbeatMs?: number
  /** WebSocket factory (defaults to global WebSocket; injectable for tests). */
  wsFactory?: (url: string) => WebSocketLike
  /** fetch impl for leader write forwarding (injectable for tests). */
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

interface ElectRequest {
  term: number
  leader: string
  candidates: Candidate[]
}

interface ElectResponse {
  ok: boolean
  term: number
  leader: string
  phase: HaPhase
}

interface LeaseRenewRequest {
  term: number
  epoch: number
}

export class HubHa {
  private deps: HubHaDeps
  private cpId: string
  private priority: number
  private haRole: CpRole = 'standalone'
  private phase: HaPhase = 'standalone'
  private term = 1
  private leader = ''
  private leaderTerm = 0
  private peers = new Map<string, PeerState>()
  /** Merged overlay of nodes known via peers (metadata only, in-memory). */
  private registry = new Map<string, HaNode>()
  /** Number of quorum-loss (lease expiry / peer loss) events. */
  private failoverCount = 0
  private lastFailoverAt?: string
  /** Leader side: last time the peer acknowledged a lease renew. */
  private lastLeaseAckAt = 0
  /** Follower side: last time the (declared) leader was heard from. */
  private lastLeaderActivityAt = 0
  /** Lease epoch = term of the currently held lease (0 = none). */
  private leaseEpoch = 0
  private electInFlight = false
  /** Term of the most recent election this side WON (0 = none since boot).
   *  Distinguishes "freshly elected, waiting for the lease" (electedTerm ===
   *  term -> retry takeLease) from "restart recovery" (electedTerm < term ->
   *  must run a fresh election at term+1, per the recovery contract). */
  private electedTerm = 0
  private lastSent = new Map<string, string>()
  private outbound?: { peer: RpcPeer; url: string; cpId?: string; ws?: WebSocketLike }
  private heartbeatTimer?: NodeJS.Timeout
  private leaseTimer?: NodeJS.Timeout
  private failoverTimer?: NodeJS.Timeout
  private retryTimers = new Map<string, NodeJS.Timeout>()
  private backoffs = new Map<string, number>()
  private stopped = false
  private wsFactory: (url: string) => WebSocketLike
  private fetchImpl: typeof fetch
  private leaseTtlMs: number
  private leaseRenewMs: number
  private heartbeatMs: number
  private logFn?: (line: string) => void

  constructor(deps: HubHaDeps) {
    this.deps = deps
    this.cpId = deps.cpId
    this.priority = deps.priority ?? DEFAULT_CP_PRIORITY
    this.leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_CP_LEASE_TTL_MS
    this.leaseRenewMs = deps.leaseRenewMs ?? DEFAULT_CP_LEASE_RENEW_MS
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_CP_HEARTBEAT_MS
    this.wsFactory = deps.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.logFn = deps.log
    if (deps.peerUrls.length === 0) {
      // Standalone: fully backward-compatible single-CP mode. Nothing is
      // persisted, no timers, always readwrite (trivial "leader").
      this.haRole = 'standalone'
      this.phase = 'standalone'
      this.term = 1
      this.leader = this.cpId
      this.leaderTerm = 1
      return
    }
    // Multi-CP: restore persisted fencing state (term/leader). Quorum is NOT
    // granted at startup: we start read-only (nominating) and only become
    // readwrite after a confirmed lease. The leader slot from persistence
    // merely orients us (a peer may already hold a lease at a higher term).
    const persisted = this.readPersisted()
    this.term = persisted.term
    this.leader = persisted.leader || this.cpId
    this.leaderTerm = persisted.leaderTerm || this.term
    this.haRole = this.leader === this.cpId ? 'leader' : 'follower'
    this.phase = 'nominating'
  }

  get cpIdValue(): string {
    return this.cpId
  }

  /** Current HA role: 'leader' | 'follower' | 'standalone'. */
  role(): CpRole {
    return this.haRole
  }

  get termValue(): number {
    return this.term
  }

  get leaderId(): string {
    return this.leader
  }

  /** Current phase (see module doc). */
  phaseValue(): HaPhase {
    return this.phase
  }

  /** Whether THIS hub may execute writes directly (standalone or leased leader). */
  writeMode(): HaWriteMode {
    if (this.phase === 'leader-leased' || this.phase === 'standalone') return 'readwrite'
    return 'readonly'
  }

  /** 2/2 quorum: standalone trivially true; multi-CP requires a LIVE peer. */
  quorum(): boolean {
    if (this.deps.peerUrls.length === 0) return true
    return [...this.peers.values()].some((p) => this.peerConnected(p))
  }

  log(line: string): void {
    this.logFn?.(line)
  }

  /** Start peer dialing + timers (no-op in standalone mode). */
  start(): void {
    if (this.phase === 'standalone' || this.stopped) return
    this.stopped = false
    this.lastLeaderActivityAt = Date.now()
    for (const url of this.deps.peerUrls) {
      this.dial(url)
    }
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatMs)
    this.heartbeatTimer.unref?.()
    this.leaseTimer = setInterval(() => void this.renewLease(), this.leaseRenewMs)
    this.leaseTimer.unref?.()
    this.failoverTimer = setInterval(() => this.tick(), 1_000)
    this.failoverTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.leaseTimer) clearInterval(this.leaseTimer)
    if (this.failoverTimer) clearInterval(this.failoverTimer)
    for (const t of this.retryTimers.values()) clearTimeout(t)
    this.retryTimers.clear()
    this.outbound?.ws?.close()
    this.outbound = undefined
  }

  // ---- /cp-status payload ----

  statusPayload(): {
    cpId: string
    role: CpRole
    phase: HaPhase
    term: number
    leaderId: string
    writeMode: HaWriteMode
    quorum: boolean
    leaseEpoch: number
    peers: Array<{ cpId: string; url: string; connected: boolean; lastSeen: number; role: string }>
    syncOk: boolean
    failoverCount: number
    lastFailoverAt?: string
  } {
    return {
      cpId: this.cpId,
      role: this.haRole,
      phase: this.phase,
      term: this.term,
      leaderId: this.leader,
      writeMode: this.writeMode(),
      quorum: this.quorum(),
      leaseEpoch: this.leaseEpoch,
      peers: [...this.peers.values()].map((p) => ({
        cpId: p.cpId,
        url: p.url,
        connected: this.peerConnected(p),
        lastSeen: p.lastSeen,
        role: p.cpId === this.leader ? 'leader' : 'follower',
      })),
      syncOk: this.deps.peerUrls.length === 0 ? true : [...this.peers.values()].some((p) => this.peerConnected(p)),
      failoverCount: this.failoverCount,
      lastFailoverAt: this.lastFailoverAt,
    }
  }

  // ---- merged catalog (feeds ControlPlane.nodeCatalog / nodes_list) ----

  /** Merge local store rows with the remote overlay. */
  mergedCatalog(
    rows: Array<{ node: StoredNode; connection: boolean }>,
  ): Array<{ node: StoredNode; connection: boolean; derived?: boolean }> {
    const out: Array<{ node: StoredNode; connection: boolean; derived?: boolean }> = []
    const seen = new Set<string>()
    for (const { node, connection } of rows) {
      const o = this.registry.get(node.node_id)
      let mergedNode = node
      if (o && (o.last_seen ?? '') > (node.last_seen ?? '')) {
        mergedNode = { ...node, display_name: o.display_name ?? node.display_name, last_seen: o.last_seen ?? node.last_seen }
      }
      const conn = connection || (o ? this.nodeConnectedNow(o) : false)
      out.push({ node: mergedNode, connection: conn, derived: conn && !connection })
      seen.add(node.node_id)
    }
    for (const [id, o] of this.registry) {
      if (seen.has(id)) continue
      const conn = this.nodeConnectedNow(o)
      out.push({ node: this.toStoredNode(o), connection: conn, derived: conn })
    }
    return out
  }

  /** Whether a merged overlay node is currently connected (direct or derived). */
  private nodeConnectedNow(o: HaNode): boolean {
    if (this.deps.connections.has(o.node_id)) return true
    return o.connected && this.peerAlive(o.peer)
  }

  private toStoredNode(o: HaNode): StoredNode {
    return {
      node_id: o.node_id,
      display_name: o.display_name,
      platform: o.platform ?? { os: 'linux', arch: '', release: '', nodeVersion: '' },
      versions: o.versions ?? { agent: '', protocol: 0 },
      capabilities: o.capabilities ?? { sessions: false, serena: false, tunnel: false, presenceProvider: false, defaultNode: false },
      status: (['online', 'offline', 'blocked'] as const).includes(o.status as never) ? (o.status as 'online' | 'offline' | 'blocked') : 'offline',
      last_seen: o.last_seen,
      heartbeat_seq: 0,
      registered_at: o.last_seen ?? '',
      schema_version: NODE_PROTOCOL_VERSION,
    }
  }

  // ---- inbound peer registration (hub-cli wires this via mesh) ----

  /** Register the HA cp.* surface on a peer pipe. The INBOUND pipe is the
   *  HubConnection RpcPeer (hub-cli wires it); the OUTBOUND pipe is the raw
   *  RpcPeer we create in dial() — both must answer cp.sync/cp.heartbeat/
   *  cp.elect/cp.lease.renew, because a peer that only has ONE direction up
   *  (e.g. it dialed us but our dial to it failed) sends its requests over
   *  the pipe it has. Without handlers here those requests die with
   *  "method not found" and the pair can never converge. */
  private registerPeerHandlers(peer: RpcPeer, cpId: string): void {
    peer.on(CP_METHODS.SYNC, (p) => this.handleSyncRequest(p as CpPeerState, cpId))
    peer.on(CP_METHODS.HEARTBEAT, (p) => this.handleHeartbeatRequest(p as CpPeerState, cpId))
    peer.on(CP_METHODS.ELECT, (p) => this.handleElectRequest(p as ElectRequest))
    peer.on(CP_METHODS.LEASE_RENEW, (p) => this.handleLeaseRenew(p as LeaseRenewRequest))
  }

  /** A peer authenticated on an inbound connection (node_id `cp:<cpId>`). */
  registerInboundPeer(cpId: string, peer: RpcPeer): void {
    const st = this.peerState(cpId)
    st.inbound = peer
    st.connected = true
    st.lastSeen = Date.now()
    this.registerPeerHandlers(peer, cpId)
    this.log(`[ha] inbound peer connected: ${cpId}`)
  }

  /** A peer pipe closed (hub-cli wires this via mesh onClose). */
  onPeerDisconnected(cpId: string, pipe: 'inbound' | 'outbound'): void {
    const st = this.peers.get(cpId)
    if (!st) return
    if (pipe === 'inbound') st.inbound = undefined
    else st.outbound = undefined
    const wasConnected = st.connected
    st.connected = !!(st.inbound || st.outbound)
    if (wasConnected && !st.connected) {
      this.log(`[ha] peer ${cpId} disconnected (${pipe} pipe closed)`)
      this.onPeerLost()
    }
    if (this.outbound?.cpId === cpId) this.outbound = undefined
  }

  /** A peer became fully unreachable: no promotion, no term bump — just
   *  read-only until a fresh negotiated election grants a lease. */
  private onPeerLost(): void {
    this.log(`[ha] quorum lost: peer unreachable — demoting to read-only (no single-writer promotion)`)
    if (this.phase === 'leader-leased' || this.phase === 'follower' || this.phase === 'nominating') {
      this.phase = 'read-only-no-quorum'
      if (this.leaseEpoch !== 0) {
        this.failoverCount++
        this.lastFailoverAt = new Date().toISOString()
        this.leaseEpoch = 0
      }
      this.log(`[ha] phase -> read-only-no-quorum (failover #${this.failoverCount})`)
    }
  }

  private peerState(cpId: string): PeerState {
    let st = this.peers.get(cpId)
    if (!st) {
      st = { cpId, url: '', mcpUrl: '', connected: false, lastSeen: 0, priority: DEFAULT_CP_PRIORITY, term: 0, leader: '', leaderTerm: 0 }
      this.peers.set(cpId, st)
    }
    return st
  }

  /**
   * A peer counts as connected only while a pipe is attached AND the peer has
   * been heard from recently (heartbeat freshness). A half-open TCP socket
   * (peer process killed without orderly close) therefore stops counting as
   * quorum after ~3 heartbeats, instead of forever.
   */
  private peerConnected(st: PeerState | undefined): boolean {
    if (!st || !(st.inbound || st.outbound)) return false
    if (st.lastSeen === 0) return true
    return Date.now() - st.lastSeen < this.heartbeatMs * 3
  }

  private peerAlive(cpId: string): boolean {
    return this.peerConnected(this.peers.get(cpId))
  }

  private firstConnectedPeer(): PeerState | undefined {
    for (const st of this.peers.values()) {
      if (this.peerConnected(st)) return st
    }
    return undefined
  }

  private candidates(): Candidate[] {
    const out: Candidate[] = [{ cpId: this.cpId, priority: this.priority }]
    for (const st of this.peers.values()) {
      if (this.peerConnected(st)) out.push({ cpId: st.cpId, priority: st.priority })
    }
    return out
  }

  // ---- inbound RPC handlers ----

  private handleSyncRequest(state: CpPeerState, peerId: string): CpPeerState {
    this.onPeerState(state, state.from || peerId)
    return this.currentState()
  }

  private handleHeartbeatRequest(state: CpPeerState, peerId: string): { ok: true } {
    this.onPeerState(state, state.from || peerId)
    return { ok: true }
  }

  private handleElectRequest(req: ElectRequest): ElectResponse {
    // Validate against OUR view of the candidate set. When the proposer's
    // choice matches the deterministic winner we accept: both sides land the
    // same term+leader atomically. Otherwise refuse with our expectation.
    const theirDesired = req.leader
    if (theirDesired === this.cpId) {
      // The peer elects us (e.g. it only sees us while we see more peers).
      // Term/leader land on both sides, but the write lease is NOT granted
      // yet: we stay nominating (read-only) until the peer acks cp.lease.renew
      // (takeLease) — writes resume only on the confirmed lease.
      this.term = req.term
      this.electedTerm = req.term
      this.leader = this.cpId
      this.leaderTerm = req.term
      this.haRole = 'leader'
      this.persistState()
      this.phase = 'nominating'
      this.leaseEpoch = 0
      this.log(`[ha] peer elected us leader (term ${req.term}) — requesting lease (writes stay read-only until confirmed)`)
      void this.takeLease()
      return { ok: true, term: this.term, leader: this.cpId, phase: this.phase }
    }
    const myDesired = electLeader(this.candidates())
    if (myDesired === theirDesired) {
      this.term = req.term
      this.leader = req.leader
      this.leaderTerm = req.term
      this.haRole = 'follower'
      this.persistState()
      this.phase = 'follower'
      // The leader's lease is NOT confirmed yet (it still has to ack it via
      // cp.lease.renew); the follower reports leaseEpoch 0 until then.
      this.leaseEpoch = 0
      this.lastLeaderActivityAt = Date.now()
      this.log(`[ha] accepted election: leader ${req.leader} at term ${req.term}`)
      return { ok: true, term: this.term, leader: req.leader, phase: this.phase }
    }
    this.log(`[ha] election refused: peer proposes ${theirDesired}@${req.term}, we expect ${myDesired}`)
    return { ok: false, term: this.term, leader: myDesired, phase: this.phase }
  }

  private handleLeaseRenew(req: LeaseRenewRequest): { ok: boolean } {
    // Ack only when we are aligned with the lease-holding leader at the same
    // term (epoch == term). Acking also re-marks us 'follower' (quorum OK).
    if (req.term === this.term && req.epoch === this.term && req.term === this.leaderTerm && this.leader !== this.cpId) {
      this.lastLeaderActivityAt = Date.now()
      const wasFollower = this.phase === 'follower'
      this.phase = 'follower'
      // leaseEpoch mirrors the leader's confirmed lease epoch on BOTH sides,
      // so /cp-status reports one consistent number cluster-wide.
      this.leaseEpoch = req.epoch
      if (!wasFollower) this.log(`[ha] lease acknowledged from leader ${this.leader}@term ${req.term} — quorum OK, follower`)
      return { ok: true }
    }
    return { ok: false }
  }

  /** Apply a peer's declared state: merge registry, align term/leader, react
   *  to phase changes. Never grants write access by itself. */
  onPeerState(state: CpPeerState, peerId: string): void {
    const st = this.peerState(peerId)
    st.priority = state.priority
    st.term = state.term
    st.leader = state.leader
    st.leaderTerm = state.leaderTerm
    st.phase = state.phase as HaPhase | undefined
    st.lastSeen = Date.now()
    st.connected = !!(st.inbound || st.outbound)
    if (state.from) {
      const byFrom = this.peers.get(state.from)
      if (byFrom && byFrom !== st) {
        // The payload's sender identity is authoritative; fold both pipes.
        byFrom.priority = state.priority
        byFrom.term = state.term
        byFrom.leader = state.leader
        byFrom.leaderTerm = state.leaderTerm
        byFrom.phase = state.phase as HaPhase | undefined
        byFrom.lastSeen = Date.now()
        if (st.inbound && !byFrom.inbound) byFrom.inbound = st.inbound
        if (st.outbound && !byFrom.outbound) byFrom.outbound = st.outbound
        byFrom.connected = !!(byFrom.inbound || byFrom.outbound)
        this.peers.delete(peerId)
      }
    }
    mergeRegistryEntries(this.registry, state.registry ?? [], {
      directConnections: new Set(this.deps.connections.keys()),
      peerId: state.from || peerId,
    })
    const judgment = judgeTerm({ term: this.term, leader: this.leader }, { term: state.term, leader: state.leader })
    if (judgment === 'accept-peer') {
      this.term = state.term
      this.leader = state.leader
      this.leaderTerm = state.leaderTerm
      this.persistState()
      this.log(`[ha] aligned to peer term ${state.term} (leader ${state.leader})`)
      if (state.leader === this.cpId) {
        // The peer declares us leader (it already ran its side of the
        // election at this term): we need the lease from it to write.
        this.electedTerm = state.term
        this.haRole = 'leader'
        this.phase = 'nominating'
      } else if (state.phase === 'leader-leased' && state.leader === state.from) {
        this.haRole = 'follower'
        this.phase = 'follower'
        this.leaseEpoch = state.term
        this.lastLeaderActivityAt = Date.now()
      } else {
        this.haRole = 'follower'
        this.phase = 'read-only-no-quorum'
      }
    } else if (judgment === 'split-brain') {
      this.log(
        `[ha] split-brain: local (term ${this.term}, leader ${this.leader}) vs peer ${state.from} (term ${state.term}, leader ${state.leader}) — bumping term and re-electing`,
      )
      this.term += 1
      this.persistState()
      this.phase = 'read-only-no-quorum'
    } else {
      if (state.from === this.leader || (state.leader === this.leader && state.leaderTerm >= this.leaderTerm)) {
        this.lastLeaderActivityAt = Date.now()
      }
      if (this.leader !== this.cpId && state.leader === this.leader && state.phase === 'leader-leased' && this.phase !== 'follower') {
        this.haRole = 'follower'
        this.phase = 'follower'
        this.leaseEpoch = state.term
      }
    }
  }

  // ---- election / lease (2/2 quorum) ----

  /** Periodic state check (1s): lease expiry, leader liveness, election retry. */
  private tick(): void {
    if (this.stopped || this.phase === 'standalone') return
    const now = Date.now()
    if (this.phase === 'leader-leased') {
      if (now - this.lastLeaseAckAt > this.leaseTtlMs) {
        this.log(`[ha] lease not renewed for ${Math.round((now - this.lastLeaseAckAt) / 1000)}s (>= ${this.leaseTtlMs}ms) — quorum lost`)
        this.loseQuorum()
      }
      return
    }
    if (this.phase === 'follower') {
      if (now - this.lastLeaderActivityAt > this.leaseTtlMs) {
        this.log(`[ha] leader ${this.leader} silent for ${Math.round((now - this.lastLeaderActivityAt) / 1000)}s (>= ${this.leaseTtlMs}ms) — read-only, NO self-promotion`)
        this.phase = 'read-only-no-quorum'
        this.leaseEpoch = 0
      }
      return
    }
    // nominating / read-only-no-quorum: once the peer is back, run a fresh
    // election. Only the deterministic winner proposes; it stays read-only
    // until the peer confirms the term AND acks the write lease.
    if (this.phase === 'nominating' && this.haRole === 'leader') {
      if (this.electedTerm === this.term && !this.electInFlight) {
        // Freshly elected (or the peer re-confirmed us): only the lease is
        // missing — retry takeLease, never re-propose or self-promote.
        if (this.firstConnectedPeer()) void this.takeLease()
      } else if (!this.electInFlight && this.firstConnectedPeer()) {
        // Restart recovery: we booted as the persisted leader but have NOT
        // run an election this boot. Per the recovery contract, recovery
        // ALWAYS runs a fresh election (term+1, negotiated) before the lease
        // — no lease is ever resumed without a new term.
        this.log(`[ha] recovery: running a fresh election (electedTerm=${this.electedTerm} < term ${this.term})`)
        void this.startElection()
      }
      return
    }
    if (!this.electInFlight && this.firstConnectedPeer()) {
      const desired = electLeader(this.candidates())
      if (desired === this.cpId) {
        void this.startElection()
      } else if (this.leader !== desired && this.phase === 'read-only-no-quorum') {
        // Expected leader is our peer: align and wait for its elect/lease.
        this.leader = desired
        this.leaderTerm = this.term
        this.phase = 'nominating'
      }
    }
  }

  private loseQuorum(): void {
    this.phase = 'read-only-no-quorum'
    if (this.leaseEpoch !== 0) {
      this.failoverCount++
      this.lastFailoverAt = new Date().toISOString()
      this.leaseEpoch = 0
    }
    this.log(`[ha] phase -> read-only-no-quorum (failover #${this.failoverCount})`)
  }

  /** Propose a fresh election at max(terms)+1. Only the deterministic winner
   *  calls this; the peer ack lands the term on both sides, then we take the
   *  lease (peer ack of cp.lease.renew completes the transition). */
  private async startElection(): Promise<void> {
    if (this.electInFlight) return
    const peer = this.firstConnectedPeer()
    if (!peer) return
    this.electInFlight = true
    this.phase = 'nominating'
    const proposedTerm = Math.max(this.term, peer.term) + 1
    const req: ElectRequest = { term: proposedTerm, leader: this.cpId, candidates: this.candidates() }
    this.log(`[ha] proposing election: leader=${this.cpId} term=${proposedTerm}`)
    try {
      const resp = (await this.rpcPeerFor(peer).request(CP_METHODS.ELECT, req, { timeoutMs: 10_000 })) as ElectResponse | undefined
      if (resp?.ok) {
        this.term = proposedTerm
        this.electedTerm = proposedTerm
        this.leader = this.cpId
        this.leaderTerm = proposedTerm
        this.haRole = 'leader'
        this.persistState()
        // The peer accepted the term/leader, but the write lease is not yet
        // confirmed: stay read-only (nominating) until takeLease()'s
        // cp.lease.renew is acked by the peer.
        this.phase = 'nominating'
        this.leaseEpoch = 0
        this.log(`[ha] elected leader (term ${proposedTerm}) — requesting lease (writes stay read-only until confirmed)`)
        await this.takeLease()
      } else if (resp?.leader && resp.leader !== this.cpId) {
        this.term = Math.max(this.term, resp.term ?? 1)
        this.leader = resp.leader
        this.leaderTerm = resp.term ?? this.term
        this.haRole = 'follower'
        this.persistState()
        this.phase = resp.phase === 'leader-leased' ? 'follower' : 'read-only-no-quorum'
        if (this.phase === 'follower') this.lastLeaderActivityAt = Date.now()
        this.log(`[ha] election refused; following ${this.leader}@term ${this.term}`)
      } else {
        this.phase = 'read-only-no-quorum'
      }
    } catch (err) {
      this.log(`[ha] election failed: ${err instanceof Error ? err.message : err} — retry on next tick`)
      this.phase = 'read-only-no-quorum'
    }
    this.electInFlight = false
  }

  private rpcPeerFor(st: PeerState): RpcPeer {
    return st.outbound?.peer ?? st.inbound!
  }

  /** Leader: renew the write lease to the peer. Every ack refreshes
   *  lastLeaseAckAt; expiry demotes us (see tick). */
  private async renewLease(): Promise<void> {
    if (this.stopped || this.phase !== 'leader-leased') return
    const peer = this.firstConnectedPeer()
    if (!peer) return
    const req: LeaseRenewRequest = { term: this.term, epoch: this.leaseEpoch }
    try {
      const resp = (await this.rpcPeerFor(peer).request(CP_METHODS.LEASE_RENEW, req, { timeoutMs: 10_000 })) as { ok?: boolean } | undefined
      if (resp?.ok) {
        this.lastLeaseAckAt = Date.now()
      } else {
        this.log(`[ha] lease renew refused by peer (term ${req.term})`)
      }
    } catch {
      this.log('[ha] lease renew failed (peer unreachable) — expiry will demote')
    }
  }

  /** Leader side: obtain the write lease. The transition to 'leader-leased'
   *  (readwrite) happens ONLY when the peer acks cp.lease.renew at our term —
   *  writes never resume on an unconfirmed lease ("new leader takes the lease,
   *  both sides confirm, THEN writes resume"). Any refusal/failure keeps us
   *  nominating (read-only); the 1s tick retries. */
  private async takeLease(): Promise<void> {
    if (this.stopped || this.haRole !== 'leader' || this.phase === 'leader-leased') return
    const peer = this.firstConnectedPeer()
    if (!peer) return
    const req: LeaseRenewRequest = { term: this.term, epoch: this.term }
    try {
      const resp = (await this.rpcPeerFor(peer).request(CP_METHODS.LEASE_RENEW, req, { timeoutMs: 10_000 })) as { ok?: boolean } | undefined
      if (resp?.ok) {
        this.phase = 'leader-leased'
        this.leaseEpoch = this.term
        this.lastLeaseAckAt = Date.now()
        this.log(`[ha] lease confirmed by peer — phase -> leader-leased (term ${this.term}, readwrite)`)
      } else {
        this.log(`[ha] lease refused by peer (term ${this.term}) — staying read-only`)
      }
    } catch {
      this.log('[ha] lease request failed (peer unreachable) — staying read-only')
    }
  }

  // ---- term persistence (store kv) ----

  private readPersisted(): { term: number; leader: string; leaderTerm: number } {
    try {
      const db = this.deps.store.db
      const get = (k: string): string | undefined =>
        (db.prepare(`SELECT value FROM kv WHERE key = ?`).get(k) as { value?: string } | undefined)?.value
      const term = Number(get(CP_TERM_KV.TERM) ?? '1')
      const leader = get(CP_TERM_KV.LEADER) ?? ''
      const leaderTerm = Number(get(CP_TERM_KV.LEADER_TERM) ?? '0')
      return { term: Number.isFinite(term) && term >= 1 ? term : 1, leader, leaderTerm: Number.isFinite(leaderTerm) ? leaderTerm : 0 }
    } catch (err) {
      this.log(`[ha] read persisted term failed: ${err instanceof Error ? err.message : err} — starting at term 1`)
      return { term: 1, leader: '', leaderTerm: 0 }
    }
  }

  private persistState(): void {
    try {
      const db = this.deps.store.db
      const set = (k: string, v: string): void => {
        db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run(k, v)
      }
      set(CP_TERM_KV.TERM, String(this.term))
      set(CP_TERM_KV.LEADER, this.leader)
      set(CP_TERM_KV.LEADER_TERM, String(this.leaderTerm))
    } catch (err) {
      this.log(`[ha] persist term failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // ---- local registry snapshot ----

  private localRegistry(): CpSyncNode[] {
    const out: CpSyncNode[] = []
    for (const n of this.deps.nodes.list()) {
      out.push({
        node_id: n.node_id,
        display_name: n.display_name,
        connected: this.deps.connections.has(n.node_id),
        last_seen: n.last_seen,
        status: n.status,
        platform: n.platform,
        versions: n.versions,
        capabilities: n.capabilities,
        health: this.deps.nodes.healthReport(n.node_id),
      })
    }
    return out
  }

  private currentState(): CpPeerState {
    return {
      from: this.cpId,
      priority: this.priority,
      term: this.term,
      leader: this.leader,
      leaderTerm: this.leaderTerm,
      phase: this.phase,
      leaseEpoch: this.leaseEpoch,
      registry: this.localRegistry(),
    }
  }

  // ---- outbound dialing ----

  private dial(url: string): void {
    if (this.stopped) return
    let ws: WebSocketLike
    try {
      ws = this.wsFactory(url)
    } catch (err) {
      this.log(`[ha] ws factory failed for ${url}: ${err instanceof Error ? err.message : err}`)
      this.scheduleDialRetry(url)
      return
    }
    this.log(`[ha] connecting to control plane peer ${url}`)
    const sender: MessagePeer = {
      send: (m: WireMessage) => {
        try {
          ws.send(JSON.stringify(m))
        } catch {
          /* socket gone */
        }
      },
    }
    const handshake = new HandshakeClient(
      sender,
      `${CP_NODE_PREFIX}${this.cpId}`,
      this.deps.cpToken,
      NODE_PROTOCOL_VERSION,
      {
        onOutcome: (outcome) => {
          if (outcome.ok) {
            this.backoffs.delete(url)
            const peer: MessagePeer = {
              send: (m) => {
                try {
                  ws.send(JSON.stringify({ type: 'rpc', v: NODE_PROTOCOL_VERSION, body: m } as WireMessage))
                } catch {
                  /* ignore */
                }
              },
            }
            const rpc = new RpcPeer(peer, (l) => this.log(`[ha peer ${url}] ${l}`))
            // Requests arriving over OUR outbound pipe (the peer had only this
            // pipe up) must be answered too — see registerPeerHandlers.
            this.registerPeerHandlers(rpc, '')
            this.outbound = { peer: rpc, url, ws }
            this.log(`[ha] outbound peer connected: ${url}`)
            void this.sendFullSync(url)
          } else {
            this.log(`[ha] peer handshake failed (${url}): ${outcome.message}`)
            this.scheduleDialRetry(url)
          }
        },
      },
    )
    ws.onopen = () => handshake.start()
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WireMessage
        if (msg.type === 'rpc') {
          this.outbound?.peer.dispatchPublic(msg.body)
        } else {
          handshake.inbound(msg)
        }
      } catch {
        this.log('[ha] dropping unparseable peer frame')
      }
    }
    ws.onclose = () => {
      if (this.outbound && this.outbound.url === url) {
        const cpId = this.outbound.cpId
        this.outbound = undefined
        if (cpId) this.onPeerDisconnected(cpId, 'outbound')
      }
      this.scheduleDialRetry(url)
    }
    ws.onerror = (err) => {
      this.log(`[ha] peer ws error (${url}): ${err instanceof Error ? err.message : String(err)}`)
      // undici does not always fire 'close' after a failed connect; retry here
      // too (scheduleDialRetry is idempotent per url).
      this.scheduleDialRetry(url)
    }
  }

  private scheduleDialRetry(url: string): void {
    if (this.stopped) return
    if (this.retryTimers.has(url)) return
    const backoff = this.backoffs.get(url) ?? RECONNECT_BACKOFF_BASE_MS
    this.backoffs.set(url, Math.min(backoff * 2, RECONNECT_BACKOFF_MAX_MS))
    const delay = backoff + Math.random() * 500
    this.log(`[ha] redial ${url} in ${Math.round(delay)}ms`)
    const t = setTimeout(() => {
      this.retryTimers.delete(url)
      this.dial(url)
    }, delay)
    t.unref?.()
    this.retryTimers.set(url, t)
  }

  /** Full registry + leader state push on connect (both directions). */
  private async sendFullSync(url: string): Promise<void> {
    const out = this.outbound
    if (!out) return
    const full = this.currentState()
    this.lastSent = new Map(full.registry.map((n) => [n.node_id, JSON.stringify(n)]))
    try {
      const resp = (await out.peer.request(CP_METHODS.SYNC, full, { timeoutMs: 10_000 })) as CpPeerState | undefined
      if (resp?.from) {
        const st = this.peerState(resp.from)
        st.url = url
        st.mcpUrl = derivePeerMcpUrl(url)
        st.outbound = { peer: out.peer, url }
        st.connected = true
        st.lastSeen = Date.now()
        out.cpId = resp.from
        if (this.outbound?.url === url) this.outbound.cpId = resp.from
        this.log(`[ha] peer ${resp.from} identified via ${url}; full sync exchanged`)
        this.onPeerState(resp, resp.from)
      }
    } catch (err) {
      this.log(`[ha] full sync with ${url} failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  /** Heartbeat: push leader state + registry diff to peers (5s). */
  private async heartbeat(): Promise<void> {
    if (this.stopped || this.phase === 'standalone') return
    const diff = registryDiff(this.lastSent, this.localRegistry())
    const state: CpPeerState = {
      from: this.cpId,
      priority: this.priority,
      term: this.term,
      leader: this.leader,
      leaderTerm: this.leaderTerm,
      phase: this.phase,
      leaseEpoch: this.leaseEpoch,
      registry: diff,
    }
    if (this.outbound?.peer) {
      try {
        await this.outbound.peer.request(CP_METHODS.HEARTBEAT, state, { timeoutMs: 10_000 })
      } catch {
        /* pipe will be re-established by the dial loop */
      }
      return
    }
    // No outbound pipe (e.g. the peer dialed us first): push over inbound pipes.
    for (const st of this.peers.values()) {
      if (!st.inbound) continue
      try {
        await st.inbound.request(CP_METHODS.HEARTBEAT, state, { timeoutMs: 10_000 })
      } catch {
        /* transient */
      }
    }
  }

  // ---- write path: leader execution vs forwarding vs quorum refusal ----

  /**
   * Entry point for WRITE_TOOLS on this hub (invoked by the MCP server only
   * when writeMode() === 'readonly').
   * - follower with healthy quorum: forward to the leased leader's HTTP MCP.
   * - anything else (no quorum / no leader): structured QUORUM_LOST error.
   */
  async handleWrite(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (this.phase === 'follower') {
      return this.forwardWrite(name, args)
    }
    this.log(`[ha] write ${name} refused: writeMode=readonly phase=${this.phase} (quorum=${this.quorum()})`)
    return this.quorumLostResult()
  }

  /** Follower -> leader Streamable HTTP MCP call. Any failure (leader down,
   *  no live peer, HTTP error) yields the structured QUORUM_LOST error. */
  async forwardWrite(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const peer = this.peers.get(this.leader)
    if (!peer || !peer.connected || !peer.mcpUrl) {
      this.log(`[ha] cannot forward ${name}: leader ${this.leader} has no live peer connection`)
      return this.quorumLostResult()
    }
    this.log(`[ha] follower: forwarding ${name} to leader ${this.leader} (${peer.mcpUrl})`)
    try {
      return await mcpCallLeader(peer.mcpUrl, name, args, this.fetchImpl)
    } catch (err) {
      this.log(`[ha] forward ${name} to ${peer.mcpUrl} failed: ${err instanceof Error ? err.message : err}`)
      return this.quorumLostResult()
    }
  }

  private quorumLostResult(): McpCallResult {
    return { content: [{ type: 'text', text: QUORUM_LOST_ERROR }], isError: true }
  }
}

/**
 * Streamable-HTTP MCP client call against a leader hub (used by forwardWrite).
 */
export async function mcpCallLeader(
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<McpCallResult> {
  const init = await fetchImpl(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-helm-hub-ha', version: '0.1.0' } },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!init.ok) throw new Error(`leader mcp initialize http ${init.status}`)
  const sessionId = init.headers.get('mcp-session-id')
  if (!sessionId) throw new Error('leader mcp initialize: no mcp-session-id header')
  const call = await fetchImpl(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!call.ok) throw new Error(`leader mcp tools/call http ${call.status}`)
  const body = (await call.json()) as { result?: McpCallResult; error?: { message?: string } } | undefined
  if (!body) throw new Error('leader mcp: empty response')
  if (body.error) throw new Error(`leader mcp error: ${body.error.message ?? 'unknown'}`)
  if (!body.result) throw new Error('leader mcp: empty result')
  return body.result
}
