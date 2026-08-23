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
│   │                         #   本地 DSH 桥（MCP client → 3457）、元数据对账
│   ├── platform/             # 跨平台适配：配置路径、launchd/systemd/Windows
│   │                         #   Task 服务模板、默认端口
│   ├── presence/             # presence 提供方：手动声明、macOS desktop
│   │                         #   sidecar、Windows/浏览器脚手架
│   └── cli/                  # dsh-helm CLI：init/agent/hub/status/nodes/
│                             #   route-explain/presence/rotate-token/handoff
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
dsh-helm agent                      # 前台
./scripts/install-service.sh        # 后台 launchd 服务（macOS）

# 6. 自检
./scripts/verify.sh                 # 0 全绿 / 1 警告 / 2 严重
./scripts/health.sh                 # 节点状态表（走 hub MCP，或退化读本地 store）
```

> hub 的 token 通过 `DSH_HELM_TOKEN` 环境变量下发（`node_id=token,...`，见 `packages/hub/src/hub-cli.ts`）；生产建议接密钥管理。hub 默认只监听 `127.0.0.1`，WSS 需反向代理或 `DSH_HELM_BIND=0.0.0.0` + TLS。

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

当前 **134 个测试用例**：

- **单元 121**：协议（HMAC 握手/信封/JSON-RPC）、store（db/注册表/presence/目录）、hub（路由矩阵/校验矩阵/MCP server）、node-agent（桥）、platform、presence、CLI。
- **集成 13**：其中 **9 个双 fake node 全协议端到端**（`tests/integration/two-fake-nodes.test.ts`，内存握手→注册→心跳→对账→presence→路由转发，无真实 socket），另有 node-agent 桥集成 4 个。

```bash
pnpm test                       # 全部（vitest run）
pnpm test:integration           # 仅 tests/integration/
```

## 与单机 connector 的关系

仓库同级 `../connector/`（dsh-chatgpt-connector 套件 worktree）是**单机兼容基线**：19 个 MCP 工具的名与参数在 hub 上原样保留，hub MCP 的 Streamable HTTP 形状（`initialize` → `tools/call`）与单机 daemon（3457）一致。本仓库把它升级为控制平面：

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

**v0.1.0 开发中**。当前验证边界：单元 + 集成测试（含双 fake node 全协议内存端到端）全绿；**真实双机冒烟（两台物理机 WSS + 真实 DSH）待做**，hub-cli 的 launchd/systemd 生产化包装、密钥管理与 WSS 代理模板是下一步。

## ops 脚本

| 脚本 | 作用 |
|---|---|
| `scripts/install.sh` | 安装 CLI（node 检查 / pnpm build / wrapper / 配置提示），幂等 |
| `scripts/uninstall.sh` | 卸载（停 launchd 服务 / 删 wrapper / 问询删配置，默认保留），`--purge` 全删 |
| `scripts/verify.sh` | 自检（node ≥22.5 / wrapper / node.json 0600 / 3457 可达 / hub 端口），退出码 0/1/2 |
| `scripts/health.sh` | 节点状态表（hub MCP 优先，本地 store 退化） |
| `scripts/install-service.sh` | 装 node agent 为 launchd 服务（macOS），`--stop` 卸载 |
| `scripts/dsh-helm-watchdog.sh` | 15s 自愈 watchdog（进程级拉起，单实例锁；datapath 探测属 TS 层，不越权） |

所有脚本：bash 3.2 兼容（`set -eu`，pipefail 有则用）、`[dsh-helm]` 输出前缀、幂等、只探测不修改生产端口（3080/3457/3458）上的现有服务。
