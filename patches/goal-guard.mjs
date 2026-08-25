#!/usr/bin/env node
/**
 * goal-guard patch v2 —— ChatGPT 指令禁止在 DSH 开启 goal（消息在 GUI 可见）
 *
 * 背景（2026-08-25 实测定位）：
 * 链路 ChatGPT 网页版 → tunnel → hub → node-agent → helm daemon(3457) → DSH 插件
 * @beforewave/dsh-chatgpt-helm 的 DshAdapter.prompt() 注入用户消息。DSH 的
 * create_goal 权威校验（dsh-tool-goal requireDirectHuman）只认回合内存在
 * `source.kind === "user"` 的用户消息——插件原样注入 kind:"user" 时 ChatGPT
 * 一条长任务指令就能开 goal，回合结束自动续跑、不听指挥。
 *
 * v1 把注入 source 改成 plugin（消息在 DSH GUI 不显示原文）；v2 修正为：
 *   消息以 `source:{kind:"user", relayedBy:"dsh-chatgpt-helm"}` 注入——
 *   GUI 正常显示原文、模型历史语义与本人消息一致；
 *   同时 patch dsh-tool-goal 的 hasDirectHumanInput，把带 relayedBy 标记的
 *   消息排除出「直接人类输入」判定——goal 权威依然拒绝。
 *
 * 补丁内容：
 *   A. 插件 lib/index.js：
 *      1. createSession initialMessage / prompt 注入 source 统一为
 *         {kind:"user", relayedBy:"dsh-chatgpt-helm"}
 *      2. prompt() 注入前：会话存在 active goal 时自动 pause（disarm 自动续跑）
 *      3. inject 数组补充 "goals" 服务
 *   B. DSH 核心 dsh-tool-goal lib/index.js：
 *      hasDirectHumanInput 增加 `&& event.data.source.relayedBy === void 0`
 *      （仅排除 helm 标记的消息，GUI/TG 等其他路径不受影响）
 *
 * 幂等：检测到已应用则退出 0；应用前自动备份 .bak-goalguard-<ts>。
 * 应用后需重启 DSH web（launchctl kickstart -k gui/$(id -u)/com.ashuang.dsh-web-local）
 * 才生效。DSH 升级或插件重装后重跑本脚本即可。
 *
 * 用法：node patches/goal-guard.mjs [--plugin <lib/index.js 路径>] [--tool-goal <index.js 路径>]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.HOME ?? '.'
const argOf = (flag) => {
  const i = process.argv.indexOf(flag)
  return i > -1 ? process.argv[i + 1] : undefined
}
const pluginTarget =
  argOf('--plugin') ?? join(HOME, '.dsh/profiles/web/node_modules/@beforewave/dsh-chatgpt-helm/lib/index.js')
const toolGoalTarget =
  argOf('--tool-goal') ??
  join(HOME, '.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-goal/lib/index.js')

const RELAYED = 'source:{kind:"user",relayedBy:"dsh-chatgpt-helm"}'
const PAUSE_SNIPPET =
  'let hgs=this.ctx.get("goals");if(hgs){let hga=this.ctx.agents.get(u(e));if(hga){let hgv=hgs.get(hga);if(hgv&&hgv.phase==="active")hgs.pause(hga,{id:hgv.id,revision:hgv.revision})}}'
const PROMPT_OLD = 'async prompt(e,t){if(!t.trim())throw new Error("message must not be empty");return(await this.#o(e)).followup(A({content:[{type:"text",text:t}],source:{kind:"user"}})),{accepted:!0,sessionId:e}}'
const PROMPT_OLD_V1 = 'async prompt(e,t){if(!t.trim())throw new Error("message must not be empty");return(await this.#o(e)).followup(A({content:[{type:"text",text:t}],source:{kind:"plugin",plugin:"dsh-chatgpt-helm",form:"relay"}})),{accepted:!0,sessionId:e}}'
const PROMPT_NEW = `async prompt(e,t){if(!t.trim())throw new Error("message must not be empty");${PAUSE_SNIPPET}return(await this.#o(e)).followup(A({content:[{type:"text",text:t}],source:{kind:"user",relayedBy:"dsh-chatgpt-helm"}})),{accepted:!0,sessionId:e}}`
const INJECT_OLD = 'oe=["agents","agentDefaultModel","agentPresets","sessions","sessionPersistence","workspaceRegistry"]'
const INJECT_NEW = 'oe=["agents","agentDefaultModel","agentPresets","goals","sessions","sessionPersistence","workspaceRegistry"]'

const TOOLGOAL_OLD = 'event.data.source.kind === "user"'
const TOOLGOAL_NEW = 'event.data.source.kind === "user" && event.data.source.relayedBy === void 0'

function syntaxCheck(target, content) {
  const tmp = `${target}.check`
  writeFileSync(tmp, content)
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
  } catch (err) {
    console.error(`[goal-guard] syntax check failed for ${target}, aborting (no changes written)`)
    console.error(String(err.stderr ?? err))
    process.exit(4)
  }
}

function applyEdits(target, label, edits) {
  if (!existsSync(target)) {
    console.error(`[goal-guard] target not found: ${target}`)
    process.exit(2)
  }
  let src = readFileSync(target, 'utf8')
  let changed = false
  for (const { old: o, new: n, once } of edits) {
    const count = src.split(o).length - 1
    if (count === 0 && once) continue // already in target state
    if (count < 1) {
      console.error(`[goal-guard] ${label}: expected >=1 match of ${o.slice(0, 60)}..., found ${count}`)
      process.exit(3)
    }
    src = src.replaceAll(o, n)
    changed = true
  }
  if (!changed) return false
  syntaxCheck(target, src)
  const bak = `${target}.bak-goalguard-${Date.now()}`
  copyFileSync(target, bak)
  writeFileSync(target, src)
  console.log(`[goal-guard] patched ${label}: ${target}`)
  console.log(`[goal-guard] backup: ${bak}`)
  return true
}

// ---------- A. 插件 ----------
let pluginSrc = existsSync(pluginTarget) ? readFileSync(pluginTarget, 'utf8') : ''
if (pluginSrc.includes(RELAYED) && pluginSrc.includes('"goals"')) {
  console.log('[goal-guard] plugin already applied (v2)')
} else {
  const edits = []
  // 1. prompt()：加存量 goal 自动 pause + user/relayedBy source（兼容原版/v1 两种旧态）
  if (!pluginSrc.includes('hgs=this.ctx.get("goals")')) {
    if (pluginSrc.includes(PROMPT_OLD)) edits.push({ old: PROMPT_OLD, new: PROMPT_NEW })
    else if (pluginSrc.includes(PROMPT_OLD_V1)) edits.push({ old: PROMPT_OLD_V1, new: PROMPT_NEW })
    else {
      console.error('[goal-guard] plugin prompt() shape unrecognized; aborting')
      process.exit(3)
    }
  }
  // 2. 其余 source 归一化（原版 user / v1 plugin → user+relayedBy）
  for (const o of ['source:{kind:"user"}', 'source:{kind:"plugin",plugin:"dsh-chatgpt-helm",form:"relay"}']) {
    if (pluginSrc.includes(o) && !pluginSrc.includes(RELAYED)) edits.push({ old: o, new: RELAYED })
  }
  // 3. inject 补 goals
  if (!pluginSrc.includes('"goals"')) edits.push({ old: INJECT_OLD, new: INJECT_NEW })
  applyEdits(pluginTarget, 'plugin', edits)
}

// ---------- B. DSH 核心 dsh-tool-goal ----------
let tgSrc = existsSync(toolGoalTarget) ? readFileSync(toolGoalTarget, 'utf8') : ''
if (tgSrc.includes(TOOLGOAL_NEW)) {
  console.log('[goal-guard] tool-goal already applied (relayedBy excluded)')
} else {
  applyEdits(toolGoalTarget, 'dsh-tool-goal', [{ old: TOOLGOAL_OLD, new: TOOLGOAL_NEW }])
}

console.log('[goal-guard] restart DSH web to apply: launchctl kickstart -k gui/$(id -u)/com.ashuang.dsh-web-local')
