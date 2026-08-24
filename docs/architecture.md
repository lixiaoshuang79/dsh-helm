# dsh-helm 多节点控制平面架构文档

## 概述

dsh-helm 是把已验证的单机「ChatGPT ↔ DSH」桥（dsh-chatgpt-connector：tunnel-client + helm daemon + DSH 插件）进化为多节点控制平面的项目：一台入口节点运行 Hub 控制平面，聚合多台机器上的 DSH（每台机器一个 Node Agent，通过本地 helm daemon 的 MCP 语义接入），并继续以同一个 MCP 工具面为 ChatGPT 隧道提供服务，使 ChatGPT 能在一个入口上发现、路由并操作任意节点上的会话与工作区。本文是控制平面的正式架构文档，描述系统组成、wire 协议、路由决策、数据模型、生命周期、兼容模式与已知边界；文中端口、间隔、工具面、类名等事实与 `packages/` 实现一致，所有已拍板的架构决策逐条固化，后续实现与评审以本文件为准。

### 决策速览（已拍板，逐条体现于后文对应章节）

| # | 决策 | 落实章节 |
|---|------|---------|
| 1 | 身份：`node_id` 是 UUID（首次安装生成，0600 配置）；`hostname` 只是 `display_name`，永远不是身份 | §3.1 / §3.4 / §4.2 |
| 2 | 传输：node agent 出站拨号 hub（WSS JSON-RPC v1 envelope + HMAC challenge 握手；TLS/WSS 生产，ws 仅 loopback/test）；协议版本协商，不兼容明确拒绝，绝不静默降级；绝不在网络上暴露 daemon 的 loopback unix socket adapter 协议 | §4.1 / §4.2 |
| 3 | 存储：SQLite（`node:sqlite` `DatabaseSync`，WAL + `busy_timeout` + `schema_version` 迁移），只存元数据（节点/租约/会话与工作区目录/审计/路由日志），绝不存 DSH 会话正文 | §3.2 / §6 |
| 4 | 全局标识：global session key = `node_id:native_session_id`（native id 原样保留）；workspace catalog key = `node_id` + native workspace id（path 只是属性，永远不是跨 OS 身份） | §3.2 / §6 |
| 5 | 心跳与租约：heartbeat 15s、node lease 45s、连续 3 次丢失判离线；reconnect 指数退避 + jitter，重连后全量 re-register + metadata reconcile（无部分状态） | §4.5 / §7.3 |
| 6 | Presence：renew 20s / TTL 60s；confidence + source + observed_at；15s 窗口内两台都 high-confidence fresh = ambiguous（不自动选）；manual claim 默认 TTL 10min 可 pin 可显式 release；显式 target 永远优先 | §3.5 / §5.1 |
| 7 | 路由优先级（Router）：explicit target_node > session owner（强亲和，不静默迁移）> workspace owner（code 工具强亲和，code 调用必须代理到 owner node，不是 hub 本地 serena）> 无歧义 fresh presence > 配置的 default/local healthy 节点 > no-route；无 session 无 workspace 的新会话：presence 可先于 session owner | §5.1 |
| 8 | 读/写区分：只读发现类（`nodes_list`/`workspaces_list`/`sessions_list`/`agents_list`/`supervisor_health`/`projects_list`）hub 聚合多节点；破坏性/副作用类（`prompt`/`resume`/`cancel`/`create`/write-capable code 工具）在 fallback 路由 + 目标不清晰时 fail-closed 返回 `route_confirmation_required` | §5.2 |
| 9 | 可观测与安全：每次路由决策写 route_log（request/tool、selected node、reason、explicit?、danger、result——无 prompt 正文无密钥）+ audit 表；结构化 JSON 日志；统一 redactor（node token/tunnel token/API key 永不出现在 argv/git/快照）；分层健康（control process/store → node channel/lease → node adapter → sessions_list datapath → serena/workspace → tunnel），绝不折叠成单一 `status: ok` | §3.3 / §5.4 / §7.4 |
| 10 | 跨平台：核心零平台代码；platform 包隔离 launchd/osascript/PowerShell；macOS launchd 模板 + Windows PowerShell/Scheduled Task（或 Service）模板 + systemd unit；Windows 路径静态可测 | §3.6 |
| 11 | handoff：定义明确接口/规范，v1 返回 unsupported（无 fake 无损迁移） | §3.7 / §9 |
| 12 | 上游：beforewave `agent-chatgpt-helm` / `dsh-chatgpt-helm` 固定 0.1.1 不动（生产 node_modules 不改）；dev 区 `upstream-helm/` 是 npm tarball 精确快照 pin | §8.4 |
| 13 | harness 核心零侵入：hub 通过每个节点本地 daemon 的 MCP 语义工作；watchdog 等 shell 自愈逻辑不进 TS 核心 | §3.4 / §8.5 |
| 14 | MCP 面：19 个兼容工具（snake_case）原样保留 + 新增 `nodes_list`/`node_get`/`route_explain`/`presence_claim`/`presence_release` + 可路由工具增加可选 `target_node` 参数；`supervisor_health` 扩展 control 层 + 各节点分层健康 | §3.3 / §8.3 |

---

## 1. 背景

单机 ChatGPT↔DSH 桥（dsh-chatgpt-connector：tunnel-client + helm daemon + DSH 插件）已稳定，现在把它进化成多节点控制平面。长期方向：**单一 Connector/Hub**；每台机器的 connector/tunnel 保留为**安全兼容模式（additive，不是替代）**——单机行为不回归，多节点能力是叠加而非替换。ChatGPT 侧的连接器入口由单机 daemon 的 3457 端口升级为 Hub 的 MCP server（3471），但 19 个既有工具（snake_case）原样保留，ChatGPT 侧无需任何改动即可继续工作。

## 2. 架构图

### 2.0 真实部署链路（ChatGPT → DSH，端到端）

下述链路为实际部署验证的完整路径（Tailscale 组网 + OpenAI Secure MCP Tunnel 接入）：

