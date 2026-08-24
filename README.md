# dsh-helm

**DSH 多节点控制平面**：把单机「ChatGPT ↔ DSH」连接器扩展成多节点控制平面。多台机器上的 DeepSeek Harness（DSH）通过节点代理（node-agent）注册到统一 Hub，ChatGPT 经一个入口即可路由到任意节点——读写代码、管理会话、查看健康，且不暴露任何节点给公网。

```
ChatGPT Web（连接器/插件）
   │ OpenAI Secure MCP Tunnel（tunnel-client，TLS）
   ▼
Hub 控制平面     MCP 127.0.0.1:3471（ChatGPT 入口）    mesh <hub-ip>:3470（节点接入）
   │ 路由：显式 target → session owner → workspace owner → presence → default
   ├──────────────┬──────────────┬──────────────┐
   ▼              ▼              ▼              ▼
node-agent    node-agent    node-agent    node-agent   （每台机器：出站 WS + HMAC 握手）
   │              │              │              │
   ▼              ▼              ▼              ▼
daemon 3457 → DSH   daemon 3457 → DSH   ……      （各节点本地 helm daemon，Bearer 鉴权）
```

- 每个节点跑 `dsh-helm agent`：**只出站**连 hub（mesh WS），向内桥接本机 helm daemon 的 MCP（`127.0.0.1:3457/mcp`）。
- hub 是唯一入口：ChatGPT 经 hub MCP（3471）调用工具，hub 按路由策略转发到正确节点；节点数对 ChatGPT 透明。
- 单机兼容：单节点且 `node_id == hub defaultNodeId` 时，行为与单机 daemon 完全一致。

## 功能特性

- **多节点注册与心跳**：节点身份 `node_id`（UUID）+ HMAC 挑战握手；15s 心跳、45s 租约；新版 agent 心跳超时自动重连（半开连接自愈）。
- **五级路由**：`显式 target_node → session owner → workspace owner → 无歧义 presence → defaultNodeId 兜底`；destructive/write 操作目标不清晰时 **fail-closed** 拒绝（`route_confirmation_required`），绝不猜。
- **转发可溯源**：每次转发结果附带 `_route.node_name`（display_name）标注执行节点；`route_explain` 预演不执行。
- **MCP 工具面 19+5**：单机 daemon 的 19 个工具（`code_*`/`sessions_*`/`projects_list`/`supervisor_health` 等，snake_case 参数不变）原样保留，新增 `nodes_list`/`node_get`/`route_explain`/`presence_claim`/`presence_release`；所有可路由工具带可选 `target_node`。
- **presence**：手动声明（10 分钟 pin）+ macOS 前台应用自动探测（桌面 sidecar）；15s 歧义窗口内双节点高置信 → 判 ambiguous，不自动选。
- **分层健康**：control / channel / adapter / datapath / serena / tunnel 各层独立上报，绝不折叠成单一 `status: ok`。
- **跨节点聚合**：`workspaces_list`/`sessions_list`/`agents_list`/`projects_list` 返回多节点扁平结果（每条带 `node_id`）。
- **审计与路由日志**：节点注册、心跳、路由决策、presence 变更全部落库（`audit`/`route_log`）。
- **元数据红线**：hub 存储只含元数据（节点/租约/会话与工作区目录/审计），**从不存储 DSH 会话正文**。

## 目录结构

```
dsh-helm/
├── packages/
│   ├── protocol/    # wire 协议：envelope、JSON-RPC、HMAC 握手、常量
│   ├── store/       # SQLite：节点注册表、presence、目录、审计
│   ├── hub/         # 控制面：Router、WS mesh 3470、MCP 3471
│   ├── node-agent/  # 节点代理：出站 WS、重连、本地 DSH 桥
│   ├── presence/    # presence providers（手动/macOS/浏览器）
│   ├── platform/    # 跨平台适配（launchd/systemd/Windows 模板）
│   └── cli/         # dsh-helm CLI（init/agent/hub/status/nodes/…）
├── tests/integration/  # 双 fake node 端到端测试
└── scripts/            # ops 脚本（bash，macOS 优先）
```

