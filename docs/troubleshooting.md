# dsh-helm 故障排查手册

按「症状 → 排查 → 解决」组织，覆盖接入链路（tunnel/连接器/hub/节点/网络）的真实踩坑。全部条目均来自实际部署验证。相关文档：[architecture.md](architecture.md)、[chatgpt-tunnel-setup.md](chatgpt-tunnel-setup.md)、[chatgpt-connector.md](chatgpt-connector.md)、[onboarding.md](onboarding.md)。

## 0. 排查思路（先定层，再动手）

```
ChatGPT Web → OpenAI Tunnel → tunnel-client → hub MCP(3471) → mesh(3470) → node-agent → daemon(3457) → DSH
     [连接器]      [平台]        [本机进程]         [控制面]          [网络]        [节点进程]      [本地DSH]
```

症状出现时先判断在哪一段：插件页问题多半在「平台/tunnel 绑定」；tunnel not ready 在「tunnel-client ↔ hub」；节点 offline 在「mesh/agent」；工具调用失败在「hub 路由/节点 daemon」。

## 1. Tunnel 一直 not ready（连接器探活失败）

- **症状**：ChatGPT 连接器一直显示不可用/未就绪；tunnel-client 日志反复出现：
  `mcp probe failed: sending "notifications/initialized": Bad Request`
- **原因**：**旧版 hub 的 bug**——连接器探活时 hub 对 `notifications/initialized` 返回 400，导致 tunnel 永远 not ready。不是网络问题。
- **排查**：`grep -i "notifications" <tunnel-client 日志>`；确认 hub 版本（`git log` 是否含 `b50ea66 fix(hub): accept Streamable HTTP notifications`）。
- **解决**：**升级 hub 到含修复版本**（当前 main 已修：`notifications/*` 返回 **202 Accepted**）。升级后重启 hub 与 tunnel-client，探活即通过。

## 2. 插件页「隧道」选择器看不到 tunnel

