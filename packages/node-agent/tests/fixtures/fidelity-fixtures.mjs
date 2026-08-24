/**
 * Session 瘦身信息保真验收 —— 三类 fixture 唯一事实源（2026-08-24）。
 *
 * 每条消息 { seq, time, role, text }，与 DSH 0.1.1 sessions_get 的 messages
 * 元素同构。固定 seed 生成、内容模板固定 → 字节数/token 可复现。
 *
 * 每类 1000 条消息；关键事实分「远端」（<980 条，验证默认摘要窗口外丢失）
 * 与「近端」（>=980 条，验证窗口内保留）。token 估算方式：字符数/4（与
 * summary.ts tokenEstimate 一致）。
 */

/** 三个 fixture 的 key。 */
export const FIXTURE_KINDS = ['long-task', 'tool-heavy', 'high-risk']

/**
 * 固定地面真相（ground truth）——下游决策评分依据。
 * 纯 JS 模块（评审脚本与 vitest 共用）：字段含义见 JSDoc 上方注释。
 * @type {Record<string, {goal:string, decision:string, todo:string, next_action:string,
 *   commit?:string, path?:string, error?:string, retry_ok?:boolean, tests?:string,
 *   pushed?:boolean, redline?:string, needs_confirm?:boolean, failure?:string,
 *   pending?:string, secret?:string, secret_absent:true}>}
 */

export const GROUND_TRUTH = {
  'long-task': {
    goal: '实现 fund-sync 的 --apply 模式（当前只有 --dry-run）',
    decision: '状态存储用 sqlite，不用 JSON 文件',
    todo: '完成后更新 README 的 CLI 章节',
    next_action: '先跑 lint 和测试，通过后再提交',
    secret_absent: true,
  },
  'tool-heavy': {
    goal: '修复同步重试逻辑并推送',
    decision: '重试退避用指数退避（1s/2s/4s）',
    todo: '补充 TestSyncRetry 单测',
    next_action: '修复 TestSyncRetry 失败并重跑全量测试',
    commit: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    path: '/src/fund-sync/main.go',
    error: 'dial tcp 127.0.0.1:5432: connect: connection refused',
    retry_ok: true,
    tests: '12 passed, 1 failed',
    pushed: true,
    secret_absent: true,
  },
  'high-risk': {
    goal: 'staging 灰度验证后部署',
    decision: '灰度比例 10% 起步',
    todo: '记录灰度观察指标',
    next_action: '等待用户确认灰度比例后执行部署',
    redline: '绝不要在生产库执行 DROP/TRUNCATE',
    needs_confirm: true,
    failure: '上次部署失败原因：磁盘空间不足，已清理 /var/tmp 释放 12GB',
    pending: 'staging 灰度比例 10% 是否合适（未确认）',
    secret: 'sk-test-secret-12345',
    secret_absent: true,
  },
}

/** 确定性伪随机（不依赖 Math.random，保证可复现）。 */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

/** 每类填充一轮对话（user→assistant 交替）。 */
function filler(rand, i, kind) {
  const topics =
    kind === 'long-task'
      ? ['继续实现 --apply 的写入路径', '处理 sqlite 迁移', '补充 --apply 的日志输出']
      : kind === 'tool-heavy'
        ? ['执行 go build ./...', '运行 go vet', '跑 go test -run TestSync']
        : ['检查 staging 磁盘水位', '核对变更集清单', '回滚演练记录']
  const topic = topics[i % topics.length]
  const user = i % 2 === 0
  return [
    { seq: 0, time: 0, role: 'user', text: user ? topic : `继续：${topic}` },
    { seq: 0, time: 0, role: 'assistant', text: user ? `好的，已处理：${topic}` : `处理中：${topic}（第 ${i} 轮）` },
  ]
}

/** 生成 1000 条消息（精确槽位模型：事实固定在目标 seq，可复现）。 */
export function buildFixtureMessages(kind, count = 1000) {
  const rand = rng(kind.length * 7919 + 17)
  const msgs = []
  let seq = 0
  const push = (role, text) => {
    msgs.push({ seq: seq, time: 1700000000000 + seq * 1000, role, text })
    seq++
  }

  // ① 全部槽位先填填充轮
  const topics =
    kind === 'long-task'
      ? ['继续实现 --apply 的写入路径', '处理 sqlite 迁移', '补充 --apply 的日志输出']
      : kind === 'tool-heavy'
        ? ['执行 go build ./...', '运行 go vet', '跑 go test -run TestSync']
        : ['检查 staging 磁盘水位', '核对变更集清单', '回滚演练记录']
  const fill = () => {
    const i = Math.floor(seq / 2)
    push(seq % 2 === 0 ? 'user' : 'assistant', seq % 2 === 0 ? '收到' : `好的（第 ${i} 轮）`)
  }
  while (seq < count) fill()

  // ② 覆盖远端关键事实槽位（固定 seq）
  const at = (seqIdx, role, text) => {
    msgs[seqIdx] = { seq: seqIdx, time: 1700000000000 + seqIdx * 1000, role, text }
  }
  const LONG = GROUND_TRUTH['long-task']
  const TOOL = GROUND_TRUTH['tool-heavy']
  const RISK = GROUND_TRUTH['high-risk']
  if (kind === 'long-task') {
    at(2, 'user', `${LONG.goal}（第 5 条，远端）`)
    at(50, 'user', `${LONG.decision}（第 50 条，远端）`)
    at(150, 'user', `${LONG.todo}（第 150 条，远端）`)
    at(985, 'user', `下一步：${LONG.next_action}（第 985 条，近端窗口内）`)
    at(990, 'assistant', '好的，先跑 lint 和测试（第 991 条）')
  } else if (kind === 'tool-heavy') {
    at(2, 'user', `目标：${TOOL.goal}（第 5 条，远端）`)
    at(700, 'assistant', `生成文件 ${TOOL.path}（第 700 条）`)
    at(750, 'assistant', `命令输出：Error: ${TOOL.error}（第 750 条）`)
    at(760, 'assistant', '重试后连接成功（第 760 条，重试成功）')
    at(940, 'assistant', `commit ${TOOL.commit}（message: fix sync retry）（第 940 条，max_messages=100 可达）`)
    at(950, 'assistant', 'git push origin main 成功（第 950 条）')
    at(985, 'assistant', `测试结果：${TOOL.tests}（TestSyncRetry）（第 985 条，近端窗口内）`)
    at(990, 'user', '修复 TestSyncRetry 失败（第 995 条，近端窗口内）')
  } else {
    at(200, 'user', `${RISK.redline}（第 200 条，远端红线）`)
    at(300, 'user', '部署前必须等我明确确认，不要自动部署（第 300 条，远端）')
    at(400, 'assistant', `${RISK.failure}（第 400 条，远端失败记录）`)
    at(500, 'assistant', `配置样例：API_KEY=${RISK.secret}（仅测试环境，勿外传）（第 500 条）`)
    at(985, 'user', `未确认事项：${RISK.pending}（第 985 条，近端窗口内）`)
    at(990, 'assistant', '等待确认，未执行部署（第 990 条，近端状态）')
  }
  return msgs
}

/** 固定统计：每类 fixture 的字节数与估算 token（可复现）。 */
export function fixtureStats(kind, count = 1000) {
  const msgs = buildFixtureMessages(kind, count)
  const bytes = Buffer.byteLength(JSON.stringify(msgs), 'utf8')
  const chars = msgs.reduce((acc, m) => acc + m.text.length, 0)
  return { bytes, tokens: Math.max(1, Math.round(chars / 4)) }
}
