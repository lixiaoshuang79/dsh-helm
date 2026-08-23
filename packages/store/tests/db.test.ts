import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshHelmStore, readSchemaVersion, migrate } from '../src/db.js'
import { STORE_SCHEMA_VERSION } from '@dsh-helm/protocol'

function tmpDb(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-helm-${name}-`))
  const file = join(dir, 'store.sqlite3')
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('store db', () => {
  it('opens in-memory db at target schema version', () => {
    const store = new DshHelmStore({ file: ':memory:' })
    expect(readSchemaVersion(store.db)).toBe(STORE_SCHEMA_VERSION)
    store.close()
  })

  it('creates all v1 tables', () => {
    const store = new DshHelmStore({ file: ':memory:' })
    const tables = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: { name: string }) => r.name)
    for (const t of ['kv', 'nodes', 'presence_leases', 'sessions', 'workspaces', 'audit', 'route_log']) {
      expect(tables).toContain(t)
    }
    store.close()
  })

  it('persists across reopen and keeps schema version', () => {
    const { file, cleanup } = tmpDb('persist')
    try {
      {
        const s = new DshHelmStore({ file })
        s.db.prepare(`INSERT INTO kv (key, value) VALUES ('test', 'x')`).run()
        s.close()
      }
      const s2 = new DshHelmStore({ file })
      expect(readSchemaVersion(s2.db)).toBe(STORE_SCHEMA_VERSION)
      expect((s2.db.prepare(`SELECT value FROM kv WHERE key='test'`).get() as { value: string }).value).toBe('x')
      s2.close()
    } finally {
      cleanup()
    }
  })

  it('enables WAL journal mode on file stores', () => {
    const { file, cleanup } = tmpDb('wal')
    try {
      const s = new DshHelmStore({ file })
      const row = s.db.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string }
      expect(row.journal_mode.toLowerCase()).toBe('wal')
      s.close()
    } finally {
      cleanup()
    }
  })

  it('migrates an empty db from version 0 to target', () => {
    const { file, cleanup } = tmpDb('migrate')
    try {
      const s = new DshHelmStore({ file, targetVersion: STORE_SCHEMA_VERSION })
      expect(readSchemaVersion(s.db)).toBe(STORE_SCHEMA_VERSION)
      s.close()
    } finally {
      cleanup()
    }
  })

  it('rejects a database with a newer schema version', () => {
    const { file, cleanup } = tmpDb('newer')
    try {
      const s = new DshHelmStore({ file, targetVersion: 1 })
      s.db.prepare(`UPDATE kv SET value = '99' WHERE key = 'schema_version'`).run()
      s.close()
      expect(() => new DshHelmStore({ file, targetVersion: 1 })).toThrow(/newer than supported/)
    } finally {
      cleanup()
    }
  })

  it('migrate() is idempotent', () => {
    const s = new DshHelmStore({ file: ':memory:' })
    migrate(s.db, STORE_SCHEMA_VERSION)
    migrate(s.db, STORE_SCHEMA_VERSION)
    expect(readSchemaVersion(s.db)).toBe(STORE_SCHEMA_VERSION)
    s.close()
  })
})