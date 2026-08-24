# dsh-helm

**DSH ChatGPT Helm 多节点控制平面**：把单机 ChatGPT↔DSH 连接器扩展成多机控制平面——多台机器上的 DeepSeek Harness（DSH）通过节点代理注册到统一 hub，ChatGPT 经一个入口即可路由到任意节点读写代码、管理会话。

```
                    ┌────────────────────────────────────────────┐
                    │                  Hub（控制面）               │
                    │                                            │
  Node A ──────────►│  NodeRegistry · Router · PresenceRegistry  │
  (macOS 主机)       │  Session/Workspace Catalog · HealthAggreg  │
   dsh-helm agent ──►│  AuditLog · RouteLog · HubMcpServer        │
   │      ▲         │                                            │
   │      │ WSS mesh │  mesh 3470（节点↔hub）                      │
   │      │ (3470)   │  MCP 3471（ChatGPT 入口）                   │
   ▼      │         └───────────────▲────────────────────────────┘
 本地 daemon ───────────────────────┤
  MCP 3457                          │
   │                                │
   ▼                                │
  DSH web 3080                ChatGPT ──(OpenAI Helm Tunnel，可选)──┘
   │
   ▼
 Node B ──► hub（Linux/Windows 亦可，见 packages/platform）
```

- 每个节点跑 `dsh-helm agent`：向外连 hub（WSS/WS），向内桥接本机 helm daemon MCP（3457）。
- hub 是唯一入口：ChatGPT 经 hub MCP（3471）调用工具，hub 按路由策略把调用转发到正确节点。
- 单机兼容：单节点 + `defaultNode` 时，hub 行为与单机 daemon 完全一致（见下「与单机 connector 的关系」）。

## 功能特性

- **多节点注册与心跳**：节点身份 `node_id`（UUID）+ HMAC 挑战握手；15s 心跳、45s 租约、3 次心跳丢失判离线（`packages/protocol` 常量，测试与文档同源）。
- **健康分层**：control（hub+store）/ channel（WS 连接+租约）/ adapter（节点 DSH 桥）/ datapath（节点 sessions_list 真实可用）/ serena / tunnel，各层独立上报，绝不塌缩成单个 `status: ok`。
- **路由优先级**：`explicit → session_owner → workspace_owner → presence → default_local`；`target_node` 参数显式覆盖。
- **presence**：手动声明（10 分钟 TTL）+ macOS desktop sidecar + Windows/浏览器脚手架；15s 歧义窗口内双节点同时高置信 → 路由判 `ambiguous`。
- **MCP 兼容 19+5 工具**：完整保留单机 daemon 的 19 个工具（`code_*`/`sessions_*`/`supervisor_health` 等，snake_case 参数不变，ChatGPT 侧零改动），新增 5 个控制面工具（`nodes_list`/`node_get`/`route_explain`/`presence_claim`/`presence_release`）。
- **fail-closed**：破坏性操作（DANGER.destructive，如 `sessions_prompt`）无明确/可仲裁目标时直接拒绝，不猜测转发。
- **审计**：store 落库 audit log 与 route log（节点注册、心跳、路由决策、presence 变更）。
- **单机兼容模式**：单节点且 `node_id == hub defaultNodeId` 时路由收敛到该节点，等价单机 daemon。
- 存储只含**元数据**（节点注册表、presence 租约、会话/工作区目录、审计日志），**从不存储 DSH 会话正文**。

## 目录结构

