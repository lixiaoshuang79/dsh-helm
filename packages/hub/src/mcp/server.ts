/**
 * HubMcpServer: exposes the connector MCP surface on top of the ControlPlane.
 *
 * Handles tool calls:
 * - discovery tools (projects_list, workspaces_list, sessions_list,
 *   agents_list, supervisor_health, nodes_list, node_get, route_explain)
 *   answered locally by the hub (aggregating node catalogs),
 * - routable tools (code_*, sessions_*, presence_*) routed through the
 *   Router to the owning/present/default node, with fail-closed rejection
 *   for destructive ops without a clear target,
 * - `target_node` param overrides routing explicitly.
 *
 * Local compat mode: with a single node whose node_id == hub defaultNodeId,
 * routing behaves exactly like the single-machine daemon (explicit/session/
 * workspace/default all converge on that node).
 */

import type { PresenceClaim, RouteDecision } from '@dsh-helm/protocol'
import { DANGER, ROUTE_OUTCOME } from '@dsh-helm/protocol'
import { ControlPlane } from '../control-plane.js'
import { TOOL_BY_NAME, WRITE_TOOLS, type ToolDef } from './tools.js'
import { applyGuard } from './guard.js'
import { McpMetrics } from './metrics.js'
import { checkModelDeclaration, rejectionText, MODEL_GATED_TOOLS } from './model-gate.js'

export interface HubMcpServerOptions {
  cp: ControlPlane
  /** HA write forwarder (HubHa). When present and the hub is a follower,
   *  every WRITE_TOOLS call is forwarded to the leader instead of executing
   *  locally (single-writer fencing). */
  ha?: WriteForwarder
  log?: (line: string) => void
  /** MCP 调用指标计数器（/metrics 数据源）。缺省自建一个。 */
  metrics?: McpMetrics
}

/** Minimal HA surface the MCP server needs (implemented by HubHa). */
export interface WriteForwarder {
  /**
   * 'readwrite' = this hub may execute writes locally (standalone, or the
   * lease-holding leader). 'readonly' = this hub must not (follower,
   * nominating, or quorum lost).
   */
  writeMode(): 'readwrite' | 'readonly'
  /**
   * Execute a WRITE_TOOLS call on this hub. Called only when writeMode() is
   * 'readonly': follower+quorum forwards to the leader; otherwise returns
   * the structured QUORUM_LOST error. Never throws.
   */
  handleWrite(name: string, args: Record<string, unknown>): Promise<McpCallResult>
}

export interface McpToolCall {
  name: string
  arguments?: Record<string, unknown>
}

export interface McpCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export class HubMcpServer {
  private cp: ControlPlane
  private ha?: WriteForwarder
  private logFn?: (line: string) => void
  /** MCP 调用指标（public：hub-cli 的 /metrics 与测试直接读取）。 */
  readonly metrics: McpMetrics

  constructor(opts: HubMcpServerOptions) {
    this.cp = opts.cp
    this.ha = opts.ha
    this.logFn = opts.log
    this.metrics = opts.metrics ?? new McpMetrics()
  }

  log(line: string): void {
    this.logFn?.(line)
  }