## 快速开始

前置：Node.js >= 22.5、pnpm、curl；每台节点机先装好 DSH 与 helm daemon（`127.0.0.1:3457/mcp`，Bearer token 在 `~/.agent-chatgpt-helm/token`）。

```bash
# 1. 安装 CLI（构建 + 写 ~/.local/bin/{dsh-helm,dsh-helm-agent,dsh-helm-hub}，幂等）
./scripts/install.sh

# 2. 初始化节点身份（生成 ~/.dsh/helm/node.json，权限 0600）
dsh-helm init

# 3. 编辑 ~/.dsh/helm/node.json：设置 hub_url 与 local_mcp_token
#    hub_url：内网/Tailscale 用 ws://<hub-ip>:3470，生产用 wss://

# 4. hub 机器：启动控制面（mesh 3470 + MCP 3471；默认只绑 127.0.0.1）
dsh-helm hub
#    多机场景：dsh-helm hub --bind <tailnet-ip> --mcp-bind 127.0.0.1

# 5. 节点机器：启动 agent（先前台验证，再装自启服务）
dsh-helm agent
./scripts/install-service.sh        # macOS：launchd 服务（com.dsh-helm.node-agent）

# 6. 自检与状态
./scripts/verify.sh                 # 0 全绿 / 1 警告 / 2 严重
./scripts/health.sh                 # 节点状态表（走 hub MCP supervisor_health）
dsh-helm status                    # 本地配置与连接状态
```

**加入更多节点**：新节点机 `dsh-helm init` 后，把 `node.json` 的 `node_id` 与 `token` 经安全渠道交给 hub 管理员，在 hub 机器上执行（幂等：追加/更新 token 表，自动重载 launchd 服务）：

```bash
./scripts/register-node.sh <node_id> <token>
```

详细流程见 [docs/onboarding.md](docs/onboarding.md)。

## 接入 ChatGPT

两条路径，按部署阶段选择：

- **A. 单机直连（起步）**：本机已有 helm daemon 时，hub 把本机节点当 local node，行为与单机连接器一致，无需隧道。
- **B. 多节点（控制平面，推荐）**：OpenAI Secure MCP Tunnel 接入 hub MCP（3471），ChatGPT 一个入口管所有节点。

OpenAI Platform 侧完整教程（建 tunnel / 绑定 workspace / 建 API key / tunnel-client 参数 / 代理）见 [docs/chatgpt-tunnel-setup.md](docs/chatgpt-tunnel-setup.md)；ChatGPT Web 侧（开发者模式 / 创建连接器 / 测试）见 [docs/chatgpt-connector.md](docs/chatgpt-connector.md)。

**两种拓扑取舍**：每台 daemon 各配一个 tunnel+连接器（多入口、各管各），或一个 hub tunnel + 一个连接器管 N 台节点（单入口，推荐——hub 路由 `target_node`/路由规则，回复带 `node_name`）。

## 控制面 HA（双 Control Plane）

两台 hub 组成一个 quorum（2/2）控制面，任一台故障时另一台仍可服务读路由与节点入口。

