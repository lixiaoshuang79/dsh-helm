/**
 * dsh-helm pair / join — 新增 DSH 设备的一次性配对（enrollment）。
 *
 * pair（在 hub 主机上运行）：
 *   调 hub 本机 loopback 端点 GET /pair/new（默认 http://127.0.0.1:3471），
 *   返回一次性配对码。明文只在创建响应中出现一次；hub 只存 sha256(code)。
 *
 * join（在新设备上运行）：
 *   1. 校验 tailscale（未安装/未登录只提示，不阻断——连接失败时错误信息会说明）；
 *   2. 生成 node_id（UUID）+ enroll 临时身份（enroll:<uuid>）；
 *   3. 连接 control plane WebSocket，走未认证 enrollment 握手：hello 带
 *      enroll 前缀 → hub 直接 welcome（跳过 HMAC challenge）→ 发送
 *      enrollment.consume { code, node_id, display_name } → 拿到长期 token；
 *   4. 写 ~/.dsh/helm/node.json（0600）；
 *   5. 提示启动 agent。
 *
 * 所有系统依赖（fetch / ws / fs / tailscale）均可注入，测试不碰真实环境。
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { ENROLL_NODE_ID_PREFIX, HUB_METHODS, HandshakeClient, PAIRING_CODE_PATTERN, RpcPeer, type MessagePeer, type WireMessage } from '@dsh-helm/protocol'
import { defaultConfigDir } from '@dsh-helm/node-agent'
import type { WebSocketLike } from '@dsh-helm/node-agent'
import { DEFAULT_PORTS, findTailscaleCli, getTailscaleIp, getTailscaleStatus } from '@dsh-helm/platform'

export const DEFAULT_PAIR_HUB_URL = 'http://127.0.0.1:3471'
export const DEFAULT_JOIN_TIMEOUT_MS = 15_000

// ---- pair ----

export interface PairRunOptions {
  /** hub MCP HTTP origin（默认 http://127.0.0.1:3471） */
  hubUrl?: string
  json?: boolean
  fetchImpl?: typeof fetch
  /** tailscale IPv4 来源（注入后测试不碰真实环境） */
  tailscaleIpFetcher?: () => string | null
}

function defaultTailscaleIp(): string | null {
  const cli = findTailscaleCli()
  if (!cli) return null
  return getTailscaleIp(cli)
}

/** dsh-helm pair：生成一次性配对码（hub 本机运行）。 */
export async function runPair(opts: PairRunOptions = {}): Promise<number> {
  const hubUrl = opts.hubUrl ?? DEFAULT_PAIR_HUB_URL
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(`${hubUrl}/pair/new`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.error(`配对码生成失败：hub /pair/new HTTP ${res.status}`)
      console.error('（pair 需要 hub 在本机运行且 MCP 绑定 127.0.0.1：dsh-helm hub）')
      return 1
    }
    const body = (await res.json()) as { code?: unknown; expiresAt?: unknown }
    if (typeof body.code !== 'string' || typeof body.expiresAt !== 'string') {
      console.error('配对码生成失败：hub 响应格式异常')
      return 1
    }
    if (opts.json) {
      console.log(JSON.stringify({ code: body.code, expiresAt: body.expiresAt }, null, 2))
      return 0
    }
    const ip = (opts.tailscaleIpFetcher ?? defaultTailscaleIp)()
    const host = ip ?? '<tailscale-ip>'
    console.log('配对码已生成（一次性，默认 10 分钟有效）：')
    console.log(`  ${body.code}`)
    console.log('在新设备上运行：')
    console.log(`  dsh-helm join --control-plane ws://${host}:${DEFAULT_PORTS.mesh} --code ${body.code}`)
    console.log(`有效期至 ${new Date(body.expiresAt).toLocaleString('zh-CN', { hour12: false })}`)
    return 0
  } catch (err) {
    console.error(`配对码生成失败：${err instanceof Error ? err.message : err}`)
    console.error('（pair 需要 hub 在本机运行且 MCP 绑定 127.0.0.1：dsh-helm hub）')
    return 1
  }
}

// ---- join ----

export interface TailscaleProbeResult {
  installed: boolean
  online: boolean
  detail: string
}

export interface JoinRunOptions {
  /** hub mesh WebSocket 地址，如 ws://100.x.y.z:3470 */
  controlPlane: string
  /** 一次性配对码（dshp- 前缀） */
  code: string
  /** node.json 目录（默认 ~/.dsh/helm；注入后测试不碰真实环境） */
  nodeDir?: string
  /** 显示名（默认 os.hostname()） */
  displayName?: string
  /** 覆盖已存在的 node.json */
  force?: boolean
  wsFactory?: (url: string) => WebSocketLike
  /** tailscale 探测（注入后测试不碰真实环境） */
  tailscaleProbe?: () => TailscaleProbeResult
  log?: (line: string) => void
  timeoutMs?: number
}

export type EnrollResult = { ok: true; token: string } | { ok: false; message: string }

function defaultTailscaleProbe(): TailscaleProbeResult {
  const cli = findTailscaleCli()
  if (!cli) return { installed: false, online: false, detail: '未找到 tailscale CLI' }
  const st = getTailscaleStatus(cli)
  if (!st.ok) return { installed: true, online: false, detail: st.error }
  const self = st.status.self
  if (!self) return { installed: true, online: false, detail: 'tailscale status 无 self 信息' }
  if (!self.online) return { installed: true, online: false, detail: `${self.hostName} 离线（请先 tailscale up）` }
  const ip = self.tailscaleIPs[0] ?? getTailscaleIp(cli) ?? ''
  return { installed: true, online: true, detail: `${self.hostName} ${ip}`.trim() }
}

