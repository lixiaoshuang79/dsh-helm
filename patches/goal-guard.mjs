#!/usr/bin/env node
/**
 * goal-guard patch —— 禁止 ChatGPT 网页版指令在 DSH 里开启 goal
 *
 * 背景（2026-08-25 实测定位）：
 * 链路 ChatGPT 网页版 → tunnel → hub → node-agent → helm daemon(3457) → DSH 插件
 * @beforewave/dsh-chatgpt-helm 的 DshAdapter.prompt() 把消息以
 * `source:{kind:"user"}` 注入 DSH 会话 —— 伪装成「直接人类输入」。
 * 而 DSH 的 create_goal 权威校验（dsh-tool-goal requireDirectHuman）只认
 * `source.kind === "user"` 的回合事件，因此 ChatGPT 一条长任务指令就能开 goal，
 * 回合结束 goal 自动注入下一段（source.kind="goal"），自主续跑、不听 ChatGPT 指挥。
 *
 * 本补丁对插件 lib/index.js 做三处修改：
 *   1. createSession initialMessage 注入：source user → plugin（form:relay）
 *   2. prompt() 消息注入：source user → plugin（form:relay）
 *   3. prompt() 注入前：会话存在 active goal 时自动 pause（disarm 自动续跑）
 *      （inject 数组补充 "goals" 服务）
 *
 * 效果：ChatGPT 发来的指令无法通过 create_goal/update_goal 的人类权威校验
 * （GOAL_TOOL_DRIVER_REQUIRED 拒绝）；存量 goal 在收到 ChatGPT 指令时被暂停，
 * 回合结束后不再自动注入下一段。本机 GUI（web）不受影响，可照常管理 goal。
 *
 * 幂等：检测到已应用则直接退出 0；应用前自动备份 .bak-goalguard-<ts>。
 * 应用后需重启 DSH web（launchd kickstart -k gui/$(id -u)/com.ashuang.dsh-web-local）
 * 才生效。插件重装/升级后重跑本脚本即可。
 *
 * 用法：node patches/goal-guard.mjs [--plugin <lib/index.js 路径>]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.HOME ?? '.'
const argPlugin = process.argv.indexOf('--plugin')
const target =
  argPlugin > -1
    ? process.argv[argPlugin + 1]
    : join(HOME, '.dsh/profiles/web/node_modules/@beforewave/dsh-chatgpt-helm/lib/index.js')

if (!existsSync(target)) {
  console.error(`[goal-guard] target not found: ${target}`)
  process.exit(2)
}

const src = readFileSync(target, 'utf8')

// ---------- 检查是否已应用 ----------
const MARKER = 'source:{kind:"plugin",plugin:"dsh-chatgpt-helm",form:"relay"}'
if (src.includes(MARKER) && src.includes('"goals"')) {
  console.log('[goal-guard] already applied, nothing to do')
  process.exit(0)
}

// ---------- 三处替换 ----------
const edits = [
  {
    // 1. createSession initialMessage 注入
    old: 'e.initialMessage?.trim()&&r.agent.followup(A({content:[{type:"text",text:e.initialMessage}],source:{kind:"user"}}))',
    new: 'e.initialMessage?.trim()&&r.agent.followup(A({content:[{type:"text",text:e.initialMessage}],source:{kind:"plugin",plugin:"dsh-chatgpt-helm",form:"relay"}}))',
  },
  {
    // 2. prompt() 消息注入 + 3. 存量 active goal 自动 pause
    old: 'async prompt(e,t){if(!t.trim())throw new Error("message must not be empty");return(await this.#o(e)).followup(A({content:[{type:"text",text:t}],source:{kind:"user"}})),{accepted:!0,sessionId:e}}',
    new: 'async prompt(e,t){if(!t.trim())throw new Error("message must not be empty");let hgs=this.ctx.get("goals");if(hgs){let hga=this.ctx.agents.get(u(e));if(hga){let hgv=hgs.get(hga);if(hgv&&hgv.phase==="active")hgs.pause(hga,{id:hgv.id,revision:hgv.revision})}}return(await this.#o(e)).followup(A({content:[{type:"text",text:t}],source:{kind:"plugin",plugin:"dsh-chatgpt-helm",form:"relay"}})),{accepted:!0,sessionId:e}}',
  },
  {
    // inject 数组补充 goals 服务
    old: 'oe=["agents","agentDefaultModel","agentPresets","sessions","sessionPersistence","workspaceRegistry"]',
    new: 'oe=["agents","agentDefaultModel","agentPresets","goals","sessions","sessionPersistence","workspaceRegistry"]',
  },
]

let patched = src
for (const { old: o, new: n } of edits) {
  const count = patched.split(o).length - 1
  if (count !== 1) {
    console.error(`[goal-guard] expected exactly 1 match, found ${count}: ${o.slice(0, 80)}...`)
    process.exit(3)
  }
  patched = patched.replace(o, n)
}

// ---------- 语法校验 ----------
const tmp = `${target}.check`
writeFileSync(tmp, patched)
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
} catch (err) {
  console.error('[goal-guard] syntax check failed, aborting (no changes written)')
  console.error(String(err.stderr ?? err))
  process.exit(4)
}

// ---------- 备份 + 写入 ----------
const bak = `${target}.bak-goalguard-${Date.now()}`
copyFileSync(target, bak)
writeFileSync(target, patched)
console.log(`[goal-guard] patched ${target}`)
console.log(`[goal-guard] backup: ${bak}`)
console.log('[goal-guard] restart DSH web to apply: launchctl kickstart -k gui/$(id -u)/com.ashuang.dsh-web-local')