```
dsh-helm/
├── package.json              # pnpm workspace 根（build/typecheck/test 脚本）
├── pnpm-workspace.yaml       # packages/* 工作区
├── tsconfig.base.json        # 共享 TS 配置（NodeNext 严格模式）
├── vitest.config.ts          # 测试别名（@dsh-helm/* → packages/*/src）
├── tests/
│   └── integration/          # 端到端集成测试（双 fake node 全协议）
├── packages/
│   ├── protocol/             # node-protocol v1：wire envelope、JSON-RPC、
│   │                         #   HMAC 挑战握手、共享类型与全部常量
│   ├── store/                # SQLite 存储（WAL）：节点注册表、presence
│   │                         #   租约、会话/工作区目录、审计与路由日志
│   ├── hub/                  # 控制面核心：ControlPlane、Router、HealthAggregator、
│   │                         #   WS mesh 服务器（3470）、MCP 服务器（3471）、
│   │                         #   hub-cli 入口
│   ├── node-agent/           # 节点代理：出站 WS 连接、心跳/重连/认证、
│   │                         #   本地 DSH 桥（MCP client → 3457）、元数据对账；
│   │                         #   bin: dsh-helm-agent（agent-cli.js）
│   ├── platform/             # 跨平台适配：配置路径、launchd/systemd/Windows
│   │                         #   Task 服务模板、默认端口
│   ├── presence/             # presence 提供方：手动声明、macOS desktop
│   │                         #   sidecar、Windows/浏览器脚手架
│   └── cli/                  # dsh-helm CLI：init/agent/hub/status/nodes/
│                             #   route-explain/presence/rotate-token/handoff；
│                             #   bin: dsh-helm（agent/hub 委派给对应 bin）
└── scripts/                  # ops 脚本（bash，macOS 优先，见下）
```

## 快速开始

```bash
# 0. 前置：Node.js >= 22.5（engine 要求）、pnpm、curl

# 1. 安装 CLI（构建 + 写 ~/.local/bin/dsh-helm wrapper）
./scripts/install.sh

# 2. 初始化节点身份（生成 node.json：node_id + token，权限 0600）
dsh-helm init

# 3. 编辑 ~/.dsh/helm/node.json，设置 hub_url（如 wss://hub.example.com/）

# 4. hub 机：启动控制面（前台；生产建议用 launchd/systemd 包装）
dsh-helm hub

# 5. 节点机：启动 agent（前台；或安装为 launchd 服务）
dsh-helm agent                     # 前台（委派 dsh-helm-agent）
./scripts/install-service.sh       # 后台 launchd 服务（macOS）

# 6. 自检
./scripts/verify.sh                 # 0 全绿 / 1 警告 / 2 严重
./scripts/health.sh                 # 节点状态表（走 hub MCP，或退化读本地 store）
```

> hub 的 token 通过 `DSH_HELM_TOKEN` 环境变量下发（`node_id=token,...`，见 `packages/hub/src/hub-cli.ts`）；生产建议接密钥管理。hub 默认只监听 `127.0.0.1`，WSS 需反向代理或 `DSH_HELM_BIND=0.0.0.0` + TLS。

## ChatGPT / OpenAI 连接方式

dsh-helm 与 ChatGPT 的接入有两条路径，按部署阶段选择：

### A. 单机直连（推荐起步，等价原 connector）

本机已有 helm daemon（`agent-chatgpt-helm`，监听 `127.0.0.1:3457/mcp`，Bearer token 在
`~/.agent-chatgpt-helm/token`）时，hub 把**本机节点**当 local node，行为与单机
connector 完全一致：

```
ChatGPT → hub MCP (3471) → router(default_local) → 本机 node agent
       → 本机 helm daemon MCP (3457) → DSH
```

- 无需 `target_node`，无需 presence，单节点零配置收敛。
- ChatGPT 侧工具面 = 19 个兼容工具，参数与 connector 完全一致。

### B. Secure MCP Tunnel / 多节点（控制平面）

```
ChatGPT ──(OpenAI Secure MCP Tunnel，可选)──▶ hub MCP (3471)
                                                │  路由（见「路由规则」）
         ┌──────────────────────────────────────┴───────────────┐
         ▼                                                     ▼
  Node A（本机）                                         Node B（远程）
  dsh-helm agent ──▶ 本机 daemon MCP 3457               dsh-helm agent ──▶ 本机 daemon MCP 3457
```

