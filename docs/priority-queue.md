# P4 设计评审：纠错指令插队 —— sessions_interrupt / priority queue 可行性

> 状态：设计评审（2026-08-24）。按用户要求"先设计评审，不一定立即大改"，
> 本文档只做调研与方案设计，不包含实现。评审通过后再实施。

## 1. 问题定义

ChatGPT ↔ DSH MCP Connector 链路中，一个长任务（如大上下文代码生成）正在运行
时，用户/上游发来**后续纠错指令**。当前行为：

1. `sessions_prompt` 是异步投递（返回 `accepted:true`），新指令进入 DSH 会话队列排队；
2. 队列 FIFO，长任务不结束，纠错指令就一直排队，**无法插队**；
3. 用户只能等长任务跑完（可能数分钟），或手动 `sessions_cancel` 把当前回合整个打断
   （丢失进行中的结果，之后需要重发指令）。

目标：让后续纠错指令能够**及时干预**当前生成，而不是干等或整回合丢弃。

## 2. DSH 侧能力调研（已实测/已确认）

| 能力 | 行为 | 证据 |
|---|---|---|
| `session.prompt`（经 DSH MCP `sessions_prompt`） | 异步投递，返回 accepted；队列 placement 三态 `queued` / `steering` / `context` | dsh 源码 + TG 桥 v6.2 线上实测（2026-08-21） |
| `mode:'steer'` | **运行中注入**纠偏：打断当前生成、以新指令重定向，不丢弃上下文；steer 窗口关闭时返回 `rpc_code=steer-unavailable`（区别于 session-not-found） | TG 桥 v6.2 线上实测 |
| `session.cancel`（DSH MCP `sessions_cancel`） | 打断当前回合，结果作废（reason.kind=aborted） | TG 桥 v6.3.3 实测 |
| `session.history` 分页 `beforeSeq` | 页内升序、页间新→旧 | TG 桥 v6.3.3 实测 |

结论：**DSH 本身已有队列与插队机制**（steer），hub/agent 不需要自造队列。

## 3. 现状缺口（dsh-helm 侧）

- `packages/hub/src/mcp/tools.ts`：`sessions_prompt` schema 只有
  `{session_id, message, target_node}`——**没有 mode 参数**；
- `packages/node-agent/src/agent.ts` PROMPT handler：
  `backend.callTool('sessions_prompt', { session_id, message })`——**不透传 mode**；
- `sessions_cancel` 已存在（写工具集 WRITE_TOOLS 内，HA 双 CP 下走 leader 转发）。

即：DSH 的 steer 能力在 dsh-helm 链路里**被丢弃**。这是"纠错无法插队"的直接原因。

## 4. 方案设计

### 方案 A（推荐）：透传 `mode`，不新增工具

- hub `sessions_prompt` schema 增加可选参数 `mode: 'normal' | 'steer'`（默认 `normal`，
  缺省行为不变 → 向后兼容）；
- agent PROMPT handler 把 `mode` 透传给 DSH `sessions_prompt`；
- 上游（ChatGPT connector / 后续编排层）在**检测到目标 session 正在生成**时，
  用 `mode:'steer'` 发纠错指令；
- 返回值透传 DSH 语义：`steer-unavailable`（窗口关闭）→ 调用方回退普通排队。

改动量：hub schema 1 处 + agent 透传 1 处 + 测试。风险最低，完全兼容。

### 方案 B：新增 `sessions_interrupt` 工具

- `sessions_interrupt {session_id, message?}`：语义="打断当前生成"。
- 实现 = `sessions_cancel` +（message 存在时）`sessions_prompt mode:'steer'` 的封装；
- 优点：语义显式、便于 connector 编排（不用知道 steer 细节）；
- 缺点：与方案 A 功能重叠；"先 cancel 再 prompt" 有窗口（cancel 后新指令仍可能排队）。
  **cancel 不推荐作为插队手段**（丢弃进行中结果），仅作为"停止"语义保留。

### 方案 C：hub 级 priority queue（不推荐）

- hub/agent 自建消息队列、按优先级重排 DSH 投递顺序；
- **否决理由**：① DSH 队列三态（queued/steering/context）已覆盖投递语义，hub 再排队是
  重复实现且看不到 DSH 内部执行状态，无法正确判断"该插还是该排"；② 增加 hub 状态
  与 HA 同步负担（队列状态要跨 CP 复制）；③ 与"不重构、兼容层"原则冲突。

## 5. 验收口径（评审通过后的实施计划）

1. hub `sessions_prompt` 支持 `mode`（schema + 透传），旧调用（无 mode）行为逐字节不变；
2. agent 测试：fake backend 断言 `mode:'steer'` 被透传；缺省时参数不变；
3. 真实 smoke：对运行中 session 发 `mode:'steer'`，验证打断生效
   （steer-unavailable 或 steering 态返回）；
4. `sessions_interrupt`（方案 B）视 connector 编排需要再决定是否实施——**默认不做**，
   避免与 steer 语义重叠；文档保留。

## 6. 与 P0-P3 的关系

- 本方案独立于 Context Isolation（P0-P3），不依赖 summary/guard/metrics；
- 建议实施顺序：P0-P3 验收后单独评审实施 P4（避免一次改动面过大）。