  /** Tool list for MCP tools/list. */
  listTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return [...TOOL_BY_NAME].map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.schema,
    }))
  }

  /** Execute one tool call. Returns an MCP result or throws on hard error. */
  async callTool(call: McpToolCall): Promise<McpCallResult> {
    const def = TOOL_BY_NAME.get(call.name)
    if (!def) {
      return this.finish({ content: [{ type: 'text', text: `unknown tool: ${call.name}` }], isError: true }, call.name, 'unknown tool')
    }
    const args = call.arguments ?? {}
    const callId = `mcp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    try {
      // Model declaration gate（P4）：ChatGPT 链路的声明式模型门禁。对消息
      // 注入工具校验消息文本里的模型声明（隧道不带模型信息，只能声明式）。
      if (MODEL_GATED_TOOLS.has(def.name)) {
        const gateText = def.name === 'sessions_prompt' ? args.message : args.initial_message
        if (typeof gateText === 'string' && gateText.trim()) {
          const gate = checkModelDeclaration(gateText)
          if (!gate.ok) {
            this.log(`model gate ${gate.code} on ${def.name}`)
            return this.finish({ content: [{ type: 'text', text: rejectionText(gate) }], isError: true }, def.name, gate.code)
          }
        }
      }
      if (def.discovery) {
        return this.finish(await this.handleDiscovery(def, args, callId), def.name)
      }
      // Single-writer fencing via 2/2-quorum write lease: while this hub is
      // NOT the leased leader (writeMode 'readonly'), every mutating tool is
      // either forwarded to the leader (follower+quorum) or refused with the
      // structured QUORUM_LOST error.
      if (this.ha && WRITE_TOOLS.has(def.name) && this.ha.writeMode() === 'readonly') {
        this.log(`[ha] write ${def.name} via HA path (writeMode=readonly)`)
        return this.finish(await this.ha.handleWrite(def.name, args), def.name)
      }
      return this.finish(await this.handleRouted(def, args, callId), def.name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`tool ${call.name} error: ${msg}`)
      return this.finish({ content: [{ type: 'text', text: `error: ${msg}` }], isError: true }, call.name, msg)
    }
  }

  /** 统一出口：所有返回路径（含 isError 与 HA 转发结果）都过 Response Size
   *  Guard（P1），并记录调用指标（P3）。errorMsg 缺省时按 isError 派生
   * （this.error() 直返的错误响应同样计入 errorCount）。 */
  private finish(result: McpCallResult, tool: string, errorMsg?: string): McpCallResult {
    const guarded = applyGuard(result, tool, (line) => this.log(line))
    const text = guarded.content[0]?.text ?? ''
    const err = errorMsg ?? (guarded.isError ? text : undefined)
    this.metrics.recordRequest(tool, Buffer.byteLength(text), guarded !== result, err)
    return guarded
  }

  // ---- discovery tools (hub-local answers) ----

  private async handleDiscovery(def: ToolDef, args: Record<string, unknown>, _callId: string): Promise<McpCallResult> {
    switch (def.name) {
      case 'projects_list':
      case 'workspaces_list': {
        const rows = await this.cp.aggregateWorkspaces()
        const names = new Map(this.cp.nodeCatalog().map(({ node }) => [node.node_id, node.display_name]))
        const flat = rows.flatMap((r) =>
          r.workspaces.map((w) => ({
            node_id: r.node_id,
            node_name: names.get(r.node_id) ?? r.node_id.slice(0, 8),
            workspace_id: w.native_workspace_id,
            path: w.path,
            title: w.title,
          })),
        )
        return this.text({ projects: flat, workspaces: flat })
      }
      case 'sessions_list': {
        const nodeFilter = typeof args.node_id === 'string' ? args.node_id : undefined
        const rows = await this.cp.aggregateSessions()
        const names = new Map(this.cp.nodeCatalog().map(({ node }) => [node.node_id, node.display_name]))
        const flat = rows
          .filter((r) => !nodeFilter || r.node_id === nodeFilter)
          .flatMap((r) =>
            r.sessions.map((s) => ({
              node_id: r.node_id,
              node_name: names.get(r.node_id) ?? r.node_id.slice(0, 8),
              session_id: s.native_session_id,
              global_id: `${r.node_id}:${s.native_session_id}`,
              title: s.title,
              status: s.status,
              live: s.live,
            })),
          )
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        return this.text({ sessions: limit ? flat.slice(0, limit) : flat })
      }
      case 'agents_list': {
        const rows = this.cp.nodeCatalog().map(({ node, connection }) => ({
          node_id: node.node_id,
          display_name: node.display_name,
          connected: connection,
          status: node.status,
          adapters: [{ id: node.capabilities.sessions ? 'dsh' : 'unknown', health: connection ? 'ok' : 'offline' }],
        }))
        return this.text({ agents: rows })
      }
      case 'supervisor_health': {
        const agg = this.cp.aggregateHealth()
        return this.text({
          status: agg.nodes.every((n) => n.status === 'ok') ? 'ok' : agg.nodes.some((n) => n.status === 'down') ? 'degraded' : 'ok',
          control: agg.control,
          serena: { connected: agg.nodes.some((n) => n.serena.status === 'ok'), activeNodes: agg.nodes.filter((n) => n.serena.status === 'ok').map((n) => n.node_id) },
          tunnel: { managed: false },
          adapters: agg.nodes.map((n) => ({ id: n.node_id, health: n.status, channel: n.channel, datapath: n.datapath })),
          nodes: agg.nodes,
        })
      }
      case 'nodes_list': {
        const rows = this.cp.nodeCatalog().map(({ node, connection, derived }) => ({
          node_id: node.node_id,
          display_name: node.display_name,
          platform: node.platform,
          versions: node.versions,
          capabilities: node.capabilities,
          status: node.status,
          connected: connection,
          last_seen: node.last_seen,
          // dual-CP: true when this CP learned the node via its peer (the
          // direct CP's report is authoritative for `connected`)
          ...(derived ? { derived: true } : {}),
        }))
        return this.text({ nodes: rows })
      }
      case 'node_get': {
        const nodeId = String(args.node_id ?? '')
        const { node, connection } = this.cp.nodeCatalog().find((x) => x.node.node_id === nodeId) ?? { node: undefined, connection: false }
        if (!node) return { content: [{ type: 'text', text: `unknown node: ${nodeId}` }], isError: true }
        const summary = this.cp.health.nodeHealth(node)
        return this.text({ node: { ...node, connected: connection, health: summary } })
      }
      case 'route_explain': {
        const op = String(args.op ?? '')
        const def = TOOL_BY_NAME.get(op)
        if (!def) return { content: [{ type: 'text', text: `unknown tool: ${op}` }], isError: true }
        const sessionId = typeof args.session_id === 'string' ? args.session_id : undefined
        const workspace = typeof args.workspace === 'string' ? args.workspace : undefined
        const targetNode = typeof args.target_node === 'string' ? args.target_node : undefined
        const route = this.cp.router.route({ op, session_id: sessionId, workspace, target_node: targetNode, danger: def.danger })
        return this.text({
          op,
          danger: def.danger,
          decision: route.decision,
          action: route.action,
          errorCode: route.errorCode,
        })
      }
      default:
        return { content: [{ type: 'text', text: `unhandled discovery tool: ${def.name}` }], isError: true }
    }
  }

  // ---- routed tools (through the Router) ----

  private async handleRouted(def: ToolDef, args: Record<string, unknown>, callId: string): Promise<McpCallResult> {
    // presence tools are hub-local (not node-routed)
    if (def.name === 'presence_claim' || def.name === 'presence_release') {
      return this.handlePresence(def, args)
    }

    const targetNode = typeof args.target_node === 'string' && args.target_node ? args.target_node : undefined
    const sessionId = def.sessionRouted ? (typeof args.session_id === 'string' ? args.session_id : undefined) : undefined
    const workspace = def.workspaceRouted ? (typeof args.workspace === 'string' ? args.workspace : undefined) : undefined

    const route = this.cp.router.route({
      op: def.name,
      target_node: targetNode,
      session_id: sessionId,
      workspace,
      danger: def.danger,
    })
    if (route.action !== 'forward' || !route.decision.node_id) {
      const code = route.errorCode ?? 'no_route'
      return this.error(`route rejected (${code}): ${route.decision.reason}`)
    }
    // strip control params before forwarding
    const { target_node: _t, ...forwardArgs } = args
    const result = await this.cp.forward(route, def.name, forwardArgs, callId, def.danger)
    // Attach human-readable serving node so callers (ChatGPT) can tell which
    // DSH actually answered (node_id UUIDs are not enough).
    const names = new Map(this.cp.nodeCatalog().map(({ node }) => [node.node_id, node.display_name]))
    const routeMeta = {
      ...route.decision,
      node_name: names.get(route.decision.node_id) ?? route.decision.node_id.slice(0, 8),
    }
    return this.text({ ...(result as Record<string, unknown>), _route: routeMeta })
  }

  private async handlePresence(def: ToolDef, args: Record<string, unknown>): Promise<McpCallResult> {
    const nodeId = String(args.node_id ?? '')
    const node = this.cp.nodeCatalog().find((x) => x.node.node_id === nodeId)
    if (!node) return this.error(`unknown node: ${nodeId}`)
    if (def.name === 'presence_claim') {
      const claim: PresenceClaim = {
        node_id: nodeId,
        source: 'manual',
        confidence: 1.0,
        observed_at: new Date().toISOString(),
        ttl_ms: typeof args.ttl_ms === 'number' ? args.ttl_ms : 0,
        pinned: true,
      }
      this.cp.presenceRegistry().claim(claim)
      return this.text({ claimed: true, node_id: nodeId, pinned: true })
    }
    this.cp.presenceRegistry().release(nodeId)
    return this.text({ released: true, node_id: nodeId })
  }

  private text(data: unknown): McpCallResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  private error(msg: string): McpCallResult {
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
}

export type { ToolDef }
export { TOOLS, TOOL_BY_NAME, COMPAT_TOOLS } from './tools.js'
export { DANGER, ROUTE_OUTCOME }
export type { RouteDecision }