/**
 * Phase 2 acceptance: dual control-plane HA over REAL WebSockets on loopback.
 *
 * Two full hubs (startHub) with the 2/2-quorum write lease:
 *   - exactly ONE leader-leased (readwrite), the other follower (readonly)
 *   - follower WRITE_TOOLS forward to the leader (single-writer fencing)
 *   - leader loses the peer -> immediate read-only + structured QUORUM_LOST
 *     on writes; reads keep working
 *   - peer restarts -> full sync -> fresh negotiated election (term+1) ->
 *     confirmed lease -> writes resume (no side ever self-promotes)
 *
 * Ports: mesh 13970/13972, mcp 13971/13973 (mcp = mesh + 1, matching
 * derivePeerMcpUrl). Stores are temp files; nothing touches ~/.dsh.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeInfo } from '../../packages/protocol/src/index.js'
import { DshHelmStore, NodeRegistry, RegistrationTokenStore } from '../../packages/store/src/index.js'
import { startHub } from '../../packages/hub/src/hub-cli.js'

const MESH_A = 13970
const MESH_B = 13972
const MCP_A = 13971
const MCP_B = 13973
const TOK_A = 'cp-token-a'
const TOK_B = 'cp-token-b'
const NODE_1 = '11111111-2222-3333-4444-555555555555'

function makeNodeInfo(id: string, name: string): NodeInfo {
  return {
    node_id: id,
    display_name: name,
    platform: { os: 'darwin', arch: 'arm64', release: 'test', nodeVersion: 'v22' },
    versions: { agent: '0.1.0-test', protocol: 1 },
    capabilities: { sessions: true, serena: false, tunnel: false, presenceProvider: false, defaultNode: false },
  }
}

interface HubUnderTest {
  hub: ReturnType<typeof startHub>
  logs: string[]
  mcpPort: number
  dir: string
}

function hubArgs(overrides: Partial<Parameters<typeof startHub>[0]> & { storeFile: string }): Parameters<typeof startHub>[0] {
  return {
    meshPort: 0,
    mcpPort: 0,
    storeFile: overrides.storeFile,
    hubId: 'hub',
    defaultNodeId: '',
    bind: '127.0.0.1',
    heartbeatMs: 15_000,
    leaseMs: 45_000,
    cpPeers: [],
    cpId: '',
    cpToken: '',
    cpPriority: 0,
    cpFailoverMs: 1_500,
    leaseRenewMs: 500,
    ...overrides,
  }
}

async function startHubAt(args: Parameters<typeof startHub>[0], dir: string): Promise<HubUnderTest> {
  const logs: string[] = []
  const hub = startHub(args, (l) => logs.push(l))
  // wait for the MCP http listener (listen is async in startHub)
  let addr: { port: number } | null = null
  for (let i = 0; i < 40 && !addr; i++) {
    await new Promise((r) => setTimeout(r, 25))
    addr = hub.mcpHttp.address()
  }
  return { hub, logs, mcpPort: addr?.port ?? 0, dir }
}

async function cpStatus(port: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/cp-status`)
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('dual control-plane HA (real WebSockets, 2/2 quorum write lease)', () => {
  it('one leased leader / one follower -> quorum loss refuses writes -> restart recovers writes', async () => {
    // seed node + peer tokens BEFORE starting the hubs (token lookup = env +
    // registration_tokens; peers authenticate as `cp:<id>`)
    const dirA = mkdtempSync(join(tmpdir(), 'dsh-helm-dualcp-A-'))
    const dirB = mkdtempSync(join(tmpdir(), 'dsh-helm-dualcp-B-'))
    const storeFileA = join(dirA, 'store.sqlite3')
    const storeFileB = join(dirB, 'store.sqlite3')
    const seedA = new DshHelmStore({ file: storeFileA })
    new NodeRegistry(seedA.db).register(makeNodeInfo(NODE_1, 'seed-node'))
    new RegistrationTokenStore(seedA.db).upsert('cp:cp-b', TOK_B, new Date().toISOString())
    seedA.close()
    const seedB = new DshHelmStore({ file: storeFileB })
    new RegistrationTokenStore(seedB.db).upsert('cp:cp-a', TOK_A, new Date().toISOString())
    seedB.close()

    const A = await startHubAt(
      hubArgs({ meshPort: MESH_A, mcpPort: MCP_A, storeFile: storeFileA, hubId: 'hub-a', cpId: 'cp-a', cpToken: TOK_A, cpPriority: 1, cpPeers: [`ws://127.0.0.1:${MESH_B}`] }),
      dirA,
    )
    const B = await startHubAt(
      hubArgs({ meshPort: MESH_B, mcpPort: MCP_B, storeFile: storeFileB, hubId: 'hub-b', cpId: 'cp-b', cpToken: TOK_B, cpPriority: 2, cpPeers: [`ws://127.0.0.1:${MESH_A}`] }),
      dirB,
    )
    let B2: HubUnderTest | undefined
    try {
      expect(A.mcpPort).toBeGreaterThan(0)
      expect(B.mcpPort).toBeGreaterThan(0)

      // ① convergence: exactly one leased leader (cp-a: lower priority),
      //    the other a quorum-healthy follower; same term; leaseEpoch == term
      await waitFor(async () => {
        const a = await cpStatus(A.mcpPort)
        const b = await cpStatus(B.mcpPort)
        return (
          a.phase === 'leader-leased' && a.writeMode === 'readwrite' && a.quorum === true &&
          b.phase === 'follower' && b.writeMode === 'readonly' && b.quorum === true &&
          a.term === b.term && a.leaseEpoch === a.term
        )
      }, 15_000, 'dual-CP convergence (leader cp-a leased, cp-b follower)')
      const convergedA = await cpStatus(A.mcpPort)
      const convergedB = await cpStatus(B.mcpPort)
      expect(convergedA.cpId).toBe('cp-a')
      expect(convergedB.leaderId).toBe('cp-a')
      expect(convergedA.leaseEpoch).toBeGreaterThan(0)

      // ② follower write path: WRITE_TOOLS on cp-b forward to cp-a and
      //    execute THERE (single-writer fencing)
      const claim = await B.hub.mcp.callTool({ name: 'presence_claim', arguments: { node_id: NODE_1 } })
      expect(claim.isError).toBeFalsy()
      expect(JSON.parse(claim.content![0]!.text)).toMatchObject({ claimed: true, node_id: NODE_1 })
      expect(B.logs.join('\n')).toContain(`forwarding presence_claim to leader cp-a`)

      // ③ kill cp-b -> cp-a loses quorum: immediate read-only, QUORUM_LOST
      B.hub.ha.stop()
      await B.hub.mesh.close()
      B.hub.mcpHttp.close()
      B.hub.cp.stop()
      B.hub.store.close()
      await waitFor(async () => {
        const a = await cpStatus(A.mcpPort)
        return a.phase === 'read-only-no-quorum' && a.writeMode === 'readonly' && a.quorum === false
      }, 10_000, 'cp-a demotion to read-only-no-quorum after peer loss')

      const denied = await A.hub.mcp.callTool({ name: 'presence_claim', arguments: { node_id: NODE_1 } })
      expect(denied.isError).toBe(true)
      expect(denied.content![0]!.text).toContain('QUORUM_LOST')
      expect(denied.content![0]!.text).toContain('peer unreachable')
      // reads keep working without quorum
      const reads = await A.hub.mcp.callTool({ name: 'nodes_list' })
      expect(reads.isError).toBeFalsy()
      expect((JSON.parse(reads.content![0]!.text) as { nodes: unknown[] }).nodes.length).toBeGreaterThanOrEqual(1)

      // ④ restart cp-b (same store file: persisted term) -> full sync ->
      //    fresh election (term+1) -> confirmed lease -> writes resume
      const termBefore = (await cpStatus(A.mcpPort)).term as number
      B2 = await startHubAt(
        hubArgs({ meshPort: MESH_B, mcpPort: MCP_B, storeFile: storeFileB, hubId: 'hub-b', cpId: 'cp-b', cpToken: TOK_B, cpPriority: 2, cpPeers: [`ws://127.0.0.1:${MESH_A}`] }),
        dirB,
      )
      await waitFor(async () => {
        const a = await cpStatus(A.mcpPort)
        const b = await cpStatus(B2!.mcpPort)
        return (
          a.phase === 'leader-leased' && a.writeMode === 'readwrite' && a.term > termBefore &&
          b.phase === 'follower' && b.writeMode === 'readonly' && b.quorum === true
        )
      }, 15_000, 'post-restart recovery (re-election + lease on cp-a)')
      const recovered = await cpStatus(A.mcpPort)
      expect(recovered.leaseEpoch).toBe(recovered.term)

      // follower write path works again after recovery
      const claim2 = await B2!.hub.mcp.callTool({ name: 'presence_claim', arguments: { node_id: NODE_1 } })
      expect(JSON.parse(claim2.content![0]!.text)).toMatchObject({ claimed: true })
      expect(B2!.logs.join('\n')).toContain('forwarding presence_claim to leader cp-a')
    } finally {
      A.hub.ha.stop()
      await A.hub.mesh.close()
      A.hub.mcpHttp.close()
      A.hub.cp.stop()
      A.hub.store.close()
      if (B2) {
        B2.hub.ha.stop()
        await B2.hub.mesh.close()
        B2.hub.mcpHttp.close()
        B2.hub.cp.stop()
        B2.hub.store.close()
      }
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})
