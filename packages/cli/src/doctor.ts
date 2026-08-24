/**
 * dsh-helm doctor — 本机诊断报告（只读）。
 *
 * 规则：
 *  - 只读：不修改任何配置、不起服务、不发心跳。
 *  - 每节失败不中断：所有检查全部收集后统一汇总 exit code（有 FAIL 返回 1）。
 *  - 敏感信息一律 redact：token 只显示「已配置/未配置」，node_id / tunnel id
 *    只显示前后 8 字符，含 sk-proj- / Authorization: Bearer 的字符串走 redactToken。
 *  - 所有系统依赖（fetch / 子进程 / 平台 / 路径）均可注入，测试不碰真实环境。
 */

import { findTailscaleCli, getTailscaleVersion } from '@dsh-helm/platform'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// ---- 基础类型 ----

export type SectionStatus = 'ok' | 'warn' | 'fail'

export interface DoctorLine {
  status: SectionStatus
  text: string
}

export interface DoctorSection {
  title: string
  status: SectionStatus
  lines: DoctorLine[]
}

export interface DoctorOptions {
  /** hub 基础 URL，默认 http://127.0.0.1:3471 */
  hubUrl?: string
  /** tunnel 健康检查 URL，默认 http://127.0.0.1:3468 */
  tunnelHealthUrl?: string
  /** ~/.dsh/helm/node.json 路径（可注入，测试用） */
  nodeConfigPath?: string
  /** launchd plist 路径（macOS tunnel 服务，可注入） */
  tunnelPlistPath?: string
  /** 单次网络/子进程超时（ms），默认 5000 */
  timeoutMs?: number
  /** tailscale CLI 路径；null = 未安装；缺省自动探测（注入后测试不碰真实环境） */
  tailscaleCli?: string | null
  /** fetch 实现，测试注入 */
  fetchImpl?: typeof fetch
  /** 子进程执行器，测试注入 */
  run?: RunFn
  /** 目标平台，默认 process.platform */
  platform?: NodeJS.Platform
}

// ---- 纯函数（可单测） ----

/** node 版本是否满足 engine 要求（如 >=22.5）。 */
export function nodeVersionSatisfies(version: string, minMajor: number, minMinor: number): boolean {
  const [majorS, minorS] = version.split('.')
  const major = Number.parseInt(majorS ?? '', 10)
  if (Number.isNaN(major)) return false
  if (major > minMajor) return true
  if (major < minMajor) return false
  const minor = Number.parseInt(minorS ?? '', 10)
  return (Number.isNaN(minor) ? 0 : minor) >= minMinor
}

/** 抹掉 sk-proj-* 与 Authorization: Bearer <token> 形态的敏感信息。 */
export function redactToken(s: string): string {
  if (s === '') return s
  return s
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, (m) => `${m.slice(0, 12)}…`)
    .replace(/Authorization:\s*Bearer\s+[^\s,;]+/gi, 'Authorization: Bearer <redacted>')
}

/** node_id 省略显示：前后各 8 字符（UUID 等长 id 不会整体泄露）。 */
export function redactNodeId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-8)}`
}

/** tunnel id 省略显示：前 8 字符 + …。 */
export function redactTunnelId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`
}

/**
 * 从 launchd plist 文本解析 ProgramArguments 中
 * `--control-plane.tunnel-id` 的后一个参数。找不到返回 null。
 */
export function parseTunnelIdFromPlist(plistText: string): string | null {
  const strings = [...plistText.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!)
  const idx = strings.indexOf('--control-plane.tunnel-id')
  if (idx === -1 || idx + 1 >= strings.length) return null
  const v = strings[idx + 1]!
  return v === '' ? null : v
}

/** 本机节点配置（只读读取，绝不生成/写入文件）。 */
export interface LocalNodeConfig {
  found: boolean
  display_name: string
  node_id: string
  hub_url: string
  hasToken: boolean
}