- **角色与租约**：`--cp-priority` 小者胜出为 leader（唯一写者）；leader 每 10s 向 peer 续写租约，peer 失联超过租约 TTL（`--cp-failover-ms`，默认 45s）→ 双方进入 `read-only-no-quorum`，写操作返回 `QUORUM_LOST`。**follower 永不单方提升**——失去 quorum 时只读不写（CAP 优先安全）。
- **恢复**：peer 重连 → 注册表全量同步 → 强制重选（term+1）→ 租约双方确认 → 写恢复。整个恢复窗口内双方保持只读。
- **agent 多 endpoint**：`node.json` 配 `hub_url` + `fallback_urls`，重连时轮询尝试、成功后 pin；故障时自动切到第二 CP。
- **观测**：`GET /cp-status` 返回 `role/phase/writeMode/quorum/term/leaderId/peers/syncOk/leaseEpoch/failoverCount`；`dsh-helm doctor` 与 Dashboard「控制面 HA」卡直接展示。
- **ChatGPT 入口 HA**：OpenAI tunnel-client 的 `--mcp.server-url` 是 channel 限定、无同连接器多后端 failover。本地起 `dsh-helm ha-proxy`（默认 `127.0.0.1:3481`，`--primary http://127.0.0.1:3471 --secondary http://<peer-cp>:3471`），tunnel 仍指向**一个**连接器（3481）；主 CP 失联自动切副 CP、恢复后切回。双 tunnel + 双连接器是备选拓扑。
- **第二 CP 部署**：`dsh-helm hub --cp-peer ws://<peer-cp>:3470 --cp-priority 1 --cp-id <node-id> --cp-token-env DSH_HELM_CP_TOKEN`；两侧 `DSH_HELM_TOKEN` 都含**双方**节点 token 表（任一 agent 故障切换时对方 CP 都能认证）。MCP 需跨机可达时用 `--mcp-bind <tailnet-ip>`（Tailscale ACL 围栏，单机场景保持 loopback）。

## 设备配对（新增 DSH 设备）

Dashboard「新增 DSH 设备」→ 生成一次性配对码（10 分钟有效、单次消费、仅存哈希）；新机器执行 `dsh-helm join --control-plane ws://<hub>:3470 --code <code>` 完成入网（生成长期 node token 写入 `~/.dsh/helm/node.json`，hub 只存 hash/状态）。配对 API 仅 loopback + 防 CSRF 头；日志只记哈希前缀。详见 [docs/security.md](docs/security.md) §5。

## MCP Context Isolation（大上下文稳定性）

ChatGPT ↔ DSH connector 长时间运行、大上下文 session 下的响应瘦身与监控（兼容层，链路不变）：

- **sessions_get 默认摘要**：默认只返回结构化摘要（`id/title/status/workspace/created_at/updated_at/last_message_summary/last_assistant_summary/token_estimate/continuation_available`，无 messages），实测大 session 响应 75KB → 1.2KB。摘要由 node agent 生成（只向 DSH 要最后 2 条消息），缓存于 `~/.dsh/helm/summaries/<session_id>.json`（60s TTL，写操作后失效）。
- **完整历史按需取**：`include_messages=true`（可配 `max_messages` 默认 20、`before_seq` 翻页游标）返回完整消息；旧调用（不带参数）自动走摘要，行为不变。
- **Response Size Guard**：hub 所有 MCP 响应统一 middleware，`MAX_RESPONSE_BYTES=50000`；超限自动 smart-truncate（保证仍是合法 JSON，挂 `truncated` 元数据），日志 `[mcp-guard] <tool> original=.. returned=.. truncated`。
- **健康监控**：hub 新增 `GET /metrics`（请求数/平均与最大响应字节/截断与错误计数/活跃连接/perTool 明细）、`GET /readyz`（HA quorum 就绪）、`GET /version`；Dashboard 新增「MCP 控制面」页签展示。
- **纠错插队设计**（评审稿）：DSH 原生支持 `mode:'steer'` 注入纠偏，转发层当前未透传；方案见 [docs/priority-queue.md](docs/priority-queue.md)，待评审实施。

## 平台支持

| 平台 | hub | node agent | presence | 服务自启 |
|---|---|---|---|---|
| macOS | ✅ 已验证 | ✅ 已验证 | ✅ 桌面 sidecar 自动 + 手动 | ✅ launchd（`install-service.sh`） |
| Linux | ✅ 部分支持 | ✅ 部分支持 | ✅ 手动 | ✅ systemd 模板（`@dsh-helm/platform`） |
| Windows | ⚠️ 需 Node ≥22.5 | ⚠️ 脚手架 | 🚧 待真机验证 | 🚧 Task Scheduler 模板 |