```
ChatGPT Web（连接器/插件，对话里选连接器）
   │ ① OpenAI Secure MCP Tunnel（OpenAI 托管端点，TLS）
   ▼
tunnel-client（入口节点本机进程；出站轮询 api.openai.com，经本地 HTTPS 代理；
              健康端口 127.0.0.1:3468，示例值可配置）
   │ ② Streamable HTTP MCP（initialize → tools/list → tools/call）
   ▼
Hub 控制平面（dsh-helm hub）
   ├─ MCP  server 127.0.0.1:3471  ←── ② 的落点（ChatGPT 唯一入口；默认 loopback 无鉴权）
   ├─ mesh server <tailnet-ip>:3470 ←─ ③ 节点出站拨号落点（HMAC 挑战握手）
   └─ Router：explicit target → session owner → workspace owner → presence → default
        │ ④ mcp.call 转发（转发前剥离 target_node；回复附 _route，含 node_name）
        ├───────────────┬───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
   node-agent A    node-agent B    node-agent C    ……（每台机器一个，只出站）
        │ ⑤ 本地 MCP（127.0.0.1:3457/mcp，Bearer token）
        ▼
   helm daemon（@beforewave，0.1.1 固定）──▶ 本机 DSH（sessions/workspaces/serena）
```

段落说明：

- ① 段：tunnel 与 ChatGPT workspace 绑定、tunnel-client 参数与代理配置见 `docs/chatgpt-tunnel-setup.md`；连接器创建见 `docs/chatgpt-connector.md`。
- ② 段：hub MCP 是 Streamable HTTP（`/mcp` + `/healthz`）；必须先 `initialize` 拿 `mcp-session-id`（直接 curl tools/list 返回空/报错属正常，见 `docs/troubleshooting.md`）。
- ③ 段：节点与 hub 之间是星型，节点**只出站**（HMAC 握手后注册+心跳）；mesh 生产必须 `wss://`，内网/Tailscale 可用 `ws://`（信任网络内）。
- ④ 段：路由决策细节见 §5；每次转发结果附 `_route`（含 `node_name` = display_name，缺省回退 node_id 前 8 位），供 ChatGPT 侧溯源「哪台机器执行了」。
- ⑤ 段：node agent 只走 daemon 的 3457 认证 MCP 端点，**绝不**在网络上传 daemon 的 loopback unix socket 协议（决策 2/13）。

### 2.1 控制平面组件图（详细）

```
                        ┌──────────────────────────────────────────────┐
                        │                   ChatGPT                     │
                        │          （对话里选连接器，19 工具 MCP 面）      │
                        └──────────────────────┬───────────────────────┘
                                               │ OpenAI Secure MCP Tunnel
                                               │ （控制面 api.openai.com，经本地 HTTPS 代理）
                                               ▼
                        ┌──────────────────────────────────────────────┐
                        │     tunnel-client（仅 Hub 入口节点，3458 健康）  │
                        └──────────────────────┬───────────────────────┘
                                               │ 本机 MCP（Bearer token）
                                               ▼
   ┌──────────────────────  Hub 控制平面（入口节点 · dsh-helm hub） ──────────────────────┐
   │  NodeRegistry │ PresenceRegistry │ SessionCatalog │ WorkspaceCatalog              │
   │  HealthAggregator │ AuditLog / RouteLog（SQLite store）│ Router                    │
   │  WebSocket mesh server :3470       MCP server :3471（ChatGPT 隧道入口）            │
   └───▲───────────────────▲───────────────────▲───────────────────────▲───────────────┘
       │  wss 出站拨号       │                   │                       │
       │ （HMAC 握手）        │                   │                       │
   ┌───┴────────┐     ┌─────┴──────┐     ┌──────┴─────┐          ┌──────┴──────┐
   │ Node Agent │     │ Node Agent │     │ Node Agent │          │ Hub 自身节点 │
   │  (macOS)   │     │ (Windows)  │     │  (Linux)   │          │  (入口节点)  │
   └───┬────────┘     └─────┬──────┘     └──────┬─────┘          └──────┬──────┘
       │ LocalHelmBackend（默认 McpLocalHelmBackend → 本地 3457 MCP）           │                        │
       │ http://127.0.0.1:3457/mcp + Bearer     │                        │
   ┌───┴────────┐     ┌─────┴──────┐     ┌──────┴─────┐          ┌──────┴──────┐
   │ helm daemon│     │ helm daemon│     │ helm daemon│          │ helm daemon │
   │ 0.1.1 固定 │     │ 0.1.1 固定 │     │ 0.1.1 固定 │          │ 0.1.1 固定  │
   │ DSH+Serena│     │ DSH+Serena│     │ DSH+Serena│          │ DSH+Serena  │
   └───────────┘     └────────────┘     └───────────┘          └─────────────┘
```

每台机器的 presence 链路（Node Agent 侧，hub 只见 claim）：

```
   ┌───────────────────────────────────────────────────────────────┐
   │  PresenceListener :3472（仅 127.0.0.1） ◄── browser MV3 扩展    │
   │        ▲                                    （chatgpt.com focus）│
   │        │ claim 上报（source/confidence/observed_at/ttl）         │
   │  Node Agent presenceProvider 链（CompositePresenceProvider）    │
   │    ├─ manual   CLI/MCP pin（confidence 1.0，pinned，TTL 10min）│
   │    ├─ desktop  macOS osascript 前台 app 探测（0.9 / 空闲 0.2）  │
   │    ├─ windows  PowerShell 前台进程 scaffold（GetForegroundWindow）│
   │    └─ browser  MV3 扩展 → 本地 listener 3472（0.95，20s 续约）  │
   └───────────────────────────────────────────────────────────────┘
```

**端口约定**（`packages/platform` 与 `packages/protocol` 的常量，单点事实来源；tunnel-client 端口为其自身参数，可配置）：

| 端口 | 用途 |
|------|------|
| 3470 | Hub WebSocket mesh server（节点出站拨号入口；hub-cli 默认绑定 `127.0.0.1`，跨机用 `--bind <tailnet-ip>`；仅 loopback/test 用明文 ws，生产 wss） |
| 3471 | Hub MCP server（ChatGPT 隧道入口，唯一连接器入口；`--mcp-bind` 可与 mesh 绑定解耦，保持仅 loopback） |
| 3472 | 本地 presence listener（127.0.0.1，接收 browser 扩展等本地上报） |
| 3457 | 每台机器本地 helm daemon MCP（`/mcp` + `/healthz`，仅 127.0.0.1） |
| 3468 | 入口节点 tunnel-client 健康端口（示例值，`--health.listen-addr` 可配置；旧 connector 套件 keepalive 探针用 3458） |
| 3080 | DSH web（信息性；Node Agent 不直接访问，一切经 daemon MCP 语义） |