export function readLocalNodeConfig(path: string): LocalNodeConfig {
  if (!existsSync(path)) return { found: false, display_name: '', node_id: '', hub_url: '', hasToken: false }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return {
      found: true,
      display_name: typeof raw.display_name === 'string' ? raw.display_name : '',
      node_id: typeof raw.node_id === 'string' ? raw.node_id : '',
      hub_url: typeof raw.hub_url === 'string' ? raw.hub_url : '',
      hasToken: typeof raw.token === 'string' && raw.token.length > 0,
    }
  } catch {
    return { found: false, display_name: '', node_id: '', hub_url: '', hasToken: false }
  }
}

// ---- 系统命令/HTTP 执行（可注入） ----

export interface RunResult {
  ok: boolean
  stdout: string
}

export type RunFn = (cmd: string, args: string[], shell?: boolean) => RunResult

export function runCommand(cmd: string, args: string[], shell = false): RunResult {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, shell })
    if (r.error) return { ok: false, stdout: '' }
    return { ok: r.status === 0 && (r.stdout ?? '') !== '', stdout: r.stdout ?? '' }
  } catch {
    return { ok: false, stdout: '' }
  }
}

interface HttpResult {
  ok: boolean
  status: number
  body: unknown
  headers: Headers
  error: string
}

