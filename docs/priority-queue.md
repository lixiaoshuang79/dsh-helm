# P4 设计评审：纠错指令插队 —— sessions_interrupt / priority queue 可行性

> 状态：**已实施（2026-08-24）**。评审通过后按方案 A 实施并验收（commit 见 §5）。
> 实施中实测修正了评审稿两处假设：① hub 线上转发 `sessions_prompt` 走
> `NODE_METHODS.MCP_CALL`（cp.forward 统一转发），**不是** PROMPT RPC——因此 agent
> 的 MCP_CALL handler 也必须拦截（与 sessions_get 同款双入口）；② DSH 的
> `mode` 枚举**官方只有 `queue` / `steer` 两个值**（无 'normal'），且 MCP 工具层
> `sessions_prompt` 不透传 mode——steer 必须经 DSH **宿主 API**
> （`http://127.0.0.1:3080/api/session.prompt`，loopback 无鉴权）调用。

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

### 方案 A（已实施）：`mode` 透传 + 宿主 API steer，不新增工具

- hub `sessions_prompt` schema 增加可选参数 `mode: 'queue' | 'steer'`（默认 `queue`，
  缺省行为逐字节不变 → 向后兼容）；
- agent 在 MCP_CALL 与 PROMPT RPC **双入口**拦截 `sessions_prompt`：`mode:'steer'`
  时经 DSH 宿主 API `session.prompt`（`{sessionId, mode:'steer',
  content:[{type:'text',text}]}`）注入运行中回合；缺省/`queue` 走原 MCP 工具层路径；
- 返回**结构化状态**（不 throw）：
  `{status:'steered', session_was_running, accepted}` /
  `{status:'rejected', code, reason}`（DSH 明确拒绝：steer-unavailable 窗口关闭、
  session-not-found、bad-request 等）/ `{status:'unavailable', reason}`（宿主 API
  不可达/超时/响应异常）；
- 提交前用 `session.list` 的 `running` 标志探测会话运行状态（探测失败按空闲处理，
  附 `probe_error` 标注）；steer 成功后摘要缓存立即失效；
- 安全边界：steer 不绕过 DSH 的权限/审批（`approval/policy`、`permission/preset`
  sandbox 事件由 DSH 自身维持）；hub 端 danger=DESTRUCTIVE 不变；`sessions_cancel`
  仍作为"停止"语义保留，**不**推荐 cancel+prompt 拼插队（会丢弃进行中结果）。

实现：`packages/hub/src/mcp/tools.ts`（schema）、`packages/node-agent/src/steer.ts`
（新增，宿主 API 封装 + 状态机）、`packages/node-agent/src/agent.ts`（双入口分流）、
`packages/node-agent/src/config.ts`（`host_api_url`，默认 http://127.0.0.1:3080）。

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

## 5. 验收结果（2026-08-24 全部通过）

1. hub `sessions_prompt` 支持 `mode`（schema enum + 双入口透传），旧调用（无 mode）
   行为逐字节不变 ✓（e2e 断言 args 原样透传 + 单测）；
2. 两种模式测试：queue 默认走 MCP 工具层（断言无 mode 参数透传）✓；steer 走宿主 API
   （断言 envelope/payload/content blocks 形状）✓；
3. 运行中 session：集成测试 mock running=true → steered+session_was_running=true ✓；
   **真实全链路 smoke**（hub→agent→宿主 API→DSH）：长任务运行中发
   `mode:'steer'` → 返回 `{"status":"steered","session_was_running":true}`，DSH 历史
   事件流出现 `agent/inbox/spliced`（注入标记）且 turn 递增 ✓；
4. 队列顺序：queue 语义不变（DSH 队列 FIFO，agent 不干预）✓；
5. 异常恢复：宿主 API 不可达 → `unavailable`（不 throw、不毒化连接，随后 queue
   调用正常）✓；e2e broken 响应后恢复 ✓；
6. `sessions_interrupt`（方案 B）不实施，与 steer 语义重叠，文档保留。

全量测试：验收时点 387/387（47 文件），build/lint 干净（此后仓库持续演进，
最新全量结果见 [fidelity-acceptance.md](fidelity-acceptance.md) §9）。真实 smoke
用本机 DSH 0.1.1（宿主 API 3080），测试会话已 cancel 清理。

## 6. 与 P0-P3 的关系

- 本方案独立于 Context Isolation（P0-P3），不依赖 summary/guard/metrics；
- 实施顺序：P0-P3 验收后单独实施 P4（本次即按此执行）。
