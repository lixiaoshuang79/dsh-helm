import { describe, expect, it } from 'vitest'
import { parseHubArgs, tokenLookupFromEnv, startHub } from '../src/hub-cli.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('hub-cli', () => {
  it('parses hub args', () => {
    const opts = parseHubArgs(['--mesh-port', '3479', '--mcp-port', '3480', '--hub-id', 'hub-x', '--store', '/tmp/x.sqlite3', '--default-node', 'n-1'])
    expect(opts.meshPort).toBe(3479)
    expect(opts.mcpPort).toBe(3480)
    expect(opts.hubId).toBe('hub-x')
    expect(opts.storeFile).toBe('/tmp/x.sqlite3')
    expect(opts.defaultNodeId).toBe('n-1')
  })

  it('rejects unknown options', () => {
    expect(() => parseHubArgs(['--bogus', '1'])).toThrow(/unknown hub option/)
  })

  it('parses DSH_HELM_TOKEN env into lookup', () => {
    const lookup = tokenLookupFromEnv('n-a=tok-a,n-b=tok-b')
    expect(lookup('n-a')).toBe('tok-a')
    expect(lookup('n-b')).toBe('tok-b')
    expect(lookup('n-c')).toBeUndefined()
    expect(tokenLookupFromEnv(undefined)('x')).toBeUndefined()
  })

  it('starts a real hub: mesh + MCP + healthz (smoke)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-hubcli-'))
    const storeFile = join(dir, 'store.sqlite3')
    const opts = parseHubArgs(['--mesh-port', '0', '--mcp-port', '0', '--store', storeFile, '--default-node', 'n-a'])
    // port 0 -> OS-assigned; resolve actual after start
    const logs: string[] = []
    const hub = startHub(opts, (l) => logs.push(l))
    try {
      // mesh port 0: find actual port from ws server address (async bind)
      let meshAddr: { port: number } | null = null
      for (let i = 0; i < 20 && !meshAddr; i++) {
        await new Promise((r) => setTimeout(r, 25))
        meshAddr = (hub.mesh as unknown as { wss: { address: () => { port: number } | null } }).wss.address()
      }
      expect(meshAddr?.port).toBeGreaterThan(0)
      // MCP healthz via actual port
      const mcpAddr = hub.mcpHttp.address()
      const port = typeof mcpAddr === 'object' && mcpAddr ? mcpAddr.port : 0
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; nodes: number }
      expect(body.ok).toBe(true)
      expect(body.nodes).toBe(0)
      // tools/list over MCP JSON-RPC
      const tools = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      expect(tools.status).toBe(200)
      const toolsBody = (await tools.json()) as { result?: { tools?: unknown[] } }
      expect(toolsBody.result?.tools).toHaveLength(24)
    } finally {
      await hub.mesh.close()
      hub.mcpHttp.close()
      hub.cp.stop()
      hub.store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves loopback pairing endpoints /pair/new and /pair/list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-hubcli-pair-'))
    const storeFile = join(dir, 'store.sqlite3')
    const opts = parseHubArgs(['--mesh-port', '0', '--mcp-port', '0', '--store', storeFile])
    const hub = startHub(opts, () => {})
    try {
      // wait for the MCP http listener (listen is async in startHub)
      let mcpAddr: { port: number } | null = null
      for (let i = 0; i < 20 && !mcpAddr; i++) {
        await new Promise((r) => setTimeout(r, 25))
        mcpAddr = hub.mcpHttp.address()
      }
      const port = mcpAddr?.port ?? 0
      expect(port).toBeGreaterThan(0)

      const created = await fetch(`http://127.0.0.1:${port}/pair/new`)
      expect(created.status).toBe(200)
      const pair = (await created.json()) as { code: string; expiresAt: string }
      expect(pair.code).toMatch(/^dshp-[0-9a-z]{20}$/)
      expect(Date.parse(pair.expiresAt)).toBeGreaterThan(Date.now())

      // the store must not hold the plaintext code
      const rows = hub.store.db.prepare(`SELECT code_hash FROM enrollment_codes`).all() as Array<{ code_hash: string }>
      expect(JSON.stringify(rows)).not.toContain(pair.code)

      const listed = await fetch(`http://127.0.0.1:${port}/pair/list`)
      expect(listed.status).toBe(200)
      const list = (await listed.json()) as { codes: Array<{ codeHashPrefix: string; status: string }> }
      expect(list.codes).toHaveLength(1)
      expect(list.codes[0]!.codeHashPrefix).toHaveLength(8)
      expect(JSON.stringify(list)).not.toContain(pair.code)
    } finally {
      await hub.mesh.close()
      hub.mcpHttp.close()
      hub.cp.stop()
      hub.store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})