function validateControlPlane(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    if (!u.hostname) return null
    return raw
  } catch {
    return null
  }
}

/**
 * 未认证 enrollment 客户端：hello(enroll:<uuid>) → welcome → RPC
 * enrollment.consume。Hub 侧对这类连接只开放这一个 RPC，成功后即断开。
 */
export function enrollClient(
  wsUrl: string,
  enrollId: string,
  params: { code: string; node_id: string; display_name?: string },
  opts: { wsFactory?: (url: string) => WebSocketLike; timeoutMs?: number; log?: (line: string) => void },
): Promise<EnrollResult> {
  const wsFactory = opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS
  return new Promise<EnrollResult>((resolve) => {
    let ws: WebSocketLike
    try {
      ws = wsFactory(wsUrl)
    } catch (err) {
      resolve({ ok: false, message: `无法创建 WebSocket 连接：${err instanceof Error ? err.message : err}` })
      return
    }
    let peer: RpcPeer | undefined
    let settled = false
    const timer = setTimeout(() => finish({ ok: false, message: '连接超时' }), timeoutMs)
    const finish = (r: EnrollResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve(r)
    }
    const sender: MessagePeer = {
      send: (m) => {
        try {
          ws.send(JSON.stringify(m))
        } catch {
          /* socket gone */
        }
      },
    }
    const handshake = new HandshakeClient(sender, enrollId, '', 1, {
      onOutcome: (o) => {
        if (!o.ok) {
          finish({ ok: false, message: `握手失败：${o.message}` })
          return
        }
        opts.log?.(`connected to hub ${o.welcome.hub_id}`)
        peer = new RpcPeer(sender, (l) => opts.log?.(l))
        peer
          .request(HUB_METHODS.ENROLLMENT_CONSUME, params, { timeoutMs: 10_000 })
          .then((res) => {
            const r = res as { ok?: boolean; token?: unknown; reason?: unknown }
            if (r.ok === true && typeof r.token === 'string' && r.token.length > 0) {
              finish({ ok: true, token: r.token })
            } else {
              finish({ ok: false, message: `配对码无效或已被使用（${String(r.reason ?? 'unknown')}）` })
            }
          })
          .catch((err: unknown) => finish({ ok: false, message: `enrollment.consume 失败：${err instanceof Error ? err.message : err}` }))
      },
    })
    ws.onopen = () => handshake.start()
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WireMessage
        if (msg.type === 'rpc') peer?.dispatchPublic(msg.body)
        else handshake.inbound(msg)
      } catch {
        /* drop unparseable frame */
      }
    }
    ws.onerror = () => finish({ ok: false, message: 'WebSocket 连接失败' })
    ws.onclose = () => {
      if (!settled) finish({ ok: false, message: 'WebSocket 连接被关闭' })
    }
  })
}

/** dsh-helm join：把本机注册为 hub 的新节点。 */
export async function runJoin(opts: JoinRunOptions): Promise<number> {
  const log = opts.log ?? console.log
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS

  // ① 参数校验
  if (!validateControlPlane(opts.controlPlane)) {
    console.error(`control plane 地址无效（需要 ws:// 或 wss://）：${opts.controlPlane}`)
    return 1
  }
  if (!PAIRING_CODE_PATTERN.test(opts.code)) {
    console.error('配对码格式无效（应为 dshp- 前缀 + 20 位字符）')
    return 1
  }

  // ② 目标 node.json 不得已存在（不覆盖现有节点身份）
  const dir = opts.nodeDir ?? defaultConfigDir()
  const target = join(dir, 'node.json')
  if (existsSync(target) && !opts.force) {
    console.error(`已存在 ${target}——拒绝覆盖现有节点身份（确认后删除该文件或加 --force 重新配对）`)
    return 1
  }

  // ③ tailscale 探测（未安装/未登录只提示，不阻断）
  const probe = opts.tailscaleProbe ?? defaultTailscaleProbe
  const ts = probe()
  if (!ts.installed) {
    log('⚠ tailscale 未安装——节点机需要组网（brew install --cask tailscale 或官网 App），join 仍将继续')
  } else if (!ts.online) {
    log(`⚠ tailscale 状态异常：${ts.detail}——join 仍将继续`)
  } else {
    log(`✓ tailscale: ${ts.detail}`)
  }

  // ④ 未认证 enrollment 连接，换取长期 token
  const nodeId = randomUUID()
  const enrollId = `${ENROLL_NODE_ID_PREFIX}${randomUUID()}`
  const displayName = opts.displayName ?? hostname()
  log(`connecting to ${opts.controlPlane} (enroll) ...`)
  const out = await enrollClient(opts.controlPlane, enrollId, { code: opts.code, node_id: nodeId, display_name: displayName }, { timeoutMs, log, wsFactory: opts.wsFactory })
  if (!out.ok) {
    console.error(`配对失败：${out.message}`)
    return 1
  }

  // ⑤ 写 node.json（0600）
  mkdirSync(dir, { recursive: true })
  const nodeConfig = {
    node_id: nodeId,
    token: out.token,
    hub_url: opts.controlPlane,
    display_name: displayName,
  }
  writeFileSync(target, JSON.stringify(nodeConfig, null, 2), { mode: 0o600 })
  chmodSync(target, 0o600)

  // ⑥ 下一步
  console.log(`✓ 配对成功：node_id=${nodeId}（display_name=${displayName}）`)
  console.log(`✓ 已写入 ${target}（0600）`)
  console.log('下一步：')
  console.log('  1. 启动 agent：dsh-helm agent')
  console.log('  2. 安装为系统服务（可选）：dsh-helm install')
  return 0
}