## 3. 组件详解

### 3.1 `@dsh-helm/protocol` —— wire 契约（schema v1）

零依赖、传输无关的协议库，被 hub 与 node-agent 共同引用，是版本号与所有时序值的**单一事实来源**。

- **常量**（`constants.ts`）：`NODE_PROTOCOL_VERSION = 1`、`STORE_SCHEMA_VERSION = 1`、`DEFAULT_HEARTBEAT_MS = 15_000`、`DEFAULT_NODE_LEASE_MS = 45_000`、`HEARTBEAT_LOSS_THRESHOLD = 3`、`DEFAULT_PRESENCE_RENEW_MS = 20_000`、`DEFAULT_PRESENCE_TTL_MS = 60_000`、`PRESENCE_AMBIGUITY_WINDOW_MS = 15_000`、`MANUAL_CLAIM_TTL_MS = 10 * 60_000`、`RECONNECT_BACKOFF_BASE_MS = 1_000`、`RECONNECT_BACKOFF_MAX_MS = 30_000`、`NODE_TOKEN_BYTES = 32`、`HMAC_ALGORITHM = 'sha256'`；错误码与 `ROUTE_OUTCOME`、`DANGER` 枚举（见 §4.5 / §5）。
- **类型**（`types.ts`）：`NodeInfo`（`node_id` UUID、`display_name`、`platform`、`versions`、`capabilities`）、`NodeStatus`（单调 `seq`、`ts`、分层 `health`、workspace/session 计数）、`HealthReport`/`LayerHealth`（6 层，见 §7.4）、`WorkspaceInfo`/`SessionInfo`（native id 原样保留）、`PresenceClaim`/`PresenceRecord`（`source`：`manual|desktop|browser|idle`，`confidence`，`observed_at`，`ttl_ms`，`pinned`）、`RouteDecision`/`RouteEvidence`、`AuditEntry`。设计规则：`node_id` 是稳定 UUID（首次安装生成），hostname 只做 `display_name` 永不作身份；wire 只携带元数据，绝不携带 DSH 会话正文。
- **envelope**（`envelope.ts`）：握手消息（`hello`/`challenge`/`auth`/`welcome`/`error`）+ 数据帧 `rpc`（`{type:'rpc', v, body}`，body 为 JSON-RPC 2.0）+ `control`（`lease_update`/`ping`）。方法名枚举：`NODE_METHODS`（hub→node：`health`/`listWorkspaces`/`createSession`/`listSessions`/`getSession`/`resumeSession`/`prompt`/`cancel`/`mcp.call`/`presence.report`/`catalog.reconcile`/`audit.append`）与 `HUB_METHODS`（node→hub：`node.register`/`node.heartbeat`/`node.release`/`catalog.reconcile`/`presence.report`）。
- **crypto**（`crypto.ts`）：仅用 `node:crypto`。`generateNodeToken(32B base64url)`、`generateNonce(24B)`、`computeMac = HMAC-SHA256(token, client_nonce + server_nonce)`、`verifyMac` 用 `timingSafeEqual` 常时比较、`isValidNodeId` 校验 UUID 形态。
- **handshake**（`handshake.ts`）：`HandshakeServer` / `HandshakeClient` 两个状态机，传输无关（send 函数注入），auth 尝试上限 3 次；hello 阶段版本不匹配立即 `VERSION_MISMATCH` 失败。
- **jsonrpc**（`jsonrpc.ts`）：`RpcPeer`——极简 JSON-RPC 2.0 客户端+服务端合体，`request`（默认超时 30s）/`notify`/`on`/`onNotify`，测试可用 `pairRpcPeers` 内存管道直连。

### 3.2 `@dsh-helm/store` —— SQLite 存储层

- **`DshHelmStore`**（`db.ts`）：`node:sqlite` 的 `DatabaseSync`（与 deepseek-harness 生产同驱动），打开即设 `PRAGMA journal_mode = WAL`、`synchronous = NORMAL`、`busy_timeout = 5000`、`foreign_keys = ON`；`kv` 表存 `schema_version`，`migrate()` 事务内逐版本升级（`BEGIN IMMEDIATE`…`COMMIT`/`ROLLBACK`），库版本新于程序支持版本时**拒绝打开**。`node:sqlite` 经 `createRequire` 懒加载以抑制 Node 22 的 ExperimentalWarning。**只存元数据**（节点/租约/会话与工作区目录/审计/路由日志），绝不存 DSH 会话正文。
- **DAO**（各一个类，注入 `DatabaseLike`，测试可用 `:memory:`）：
  - `NodeRegistry`：`register`（upsert 保留 `last_seen`）、`heartbeat`、`markOffline`、`block`/`unblock`、`onlineNodes(leaseMs)`（lease 内健康候选）、`channelHealth`（channel 层健康）。
  - `PresenceRegistry`：`claim`（按 source 钳制 TTL：manual 默认 10min 且上限 60min，其余 ≤60s）、`release`（显式释放）、`sweep`（清过期）、`live`、`activeNode`（pin 优先 → 最新 ≥0.8 fresh → 15s 窗口歧义判定，见 §5.1）。
  - `SessionCatalog` / `WorkspaceCatalog`：`reconcile(nodeId, list)` 事务内「删该节点全部 + 全量重插」（对账语义，见 §7.3）；`get`/`resolve` 同时接受 global key 与裸 native id/path（裸 id 跨节点歧义时返回 undefined，绝不猜）。
  - `AuditLog`：`append`（audit 表）+ `logRoute`（route_log 表，存完整 `RouteDecision` JSON），`list`/`recentRoutes` 供审计与 `route_explain` 溯源。
- **数据流**：hub 的 ControlPlane 持有各 DAO，注册表写入来自 `node.register`/`node.heartbeat`/`catalog.reconcile`/`presence.report`，读取供 Router/HealthAggregator/MCP discovery。

### 3.3 `@dsh-helm/hub` —— 控制平面（跑在入口节点）

