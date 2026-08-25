# Goal 守卫：ChatGPT 指令禁止在 DSH 开启 goal

> 2026-08-25 建立。行为已在本机端到端验证。

## 背景与根因

链路：

```
ChatGPT 网页版 → Secure MCP Tunnel → hub MCP(3471) → node-agent → helm daemon MCP(3457)
→ DSH 插件 @beforewave/dsh-chatgpt-helm（DshAdapter）→ agent.followup(...)
```

`@beforewave/dsh-chatgpt-helm`（web profile 插件，npm 包 `beforewave/agent-chatgpt-helm` 仓库）的
`DshAdapter.prompt()` 实现（压缩产物 `lib/index.js`）：

```js
async prompt(e, t) {
  if (!t.trim()) throw new Error("message must not be empty");
  return (await this.#o(e)).followup(
    A({ content: [{ type: "text", text: t }], source: { kind: "user" } }),
  ), { accepted: !0, sessionId: e };
}
```

它把 ChatGPT 发来的消息以 `source:{kind:"user"}` 注入 DSH 会话——**伪装成直接人类输入**。

DSH 侧 `@deepseek-ai/dsh-tool-goal`（`lib/index.js`）的权威校验：

```js
function hasDirectHumanInput(ctx, execution) {
  if (!ctx.agents.roots().includes(execution.agent)) return false;
  return execution.events.some(
    (event) => event.type === "user/message" && event.data.source.kind === "user",
  );
}
function requireDirectHuman(ctx, execution) {
  if (hasDirectHumanInput(ctx, execution)) return;
  reject("this goal operation requires a direct human turn on a top-level agent");
}
```

`create_goal` / `update_goal`(edit/pause/resume) 全部走 `requireDirectHuman`。因为 helm 注入的
消息 `source.kind === "user"`，校验通过 → ChatGPT 一条长任务指令就能让 DSH 开启 goal → 回合结束
goal 自动注入下一段（`source.kind:"goal"`）自主续跑，不听 ChatGPT 指挥。

## 修复内容（patches/goal-guard.mjs，幂等）

对插件 `lib/index.js` 三处修改：

| # | 位置 | 修改 |
|---|------|------|
| 1 | `createSession` initialMessage 注入 | `source:{kind:"user"}` → `source:{kind:"plugin",plugin:"dsh-chatgpt-helm",form:"relay"}` |
| 2 | `prompt()` 消息注入 | 同上；并在注入前：会话存在 active goal 时自动 `goals.pause(agent, ref)`（disarm 自动续跑） |
| 3 | `inject` 数组 | 追加 `"goals"` 服务 |

`MessageSource` 是 merge-extensible 联合类型（内置 `user`/`plugin`/`model`/`tool`），
`plugin` 是合法来源；`hasDirectHumanInput` 只认 `user`，因此：

- 从 ChatGPT 来的指令**无法创建 goal**（`GOAL_TOOL_DRIVER_REQUIRED` 拒绝）；
- 系统提示里 goal guidance 的「direct human request」推断前提不再成立；
- 会话若已有 active goal（GUI 或其他渠道建的），收到 ChatGPT 指令时自动暂停，
  回合结束后不再自动注入下一段——ChatGPT 的指挥重新生效；
- 本机 GUI 不受影响：web 界面发消息是真正的用户输入（`source.kind:"user"`），
  可照常创建/恢复 goal。

## 应用与验证

```bash
# 应用（幂等；自动备份 .bak-goalguard-<ts>；插件重装/升级后重跑）
node patches/goal-guard.mjs

# 生效需重启 DSH web
launchctl kickstart -k gui/$(id -u)/com.ashuang.dsh-web-local
```

端到端验证（2026-08-25 实测，走 3457 MCP 真实链路）：

1. `sessions_create` 建会话，`sessions_prompt` 发「创建一个 goal 来持续优化…并自动续跑」——
   `session.history` 事件流中该消息 `source` 为
   `{"kind":"plugin","plugin":"dsh-chatgpt-helm","form":"relay"}`；全程**无 goal 创建事件**、
   回合结束**无自动续跑**。
2. 宿主 API `goal.create` 先建 active goal → `sessions_prompt` 再发指令 →
   事件流出现 `goal/change {"operation":"pause","phase":"paused","revision":+1}`（自动暂停生效）。

## 附注

- 已有 goal 的会话被 ChatGPT 指令自动暂停后，想恢复请在 DSH 本机 GUI 操作
  （ChatGPT 侧无 `update_goal` 的人类权威，无法 resume——这是本守卫的预期行为）。
- 插件升级（`@beforewave/dsh-chatgpt-helm` 换版本）会覆盖 `lib/index.js`，必须重跑
  `patches/goal-guard.mjs`；若上游修复了该问题（把 helm 注入标记为非 user 来源），
  补丁会因找不到原文而报错退出，届时删除本补丁即可。
