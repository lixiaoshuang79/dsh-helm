/**
 * MCP tool registry for the hub's connector entry.
 *
 * Keeps the 19 upstream helm-daemon tools (snake_case args) so ChatGPT keeps
 * working unchanged, and adds control-plane tools. Every routable tool gains
 * an optional `target_node` param (never confusable with the daemon's own
 * params). `danger` classifies each op for the router's fail-closed policy.
 */

import { DANGER } from '@dsh-helm/protocol'

export interface ToolDef {
  name: string
  description: string
  /** JSON schema for args (subset: properties/type/required). */
  schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  danger: string
  /** Route by session affinity (session_id param). */
  sessionRouted?: boolean
  /** Route by workspace affinity (workspace param). */
  workspaceRouted?: boolean
  /** Discovery tool: hub aggregates across nodes (no route needed). */
  discovery?: boolean
}

const targetNodeProp = {
  type: 'string',
  description: 'Explicitly route this call to a specific node_id (see nodes_list).',
}

const sessionIdProp = { type: 'string', description: 'Native DSH session id (or node_id:session global key).' }

export const TOOLS: ToolDef[] = [
  // ---- workspace/code (upstream-compatible, workspace affinity) ----
  {
    name: 'code_use_workspace',
    description: 'Select the workspace to operate on. Routes to the owning node.',
    danger: DANGER.WRITE,
    workspaceRouted: true,
    schema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace id or path.' }, target_node: targetNodeProp }, required: ['workspace'] },
  },
  {
    name: 'code_read_file',
    description: 'Read a file in the active workspace. Routes to the workspace owner.',
    danger: DANGER.READ,
    workspaceRouted: true,
    schema: { type: 'object', properties: { path: { type: 'string' }, workspace: { type: 'string' }, target_node: targetNodeProp }, required: ['path'] },
  },
  {
    name: 'code_list_dir',
    description: 'List a directory in the active workspace.',
    danger: DANGER.READ,
    workspaceRouted: true,
    schema: { type: 'object', properties: { path: { type: 'string' }, workspace: { type: 'string' }, target_node: targetNodeProp }, required: ['path'] },
  },
  {
    name: 'code_find_file',
    description: 'Find files by name pattern in the workspace.',
    danger: DANGER.READ,
    workspaceRouted: true,
    schema: { type: 'object', properties: { pattern: { type: 'string' }, workspace: { type: 'string' }, target_node: targetNodeProp }, required: ['pattern'] },
  },
  {
    name: 'code_search_for_pattern',
    description: 'Search file contents for a regex pattern.',
    danger: DANGER.READ,
    workspaceRouted: true,
    schema: { type: 'object', properties: { pattern: { type: 'string' }, workspace: { type: 'string' }, target_node: targetNodeProp }, required: ['pattern'] },
  },
  {
    name: 'code_get_symbols_overview',
    description: 'Symbol overview of the active workspace.',
    danger: DANGER.READ,
    workspaceRouted: true,
    schema: { type: 'object', properties: { workspace: { type: 'string' }, target_node: targetNodeProp } },
  },
  {
    name: 'code_find_symbol',
    description: 'Find a symbol by name.',
    danger: DANGER.READ,
    workspaceRouted: true,
    schema: { type: 'object', properties: { name: { type: 'string' }, workspace: { type: 'string' }, target_node: targetNodeProp }, required: ['name'] },
  },
  {
    name: 'code_find_referencing_symbols',
    description: 'Find symbols referencing a given symbol.',
    danger: DANGER.READ,
    workspaceRouted: true,
    schema: { type: 'object', properties: { name: { type: 'string' }, workspace: { type: 'string' }, target_node: targetNodeProp }, required: ['name'] },
  },

  // ---- projects / workspaces (discovery) ----
  {
    name: 'projects_list',
    description: 'List projects across all connected nodes.',
    danger: DANGER.READ,
    discovery: true,
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'workspaces_list',
    description: 'List workspaces across all connected nodes.',
    danger: DANGER.READ,
    discovery: true,
    schema: { type: 'object', properties: {} },
  },

  // ---- sessions (upstream-compatible, session affinity) ----
  {
    name: 'sessions_create',
    description: 'Create a new DSH session on a node.',
    danger: DANGER.WRITE,
    sessionRouted: true,
    workspaceRouted: true,
    schema: { type: 'object', properties: { workspace: { type: 'string' }, title: { type: 'string' }, initial_message: { type: 'string' }, target_node: targetNodeProp } },
  },
  {
    name: 'sessions_list',
    description: 'List sessions across all connected nodes.',
    danger: DANGER.READ,
    discovery: true,
    schema: { type: 'object', properties: { limit: { type: 'number' }, node_id: { type: 'string', description: 'Filter to one node (see nodes_list).' } } },
  },
  {
    name: 'sessions_get',
    description: 'Get session details. Routes to the session owner.',
    danger: DANGER.READ,
    sessionRouted: true,
    schema: { type: 'object', properties: { session_id: sessionIdProp, max_messages: { type: 'number' }, target_node: targetNodeProp }, required: ['session_id'] },
  },
  {
    name: 'sessions_resume',
    description: 'Resume a session on its owning node.',
    danger: DANGER.DESTRUCTIVE,
    sessionRouted: true,
    schema: { type: 'object', properties: { session_id: sessionIdProp, target_node: targetNodeProp }, required: ['session_id'] },
  },
  {
    name: 'sessions_prompt',
    description: 'Send a message to a session on its owning node.',
    danger: DANGER.DESTRUCTIVE,
    sessionRouted: true,
    schema: { type: 'object', properties: { session_id: sessionIdProp, message: { type: 'string' }, target_node: targetNodeProp }, required: ['session_id', 'message'] },
  },
  {
    name: 'sessions_wait',
    description: 'Wait for a session to reach a terminal state.',
    danger: DANGER.READ,
    sessionRouted: true,
    schema: { type: 'object', properties: { session_id: sessionIdProp, timeout_ms: { type: 'number' }, poll_ms: { type: 'number' }, target_node: targetNodeProp }, required: ['session_id'] },
  },
  {
    name: 'sessions_cancel',
    description: 'Cancel a running session on its owning node.',
    danger: DANGER.WRITE,
    sessionRouted: true,
    schema: { type: 'object', properties: { session_id: sessionIdProp, target_node: targetNodeProp }, required: ['session_id'] },
  },

  // ---- agents / supervisor (upstream-compatible) ----
  {
    name: 'agents_list',
    description: 'List agents across all connected nodes.',
    danger: DANGER.READ,
    discovery: true,
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'supervisor_health',
    description: 'Layered health of the control plane and all nodes.',
    danger: DANGER.READ,
    discovery: true,
    schema: { type: 'object', properties: {} },
  },

  // ---- control-plane tools (new) ----
  {
    name: 'nodes_list',
    description: 'List all nodes registered with the control plane, with connection and capability status.',
    danger: DANGER.READ,
    discovery: true,
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'node_get',
    description: 'Get one node by node_id with layered health.',
    danger: DANGER.READ,
    discovery: true,
    schema: { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'] },
  },
  {
    name: 'route_explain',
    description: 'Explain how a call would be routed (target/session/workspace/presence), without executing it.',
    danger: DANGER.READ,
    discovery: true,
    schema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'Tool name to explain routing for.' },
        session_id: { type: 'string' },
        workspace: { type: 'string' },
        target_node: { type: 'string' },
      },
      required: ['op'],
    },
  },
  {
    name: 'presence_claim',
    description: 'Manually claim presence on a node (default 10min TTL, pinned). Explicit target always wins routing.',
    danger: DANGER.WRITE,
    schema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node to claim presence on.' },
        ttl_ms: { type: 'number', description: 'Optional TTL override (clamped).' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'presence_release',
    description: 'Release a manual presence claim on a node.',
    danger: DANGER.WRITE,
    schema: { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'] },
  },
]

export const TOOL_BY_NAME: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]))

/**
 * Mutating tools that must run on the single writer leader in dual-CP mode.
 * These either change hub-local state (presence_*) or issue write directives
 * to nodes (sessions_*, code_use_workspace). A follower forwards every call
 * in this set to the leader's HTTP MCP endpoint; everything else is
 * read-only / discovery and executes locally on the synced registry.
 *
 * Keep in sync with TOOLS: the anti-regression test asserts this set covers
 * every tool whose danger is write or destructive.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'code_use_workspace',
  'sessions_create',
  'sessions_resume',
  'sessions_prompt',
  'sessions_cancel',
  'presence_claim',
  'presence_release',
])

/** Upstream-compatible tools (the 19 the tunnel already exposes). */
export const COMPAT_TOOLS = TOOLS.filter((t) => !t.name.startsWith('nodes_') && !t.name.startsWith('node_') && !t.name.startsWith('route_') && !t.name.startsWith('presence_'))