- **`ControlPlane`**（`control-plane.ts`）：核心服务。持有 store 注册表、`Router`、`HealthAggregator`、活动连接表 `connections: Map<node_id, NodeConnection>`。处理 `node.register`（注册/重注册并回 `heartbeat_ms`/`lease_ms`）、`node.heartbeat`（未知节点抛 `NODE_ID_CONFLICT`，blocked 节点抛 `AUTH_FAILED`）、`node.release`（优雅下线：markOffline + 删连接）、`catalog.reconcile`、`presence.report`。`forward(route, op, params, callId)`：对路由结果执行 `mcp.call`（60s 超时）并写审计；`aggregateWorkspaces`/`aggregateSessions`：只读发现类跨所有 online 节点并发聚合（单节点 15s 超时、失败跳过）；`aggregateHealth`：control + 各节点分层健康。传输无关：`NodeConnection` 以 WireMessage 驱动，生产走 ws/wss、测试走内存管道。
- **`Router`**（`router.ts`）：路由决策核心，优先级见 §5.1；输出 `RouteDecision`（outcome/node_id/reason/evidence/candidates/danger/explicit/confirmation_required）+ `RouteAction`（`forward`/`reject`/`aggregate`）+ `errorCode`。
- **`HealthAggregator`**（`health.ts`）：分层健康聚合，绝不折叠为单一 `status: ok`（见 §7.4）。
- **`MeshServer`**（`mesh.ts`）：生产 WS 传输，监听 3470；TLS 由调用方负责（传入 `https` server 或反代），明文 ws 仅 loopback/dev/test；每个 socket 配一个 `HubConnection`。
- **`HubConnection`**（`connection.ts`）：连接侧胶水——`HandshakeServer` + `RpcPeer`（hub 侧 RPC handler 表）→ 认证后注册为活动 `NodeConnection`。
- **`HubMcpServer`**（`mcp/server.ts`）：ChatGPT 隧道入口（3471）的 MCP 服务。discovery 工具 hub 本地聚合应答；可路由工具经 Router 决策后 `forward` 到目标节点（转发前剥离 `target_node` 控制参数，结果附带 `_route` 决策，`_route.node_name` = 目标节点 display_name、缺省回退 node_id 前 8 位，供 ChatGPT 侧溯源执行节点）；`presence_claim`/`presence_release` hub 本地处理。**单机兼容模式**：当只有一个节点且 `node_id == hub defaultNodeId` 时，路由的 explicit/session/workspace/default 全部收敛到该节点，行为与单机 daemon 完全一致。
- **MCP 工具面**（`mcp/tools.ts`，决策 14）：24 个工具 = **19 个兼容工具原样保留**（snake_case，与单机 daemon 一致：`code_read_file`/`code_list_dir`/`code_find_file`/`code_search_for_pattern`/`code_get_symbols_overview`/`code_find_symbol`/`code_find_referencing_symbols`/`code_use_workspace`/`projects_list`/`supervisor_health`/`agents_list`/`workspaces_list`/`sessions_create`/`sessions_list`/`sessions_get`/`sessions_resume`/`sessions_prompt`/`sessions_wait`/`sessions_cancel`）+ **5 个新增**：`nodes_list`、`node_get`、`route_explain`、`presence_claim`、`presence_release`。所有**可路由工具增加可选 `target_node` 参数**（显式目标，永不与 daemon 自身参数混淆）。`supervisor_health` 扩展为返回 control 层 + 各节点分层健康（并保留 `tunnel: {managed:false}` 等兼容字段）。

### 3.4 `@dsh-helm/node-agent` —— 每台机器的节点代理

- **`loadConfig`**（`config.ts`）：`~/.dsh/helm/node.json`（0600）。首次运行生成 `node_id = randomUUID()` 与 `token = randomBytes(32).base64url`，`display_name` 缺省 `hostname()`；`local_mcp_url` 缺省 `http://127.0.0.1:3457/mcp`，`local_mcp_token` 取自 daemon 的 token 文件；`local_probe_ms` 10s、`reconcile_ms` 60s。token 只从私有文件读取，**绝不出现在 argv 或环境转储**。
- **`LocalHelmBackend`（默认 `McpLocalHelmBackend`）**（`bridge.ts`）：本地 DSH adapter bridge——极简 MCP client（`initialize` 握手 `protocolVersion 2025-03-26` + `Mcp-Session-Id` 头管理，无 SDK 依赖），连本地 helm daemon 的 Streamable HTTP MCP 端点，带 Bearer token，与 ChatGPT 隧道访问方式完全一致。**绝不在网络上暴露 daemon 的 loopback unix socket adapter 协议**——这是硬边界：node agent 只通过 3457 `/mcp` 的认证 MCP 语义接入本地 DSH（决策 2/13）。
- **`HelmNodeAgent`**（`agent.ts`）：节点主进程。状态机 `idle/connecting/connected/reconnecting/stopped`：
  1. **出站拨号** hub（wss 生产 / ws 仅 loopback、test）；
  2. **HMAC 握手**（客户端状态机）；
  3. welcome 后：`node.register` → `catalog.reconcile`（collectLocalCatalog 经 bridge 调 `sessions_list`/`workspaces_list` 采集元数据）→ 心跳循环（15s，携带分层 health）；
  4. 服务 hub 发起的 RPC：`health`/`listWorkspaces`/`listSessions`/`createSession`/`getSession`/`resumeSession`/`prompt`/`cancel`/`mcp.call`（通用透传：hub 路由任何 MCP 工具到这里）；
  5. **reconnect**：指数退避（1s 起 ×2，上限 30s）+ jitter（0–500ms），**重连成功后全量 re-register + metadata reconcile（无部分状态）**，退避在成功连接时重置（决策 5）；
  6. `probeLocal()`：每 10s 经 bridge 调 `supervisor_health` 探活，产出分层 health（channel/adapter/datapath/serena/tunnel）。
- **数据流**：`ChatGPT → Hub MCP(3471) → Router → forward(mcp.call) → Node Agent → LocalHelmBackend(McpLocalHelmBackend) → daemon MCP(3457) → DSH`；反向：`daemon 状态 → bridge 探测/采集 → heartbeat/reconcile → Hub`。

### 3.5 `@dsh-helm/presence` —— presence providers

回答「人此刻是否在主动使用这台机器」，产出 `PresenceClaim` 由 node agent 上报 hub（决策 6）。

