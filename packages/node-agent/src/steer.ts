/**
 * ChatGPT 到 DSH 指令的立即插队/纠偏（steer）——经 DSH 宿主 API 注入运行中回合。
 *
 * 协议事实（2026-08-24 对本机 DSH 0.1.1 实测）：
 * - DSH MCP 工具层（/mcp sessions_prompt）schema 无 mode 参数（additionalProperties:false），
 *   未知键被静默忽略 → mode 无法经 MCP 工具层透传；
 * - DSH 宿主 API（http://127.0.0.1:3080/api/session.prompt，loopback 无鉴权）接受
 *   payload { sessionId, mode: 'queue'|'steer', content: [{type:'text',text}] }——
 *   mode 枚举校验错误信息里官方只列 'queue'/'steer' 两值（"Invalid input: expected
 *   \"queue\"" / "expected \"steer\""）；
 * - 响应只有 { accepted: true }，不带 placement/steered 字段；
 * - 运行中会话 + mode:'steer'：真实注入（session.history 事件流出现
 *   agent/inbox/spliced 事件 + turn 递增，旧回合被中断）；空闲会话 + steer 也被接受
 *   （直接开新回合，不排队）；
 * - 提交前用 session.list 的 running 标志探测会话是否在跑（TG 桥 v6.2 同款做法）。
 *
 * 由此 dsh-helm 返回的结构化状态语义：
 *   steered     —— DSH 接受；session_was_running=true 时=注入运行中回合（绕过队列），
 *                   false 时=DSH 直接开新回合（不排队，同款立即执行语义）
 *   queued      —— mode=queue（默认）投递成功（排队语义由 DSH 队列保证）
 *   rejected    —— DSH 明确拒绝（bad-request / steer-unavailable / session-not-found 等，
 *                   带 code 与 reason）
 *   unavailable —— DSH 宿主 API 不可达 / 网络超时 / 响应异常（链路断）
 */

export type SteerStatus = 'steered' | 'queued' | 'rejected' | 'unavailable'

export interface SteerResult {
  status: SteerStatus
  /** 提交前 session.list 探测到的运行状态（探测失败按 false）。 */
  session_was_running: boolean
  /** DSH 宿主 API 是否接受（accepted:true）。 */
  accepted?: boolean
  /** rejected 时的 DSH 错误码（如 steer-unavailable / bad-request）。 */
  code?: string
  /** rejected / unavailable 的人类可读原因。 */
  reason?: string
  /** 非 DSH 拒绝的宿主调用（session.list 探测）失败原因（unavailable 时）。 */
  probe_error?: string
}

export interface SteerOptions {
  /** DSH 宿主 API base URL，默认 http://127.0.0.1:3080（DSH web backend）。 */
  hostApiUrl: string
  sessionId: string
  message: string
  /** fetch impl（测试注入）。 */
  fetchImpl?: typeof fetch
  /** 超时（ms），默认 15000。 */
  timeoutMs?: number
  log?: (line: string) => void
}

/** 单个 DSH 宿主 API RPC；ok=false 时 throw 带 rpc_code 的错误。 */
export async function hostApiRpc(
  opts: { hostApiUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  method: string,
  payload: unknown,
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const timeoutMs = opts.timeoutMs ?? 15_000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetchImpl(`${opts.hostApiUrl.replace(/\/+$/, '')}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        method,
        payload,
      }),
      signal: ac.signal,
    })
  } catch (err) {
    throw new Error(`DSH host api ${method} unreachable: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`DSH host api ${method} http ${res.status}`)
  const body = (await res.json()) as {
    type?: string
    result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
  }
  if (body.type !== 'server-response') throw new Error(`DSH host api ${method} unexpected envelope`)
  const result = body.result
  if (!result?.ok) {
    const err = new Error((result?.error?.message as string) || `${method} failed`)
    ;(err as Error & { rpc_code?: string }).rpc_code = result?.error?.code
    throw err
  }
  return result.value
}

/**
 * 提交一条 mode='steer' 的指令：先探测会话 running 状态，再经宿主 API 注入。
 * 绝不 throw——任何情况都返回结构化 SteerResult（调用方直接把结果透传给 MCP）。
 */
export async function steerPrompt(opts: SteerOptions): Promise<SteerResult> {
  const { hostApiUrl, sessionId, message, timeoutMs } = opts
  const fetchImpl = opts.fetchImpl
  const log = opts.log ?? (() => {})

  // ① 探测当前会话是否在运行（决定 steered 语义标注；探测失败按空闲处理）
  let running = false
  let probeError: string | undefined
  try {
    const listed = (await hostApiRpc({ hostApiUrl, fetchImpl, timeoutMs }, 'session.list', {})) as {
      items?: Array<{ sessionId?: string; running?: boolean }>
    }
    running = (listed.items ?? []).some((it) => it.sessionId === sessionId && !!it.running)
  } catch (err) {
    probeError = err instanceof Error ? err.message.slice(0, 160) : String(err)
    log(`[steer] session.list probe failed (${probeError}); assuming idle`)
  }

  // ② 提交 steer（DSH 接受即注入/立即开回合）
  try {
    const value = (await hostApiRpc(
      { hostApiUrl, fetchImpl, timeoutMs },
      'session.prompt',
      { sessionId, mode: 'steer', content: [{ type: 'text', text: message }] },
    )) as { accepted?: boolean }
    if (value?.accepted === true) {
      return { status: 'steered', session_was_running: running, accepted: true, probe_error: probeError }
    }
    return { status: 'rejected', session_was_running: running, accepted: false, reason: 'not accepted', probe_error: probeError }
  } catch (err) {
    const e = err as Error & { rpc_code?: string }
    if (e.rpc_code) {
      // DSH 明确拒绝（steer-unavailable 窗口关闭 / session-not-found / bad-request 等）
      return { status: 'rejected', session_was_running: running, code: e.rpc_code, reason: e.message, probe_error: probeError }
    }
    // 链路不可达 / 超时 / 响应异常
    return { status: 'unavailable', session_was_running: running, reason: e.message, probe_error: probeError }
  }
}