async function httpJson(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs: number): Promise<HttpResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal })
    const text = await res.text()
    let body: unknown
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      body = text
    }
    return { ok: res.ok, status: res.status, body, headers: res.headers, error: '' }
  } catch (err) {
    return { ok: false, status: 0, body: undefined, headers: new Headers(), error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** 端口是否被监听（macOS lsof，含 /usr/sbin 固定路径，退回 netstat；Linux ss）。存在输出即视为占用。 */
export function isPortListening(port: number, run: RunFn = runCommand, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') {
    // lsof 常不在 PATH（macOS 上位于 /usr/sbin），依次尝试；全失败再退 netstat
    for (const cmd of ['lsof', '/usr/sbin/lsof']) {
      const r = run(cmd, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
      if (r.ok) return r.stdout.trim() !== ''
    }
    const ns = run('/usr/sbin/netstat', ['-an', '-p', 'tcp'])
    return ns.ok && new RegExp(`\\.${port}\\s+`).test(ns.stdout) && ns.stdout.includes('LISTEN')
  }
  if (platform === 'linux') {
    const r = run('ss', ['-ltn'])
    return r.ok && new RegExp(`:${port}(\\s|$)`).test(r.stdout)
  }
  return false
}

// ---- 各检查节 ----

const line = (status: SectionStatus, text: string): DoctorLine => ({ status, text })

function sectionStatus(lines: DoctorLine[]): SectionStatus {
  let s: SectionStatus = 'ok'
  for (const l of lines) {
    if (l.status === 'fail' || (l.status === 'warn' && s === 'ok')) s = l.status
  }
  return s
}

function depsSection(platform: NodeJS.Platform, run: RunFn, tailscaleCli: string | null): DoctorSection {
  const lines: DoctorLine[] = []

  const ver = process.versions.node
  lines.push(
    nodeVersionSatisfies(ver, 22, 5)
      ? line('ok', `node ${ver}（engine 要求 >=22.5）`)
      : line('fail', `node ${ver} 低于 engine 要求 >=22.5，请升级 Node.js`),
  )

  if (tailscaleCli) {
    const tsVer = getTailscaleVersion(tailscaleCli)
    lines.push(line('ok', `tailscale 已安装：${tailscaleCli}${tsVer ? `（v${tsVer}）` : ''}`))
  } else {
    lines.push(line('warn', 'tailscale 未安装——节点机需要组网（brew install --cask tailscale 或官网 App），hub 机可跳过'))
  }

  if (platform === 'win32') {
    lines.push(line('warn', 'curl 检查在 Windows 上未实现（doctor 主要面向 macOS/Linux）'))
  } else {
    const r = run('sh', ['-c', 'command -v curl'])
    lines.push(r.ok && r.stdout.trim() !== '' ? line('ok', `curl 可用（${r.stdout.trim()}）`) : line('fail', 'curl 不可用——README 前置要求'))
  }

  return { title: '依赖', status: sectionStatus(lines), lines }
}

function localConfigSection(configPath: string): DoctorSection {
  const lines: DoctorLine[] = []
  const cfg = readLocalNodeConfig(configPath)

  if (!cfg.found) {
    lines.push(line('warn', `${configPath} 不存在或无法解析——先运行 dsh-helm init`))
  } else {
    lines.push(line('ok', `display_name: ${cfg.display_name || '(空)'}`))
    lines.push(line('ok', `node_id: ${cfg.node_id ? redactNodeId(cfg.node_id) : '(空)'}`))
    lines.push(line('ok', `hub_url: ${cfg.hub_url || '(未设置)'}`))
  }
  lines.push(cfg.hasToken ? line('ok', 'token 已配置（不显示明文）') : line('fail', 'token 未配置——无法认证 hub，请运行 dsh-helm init'))

  return { title: '本机配置', status: sectionStatus(lines), lines }
}

async function hubSection(hubUrl: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<DoctorSection> {
  const lines: DoctorLine[] = []
  const r = await httpJson(`${hubUrl}/healthz`, { method: 'GET' }, fetchImpl, timeoutMs)

  if (!r.ok || r.error !== '') {
    lines.push(line('fail', `GET ${hubUrl}/healthz 失败：${r.error || `HTTP ${r.status}`}`))
  } else {
    const body = (r.body ?? {}) as { ok?: boolean; nodes?: number }
    lines.push(body.ok === true ? line('ok', `GET ${hubUrl}/healthz → ok=true, nodes=${body.nodes ?? 0}`) : line('fail', `GET ${hubUrl}/healthz → 响应异常：${JSON.stringify(r.body)}`))
  }
  return { title: 'hub 连通性', status: sectionStatus(lines), lines }
}

async function mcpSection(hubUrl: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<DoctorSection> {
  const lines: DoctorLine[] = []
  const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

  const init = await httpJson(
    `${hubUrl}/mcp`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-helm-doctor', version: '0.1.0' } },
      }),
    },
    fetchImpl,
    timeoutMs,
  )
  if (!init.ok) {
    lines.push(line('fail', `MCP initialize 失败：${init.error || `HTTP ${init.status}`}`))
    return { title: 'MCP', status: sectionStatus(lines), lines }
  }
  const sessionId = init.headers.get('mcp-session-id')
  if (!sessionId) {
    lines.push(line('fail', 'MCP initialize 未返回 mcp-session-id 响应头'))
    return { title: 'MCP', status: sectionStatus(lines), lines }
  }
  lines.push(line('ok', `MCP initialize 成功（session: ${sessionId}）`))

  const call = await httpJson(
    `${hubUrl}/mcp`,
    {
      method: 'POST',
      headers: { ...jsonHeaders, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nodes_list', arguments: {} } }),
    },
    fetchImpl,
    timeoutMs,
  )
  if (!call.ok) {
    lines.push(line('fail', `MCP tools/call nodes_list 失败：${call.error || `HTTP ${call.status}`}`))
    return { title: 'MCP', status: sectionStatus(lines), lines }
  }

  const result = (call.body ?? {}) as { result?: { content?: { type?: string; text?: string; isError?: boolean }[]; isError?: boolean } }
  const toolResult = result.result
  const text = toolResult?.content?.[0]?.text
  if (toolResult?.isError || text === undefined) {
    lines.push(line('fail', `MCP tools/call nodes_list 返回错误：${JSON.stringify(call.body)}`))
    return { title: 'MCP', status: sectionStatus(lines), lines }
  }
  try {
    const parsed = JSON.parse(text) as { nodes?: Array<{ display_name?: string; connected?: boolean }> }
    const nodes = parsed.nodes ?? []
    const online = nodes.filter((n) => n.connected === true).length
    lines.push(line('ok', `nodes_list → ${nodes.length} 个节点：在线 ${online} / 离线 ${nodes.length - online}`))
  } catch {
    lines.push(line('fail', `MCP tools/call nodes_list 响应不是有效 JSON：${text.slice(0, 200)}`))
  }
  return { title: 'MCP', status: sectionStatus(lines), lines }
}

async function tunnelSection(tunnelUrl: string, timeoutMs: number, fetchImpl: typeof fetch, plistPath: string | null): Promise<DoctorSection> {
  const lines: DoctorLine[] = []

  const ready = await httpJson(`${tunnelUrl}/readyz`, { method: 'GET' }, fetchImpl, timeoutMs)
  lines.push(ready.ok ? line('ok', `GET ${tunnelUrl}/readyz → ready`) : line('fail', `GET ${tunnelUrl}/readyz 失败：${ready.error || `HTTP ${ready.status}`}`))

  const live = await httpJson(`${tunnelUrl}/healthz`, { method: 'GET' }, fetchImpl, timeoutMs)
  lines.push(live.ok ? line('ok', `GET ${tunnelUrl}/healthz → live`) : line('fail', `GET ${tunnelUrl}/healthz 失败：${live.error || `HTTP ${live.status}`}`))

  if (plistPath === null) {
    lines.push(line('warn', '非 macOS，跳过 launchd plist 检查'))
  } else if (!existsSync(plistPath)) {
    lines.push(line('warn', `tunnel 服务未配置（未找到 ${plistPath}）`))
  } else {
    try {
      const id = parseTunnelIdFromPlist(readFileSync(plistPath, 'utf8'))
      lines.push(line('ok', id ? `tunnel id: ${redactTunnelId(id)}` : 'tunnel plist 存在但未解析到 tunnel id'))
    } catch (err) {
      lines.push(line('warn', `tunnel plist 解析失败：${err instanceof Error ? err.message : String(err)}`))
    }
  }
  return { title: 'tunnel', status: sectionStatus(lines), lines }
}

function servicesSection(platform: NodeJS.Platform, run: RunFn): DoctorSection {
  const lines: DoctorLine[] = []

  if (platform === 'darwin') {
    const r = run('launchctl', ['list'])
    if (!r.ok) {
      lines.push(line('warn', 'launchctl list 执行失败'))
    } else {
      const ours = r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /com\.dsh-helm\./.test(l))
      if (ours.length === 0) {
        lines.push(line('warn', '未发现 com.dsh-helm.* 服务（hub/agent 未安装为 launchd 服务）'))
      } else {
        for (const row of ours) {
          const [pid, status, ...labelParts] = row.split(/\t+/)
          const label = labelParts.join('\t') || 'unknown'
          lines.push(line(pid === '-' ? 'warn' : 'ok', `launchd: ${label}  pid=${pid}  status=${status ?? '?'}`))
        }
      }
    }
  } else if (platform === 'linux') {
    const r = run('systemctl', ['--user', 'list-units', '--all', '--no-legend'])
    if (!r.ok) {
      lines.push(line('warn', 'systemctl --user list-units 执行失败'))
    } else {
      lines.push(line(r.stdout.includes('dsh-helm') ? 'ok' : 'warn', r.stdout.includes('dsh-helm') ? '已发现 dsh-helm systemd user 服务' : '未发现 dsh-helm systemd user 服务'))
    }
  } else {
    lines.push(line('warn', '服务检查在 Windows 上未实现'))
  }
  return { title: '服务', status: sectionStatus(lines), lines }
}

function portsSection(platform: NodeJS.Platform, run: RunFn): DoctorSection {
  const ports: Array<[number, string]> = [
    [3470, 'mesh'],
    [3471, 'hub MCP'],
    [3468, 'tunnel'],
    [3457, '本地 daemon MCP'],
  ]
  const lines = ports.map(([port, name]) =>
    isPortListening(port, run, platform) ? line('ok', `${port} (${name})：监听中`) : line('warn', `${port} (${name})：未监听`),
  )
  return { title: '端口', status: sectionStatus(lines), lines }
}

// ---- 主入口 ----

const SECTION_NAMES = ['依赖', '本机配置', 'hub 连通性', 'MCP', '控制面 HA', 'tunnel', '服务', '端口']

/** 控制面 HA 一节：GET /cp-status（hub 未启用 HA 或旧版本时 warn，不判 fail）。 */
export async function haSection(hubUrl: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<DoctorSection> {
  const lines: DoctorLine[] = []
  const r = await httpJson(`${hubUrl}/cp-status`, { method: 'GET' }, fetchImpl, timeoutMs)
  if (!r.ok) {
    lines.push(line('warn', `GET /cp-status 失败：${r.error || `HTTP ${r.status}`}`))
    return { title: '控制面 HA', status: sectionStatus(lines), lines }
  }
  const ha = r.body as { cpId?: string; role?: string; phase?: string; term?: number; leaderId?: string; writeMode?: string; quorum?: boolean; leaseEpoch?: number; peers?: Array<{ connected?: boolean }>; syncOk?: boolean; failoverCount?: number }
  const peers = ha.peers ?? []
  const connected = peers.filter((p) => p.connected === true).length
  lines.push(line('ok', `cpId=${ha.cpId ?? '?'} role=${ha.role ?? '?'} phase=${ha.phase ?? '?'} term=${ha.term ?? '?'} leader=${ha.leaderId ?? '?'}`))
  lines.push(line(ha.writeMode === 'readwrite' ? 'ok' : 'warn', `writeMode=${ha.writeMode ?? '?'} · quorum=${ha.quorum ?? '?'} · leaseEpoch=${ha.leaseEpoch ?? '?'}`))
  lines.push(line(ha.syncOk ? 'ok' : 'warn', `peers ${connected}/${peers.length} connected · syncOk=${ha.syncOk ?? '?'} · failover=${ha.failoverCount ?? 0} 次`))
  return { title: '控制面 HA', status: sectionStatus(lines), lines }
}

export async function runDoctor(_argv: string[], opts: DoctorOptions = {}): Promise<number> {
  const hubUrl = opts.hubUrl ?? 'http://127.0.0.1:3471'
  const tunnelUrl = opts.tunnelHealthUrl ?? 'http://127.0.0.1:3468'
  const configPath = opts.nodeConfigPath ?? join(process.env.HOME ?? '.', '.dsh', 'helm', 'node.json')
  const timeoutMs = opts.timeoutMs ?? 5000
  const fetchImpl = opts.fetchImpl ?? fetch
  const run = opts.run ?? runCommand
  const platform = opts.platform ?? process.platform
  const tailscaleCli = opts.tailscaleCli === undefined ? findTailscaleCli() : opts.tailscaleCli

  const sections: DoctorSection[] = [
    depsSection(platform, run, tailscaleCli),
    localConfigSection(configPath),
    await hubSection(hubUrl, timeoutMs, fetchImpl),
    await mcpSection(hubUrl, timeoutMs, fetchImpl),
    await haSection(hubUrl, timeoutMs, fetchImpl),
    await tunnelSection(tunnelUrl, timeoutMs, fetchImpl, platform === 'darwin' ? opts.tunnelPlistPath ?? join(process.env.HOME ?? '.', 'Library', 'LaunchAgents', 'com.dsh-helm.tunnel-client.plist') : null),
    servicesSection(platform, run),
    portsSection(platform, run),
  ]

  const width = Math.max(...SECTION_NAMES.map((s) => s.length))
  const sep = '─'.repeat(Math.max(24, width + 6))
  const out: string[] = ['dsh-helm doctor — 诊断报告（只读）', sep]
  for (const s of sections) {
    out.push('', `## ${s.title}`)
    for (const l of s.lines) out.push(`- [${l.status}] ${l.text}`)
  }
  const ok = sections.filter((s) => s.status === 'ok').length
  const warn = sections.filter((s) => s.status === 'warn').length
  const fail = sections.filter((s) => s.status === 'fail').length
  const verdict = fail > 0 ? `存在 ${fail} 个 FAIL 项，需要处理` : warn > 0 ? `${warn} 个 WARN 项，可继续但建议处理` : '全部正常'
  out.push('', `${ok} 项 ok · ${warn} 项 warn · ${fail} 项 fail → ${verdict}`)
  console.log(out.join('\n'))
  return fail > 0 ? 1 : 0
}