- `ManualPresenceProvider`：CLI/MCP pin，`confidence 1.0`、`pinned: true`、默认 TTL 10min，可显式 release。
- `DesktopSidecarPresenceProvider`：macOS，osascript + System Events 探测前台 app（`chatgpt`/`arc`/`safari`/`chrome`/`edge`/`firefox`/`browser`），命中 `0.9`、空闲 `0.2`，后台 10s 轮询。
- `WindowsDesktopPresenceProvider`：Windows scaffold，静态 PowerShell 片段（user32 `GetForegroundWindow` P/Invoke 取前台进程名），`chatgpt`/`msedge`/`chrome`/`firefox`/`brave`，命令串经测试断言稳定。
- `PresenceListener` + `ListenerPresenceProvider`：本地 HTTP 端点（127.0.0.1:3472），`POST /presence/*` 收本地上报转 claim，`GET /healthz` 探活。
- `browser` MV3 扩展 scaffold（`browser.ts`）：manifest + background（`tabs.onActivated`/`windows.onFocusChanged` 跟踪 chatgpt.com focus，`confidence 0.95`，活跃期每 20s 续约）+ content script（页面可见性心跳），只与 127.0.0.1 通信。
- `CompositePresenceProvider`：组合多个 provider，第一个非空 claim 生效（manual 在前则 pin 优先）。

### 3.6 `@dsh-helm/platform` —— 跨平台适配（决策 10）

**核心代码零平台分支**；launchd/osascript/PowerShell 全部隔离在本包，以纯函数 + 模板形式提供、任意 OS 可单测：

- `configPaths(os, home)`：Windows 用 `%LOCALAPPDATA%\dsh-helm\`（node.json/store.sqlite3/logs），其余 `~/.dsh/helm/`——Windows 路径静态可测。
- `launchdPlist`（RunAtLoad + KeepAlive）、`windowsTaskXml`（LogonTrigger + RestartOnFailure PT1M×3 + IgnoreNew 多实例策略）、`systemdUnit`（Restart=always, RestartSec=10）。
- `serviceCommands(os, opts)`：返回 install/uninstall/status/start/stop 的具体 shell 命令（launchctl bootstrap/bootout、schtasks /Create /XML、systemctl --user）。
- `DEFAULT_PORTS = { mesh: 3470, mcp: 3471, presence: 3472 }`。

### 3.7 `@dsh-helm/cli` —— 运维界面

薄封装，读写与 agent 相同的 `node.json`，经 RPC 面与 hub 交互：`init`（生成 node_id + token，0600）/ `agent`（前台跑 agent）/ `hub`（前台跑 hub）/ `status` / `nodes list` / `node get <id>` / `route-explain`（解释路由，不执行）/ `presence claim|release <node>` / `target <node>`（本 CLI 会话级显式目标）/ `rotate-token` / `handoff <session> <to-node>` / `verify` / `help`。

**handoff（决策 11）**：v1 定义明确接口与规范（`handoff <session> <to-node>`），实现为诚实的 `{supported: false, reason: 'session handoff is specified in the control-plane design but not implemented in protocol v1; no lossless migration exists yet'}`——**无 fake 无损迁移**，绝不用假迁移假装支持。

## 4. 协议说明

### 4.1 传输与版本协商（决策 2）

- 节点经 **出站拨号**连接 hub（node agent 永不监听入站端口）；生产 **TLS/WSS**，明文 ws **仅允许 loopback/test**。
- 每个数据帧为带版本号的 envelope：`{type:'rpc', v, body}`，body 是 JSON-RPC 2.0。
- **版本协商**：握手第一步 `hello` 携带 `v`；与 hub `schema_version` 不匹配 → 立即 `VERSION_MISMATCH` 明确拒绝，**绝不静默降级**。welcome 回传 `schema_version` 与 `heartbeat_ms`/`lease_ms`。
- **协议边界**：节点到 DSH 只走 daemon 的 3457 `/mcp` 认证 MCP 端点（Bearer token）；daemon 的 loopback unix socket adapter 协议**绝不出现在网络上**——本控制平面协议只承载 MCP 语义 + 元数据。

### 4.2 握手序列（HMAC challenge）

```
Node Agent                                   Hub
   │ 1. hello {v, node_id, nonce(client)} ────▶ │  版本不匹配 → error VERSION_MISMATCH
   │ 2. ◀── challenge {v, node_id, nonce(server)}│
   │ 3. auth {v, node_id, nonce(client),
   │        mac = HMAC-SHA256(token, client_nonce + server_nonce)} ──▶ │
   │                                            │  验证失败/超 3 次 → error AUTH_FAILED
   │ 4. ◀── welcome {v, hub_id, schema_version, heartbeat_ms, lease_ms}
```

- 双方 nonce 均为随机（base64url，≥16B）；MAC 用 HMAC-SHA256（`node:crypto`），验证为常时比较。
- 服务端 `HandshakeServer`：auth 尝试上限 3 次；先调本地认证回调（注册连接）再发 welcome，保证客户端收到 welcome 即可发请求。
- welcome 之后双方进入 envelope 包着的 JSON-RPC 2.0 交换；`control` 帧用于罕见的租约/心跳期望更新（`lease_update`/`ping`）。

### 4.3 RPC 方法表

**node → hub（`HUB_METHODS`）**

| 方法 | 用途 |
|------|------|
| `node.register` | 注册/重注册 `NodeInfo`；返回 `{node_id, heartbeat_ms, lease_ms}` |
| `node.heartbeat` | 心跳：`NodeStatus`（seq/ts/分层 health/计数） |
| `node.release` | 优雅下线（markOffline + 断开） |
| `catalog.reconcile` | 会话/工作区元数据全量对账（`{node_id, sessions[], workspaces[]}`） |
| `presence.report` | 上报 `PresenceClaim` |

**hub → node（`NODE_METHODS`）**

| 方法 | 用途 |
|------|------|
| `health` | 取节点分层健康（触发本地探针） |
| `listWorkspaces` / `listSessions` | 只读发现（discovery 聚合用，15s 超时） |
| `createSession` / `getSession` / `resumeSession` / `prompt` / `cancel` | 会话操作，映射到本地 daemon 对应 MCP 工具 |
| `mcp.call` | **通用工具透传** `{tool, args}`——路由后的主执行通道 |
| `presence.report` | 协议保留（节点侧 presence provider 上报承接） |
| `audit.append` | 协议保留（hub 要求节点本地记录审计） |

### 4.4 错误码

| 码 | 名称 | 语义 |
|----|------|------|
| -32001 | `VERSION_MISMATCH` | 协议版本不兼容：明确拒绝，绝不静默降级 |
| -32002 | `AUTH_FAILED` | HMAC 挑战失败 / 节点被 block / 超过 3 次 auth 尝试 |
| -32003 | `NODE_ID_CONFLICT` | 身份冲突（如未注册节点发心跳） |
| -32004 | `METHOD_NOT_FOUND` | 未知 RPC 方法 |
| -32600 | `INVALID_REQUEST` | 请求形状非法 |
| -32603 | `INTERNAL_ERROR` | 处理内部错误 |
| -32010 | 路由拒绝 | `errorCode` 细分：`no_route` / `route_confirmation_required` / `unknown_node` |
| -32011 | `node_unavailable` | 目标节点无活动连接 |
| — | rpc timeout | 请求超时（默认 30s；forward 60s；聚合读 15s） |

### 4.5 心跳/租约时序（决策 5）

```
Node Agent                                          Hub
   │ hello → challenge → auth → welcome             │
   │ ── node.register ────────────────────────────▶  │
   │ ── catalog.reconcile（会话/工作区全量）────────▶  │
   │ ── node.heartbeat ──▶  每 15s（seq 单调递增）    │
   │        … 45s 内无心跳 → node lease 过期           │
   │        连续 3 次丢失（3 × 15s = 45s）→ 判离线     │
   │                                                │
   │ 断连 → 指数退避 1s→2s→…→30s + jitter(0–500ms)   │
   │ 重连成功 → 退避重置 → 全量 re-register + reconcile│