> 核心代码零平台特定逻辑（launchd/osascript/PowerShell 全部隔离在 `packages/platform` 与 `packages/presence`）；macOS 双机（Tailscale）已真机验证，Linux/Windows 待真机验证。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构、协议、路由决策、数据模型、工具面 |
| [docs/chatgpt-tunnel-setup.md](docs/chatgpt-tunnel-setup.md) | OpenAI Platform 隧道创建与 tunnel-client 配置 |
| [docs/chatgpt-connector.md](docs/chatgpt-connector.md) | ChatGPT Web 连接器创建与使用 |
| [docs/onboarding.md](docs/onboarding.md) | 新机器加入控制平面 |
| [docs/security.md](docs/security.md) | 凭据、网络边界、Tailscale ACL、威胁模型摘要 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 症状 → 排查 → 解决 |
| [docs/threat-model.md](docs/threat-model.md) | 完整威胁模型（15 条威胁） |
| [docs/upstream-compat.md](docs/upstream-compat.md) | 上游 beforewave helm 兼容基线 |

## 安全要点

- **凭据**：`~/.dsh/helm/node.json`（节点 token）与 daemon token 文件均 0600；hub token 表经 `DSH_HELM_TOKEN` 环境注入（不落盘）；token 不出现在 argv/git/日志；隧道凭据用 `env:` 语法注入。
- **绑定**：hub 默认只绑 `127.0.0.1`；跨机建议 Tailscale + `--bind <tailnet-ip>`，`--mcp-bind 127.0.0.1` 保持 MCP 仅 loopback。hub MCP（3471）v1 无鉴权——**严禁直接暴露公网**；生产 mesh 走 `wss://`（TLS 由反代/外部 https server 负责）。
- **fail-closed**：破坏性操作（`sessions_prompt`/`sessions_resume`）无明确目标即拒绝；presence 歧义窗口内不猜测。
- **无正文存储**：store 只存元数据与审计，不落 DSH 会话内容。
- 详细安全模型见 [docs/security.md](docs/security.md) 与 [docs/threat-model.md](docs/threat-model.md)。

## 状态

**v0.1.0**。自动化验证全绿（单元 + 双 fake node 全协议端到端集成测试）；macOS 双机 Tailscale 真机冒烟完成。CLI 的在线 RPC 命令（`nodes`/`node`/`route-explain`/`presence`/`rotate-token`）正在接通 live hub（当前提示 requires live hub connection），同一能力可经 hub MCP 工具（`nodes_list` 等）使用；`doctor`/`dashboard`/`install` 开发中；session handoff v1 诚实返回 unsupported。

## ops 脚本

| 脚本 | 作用 |
|---|---|
| `scripts/install.sh` | 安装 CLI（node 检查 / 构建 / 三个 wrapper），幂等 |
| `scripts/uninstall.sh` | 卸载（`--purge` 全删） |
| `scripts/verify.sh` | 自检（node / wrapper / node.json 0600 / 本地 daemon / hub 端口），退出码 0/1/2 |
| `scripts/health.sh` | 节点状态表（hub MCP 优先，本地 store 退化） |
| `scripts/install-service.sh` | 装 node agent 为 launchd 服务（macOS），`--stop` 卸载 |
| `scripts/register-node.sh` | hub 机注册/更新节点 token（幂等，自动重载 launchd） |
| `scripts/dsh-helm-watchdog.sh` | 15s 自愈 watchdog（进程级拉起，单实例锁） |

所有脚本 bash 3.2 兼容、`[dsh-helm]` 输出前缀、幂等、只探测不修改生产端口（3080/3457/3458）上的现有服务。
