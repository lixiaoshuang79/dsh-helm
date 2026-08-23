import { describe, expect, it } from 'vitest'
import { loadConfig, defaultConfigDir } from '../src/config.js'
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('node config', () => {
  it('generates node_id + token on first run and persists 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-cfg-'))
    try {
      const cfg = loadConfig(dir)
      expect(cfg.node_id).toMatch(/^[0-9a-f-]{36}$/) // UUID
      expect(cfg.token.length).toBeGreaterThanOrEqual(32)
      expect(cfg.display_name.length).toBeGreaterThan(0)
      const mode = statSync(join(dir, 'node.json')).mode & 0o777
      expect(mode).toBe(0o600)
      // second load: same identity (stable across restarts)
      const cfg2 = loadConfig(dir)
      expect(cfg2.node_id).toBe(cfg.node_id)
      expect(cfg2.token).toBe(cfg.token)
      // defaults
      expect(cfg.local_mcp_url).toBe('http://127.0.0.1:3457/mcp')
      expect(cfg.local_probe_ms).toBeGreaterThan(0)
      expect(cfg.reconcile_ms).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('merges existing config file fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-cfg-'))
    try {
      const first = loadConfig(dir)
      // rewrite with custom hub_url
      writeFileSync(join(dir, 'node.json'), JSON.stringify({ ...first, hub_url: 'wss://hub.example.com/' }))
      const cfg = loadConfig(dir)
      expect(cfg.hub_url).toBe('wss://hub.example.com/')
      expect(cfg.node_id).toBe(first.node_id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('default dir is ~/.dsh/helm', () => {
    expect(defaultConfigDir()).toBe(join(process.env.HOME ?? '.', '.dsh', 'helm'))
  })

  it('token is not derivable from node_id (random per install)', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'dsh-helm-cfg-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'dsh-helm-cfg-b-'))
    try {
      const a = loadConfig(dirA)
      const b = loadConfig(dirB)
      expect(a.token).not.toBe(b.token)
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('file survives re-read as JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-helm-cfg-'))
    try {
      loadConfig(dir)
      const raw = JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8'))
      expect(typeof raw.node_id).toBe('string')
      expect(typeof raw.token).toBe('string')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})