# 模型门禁（ChatGPT 指令须声明 gpt-5-6-thinking）

> 2026-08-25 建立。声明式模型门禁：ChatGPT 向 DSH 下发指令前必须在消息里
> 声明当前模型，hub 校验后放行/拒绝。

## 为什么是声明式（实测依据）

「拿到 ChatGPT 的响应模型」在链路上**做不到**：

1. **协议层**：OpenAI Secure MCP Tunnel 协议（[openai/tunnel-client docs/protocol.md](https://github.com/openai/tunnel-client/blob/master/docs/protocol.md)）
   只有认证头 + 诊断元数据（`X-Tunnel-Client-Name/Version`、`X-Tunnel-MCP-Server-Info`），
   **没有任何 model 字段**；MCP 协议本身也不携带调用方模型。
2. **实测层**（2026-08-25，hub 抓 ChatGPT 真实请求全头）：只有
   `x-openai-session`（v1/... 加密对话标识）、`x-openai-subject`、spiffe 证书、
   Datadog 追踪头——没有模型名，加密串也无法解码。
3. **连接器层**：ChatGPT 连接器创建时无「可用模型」绑定选项，无法平台侧限制。

因此采用**声明式协议**：ChatGPT 总导演在每次下发指令的消息文本里声明当前模型，
hub 侧硬校验。

## 门禁规则（packages/hub/src/mcp/model-gate.ts）

| 消息文本 | 结果 |
|---|---|
| 含 `gpt-5-6-thinking`（`gpt-5.6 thinking` / `GPT 5 6 thinking` 等宽松匹配） | ✅ 放行 |
| 含 `5.5-mini`（`5.5 mini` / `5.5mini` 等） | ❌ `model_rejected`（附 received 原文） |
| 无任何模型声明 | ❌ `model_declaration_required` |

- 校验对象：`sessions_prompt(message)`、`sessions_create(initial_message)`（仅当
  initial_message 非空；不带 initial_message 的建会话放行）。
- 拒绝响应：MCP `isError: true` + JSON 文本
  `{"code":"model_rejected|model_declaration_required","required_model":"gpt-5-6-thinking","received":?,"message":"..."}`，
  ChatGPT 可读原因并按提示切换模型重试。
- 门禁在 hub 层（路由前），走 hub MCP 的任何客户端都受约束（hub MCP 只服务
  ChatGPT 隧道，语义一致）。

## ChatGPT 侧配合（总导演系统指令片段）

把以下内容放进 ChatGPT 对话的系统指令（或「总导演」角色说明），固定声明格式：

```
向 DSH 下发任何任务前，必须先以固定格式声明你当前使用的模型，
作为消息第一行（不加引号）：
[model-check] 当前模型是 <模型全名>
模型全名必须是 gpt-5-6-thinking（GPT-5.6 Thinking）。如果无法确认
或不是该模型，不要调用 DSH 连接器，直接告知用户需要切换到
GPT-5.6 Thinking。
```

若 DSH 返回 `model_rejected` / `model_declaration_required`，说明模型不是
gpt-5-6-thinking（或声明缺失）——切换到 GPT-5.6 Thinking 后重发即可。

## 已知边界

- 声明来自模型自述，5.5-mini 可能认知不准（乱报模型名）。门禁拦截的是
  「明确声明 5.5-mini」与「无声明」两类；配合 ChatGPT 网页版模型选择器人工
  确认，实际效果=5.5-mini 指令必被拦、gpt-5-6-thinking 正常放行。
- 门禁不影响 DSH 本机 GUI / TG 等其他入口（它们不走 hub MCP）。

## 验证

- 单测：`packages/hub/tests/model-gate.test.ts`（7 例：放行变体/拒绝变体/缺声明/
  拒绝文本 JSON 可解析/门禁工具集合）。
- 端到端：走 3471 MCP 发无声明指令 → `model_declaration_required`；带
  `[model-check] 当前模型是 gpt-5-6-thinking` → 正常路由。