```

- **心跳**：15s；**节点租约**：45s；**离线判定**：连续 3 次心跳丢失（lease 过期）。
- **presence**：renew 20s / TTL 60s；claim 携带 confidence + source + observed_at；15s 窗口内两台都 high-confidence fresh = ambiguous（不自动选）；manual claim 默认 TTL 10min，可 pin 可显式 release；**显式 target 永远优先**。
- **重连**：指数退避 + jitter；重连后全量 re-register + metadata reconcile（**无部分状态**）。

## 5. 路由决策详解

### 5.1 优先级（决策 7，`Router.route` 严格顺序）

1. **explicit target_node**（调用方显式指定节点；未知节点 → `unknown_node` 拒绝；已知但当前不健康仍 forward，理由中注明）
2. **session owner**（session 强亲和：native session id 解析到所属节点；**不静默迁移**——会话永远留在 owner node）
3. **workspace owner**（code 工具强亲和：workspace 解析到所属节点；**code 调用必须代理到 owner node，不是 hub 本地 serena**——hub 不实现任何代码智能，只做路由）
4. **无歧义 fresh presence**（`PresenceRegistry.activeNode`：pinned manual claim 优先；否则最新 `confidence ≥ 0.8` 的租约；两台 fresh high-confidence 落在 15s 歧义窗口内 → ambiguous，**不自动选**）
5. **配置的 default/local healthy 节点**（`defaultNodeId`，通常即 hub 自身节点，要求 lease 内 online）
6. **no-route**（无显式目标、无 session/workspace owner、无 fresh presence、无健康 default）

> 新会话（无 session 无 workspace）：presence 可先于 session owner——因为还没有 owner 可循，路由自然落到第 4 级 presence。

### 5.2 读/写区分与 fail-closed（决策 8）

- **只读发现类**（`nodes_list`/`workspaces_list`/`sessions_list`/`agents_list`/`supervisor_health`/`projects_list`）：`discovery: true`，hub 本地聚合多节点应答，不占用路由。
- **破坏性/副作用类**（`prompt`/`resume`/`cancel`/`create`/write-capable code 工具如 `code_use_workspace`）：走 Router；**在 fallback 路由 + 目标不清晰时 fail-closed**——`no_route` 结果且 danger 为 `destructive`/`write` → 返回 `route_confirmation_required`（`confirmation_required: true`），调用方必须拒绝，除非提供显式 `target_node`。
- danger 分类：`read`（发现/只读 code/`sessions_get`/`sessions_wait`）· `write`（`code_use_workspace`/`sessions_create`/`sessions_cancel`/`presence_claim`/`presence_release`）· `destructive`（`sessions_resume`/`sessions_prompt`）。
- 聚合读单节点失败只跳过该节点（读容忍），写操作绝不静默换节点。

### 5.3 `route_explain` 示例

工具 `route_explain`（`op` 必填，可带 `session_id`/`workspace`/`target_node`）只解释不执行。示例 1——session 亲和命中，forward：

```json
{
  "op": "sessions_prompt",
  "danger": "destructive",
  "decision": {
    "outcome": "session_owner",
    "node_id": "3f2c9a1e-8b4d-4c6a-9e01-2a5b7c8d9e0f",
    "reason": "session s_ab12cd34 owned by node 3f2c9a1e-8b4d-4c6a-9e01-2a5b7c8d9e0f",
    "evidence": {
      "session_owner": "3f2c9a1e-8b4d-4c6a-9e01-2a5b7c8d9e0f",
      "presence_ambiguous": false,
      "healthy_nodes": ["3f2c9a1e-8b4d-4c6a-9e01-2a5b7c8d9e0f", "8d4b2f11-77aa-4c3e-b2dd-001122334455"]
    },
    "candidates": [
      { "node_id": "3f2c9a1e-8b4d-4c6a-9e01-2a5b7c8d9e0f", "reason": "session owner (s_ab12cd34)" }
    ],
    "danger": "destructive",
    "explicit": false
  },
  "action": "forward",
  "errorCode": null
}
```

示例 2——fallback 无路 + destructive → fail-closed 拒绝：

```json
{
  "op": "sessions_prompt",
  "danger": "destructive",
  "decision": {
    "outcome": "no_route",
    "node_id": "",
    "reason": "no explicit target, no session/workspace owner, no fresh presence, no healthy default node (destructive op: route_confirmation_required)",
    "evidence": { "presence_ambiguous": false, "healthy_nodes": [] },
    "candidates": [],
    "danger": "destructive",
    "explicit": false,
    "confirmation_required": true
  },
  "action": "reject",
  "errorCode": "route_confirmation_required"
}
```

### 5.4 决策记录（决策 9）

- **每次路由决策写 route_log**：request/tool、selected node、reason、explicit?、danger、result——**无 prompt 正文、无密钥**（`store.AuditLog.logRoute` 存完整 `RouteDecision` JSON，供 `route_explain` 溯源）。
- **audit 表**：`ts/call_id/op/actor_node/target_node/session_id/decision/danger/explicit/result`，result 为 `ok` / `error:<code>` / `rejected` 摘要。
- 结构化 JSON 日志（hub 侧每路由一行 `route <callId> <op> -> <node> (<outcome>)`、`route-result ...`）；统一 redactor 保证 node token / tunnel token / API key 永不出现在 argv、git、快照里。

## 6. 数据模型（SQLite，schema v1）

存储文件默认 `~/.dsh/helm/store.sqlite3`（Windows：`%LOCALAPPDATA%\dsh-helm\store.sqlite3`）。7 张表：

| 表 | 用途 | 关键列 |
|----|------|--------|
| `kv` | 键值（含 `schema_version`，迁移依据） | key PK, value |
| `nodes` | 节点注册表 | node_id PK, display_name, platform(JSON), versions(JSON), capabilities(JSON), config_home, status(`online|offline|blocked`), last_seen, heartbeat_seq, registered_at, blocked_reason, schema_version |
| `presence_leases` | presence 租约 | node_id PK, source, confidence, observed_at, expires_at, pinned |
| `sessions` | 会话目录（元数据） | global_key PK(`node_id:native_session_id`), node_id, native_session_id, title, status, updated_at, workspace_id, live；UNIQUE(node_id, native_session_id) |
| `workspaces` | 工作区目录（元数据） | global_key PK(`node_id:native_workspace_id`), node_id, native_workspace_id, path, title, session_count；UNIQUE(node_id, native_workspace_id) |
| `audit` | 审计日志 | id PK, ts(idx), call_id, op, actor_node, target_node, session_id, decision, danger, explicit, result |
| `route_log` | 路由决策日志 | id PK, ts(idx), call_id, op, decision(JSON `RouteDecision`), explicit |

**全局标识规则（决策 4）**：global session key = `node_id:native_session_id`（native id 原样保留，节点私有）；workspace catalog key = `node_id` + native workspace id；**path 只是属性，永远不是跨 OS 身份**（同一路径在两台 OS 上是两个不同 workspace）。裸 native id 跨节点歧义时解析返回 undefined，绝不猜测。**存储只含元数据，绝不存 DSH 会话正文**。

## 7. 生命周期

### 7.1 节点加入

1. `dsh-helm init`：首次安装生成 `node_id`（UUID）+ token（32B base64url），写入 `~/.dsh/helm/node.json`（**0600**）；`display_name` 缺省 hostname（仅展示）。
2. `dsh-helm agent` 启动（由 platform 包生成的服务模板守护：launchd KeepAlive / Windows Scheduled Task / systemd Restart=always）。
3. 出站拨号 hub → HMAC 握手 → welcome。
4. `node.register`（注册 NodeInfo 与 capabilities：sessions/serena/tunnel/presenceProvider/defaultNode）→ 立即 `catalog.reconcile` 全量上报本地会话/工作区元数据。
5. 进入心跳循环（15s）；presence provider 开始上报 claim。

### 7.2 节点离开与离线

- **优雅离开**：`node.release` → hub `markOffline(node_id, 'node released')` + 删除活动连接。
- **异常断连**：socket close → node agent 进入退避重连；hub 侧 lease 45s 内无心跳 → `channelHealth` 报 `lease-expired`、`status` 判离线（连续 3 次心跳丢失）。
- **违规节点**：身份冲突 / 不兼容版本 / 被运维封锁 → `status = blocked`（heartbeat 被拒：`AUTH_FAILED`）；`unblock` 恢复为 offline 重新走注册。

### 7.3 重连（决策 5）

指数退避（1s 起 ×2，上限 30s）+ jitter（0–500ms），`reconnecting` 状态内不重复调度；重连成功（welcome）后**退避重置**，并执行**全量 re-register + metadata reconcile**——不依赖任何断线前残留的部分状态（无部分状态原则）。之后周期 reconcile（60s）持续校正目录。

### 7.4 健康分层（决策 9，绝不折叠成单一 `status: ok`）

| 层 | 含义 | 来源 |
|----|------|------|
| `control` | 控制平面进程 + store | hub 计算（store 可达 → ok，否则 `store-unavailable` down） |
| `channel` | 节点 WS 连接 + lease 新鲜度 | hub registry 计算（`lease-expired` / `node-blocked` / `node-unknown`） |
| `adapter` | 节点 DSH plugin/adapter bridge（本地 helm daemon 可达） | 节点 heartbeat 上报（`adapter-unreachable`） |
| `datapath` | `sessions_list` 真正端到端可用 | 节点 heartbeat 上报（`datapath-unreachable`） |
| `serena` | Serena/workspace 运行时 | 节点 heartbeat 上报（`serena-disconnected` degraded） |
| `tunnel` | 入口隧道（仅 hub 节点） | 节点 heartbeat 上报（可选） |

`HealthAggregator` 逐层独立报告；节点级汇总仅作为便捷字段（channel/adapter/datapath 有 down 即 down，有 degraded 即 degraded），**层与层互不掩盖**——channel 活着但 datapath 死掉必须可见。`supervisor_health` 返回 control + 全部节点分层健康 + serena 聚合 + tunnel 状态。

## 8. 兼容模式（单机部署如何保持现有行为）

### 8.1 单机拓扑收敛

入口节点跑 hub + 一个 node agent（`node_id == hub defaultNodeId`）：Router 的 explicit/session/workspace/presence/default 全部收敛到同一节点，行为与单机 daemon 完全一致（`HubMcpServer` 注释即此契约）。19 个兼容工具（snake_case）原样保留，ChatGPT 隧道照旧工作；`supervisor_health` 兼容字段（`serena.connected`、`tunnel.managed:false` 等）保持既有语义，只增不破。

### 8.2 connector/tunnel 保留（additive，不是替代）

每台机器的 connector/tunnel 继续以单机兼容基线运行：`../connector/`（dsh-chatgpt-connector worktree）是**单机兼容基线 bash 套件**——install/uninstall/verify、tunnel-client keepalive（15s 探针 + 自动拉起）、dsh-web-watchdog（受控重启），launchd 模板、`credentials.example.yaml`、`helm-tunnel.patch.yml`（tunnelEnabled:false）与故障注入测试套件。控制平面不替代它；入口节点上 tunnel 仍由该套件管理（健康探针端口示例 3468，旧默认 3458），Hub MCP（3471）成为新的隧道对接面。长期方向是单一 Connector/Hub，但**每个节点保留安全兼容模式**。

### 8.3 安全模型延续

所有本地服务只监听 127.0.0.1（3080/3457/3458/3472）；MCP 调用带 Bearer token；凭据存 0600 私有文件（`~/.dsh/helm/node.json`、daemon token 文件、`~/.dsh/.credentials.yaml`），不入库、不进日志、不出现在 argv/git/快照（决策 9 redactor）。

### 8.4 上游固定（决策 12）

beforewave `agent-chatgpt-helm` / `dsh-chatgpt-helm` 固定 **0.1.1 不动**（生产 node_modules 不改）；dev 区 `upstream-helm/` 是 **npm tarball 精确快照 pin**（core: `@beforewave/agent-chatgpt-helm@0.1.1`，plugin: `@beforewave/dsh-chatgpt-helm@0.1.1`；`lib/` 为 esbuild 编译产物，`.d.ts` 是权威 API 面）——供本地开发对照，永不污染生产依赖。

### 8.5 harness 核心零侵入（决策 13）

hub 通过每个节点本地 daemon 的 **MCP 语义**工作（`mcp.call`/`sessions_*`/`code_*`/`supervisor_health`），不碰 daemon 内部协议、不修改 DSH/插件源码；watchdog 等 shell 自愈逻辑留在 connector bash 套件，**不进 TS 核心**。

## 9. 已知边界与未来

- **handoff（决策 11）**：接口与规范已定义（CLI `handoff <session> <to-node>`、协议预留），v1 诚实返回 `unsupported`——在出现**无损迁移**方案前不做 fake 实现。未来需要解决：会话状态/上下文如何在节点间迁移、目标节点 daemon 的会话重建语义、迁移期间的审计链。
- **Windows 落地**：presence 用 PowerShell 前台进程 scaffold（静态片段、测试断言稳定），服务用 Scheduled Task 模板，配置路径静态可测；browser MV3 扩展跨平台同构。待真机验证项：PowerShell 执行开销、Scheduled Task 在锁屏/睡眠下的行为。
- **多 hub / 高可用**：当前为单 hub 设计——活动连接表在内存、store 单文件 SQLite；多 hub、hub 故障转移、store 复制尚未定义。hub 重启后节点靠重连机制自动恢复（全量 re-register + reconcile），这是当前唯一的自愈路径。
- **audit/route_log 持久化**：store 层 `AuditLog` DAO（`append`/`logRoute`）已就绪；控制平面审计的完整落库与查询面（含 call_id 全链路关联）待补齐。
- **presence 边界**：browser 扩展需要用户手动加载（scaffold 生成，非商店分发）；`idle` 来源为显式低置信预留；歧义窗口内的两台机器不会自动选（fail-safe 偏保守，靠 manual claim / explicit target 收敛）。
- **只读聚合的语义**：`projects_list`/`workspaces_list`/`sessions_list`/`agents_list` 返回多节点扁平结果并带 `node_id`；跨节点同名/同路径不合并（path 不是身份）。
- **路由与审计**：`target <node>` 是 CLI 会话级内存态；session 强亲和的「不静默迁移」意味着会话一定回到 owner node，跨节点搬运会话只能走未来 handoff。
- **网络边界**：TLS 终止（证书、反代）由部署方负责（`MeshServer` 接受外部 https server）；节点 token 轮换走 `rotate-token`，配套的 hub 侧 token 更新流程需运维完成。

---

## 附录 A：MCP 工具面全表（`packages/hub/src/mcp/tools.ts`）

24 个工具 = 19 兼容 + 5 新增。`danger` 驱动 Router 的 fail-closed 策略；`workspaceRouted`/`sessionRouted` 决定路由键；`discovery` 工具 hub 本地聚合。所有可路由工具均接受可选 `target_node`。

| 工具 | danger | 路由 | 说明 |
|------|--------|------|------|
| `code_use_workspace` | write | workspace | 选择操作工作区（原样兼容） |
| `code_read_file` | read | workspace | 读文件 |
| `code_list_dir` | read | workspace | 列目录 |
| `code_find_file` | read | workspace | 按名模式找文件 |
| `code_search_for_pattern` | read | workspace | 正则搜内容 |
| `code_get_symbols_overview` | read | workspace | 符号总览 |
| `code_find_symbol` | read | workspace | 按名找符号 |
| `code_find_referencing_symbols` | read | workspace | 找引用符号 |
| `projects_list` | read | discovery | 跨节点列项目（聚合） |
| `workspaces_list` | read | discovery | 跨节点列工作区（聚合） |
| `sessions_create` | write | session+workspace | 建会话 |
| `sessions_list` | read | discovery | 跨节点列会话（聚合，可 `node_id` 过滤） |
| `sessions_get` | read | session | 取会话详情 |
| `sessions_resume` | destructive | session | 恢复会话 |
| `sessions_prompt` | destructive | session | 发消息（fail-closed 核心） |
| `sessions_wait` | read | session | 等待终态 |
| `sessions_cancel` | write | session | 取消运行中会话 |
| `agents_list` | read | discovery | 跨节点列 agent（聚合） |
| `supervisor_health` | read | discovery | control 层 + 各节点分层健康（扩展） |
| `nodes_list` | read | discovery | **新增**：列节点（连接/能力/状态） |
| `node_get` | read | discovery | **新增**：单节点 + 分层健康 |
| `route_explain` | read | discovery | **新增**：解释路由不执行 |
| `presence_claim` | write | hub 本地 | **新增**：manual claim（10min pin） |
| `presence_release` | write | hub 本地 | **新增**：显式释放 manual claim |

> 兼容规则：19 个兼容工具的参数（snake_case）与单机 daemon 完全一致，`target_node` 是唯一新增的可选参数，ChatGPT 侧旧调用不受影响；`_route` 字段附在转发结果内，供 `route_explain` 类调试任务使用。
