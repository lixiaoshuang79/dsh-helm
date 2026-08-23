/**
 * SQLite database wrapper for the control plane store.
 *
 * Uses node:sqlite (DatabaseSync) — the same driver deepseek-harness uses
 * in production. WAL journal + busy_timeout for crash safety and concurrent
 * readers; schema version tracked in a kv table with migration support.
 *
 * The store holds metadata only — node registry, presence leases, session and
 * workspace catalogs, audit and route logs. It never stores DSH conversation
 * bodies.
 *
 * node:sqlite is loaded lazily via createRequire to (a) avoid the process-wide
 * ExperimentalWarning in Node 22 and (b) keep bundlers/test-runners from
 * trying to resolve the experimental builtin at transform time.
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { STORE_SCHEMA_VERSION } from '@dsh-helm/protocol'

export interface StoreOpenOptions {
  /** SQLite file path. Use ':memory:' for tests. */
  file: string
  /** Busy timeout in ms (default 5000). */
  busyTimeoutMs?: number
  /** Override the target schema version (tests use this to simulate old DBs). */
  targetVersion?: number
}

interface DatabaseSyncLike {
  new (path: string): DatabaseLike
}
export interface DatabaseLike {
  exec(sql: string): void
  prepare(sql: string): StatementLike
  close(): void
}
export interface StatementLike {
  run(...params: unknown[]): { changes: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

let sqliteModule: { DatabaseSync: DatabaseSyncLike } | undefined

function loadSqlite(): { DatabaseSync: DatabaseSyncLike } {
  if (sqliteModule) return sqliteModule
  const require = createRequire(import.meta.url)
  const emitWarning = Reflect.get(process, 'emitWarning')
  const filtered = (warning: string | Error, ...args: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning
    const first = args[0]
    const type =
      warning instanceof Error
        ? warning.name
        : typeof first === 'string'
          ? first
          : typeof first === 'object' && first !== null && 'type' in first
            ? (first as { type?: unknown }).type
            : undefined
    if (message === 'SQLite is an experimental feature and might change at any time' && type === 'ExperimentalWarning') {
      return
    }
    Reflect.apply(emitWarning, process, [warning, ...args])
  }
  try {
    Reflect.set(process, 'emitWarning', filtered)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqliteModule = require('node:sqlite') as { DatabaseSync: DatabaseSyncLike }
  } finally {
    Reflect.set(process, 'emitWarning', emitWarning)
  }
  return sqliteModule
}

export class DshHelmStore {
  readonly db: DatabaseLike

  constructor(opts: StoreOpenOptions) {
    if (opts.file !== ':memory:') {
      mkdirSync(dirname(opts.file), { recursive: true })
    }
    const { DatabaseSync } = loadSqlite()
    const db = new DatabaseSync(opts.file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000}`)
    db.exec('PRAGMA foreign_keys = ON')
    this.db = db
    migrate(this.db, opts.targetVersion ?? STORE_SCHEMA_VERSION)
  }

  close(): void {
    this.db.close()
  }
}

/** Read the current schema version stored in kv (0 when fresh). */
export function readSchemaVersion(db: DatabaseLike): number {
  try {
    const row = db.prepare(`SELECT value FROM kv WHERE key = 'schema_version'`).get() as { value?: string } | undefined
    const v = row?.value
    return v ? Number(v) : 0
  } catch {
    return 0
  }
}

/** Migrate the database to the target schema version. */
export function migrate(db: DatabaseLike, targetVersion: number): void {
  const current = readSchemaVersion(db)
  if (current > targetVersion) {
    throw new Error(`store schema version ${current} is newer than supported ${targetVersion}`)
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (let v = current; v < targetVersion; v++) {
      applyMigration(db, v + 1)
    }
    db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)`).run(String(targetVersion))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function applyMigration(db: DatabaseLike, version: number): void {
  switch (version) {
    case 1:
      applyV1(db)
      return
    default:
      throw new Error(`unknown migration target v${version}`)
  }
}

function applyV1(db: DatabaseLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      node_id        TEXT PRIMARY KEY,
      display_name   TEXT NOT NULL,
      platform       TEXT NOT NULL,       -- JSON PlatformInfo
      versions       TEXT NOT NULL,       -- JSON ComponentVersions
      capabilities   TEXT NOT NULL,       -- JSON NodeCapabilities
      config_home    TEXT,
      status         TEXT NOT NULL DEFAULT 'offline',  -- online|offline|blocked
      last_seen      TEXT,
      heartbeat_seq  INTEGER NOT NULL DEFAULT 0,
      registered_at  TEXT NOT NULL,
      blocked_reason TEXT,
      schema_version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS presence_leases (
      node_id     TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      confidence  REAL NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      pinned      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      global_key       TEXT PRIMARY KEY,   -- node_id:native_session_id
      node_id          TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      title            TEXT,
      status           TEXT NOT NULL,
      updated_at       TEXT,
      workspace_id     TEXT,
      live             INTEGER NOT NULL DEFAULT 0,
      UNIQUE (node_id, native_session_id)
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      global_key           TEXT PRIMARY KEY,  -- node_id:native_workspace_id
      node_id              TEXT NOT NULL,
      native_workspace_id  TEXT NOT NULL,
      path                 TEXT NOT NULL,
      title                TEXT,
      session_count        INTEGER,
      UNIQUE (node_id, native_workspace_id)
    );

    CREATE TABLE IF NOT EXISTS audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      call_id     TEXT NOT NULL,
      op          TEXT NOT NULL,
      actor_node  TEXT,
      target_node TEXT NOT NULL,
      session_id  TEXT,
      decision    TEXT NOT NULL,
      danger      TEXT NOT NULL,
      explicit    INTEGER NOT NULL,
      result      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit (ts);

    CREATE TABLE IF NOT EXISTS route_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT NOT NULL,
      call_id   TEXT NOT NULL,
      op        TEXT NOT NULL,
      decision  TEXT NOT NULL,   -- JSON RouteDecision
      explicit  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_route_log_ts ON route_log (ts);
  `)
}