- **症状**：OpenAI Platform 里 tunnel 已创建，但 ChatGPT 插件页的隧道下拉里没有它。
- **原因**：**tunnel 未绑定 ChatGPT Workspace**——选择器只列出已绑定当前 workspace 的 tunnel。
- **排查**：Platform → Tunnels → 点进该 tunnel → Edit，看 ChatGPT workspaces 是否为空。
- **解决**：Edit tunnel → **ChatGPT workspaces** 选 workspace id（形如 `cd65baf6-5dcc-4916-88ef-ef7a1fafacc0`）→ 保存 → 刷新插件页。详见 [chatgpt-tunnel-setup.md §3](chatgpt-tunnel-setup.md#3-绑定-chatgpt-workspace最关键漏了看不到-tunnel)。

## 3. api.openai.com 轮询超时（context deadline exceeded）

- **症状**：tunnel-client 日志反复 `context deadline exceeded`，控制面连不上，连接器 not ready。
- **原因**：中国大陆/公司网络直连 api.openai.com 不通（或极不稳定）。
- **解决**：走本地代理（三件配套，缺一不可）：
  ```bash
  export HTTPS_PROXY=http://127.0.0.1:7897   # 示例代理端口，按本机实际
  export NO_PROXY=127.0.0.1,localhost        # 防止本地 MCP 流量绕代理
  tunnel-client run ... --control-plane.http-proxy env:HTTPS_PROXY ...
  ```
  详见 [chatgpt-tunnel-setup.md §5](chatgpt-tunnel-setup.md#5-网络代理中国大陆公司网络必读)。

## 4. 节点 registered 但 offline（半开连接）

- **症状**：`nodes_list` 里节点 `status: offline` / `channel: lease-expired`，`last_seen` 停在某个时间不再更新；节点机上 agent 进程还在跑，日志停在心跳失败处。
- **原因**：hub 被杀或网络瞬断时，agent 的 WebSocket **半开**（`onclose` 不触发）；**旧版 agent 心跳超时只记日志不重连** → 节点永久 offline。
- **排查**：agent 日志是否有 `heartbeat failed` 且之后无重连记录；`nodes_list` 看 `connected`/`last_seen`。
- **解决**：
  - **升级 agent**（新版已修：心跳 RPC 10s 超时 + `heartbeat-failed` 自动进入重连，指数退避 1s→30s + jitter，重连后全量 re-register + reconcile）——此后此类故障自愈；
  - 手动恢复（立即生效）：`launchctl kickstart -k gui/$(id -u)/com.dsh-helm.node-agent`
  - 顺便确认 hub 侧还活着：`./scripts/health.sh` 看 control/channel 层。

## 5. Tailscale 通但端口不通

- **症状**：两台机器 `tailscale status` 互见、`tailscale ping` 通，但 agent 连 hub 失败（connection refused / timeout）。
- **排查**（在 hub 机与节点机分别做）：
  ```bash
  tailscale status                 # 确认同一 tailnet、IP 正确
  nc -zv <tailnet-ip> 3470         # 节点机测 hub mesh 端口；不通 → 见下
  ```
- **原因与解决**：
  1. **hub 只绑了 127.0.0.1**（默认）→ 用 `dsh-helm hub --bind <tailnet-ip> --mcp-bind 127.0.0.1` 绑定 tailnet IP，MCP 保持 loopback（`--mcp-bind` 把两个监听解耦）；
  2. **hub 只绑 tailnet IP 时，本机 agent 的 `hub_url` 也要用 tailnet IP**——loopback 与 tailnet IP 是两个监听面，别混；
  3. 系统防火墙/安全软件拦了入站 3470 → 放行（macOS：系统设置 → 网络 → 防火墙；公司管控机可能还有 MDM 策略）；
  4. Tailscale ACL 没放开 3470 → 在 tailnet 管理台放行（见 [security.md](security.md)）。

## 6. 多连接器 vs 单 hub 连接器（选型）

- **症状**：纠结「每台机器一个 tunnel+连接器」还是「一个 hub tunnel+连接器管全部」。
- **结论**：
  - 每台 daemon 一个 tunnel+连接器：N 个入口、各管各、互不影响，但对话里要手动切连接器，无路由与溯源；
  - **一个 hub tunnel + 一个连接器管 N 台节点（推荐）**：单入口，hub 按 `target_node`/路由规则分发，回复带 `_route.node_name` 标注来源；代价是入口单点。
  - 取舍表与适用场景见 [chatgpt-connector.md §6](chatgpt-connector.md#6-多连接器-vs-单-hub-连接器拓扑取舍)。

## 7. MCP 直接 curl 返回空/报错

- **症状**：不经过 ChatGPT，直接 `curl -X POST http://127.0.0.1:3471/mcp -d '{"method":"tools/list"}'` 返回空或报错。
- **原因**：hub MCP 是 **Streamable HTTP**，必须先 `initialize` 拿 `mcp-session-id`，后续请求带该 header；跳过 initialize 直接 tools/list 属于未建立会话，行为未定义。
- **解决**：完整序列（会话 id 在 initialize 响应头 `mcp-session-id`）：
  ```bash
  # 1. initialize（保存响应头里的 mcp-session-id）
  curl -i -X POST http://127.0.0.1:3471/mcp -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
  # 2. 后续请求带 mcp-session-id（示例；也可用 scripts/health.sh --json 直接看聚合结果）
  curl -X POST http://127.0.0.1:3471/mcp -H 'content-type: application/json' \
    -H 'mcp-session-id: <上一步的id>' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"nodes_list","arguments":{}}}'
  ```
  日常查看节点状态直接用 `./scripts/health.sh`（内部已处理 initialize）。

## 8. 握手失败（handshake failed）

| 错误 | 原因 | 解决 |
|---|---|---|
| `-32002 AUTH_FAILED` | token 不匹配 / hub 未注册该 node_id / 节点被 block | 核对 `node.json` 的 token 与 hub 侧 `DSH_HELM_TOKEN`（`./scripts/register-node.sh <node_id> <token>` 可幂等重注册）；改完重启 hub 与 agent |
| `-32001 VERSION_MISMATCH` | 协议版本不一致（hello.v ≠ hub schemaVersion） | 两端升级到同一版本；**绝不静默降级** |
| `unknown node` | node_id 不在 token 表 | hub 机 `register-node.sh` 注册后再连 |

## 9. 路由拒绝

| 错误 | 含义 | 解决 |
|---|---|---|
| `route_confirmation_required` | destructive/write 操作无明确目标且无 presence/default 兜底（fail-closed 正常工作） | 带上 `target_node`（或先 `presence_claim` pin 节点）；先用 `route_explain` 预演 |
| `no_route` | 只读操作也无目标 | 检查节点是否在线（lease）、presence 是否过期；`presence_claim` 或 `target_node` |
| `unknown_node` | `target_node` 拼错/未注册 | `nodes_list` 拿真实 node_id |
| `node_unavailable` | 路由选中的节点无活动连接 | 等重连或换目标；`node_get` 看分层健康 |

## 10. 本地桥故障（local probe failed / adapter-unreachable）

- **症状**：节点 channel 正常但 adapter/datapath 层 down；agent 日志 `local probe failed`。
- **原因**：本机 helm daemon 没起 / `local_mcp_token` 不对 / daemon 重启后 token 变了。
- **排查与解决**：
  ```bash
  curl -s http://127.0.0.1:3457/healthz        # daemon 是否活着
  # 核对 node.json 的 local_mcp_token 与 ~/.agent-chatgpt-helm/token 一致
  # daemon token 泄露/丢失：删 ~/.agent-chatgpt-helm/token 让 daemon 重建，并同步 node.json
  ```
- serena 未连属于 `serena-disconnected`（degraded，不算 down），按需重启本地 DSH。

## 11. 其他常见问题

| 症状 | 原因 | 解决 |
|---|---|---|
| ChatGPT 里看不到新节点/新工具 | 连接器还指向旧入口（daemon 3457）而非 hub MCP 3471 | tunnel-client 的 `--mcp.server-url` 改为 `http://127.0.0.1:3471/mcp`；单机兼容模式下入口必须是 hub |
| 节点一直 `reconnecting` | hub 未启动/端口错/退避中 | hub 机确认 `dsh-helm hub` 在跑（`lsof -nP -iTCP:3470 -sTCP:LISTEN`）；等退避重连或 kickstart agent |
| `ws connection refused` | hub 没起 / 端口错 / SSH 隧道没建 | 见上；SSH 隧道场景确认 `ssh -L` 存活 |
| 节点显示 `blocked` | 身份冲突/版本不兼容被运维封锁 | hub 侧 `unblock` 恢复（回 offline 重新注册），或升级后重启 |
| `handshake failed` 后节点反复重试 | token 表未更新 | 见 [§8](#8-握手失败handshake-failed) |

## 12. 升级 hub/agent 后仍异常

- 半开/探活类修复（§1、§4）都在 **main 分支**：升级后务必**同时重启** hub、agent、tunnel-client 三个进程，别只升不重启；
- 升级后先跑 `./scripts/verify.sh` 与 `./scripts/health.sh`，确认 control/channel/adapter/datapath 分层全绿再继续。

---

*维护约定：本手册的症状与修复对应 `packages/` 实现与 scripts/；若实现变更，请同步更新本文与 [architecture.md](architecture.md)。*