- 各节点 agent **只出站**连 hub mesh（3470，WSS 生产）；hub 不要求入站公网端口。
- ChatGPT 侧仍只看到一个入口（hub MCP 3471）；多节点对 ChatGPT 透明。
- 远程节点经 `code_use_workspace` 天然落到**该工作区所在机器**执行（workspace affinity）。

### 本地节点 vs 隧道节点

| | 本地节点 | 隧道/远程节点 |
|---|---|---|
| 连接 | agent → hub（loopback 或内网 WSS） | agent → hub（WSS，经内网/公网） |
| 数据 | 本机 DSH 直接可达 | 节点自己的 DSH，与 hub 位置无关 |
| presence | macOS sidecar 自动 | 手动声明 / 浏览器扩展 |

## 平台支持

| 平台 | hub | node agent | presence | 服务自启 |
|---|---|---|---|---|
| macOS | ✅ | ✅ | ✅ desktop sidecar（自动）+ 手动 | ✅ launchd（`install-service.sh`） |
| Linux | ✅ | ✅ | ✅ 手动 | ✅ systemd（模板在 `@dsh-helm/platform`） |
| Windows | ✅（Node ≥22.5） | ✅ | 🚧 脚手架（PowerShell 适配器待真机验证） | 🚧 Task Scheduler 模板（待真机验证） |

> 核心代码零平台特定逻辑（launchd/osascript/PowerShell 全部隔离在 `packages/platform` 与 `packages/presence`），Windows/Linux 只需真机验证即可落地。

## 故障恢复

| 故障 | 检测 | 恢复 |
|---|---|---|
| 节点断线 | 15s 心跳丢失 ×3（45s 租约过期） | 节点标记 offline；`markOffline` 触发；重连后**全量 re-register + reconcile** |
| agent 崩溃 | 15s watchdog（`dsh-helm-watchdog.sh`，单实例 PID 锁） | 进程级拉起（不越权碰 datapath） |
| 网络抖动 | 指数退避重连（1s→30s + jitter） | 自动重连 + 重新注册/对账 |
| 隧道代理挂 | 双重健康探针（3458 自身 + 3457 upstream） | keepalive 自动重建（仅 connector 套件） |
| presence 过期 | 20s renew / 60s TTL / 手动 10min | 路由退回 default/owner；歧义窗口 15s 内不猜测 |
| 审计损坏 | store WAL + busy_timeout | 只影响元数据，不碰会话正文 |

## 当前限制（v0.1.0）

- **真实双机冒烟未做**：自动化验证（含双 fake node 全协议端到端、170 tests）全绿；物理双机 WSS + 真实 DSH 的最终冒烟待两台机器（步骤见 `docs/onboarding.md`）。
- **session handoff 未实现**：v1 协议明确定义接口并返回 `unsupported`（无 fake 无损迁移）。
- **CLI 在线 RPC 命令待接**：`nodes`/`route-explain`/`presence`/`rotate-token` 依赖 hub RPC 面（下一里程碑）。
- **Windows/Linux 真机验证待做**（见平台支持表）。
- **WSS + TLS 生产化**：hub 默认 loopback；生产需反向代理或 `MeshServerOptions.server` 传 https server。
- **token 管理**：当前 `DSH_HELM_TOKEN` 环境变量注入；生产建议接密钥管理/轮换。

## 开发

```bash
pnpm install        # 安装依赖（workspace 内联）
pnpm build          # 全包编译（tsc -b packages/*/tsconfig.json）
pnpm typecheck      # 类型检查（--noEmit）
pnpm test           # 运行全部测试（vitest run）
pnpm test:integration   # 仅集成测试
pnpm clean          # 清理 lib/
```

每个包也可单独 `cd packages/<name> && pnpm build && pnpm test`。

## 测试

当前 **170 个测试用例**（23 个测试文件，vitest run 实测）：

