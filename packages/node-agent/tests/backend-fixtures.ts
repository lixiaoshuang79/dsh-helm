/**
 * FakeBackend: in-memory LocalHelmBackend for tests.
 *
 * Implements the full LocalHelmBackend contract (connect/listTools/callTool/
 * probeHealth/reconcile) with injectable behavior — replaces the local Helm
 * MCP daemon without HTTP.
 */

import type { LocalHelmBackend, LocalHelmTool, McpToolCallResult } from '../src/bridge.js'

export interface FakeBackendOptions {
  tools?: LocalHelmTool[]
  sessions?: Array<Record<string, unknown>>
  workspaces?: Array<Record<string, unknown>>
  /** Tools that throw when called (e.g. 'supervisor_health' to simulate daemon down). */
  failTools?: Set<string>
  /** Extra structured payload for specific tools. */
  overrides?: Record<string, Record<string, unknown>>
  log?: (line: string) => void
}

export class FakeBackend implements LocalHelmBackend {
  connected = false
  calls: Array<{ name: string; args: unknown }> = []
  private tools: LocalHelmTool[]
  private sessions: Array<Record<string, unknown>>
  private workspaces: Array<Record<string, unknown>>
  private failTools: Set<string>
  private overrides: Record<string, Record<string, unknown>>

  constructor(opts: FakeBackendOptions = {}) {
    this.tools = opts.tools ?? DEFAULT_TOOLS
    this.sessions = opts.sessions ?? [{ session_id: 's-fake', status: 'idle', live: false, title: 'fake session' }]
    this.workspaces = opts.workspaces ?? [{ workspace_id: 'w-fake', path: '/tmp/fake' }]
    this.failTools = opts.failTools ?? new Set()
    this.overrides = opts.overrides ?? {}
  }

  async connect(): Promise<{ name?: string; version?: string }> {
    this.connected = true
    return { name: 'fake-local-helm', version: '0.1.0' }
  }

  async listTools(): Promise<LocalHelmTool[]> {
    return [...this.tools]
  }

  async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    this.calls.push({ name, args })
    if (this.failTools.has(name)) throw new Error(`fake backend: ${name} failed (injected)`)
    if (this.overrides[name]) return { structuredContent: this.overrides[name] }
    switch (name) {
      case 'sessions_list':
        return { structuredContent: { sessions: this.sessions } }
      case 'workspaces_list':
        return { structuredContent: { workspaces: this.workspaces } }
      case 'supervisor_health':
        return { structuredContent: { status: 'ok', serena: { connected: true }, adapters: [{ id: 'dsh', health: 'ok' }] } }
      case 'sessions_create':
        return { structuredContent: { session_id: 's-new', native_session_id: 's-new', ok: true } }
      case 'sessions_get':
        return { structuredContent: { session_id: String((args as { session_id?: string })?.session_id ?? ''), status: 'idle' } }
      case 'sessions_resume':
        return { structuredContent: { resumed: true, session_id: String((args as { session_id?: string })?.session_id ?? '') } }
      case 'sessions_prompt':
        return { structuredContent: { ok: true, reply: `[fake] processed: ${String((args as { message?: string })?.message ?? '')}` } }
      case 'sessions_cancel':
        return { structuredContent: { cancelled: true, session_id: String((args as { session_id?: string })?.session_id ?? '') } }
      case 'code_use_workspace':
        return { structuredContent: { ok: true, workspace: String((args as { workspace?: string })?.workspace ?? '') } }
      case 'code_read_file':
        return { structuredContent: { content: `[fake ${String((args as { path?: string })?.path ?? '')}]` } }
      default:
        return { structuredContent: { ok: true, tool: name } }
    }
  }

  async probeHealth(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.callTool('supervisor_health', {})
      return { ok: true }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  async reconcile(): Promise<{ sessions: Array<Record<string, unknown>>; workspaces: Array<Record<string, unknown>> }> {
    return { sessions: this.sessions, workspaces: this.workspaces }
  }

  disconnect(): void {
    this.connected = false
  }
}

/** The 19 upstream-compatible tools (snapshot; dynamic override possible). */
export const DEFAULT_TOOLS: LocalHelmTool[] = [
  'code_read_file', 'code_list_dir', 'code_find_file', 'code_search_for_pattern',
  'code_get_symbols_overview', 'code_find_symbol', 'code_find_referencing_symbols',
  'code_use_workspace',
  'projects_list', 'supervisor_health', 'agents_list', 'workspaces_list',
  'sessions_create', 'sessions_list', 'sessions_get', 'sessions_resume',
  'sessions_prompt', 'sessions_wait', 'sessions_cancel',
].map((name) => ({ name, description: `fake ${name}`, inputSchema: {} }))