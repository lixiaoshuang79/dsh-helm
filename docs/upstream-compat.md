# 上游兼容基线（upstream compatibility baseline）

> 本文档是 dsh-helm 控制平面与上游 **beforewave helm** 的兼容契约。控制平面
> **不 fork、不修改、不 clone** 上游源码——只依赖「本地每台机器上已安装的
> helm daemon 的标准 MCP 接口」与「ChatGPT 侧已知的 19 工具面」。

## 1. 上游版本基线（记录用，不要求 clone）

| 包 | 版本 | 来源 | 备注 |
|---|---|---|---|
| `@beforewave/agent-chatgpt-helm` | 0.1.1 | npm registry tarball | gitHead=`e78943baa640efe6d947ef2d6e69cb818b63a8b8`（源码仓库私有/404，版本号+gitHead 仅作基线记录） |
| `@beforewave/dsh-chatgpt-helm` | 0.1.1 | npm registry tarball | DSH 侧插件（daemon 的 MCP server 由它提供） |

基线事实：上游 `lib/` 为 esbuild 压缩产物，`.d.ts` 是权威 API 面；**19 个 MCP
工具**（见 §3）即 ChatGPT 隧道已暴露的完整工具面。

> 若日后上游发布正式 multi-adapter node extension，dsh-helm 只需替换
> node-agent 的 `LocalHelmBackend` 实现（默认 `McpLocalHelmBackend`），
> Hub 的 protocol/registry/router 零改动。

## 2. 集成边界（standalone overlay，零源码依赖）

```
ChatGPT ──tunnel──▶ Hub (MCP 3471, 24 tools)
                        │  WS JSON-RPC v1 (authenticated, outbound dial)
                        ▼
                Node Agent (每台机器)
                        │  standard MCP: initialize / tools/list / tools/call
                        ▼
                local helm daemon MCP (127.0.0.1:3457/mcp, Bearer token)
                        │
                        ▼
                本机 DSH（SerenaRuntime / sessions / workspaces）
```

- **Node Agent 只连本地 daemon 的标准 MCP**：`http://127.0.0.1:3457/mcp`，
  Bearer token 从 `~/.agent-chatgpt-helm/token`（0600）读取——**不进 argv、
  不进日志**。
- **Hub 暴露自己的 MCP tool schemas**：镜像/兼容上游 19 工具，增
  `target_node` 可选参数 + `nodes_list/node_get/route_explain/presence_claim/
  presence_release`；内部转发时把 `target_node` 从参数**剥离**，不传给旧
  local helm。
- **code affinity 天然解决**：`code_use_workspace` + 后续 `code_*` 由 Router
  送到 workspace owner 节点，在该节点自己的 SerenaRuntime 上执行。
- **local compatibility mode**：Hub 把本机 Node Agent 当 local node；无多节点
  配置时行为等价单节点 connector。

## 3. 19 工具兼容面（schema 快照）

Hub 的 `packages/hub/src/mcp/tools.ts` 定义 24 工具；其中 19 个与上游一致
（snake_case 参数），契约测试（`contract-19tools.test.ts`）保证：

1. 静态：19 工具名 + 关键参数与快照一致；
2. 动态：Node Agent 上报的 `tools.list`（来自本地 daemon）与 Hub 兼容面对齐
   ——本地有而 Hub 没有的工具会被**透传**（generic `tools.call`），Hub 有而
   本地没有的（如新控制面工具）由 Hub 本地处理，绝不硬绑上游源码。

| # | 工具 | 类别 |
|---|---|---|
| 1-8 | `code_read_file` / `code_list_dir` / `code_find_file` / `code_search_for_pattern` / `code_get_symbols_overview` / `code_find_symbol` / `code_find_referencing_symbols` / `code_use_workspace` | code（workspace 亲和） |
| 9 | `projects_list` | 只读发现 |
| 10 | `supervisor_health` | 只读健康 |
| 11 | `agents_list` | 只读发现 |
| 12 | `workspaces_list` | 只读发现 |
| 13-19 | `sessions_create` / `sessions_list` / `sessions_get` / `sessions_resume` / `sessions_prompt` / `sessions_wait` / `sessions_cancel` | session |

## 4. 兼容性验证方式

- 契约测试（自动化）：`packages/hub/tests/contract-19tools.test.ts` + Node
  Agent 动态 `tools.list` 上报对比。
- 真机验证（最终门禁）：双机部署后，ChatGPT 对话直接调 19 工具，确认
  session/code 调用经 Hub 路由到正确节点的本地 helm。
- 上游升级：仅当上游工具面变化时更新快照；控制面协议（WS JSON-RPC v1）与
  上游无关，不受影响。