- **单元 143**：协议（HMAC 握手/信封/JSON-RPC）、store（db/注册表/presence/目录）、hub（路由矩阵/校验矩阵/MCP server/hub-cli/审计持久化/单节点兼容）、node-agent（桥/config/agent-cli/reconnect）、platform、presence、CLI。
- **集成 13**：其中 **9 个双 fake node 全协议端到端**（`tests/integration/two-fake-nodes.test.ts`，内存握手→注册→心跳→对账→presence→路由转发，无真实 socket），另有 node-agent 桥集成 4 个。

```bash
pnpm test                       # 全部（vitest run）
pnpm test:integration           # 仅 tests/integration/
```

## 与单机 connector 的关系

[`lixiaoshuang79/dsh-chatgpt-connector`](https://github.com/lixiaoshuang79/dsh-chatgpt-connector) 是**单机兼容基线**（本仓库的前身）：19 个 MCP 工具的名与参数在 hub 上原样保留，hub MCP 的 Streamable HTTP 形状（`initialize` → `tools/call`）与单机 daemon（3457）一致。本仓库把它升级为控制平面：

| | 单机 connector（../connector/） | dsh-helm（本仓库） |
|---|---|---|
| 节点数 | 1 | 多（注册表 + 路由） |
| 工具入口 | 本机 daemon MCP 3457 | hub MCP 3471（节点数无关） |
| 工具面 | 19 个 | 19 兼容 + 5 控制面 = 24 |
| 目标选择 | 本机固定 | 路由策略 / target_node 显式 |
| 健康 | 单机 4 层探测 | 分层健康 + 每节点 6 层 |

`../upstream-helm/` 是上游参考（协议/工具面研究基线）。

## 安全要点

- **token 0600**：`~/.dsh/helm/node.json` 含节点 token，创建即 0600；verify.sh 会校验。
- **WSS**：生产走 `wss://`（mesh 是纯 WS，TLS 由反向代理/`https` server 负责，见 `MeshServerOptions.server`）；hub 默认只绑 127.0.0.1。
- **HMAC 挑战握手**：节点与 hub 双向认证，错误 token / 不兼容协议版本一律拒绝（无静默降级）。
- **fail-closed**：破坏性操作无明确目标即拒绝；presence 歧义窗口内不猜测。
- **无正文存储**：store 只存元数据与审计，不落 DSH 会话内容。
- 凭据不入库：`node.json`、`DSH_HELM_TOKEN` 均在运行时环境/私有文件，README 与脚本不含任何真实密钥。

## 状态

**v0.1.0 开发中**。当前验证边界：单元 + 集成测试（含双 fake node 全协议内存端到端）全绿；CLI 的 RPC 类命令（`nodes`/`node`/`route-explain`/`presence`/`rotate-token`）依赖 live hub 连接，属于下一里程碑。**真实双机冒烟（两台物理机 WSS + 真实 DSH）待做**，hub-cli 的 launchd/systemd 生产化包装、密钥管理与 WSS 代理模板是下一步。

## ops 脚本

| 脚本 | 作用 |
|---|---|
| `scripts/install.sh` | 安装 CLI（node 检查 / pnpm build / 三个 wrapper：dsh-helm、dsh-helm-agent、dsh-helm-hub / 配置提示），幂等 |
| `scripts/uninstall.sh` | 卸载（停 launchd 服务 / 删 wrapper / 问询删配置，默认保留），`--purge` 全删 |
| `scripts/verify.sh` | 自检（node ≥22.5 / wrapper / node.json 0600 / 3457 可达 / hub 端口），退出码 0/1/2 |
| `scripts/health.sh` | 节点状态表（hub MCP 优先，本地 store 退化） |
| `scripts/install-service.sh` | 装 node agent 为 launchd 服务（macOS，直接跑 agent-cli.js），`--stop` 卸载 |
| `scripts/dsh-helm-watchdog.sh` | 15s 自愈 watchdog（进程级拉起，单实例锁；datapath 探测属 TS 层，不越权） |

所有脚本：bash 3.2 兼容（`set -eu`，pipefail 有则用）、`[dsh-helm]` 输出前缀、幂等、只探测不修改生产端口（3080/3457/3458）上的现有服务。
