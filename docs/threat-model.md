# dsh-helm 多节点控制平面威胁模型

本文档与 `docs/architecture.md` 配套：架构文档描述系统"是什么"，本文描述"攻击面在哪、出事了会怎样、现在靠什么挡、还剩什么风险"。所有缓解都引用真实实现机制（模块/类/常量/脚本名），不写泛泛之谈；事实以 `packages/` 源码与 `../connector/` 套件为准，读者应能据此逐条复核。

## 1. 范围与目标

**范围内**：控制平面（Hub mesh/MCP、Node Agent、协议握手、路由、presence、SQLite store、审计日志）、每台机器本地 helm daemon 边界、上游固定依赖、入口节点上的单机兼容套件（tunnel-client / watchdog / keepalive）、跨机器数据暴露面。

**范围外**（仅记录，不展开）：DSH 核心本身的安全（沿用 deepseek-harness 自身模型）、OpenAI/Cloudflare 平台侧安全、操作系统用户隔离（本文默认同一 OS 用户可信）。

**方法论**：先给架构事实与信任边界（§2），再按 15 条威胁逐条给出 `威胁描述 / 攻击场景 / 影响 / 缓解 / 残余风险`（§3），最后是风险登记、已接受风险与加固建议（§4/§5）。

## 2. 架构事实与信任边界

### 2.1 组件与端口（事实）

| 端口 | 组件 | 认证 | 绑定 |
|---|---|---|---|
| 3470 | Hub mesh WS（`MeshServer`，节点出站拨号入口） | HMAC-SHA256 challenge 握手 | hub-cli 默认 `127.0.0.1`（`--bind` / `DSH_HELM_BIND`；MeshServer 未显式传 host 时 ws 库默认监听所有接口） |
| 3471 | Hub MCP（`hub-cli.ts` 的 Streamable HTTP，`/mcp` + `/healthz`） | **v1 无鉴权**（仅 loopback 默认绑定） | 默认 `127.0.0.1` |
| 3472 | 本地 presence listener（`packages/presence/src/listener.ts`，接收 browser 扩展上报） | 无（仅 loopback） | `127.0.0.1` 硬编码 |
| 3457 | 每台机器本地 helm daemon MCP（`/mcp` + `/healthz`） | `/mcp` 需 `Authorization: Bearer <token>`；`/healthz` 免认证 | `127.0.0.1`（upstream `config.d.ts` 默认） |
| 3458 | 入口节点 tunnel-client 健康端口 | 无（仅 loopback） | `127.0.0.1` |
| 3080 | DSH web | 无登录墙；靠 loopback 绑定 + trustedHosts 围栏 | `127.0.0.1` |

> 注：tunnel-client 健康端口（上表 3458 为旧 connector 套件默认）可用 `--health.listen-addr` 配置，本仓库验证部署使用 `127.0.0.1:3468`——两者均为示例值，以实际部署为准（见 `docs/architecture.md` §2 端口表）。

**信任边界总结**：系统整体是"本地可信、网络存疑"。节点之间永远是**星型**：Node Agent 只出站拨号 hub（`HelmNodeAgent.connect`，`ws://` 仅 loopback/test，生产 `wss://`），节点与节点之间没有任何直接通道；hub 是唯一路由者（`Router`）与唯一执行通道（`mcp.call`）。每台机器的 DSH 只通过本地 daemon 的 3457 MCP 端点（Bearer token）暴露给本机 Node Agent（`LocalHelmBackend`（默认 `McpLocalHelmBackend`）），daemon 的 unix socket adapter 协议（`~/.agent-chatgpt-helm/run/daemon.sock`，无认证）绝不上网络。

### 2.2 节点身份与握手（事实）

- 身份 = `node_id`（UUID，首次安装由 `loadConfig` 生成并写 `~/.dsh/helm/node.json`，**0600**）；`display_name`（hostname）只是展示名，永远不是身份（`types.ts` 设计规则）。
- 握手（`packages/protocol/src/handshake.ts`）：`hello{v,node_id,nonce} → challenge{server nonce} → auth{mac} → welcome`；`mac = HMAC-SHA256(token, client_nonce + server_nonce)`；验证用 `verifyMac`（`crypto.ts`，`timingSafeEqual` 常时比较）；服务端 `HandshakeServer` 每个连接 **auth 尝试上限 3 次**，超限发 `AUTH_FAILED` 并关闭；`hello.v` 与 hub `schemaVersion` 不匹配立即 `VERSION_MISMATCH` 拒绝（**绝不静默降级**）。
- token：32B 随机（`NODE_TOKEN_BYTES`），base64url；hub 侧查找来自 `ControlPlane.tokenLookup`，v1 由 `hub-cli.ts` 的 `tokenLookupFromEnv` 从 `DSH_HELM_TOKEN` 环境变量（`node_id=token,...` 逗号分隔）注入——代码注释明示"生产建议 secrets 管理"。
- RPC：握手成功后建 `RpcPeer`（JSON-RPC 2.0），hub 侧只注册固定 handler 表（`node.register/heartbeat/release`、`catalog.reconcile`、`presence.report`），**节点无法调用 hub 的任意方法**；hub→节点方向经 `mcp.call` 透传路由后的工具调用。
- 时序常量（`protocol/src/constants.ts`）：heartbeat 15s、节点 lease 45s、presence renew 20s / TTL 60s、**歧义窗口 15s**、manual claim 默认 TTL 10min（上限 60min）、reconnect 退避 1s→30s（+0–500ms jitter）、RPC 超时默认 30s（forward 60s、聚合读 15s）。

### 2.3 路由与 fail-closed（事实）

`Router.route`（`packages/hub/src/router.ts`）严格优先级：

1. 显式 `target_node`（未知节点 → `unknown_node` 拒绝）
2. session owner（catalog `get`，裸 native id 跨节点歧义 → undefined，不猜测）
3. workspace owner（`resolve` 按 global key / native id / path，歧义 → undefined）
4. 无歧义 fresh presence（`PresenceRegistry.activeNode`：pinned manual 优先；否则最新 `confidence≥0.8`；两台 fresh high-confidence 落在 `PRESENCE_AMBIGUITY_WINDOW_MS=15s` 窗口内 → **ambiguous 不自动选**）
5. 配置的 default healthy 节点（`defaultNodeId`）
6. no-route

fail-closed：`danger=destructive|write` 且落到 no-route → 返回 `route_confirmation_required`（`confirmation_required:true`），调用方必须拒绝，除非给显式 `target_node`；`danger=read` 的 no-route 返回 `no_route`。`danger` 分类在 `packages/hub/src/mcp/tools.ts`：`read`（发现/只读 code/sessions_get/sessions_wait）、`write`（code_use_workspace/sessions_create/cancel/presence_claim/release）、`destructive`（sessions_resume/sessions_prompt）。

### 2.4 存储与日志（事实）

- SQLite（`node:sqlite DatabaseSync`，WAL + `busy_timeout` + `synchronous=NORMAL` + `foreign_keys=ON`，`schema_version` 迁移，新库版本高于支持版本直接拒绝）：`~/.dsh/helm/store.sqlite3`。7 张表全部是元数据——nodes / presence_leases / sessions / workspaces / audit / route_log / kv；**任何表都不存 DSH 会话正文**（`db.ts`、`types.ts` 设计规则，wire 也只承载元数据）。
- audit 表列：`ts/call_id/op/actor_node/target_node/session_id/decision/danger/explicit/result`（`store/src/audit.ts` `AuditLog` DAO：`append` 先插 `result='pending'`，`auditResult` 按 `call_id` 用 `updateResult` 回填结果）；route_log 存完整 `RouteDecision` JSON（reason/evidence/candidates，无 args 无 prompt）。**接入现状**：`ControlPlane.auditRoute`/`auditResult` 已把每次路由决策写入 `logRoute` + `append`（v0.1.0 起），`call_id` 贯穿审计/路由/应用日志。
- redactor：upstream core 的 `redactText(text, secrets)`（长度≥4 的 secret 替换为 `[REDACTED]`）用于隧道 stdout/stderr 转发；隧道凭据经 `env:` 间接语法注入（`--control-plane.api-key env:CONTROL_PLANE_API_KEY`、`--mcp.extra-headers "Authorization: env:AGENT_CHATGPT_HELM_AUTH"`），**token 不出现在 argv/ps**；node token 从 0600 文件读取，"never from argv or environment dumps"（`node-agent/src/config.ts`）。

### 2.5 本地 daemon 边界（事实）

- daemon（`@beforewave/agent-chatgpt-helm@0.1.1`）默认：unix socket adapter `~/.agent-chatgpt-helm/run/daemon.sock`（无认证，仅本机进程间）；HTTP MCP `127.0.0.1:3457/mcp`，Bearer token 来自 `~/.agent-chatgpt-helm/token`（`resolveCoreToken`：env `AGENT_CHATGPT_HELM_TOKEN` 优先，否则读文件；文件缺失时生成 32B base64url 并以 **0o600** 写入）。
- Node Agent 的 `LocalHelmBackend`（默认 `McpLocalHelmBackend`） **只用** 3457 `/mcp`（带 Bearer），刻意不碰 unix socket adapter 协议（`bridge.ts` 注释：loopback-only, unauthenticated）。因此 daemon.sock 协议永不因本控制平面而上网络。

### 2.6 上游与单机套件（事实）

- 上游固定：`@beforewave/agent-chatgpt-helm@0.1.1`（core）+ `@beforewave/dsh-chatgpt-helm@0.1.1`（plugin）npm tarball 精确 pin（`upstream-helm/PIN.md` 记录 gitHead；源码仓库 private/404，tarball 是唯一权威）；dsh-helm 各包对 `@modelcontextprotocol/sdk` 用精确版 `1.30.0`。
- 单机套件（`../connector/`，兼容基线）：tunnel-client 以 `CONTROL_PLANE_TUNNEL_ID` / `CONTROL_PLANE_API_KEY` 连 `api.openai.com`（**必须经本地 HTTPS 代理 `HTTPS_PROXY=<local-proxy>`**，无代理控制面轮询全超时）；`dsh-web-watchdog.sh`（10s 探 3080+3457，双失败≥3 次才受控重启，PID 锁单实例）、`tunnel-client-keepalive.sh`（15s 探 3458+3457 + daemon PID 比对，重建隧道，PID 锁）；插件侧 patch `tunnelEnabled:false`（daemon 不自管隧道，keepalive 独占）。DSH web 3080 无认证，靠 loopback/trustedHosts 围栏。

### 2.7 生命周期与健康分层（事实）

- 节点加入：`dsh-helm init`（生成 node_id+token）→ `dsh-helm agent` 出站拨号 → HMAC 握手 → `node.register` → `catalog.reconcile` 全量上报 → 15s 心跳 + presence 上报。
- 节点离开：优雅 `node.release` → `markOffline`；异常断连 → 退避重连；45s 无心跳 → `channelHealth` 报 `lease-expired`、节点判离线；身份冲突/版本不兼容/被封锁 → `status=blocked`（heartbeat 被拒 `AUTH_FAILED`），`unblock` 恢复。
- 健康分层（`HealthAggregator`，绝不折叠成单一 `status: ok`）：`control`（hub 进程+store）· `channel`（节点 WS+lease）· `adapter`（本地 daemon 可达）· `datapath`（sessions_list 端到端）· `serena`（workspace 运行时）· `tunnel`（仅 hub 节点）。

### 2.8 敏感数据流盘点（谁在哪条链路上能看到什么）

| 数据 | 出现在 | 落盘 | 保护 |
|---|---|---|---|
| 会话正文 / prompt message | 执行路径：`mcp.call` 参数与结果，经 mesh（wss）→ hub 内存转发 → 节点 daemon → 本地 DSH | **hub 不落盘** | wss + 节点/daemon 本地信任 |
| 会话/工作区元数据（title/status/path） | wire、catalog、audit、route_log、`sessions_list` 聚合结果 | SQLite（hub） | 目录权限（依赖 umask） |
| 文件内容（code_* 读结果） | `mcp.call` 结果，经 mesh 与 hub 转发 | hub 不落盘 | wss |
| node token / daemon token / tunnel 凭据 | 0600 文件、进程环境（`env:` 注入） | 明文文件 | 0600 + 不进 argv/git/日志 |
| presence claim（source/confidence） | wire、presence_leases 表 | SQLite | 无敏感内容 |

## 3. 威胁清单

### T1 网络嗅探 / 中间人（WS 明文、无 TLS）

- **威胁描述**：mesh 端口（3470）在明文 `ws://` 下，同一网络（LAN/Wi-Fi/上游链路的恶意节点）可嗅探握手与全部 RPC 帧；可主动发起 MITM（不验证服务器身份，client 无法确认对端是 hub）。
- **攻击场景**：攻击者在同一 Wi-Fi 上嗅探到一台节点与 hub 的 `ws://` 会话，录下 `sessions_prompt` 的 message 与 `code_read_file` 的返回内容；或伪冒 hub 向节点下发伪造 welcome/error，让节点误以为连上了合法控制平面。
- **影响**：数据帧含节点注册信息、会话/工作区**元数据**、`mcp.call` 参数（工具名与参数——`sessions_prompt` 的 message 明文经过 mesh！）；可篡改路由结果、注入伪造 welcome/error，导致节点拒绝服务或把请求导向错误执行。
- **缓解**：生产必须 `wss://`（`MeshServer` 文档明示 TLS 是调用方职责：传外部 https server 或反代终止；agent 的 `hub_url` 用 wss）；`ws://` 仅限 loopback/test（`config.ts` 注释与架构决策 2）；握手是 HMAC challenge，**token 本身永不上线**（线上只有 nonce + MAC）；hub-cli 默认 bind `127.0.0.1`，跨机器接入必须显式 `DSH_HELM_BIND=0.0.0.0` 走 TLS 反代或 SSH 隧道。
- **残余风险**：① 内网直连 `ws://LAN-IP:3470` 属于"用户自担"的可信网络假设（文档明确提示不要暴露公网，但代码层没有强制）；② hub MCP 3471 无鉴权，若被映射出 loopback（反代配置失误）即成为无认证的指令入口；③ TLS 证书管理、反代配置正确性依赖部署方。

### T2 握手重放 / 暴力破解

- **威胁描述**：攻击者录制一次完整握手帧（hello/challenge/auth），重放；或对 token 做离线/在线暴力尝试；或对已知 node_id 反复尝试 auth。
- **攻击场景**：攻击者截获一次握手后，反复重放录制的 auth 帧——但每次重放都会得到**新的** server challenge，旧 mac 对新 nonce 必然不匹配；或对 32B token 做字典攻击（256-bit 空间，现实不可行）。
- **影响**：重放成功=以该节点身份进入控制平面；暴力破解 256-bit token 理论上不可能，但未限频的在线尝试可骚扰 hub 并产生噪音日志。
- **缓解**：**nonce 双向随机**（`generateNonce` 24B，客户端与服务端各一枚，`mac = HMAC-SHA256(token, client_nonce+server_nonce)` 同时绑定两枚）——重放的 hello 会拿到新 challenge，旧 mac 必然不匹配；`verifyMac` 用 `timingSafeEqual` 常时比较（消除时序侧信道）；`HandshakeServer.authAttempts` 每连接 **上限 3 次**，超限即 `AUTH_FAILED` 并关闭；32B token = 256-bit 熵，暴力空间不可行。
- **残余风险**：3 次上限是**每连接**的；攻击者可以开新连接无限重试（没有全局/按 IP 限频器——见 T13）；握手成功后到 `node.register` 之间没有额外的设备指纹/绑定。

### T3 token 泄露（配置文件、进程环境、git、日志）

- **威胁描述**：节点 token（`node.json`）、hub token 表（`DSH_HELM_TOKEN` 环境）、daemon Bearer token（`~/.agent-chatgpt-helm/token`）、隧道凭据（`~/.dsh/.credentials.yaml`）四类密钥，泄露渠道：文件权限错误、备份/同步工具、进程环境快照、命令行参数、日志、git 误提交。
- **攻击场景**：① 用户把 `node.json` 或 `~/.dsh/.credentials.yaml` 提交进 git（`.gitignore` 已排除 `*.sqlite3` 与凭据模板，但真实凭据文件在用户主目录，靠用户自觉不入库）；② 备份工具把 0600 文件带进云同步；③ `ps aux` 抓到 `--api-key` 明文参数（现状用 `env:` 语法已避免）。
- **影响**：hub token 泄露=任意 node_id 可冒充该节点（T4）；daemon token 泄露=本机任意进程可调 DSH 全量工具；隧道凭据泄露=可接管 ChatGPT 入口。
- **缓解**：`loadConfig` 写 `node.json` 用 `mode:0o600` + `chmodSync(0o600)`；daemon token 由 `resolveCoreToken` 以 0o600 落盘；`~/.dsh/.credentials.yaml` 0600 且 `connector/.gitignore` 排除凭据与 `*.sqlite3`（`dsh-helm/.gitignore` 同样排除）；**token 不出现在 argv**——隧道用 `env:` 语法读进程环境（`--control-plane.api-key env:CONTROL_PLANE_API_KEY`），agent 侧注释明确 "never from argv or environment dumps"；redactor（`redactText`，secret 长度≥4 替换 `[REDACTED]`）覆盖隧道 stdout/stderr 转发；审计/路由日志无密钥字段；hub 侧 `tokenLookup` 来自环境注入而非配置文件明文入库（也避免了 token 落 SQLite）。
- **残余风险**：① 密钥**静态存储全部明文**（无加密磁盘/钥匙串）；② 环境变量对同用户进程可见；③ 备份工具（Time Machine/云同步）可能把 0600 文件复制走；④ `rotate-token` 命令存在但 hub 侧 token 表更新是人工运维动作，轮换期间存在双 token 窗口。

### T4 恶意 / 伪造节点加入

- **威胁描述**：攻击者部署自己的 agent（或改写客户端）向 hub 声称某个 node_id；或注册一个全新 node_id 混入网格。
- **攻击场景**：攻击者拿到某节点的 token（T3 泄露）后，在自己的机器上以该 node_id 拨号 hub——握手通过，之后可以"代表"该节点接收路由；或伪造一个新 node_id 并尝试注册，若 hub 的 `DSH_HELM_TOKEN` 里恰好没有该 id（tokenLookup 返回 undefined）则 auth 必失败。
- **影响**：冒充合法节点可接收路由到该节点的 `mcp.call`（拿到该节点能拿到的所有 DSH 能力视图）、污染该节点的 catalog/presence；新节点混入可诱导路由（presence/默认节点回退）。
- **缓解**：身份绑定 token——`lookupToken(node_id)` 未知 node_id 返回 undefined → auth 必失败（`HandshakeServer`）；`isValidNodeId` 校验 UUID 形状；`node.heartbeat` 对未注册/被 block 节点抛 `NODE_ID_CONFLICT`/`AUTH_FAILED`（registry `block`/`unblock` 支持运维封锁）；注册只在握手成功后发生（RpcPeer 延迟到 welcome 之后才创建，握手前 rpc 帧被忽略）；节点只能注册自己的 node_id（node_id 取自握手，注册用 `hello.node_id`）。
- **残余风险**：v1 的 token 分发是**人工**的（`DSH_HELM_TOKEN` 环境注入），token 一旦泄露即等价于身份泄露；没有自动的"未知设备加入需审批"流程；`display_name` 可被任意伪装（只是展示字段）。

### T5 节点被攻陷后的横向移动

- **威胁描述**：某台节点（或它的 agent 进程）被攻陷。攻击者以该节点的身份与能力为起点，尝试触及别的节点/hub。
- **攻击场景**：攻击者攻陷了 node B 的 agent 进程（如代码注入），尝试：读取 hub 下发给 B 的 `mcp.call`（含 prompt 正文）；向 hub 上报伪造 catalog/presence 把流量吸到 B；向 hub 发起 `node.register` 之外的 RPC（被固定 handler 表拒绝）；尝试直接连 node A 的端口（A 不监听任何入站端口，且节点间无任何约定通道）。
- **影响（该节点能看到什么、能做什么）**：
  - 看到：自己经 mesh 收发的全部内容（含发往自己的 `mcp.call` 参数，如 `sessions_prompt.message`）；自己本地 daemon 可读的 DSH 会话/工作区；hub 广播/下发的元数据。**看不到**：其他节点的会话正文（star 拓扑，无节点间通道；hub 只转发元数据聚合）。
  - 能做：① 污染自己的 catalog（`catalog.reconcile` 上报任意 session/workspace 元数据）与 presence（`presence.report` 上报 confidence 1.0 pinned）→ 诱导路由；② 对发往自己的操作"撒谎"（`mcp.call` 返回任意结果）；③ 篡改自己节点上的会话内容（本来就有权）；④ 无法以他人身份发言（每连接独立握手）；⑤ 无法调用 hub 任意 RPC（固定 handler 表）；⑥ 无法向其他节点发起任何请求（hub 是唯一转发者，且 `forward` 只沿路由决策把调用发给目标节点）。
- **缓解**：最小暴露——hub→节点只下发 `NODE_METHODS` 固定面（health/listWorkspaces/listSessions/createSession/getSession/resumeSession/prompt/cancel/mcp.call/presence.report）；节点间无横向通道（星型拓扑）；catalog/presence 数据只影响路由决策，破坏性操作另有 fail-closed 兜底（T7）；审计/路由日志记录每次转发（op/target/reason/result）供事后追查。
- **残余风险**：被攻陷节点仍是**有效执行端**——发往它的 `sessions_prompt`/`code_*` 会真实操作它本地的 DSH 与文件系统（这是产品语义，不是缺陷）；路由欺骗（污染 catalog/presence）虽不能冒充身份，但能把流量导向自己（见 T6/T7 的兜底与残余）。

### T6 路由欺骗（presence spoof、错误 session/workspace 亲和导致跨节点误操作）

- **威胁描述**：攻击者伪造 presence claim（把 confidence 拉满、pinned）让 hub 把"无人指定目标"的调用路由到自己节点；或利用 session/workspace 目录中的错误/陈旧记录，把调用路由到错误节点。
- **攻击场景**：攻击者控制节点 B，让 agent 每 20s 上报 `{source:'desktop', confidence:0.9}`（或直接调 MCP 的 `presence_claim` pin 自己）；此时用户不指定 target 发起 `sessions_create`——若 B 的 claim 是唯一 fresh 高置信，路由落 B。另一场景：节点 A 上有个 `session-9`，节点 B 上也有人为上报同名 `session-9`（catalog 歧义）——`SessionCatalog.get('session-9')` 对裸 id 返回 **undefined**（两条命中），路由不会猜，落到 fail-closed。
- **影响**：写操作（`sessions_create` 等）落到攻击者节点；读操作（code 工具）落到错误节点返回错误/伪造内容；用户以为操作在 A 机器，实际发生在 B 机器。
- **缓解**：
  - 优先级让**显式 `target_node` 永远第一**（`Router.route` 第 1 级）——欺骗只能影响"未显式指定"的调用；
  - presence 有 **15s 歧义窗口**（`PRESENCE_AMBIGUITY_WINDOW_MS`）：两台 fresh high-confidence 落在窗口内 → `activeNode` 返回 undefined，**不自动选**，路由落到 default/no-route（破坏性再被 fail-closed 拦截）；
  - presence claim 的 TTL 由 hub clamp（`PresenceRegistry.claim`：provider 60s、manual 默认 10min 上限 60min），伪造 claim 最多短期有效；
  - session/workspace 目录：裸 native id 跨节点歧义 → `get`/`resolve` 返回 **undefined 而非猜测**（`LIMIT 2` 判定）；global key `node_id:native_id` 消除歧义；reconcile 是全量对账（节点上报整体替换），陈旧条目随节点离线/重连被修正；
  - 路由决策记录 evidence/candidates（`route_explain` 可查，`route_log` 存 JSON），欺骗行为可事后取证。
- **残余风险**：pinned manual claim（`presence_claim` 工具，`pinned:true`、confidence 1.0）**直接胜出**且不参与歧义判断——拿到 MCP 入口（或攻陷节点）的人可以 pin 自己；`presence` 作为"合法亲和"是**允许**把 destructive 操作路由过去的（`decide()` 对 presence 命中不 gate，只有 no-route fallback 才 fail-closed）——伪造 presence 仍能诱导 `sessions_prompt` 类操作流向自己节点；15s 窗口只防"同时两台"，防不了"一台持续 renew 独占"（诚实节点与恶意节点都在 renew 时，诚实节点先到则正常，恶意节点先到则被选）。

### T7 破坏性操作误路由（fail-closed 边界）

- **威胁描述**：`sessions_prompt`/`sessions_resume` 等 destructive 操作，在目标不清晰时被错误路由（打到错误节点、或打到无人值守的节点执行副作用）。
- **攻击场景**：用户在 ChatGPT 里让模型"继续刚才那个会话"，模型没有传 `target_node`/`session_id`，且此刻 presence 过期、default 节点离线——路由到 no-route；若没有 fail-closed，系统可能静默选任意节点执行（错误机器上建新会话/发 prompt）。
- **影响**：在错误机器上创建/恢复会话、发送 prompt（真实副作用）；在跨节点场景下"我以为在 A 上执行"。
- **缓解**：fail-closed 三件套——① danger 分类驱动（`tools.ts`：`sessions_prompt`/`sessions_resume` = `destructive`）；② `Router.route` 在 **no-route + destructive/write** 时返回 `route_confirmation_required`（`confirmation_required:true`、`errorCode:'route_confirmation_required'`），`HubMcpServer.handleRouted` 以 `route rejected (route_confirmation_required)` 拒绝，绝不静默降级到别的节点；③ 合法亲和（explicit/session owner/workspace owner/presence/default）是**可追溯的**——每次决策写 reason + evidence + candidates（route_log），`route_explain` 预演不执行。
- **残余风险**：fail-closed 只拦截"no-route"分支；**presence 命中**的 destructive 操作直接 forward（T6 残余风险同源）；`explicit target_node` 对已知但不健康的节点仍 forward（理由注明）——显式目标本身错误时系统会照做；MCP 层的 `_route` 附在结果里，但客户端可能不看。

### T8 审计日志完整性（篡改、删日志）

- **威胁描述**：运维/攻击者（持本机权限）篡改或删除 audit / route_log 记录，抹掉恶意操作痕迹。
- **攻击场景**：攻击者利用 T5 的节点攻陷或本机权限，直接编辑 `~/.dsh/helm/store.sqlite3` 的 audit/route_log 表（`sqlite3` 命令行即可），或删除 WAL/主库文件，让事后排查查不到某次 `sessions_prompt` 的转发记录。
- **影响**：失去取证能力；route_log 的 `route_explain` 溯源失效；合规/审计要求不满足。
- **缓解**：审计已落库——`ControlPlane.auditRoute` 每次路由决策写 `route_log`（完整 `RouteDecision` JSON：reason/evidence/candidates，无 args 无 prompt）+ `audit.append`（`result='pending'`），调用完成后 `auditResult` 按 `call_id` 用 `updateResult` 回填结果（`store/src/audit.ts`）；`call_id` 贯穿审计/路由/应用日志，可跨日志关联；表结构无删除接口、`updateResult` 只回填 result 列；hub 侧还有结构化日志行（`route <callId> <op> -> <node>` / `route-result`）与 SQLite 互为印证。
- **残余风险**：`updateResult` 是 UPDATE 路径（按 `call_id` 仅改 `result` 列，不覆盖其余列）；SQLite 文件是本地普通文件（默认权限由 umask 决定），持 OS 用户权限仍可直接改库/删库/清 WAL（`updateResult` 只防应用层误改，不防持文件权限者）；**无哈希链/无远程副本/无防篡改设计**；日志落盘前的内容依赖代码路径，落盘后的完整性没有机制保证。

### T9 SQLite 存储攻击（本地篡改、损坏）

- **威胁描述**：本地进程/用户篡改 store 文件（改节点状态、presence 租约、catalog 条目），或文件损坏（断电、磁盘错误、并发写）。
- **攻击场景**：同机恶意进程把 `nodes` 表的某节点 `status` 改为 `blocked`（DoS 该节点）；或把 `workspaces` 表的 path 改指向另一台机器的路径（诱导 workspace 亲和误路由）；或删掉 `presence_leases` 让 presence 路由失效；断电导致 WAL 未 checkpoint。
- **影响**：路由决策被污染（伪造 catalog → 误路由）；节点被标记 offline/blocked（DoS 自己）；损坏导致 hub 启动失败或查询报错。
- **缓解**：WAL 模式 + `synchronous=NORMAL` + `busy_timeout=5000` + `foreign_keys=ON`（崩溃安全与并发读）；`schema_version` 迁移且**新库版本高于支持版本直接拒绝**（防旧代码写新库）；**store 不含任何密钥**（token 在环境/0600 文件，不在库里），篡改 store 拿不到凭据；表内容全部是元数据，即使全泄露也没有会话正文（T14）。
- **残余风险**：无加密磁盘；同 OS 用户可读写该文件（权限依赖 umask，代码未强制 0600）；SQLite 单文件是 hub 的 SPOF（无副本、无备份策略在代码内）；`*.sqlite3` 在 .gitignore 里但云同步/备份工具可能带走（元数据+审计含会话标题等敏感元信息）。

### T10 本地 daemon 边界（bridge 用 Bearer token，sock 协议不上网）

- **威胁描述**：本机恶意进程/其他用户直接打 daemon 的 3457 `/mcp`（偷读 token 后调任意工具）；或尝试把 unix socket adapter（`daemon.sock`，无认证）暴露/转发到网络。
- **攻击场景**：同机恶意进程读 `~/.agent-chatgpt-helm/token`（0600，同用户可读），然后 POST `http://127.0.0.1:3457/mcp` 调 `sessions_create`/`code_read_file`；或攻击者把 `daemon.sock` 通过 socat 转发到公网端口——只要控制平面/套件没有把 sock 流量引向网络的路径，该转发属于"外部行为"，但一旦发生则无认证直通。
- **影响**：本机 DSH 全量能力被任意本地进程调用（读代码、建会话、发 prompt）；sock 上网络后远程可直达无认证执行面。
- **缓解**：daemon 绑 `127.0.0.1:3457`（upstream 默认，`config.d.ts` 的 `http.host=127.0.0.1`）；`/mcp` 需 `Authorization: Bearer`（token 由 `resolveCoreToken` 0o600 落盘，或 env `AGENT_CHATGPT_HELM_TOKEN`）；`LocalHelmBackend`（默认 `McpLocalHelmBackend`） 只走该认证端点，"keeps the node agent out of the daemon's unix-socket adapter protocol (loopback-only, unauthenticated)"——**控制平面代码没有任何路径会转发 daemon.sock 流量**；3471 的 hub MCP 是唯一网络面（且默认 loopback）。
- **残余风险**：daemon.sock 的目录（`~/.agent-chatgpt-helm/run/`）权限取决于 umask，同用户/同组进程可连（unix socket 无认证是 upstream 设计，靠目录权限围栏）；`/healthz` 无认证（loopback 可接受，被反代暴露则泄露状态信息）；token 文件与 node.json 同用户可读——**本机多用户场景需要逐用户隔离**（当前假设单用户可信）。

### T11 上游供应链（beforewave npm 包固定版本、npm tarball pin）

- **威胁描述**：`@beforewave/agent-chatgpt-helm` / `@beforewave/dsh-chatgpt-helm` 0.1.1 的 tarball 被替换/投毒（registry 侧、安装侧、依赖传递侧）；或上游发布带后门的新版被误升级。
- **攻击场景**：npm registry 凭据泄露/上游账号被黑 → 0.1.1 的 tarball 被替换为带后门版本；某台新机器 `pnpm install` 时拉到的 tarball 与已审计版本不一致（无哈希校验则不可察觉）；或者有人把 `upstream-helm/` 快照里的 `lib/` 换成恶意编译产物。
- **影响**：helm daemon 是每台机器上**持有本机 DSH Bearer token 与代码读取能力**的进程，被投毒 = 全机器横向（代码、会话、凭据）。
- **缓解**：双包精确固定 `0.1.1`（plugin 对 core 依赖也是精确版 `"0.1.1"`）；`upstream-helm/PIN.md` 记录 tarball pin 与 core 的 `gitHead`（e78943ba…）；dev 区快照与生产 node_modules 分离（生产不动、dev 对照）；dsh-helm 自身对 `@modelcontextprotocol/sdk` 精确到 `1.30.0`；pnpm-lock.yaml 锁全量依赖树。
- **残余风险**：PIN.md **未记录 tarball 的完整性哈希**（npm 包在 install 时由 registry 签名校验，但本地快照没有 sha 背书）；源码仓库 private/404 无法 diff 审计编译产物（`lib/` 是 esbuild minified，`.d.ts` 是唯一权威面）；供应链投毒窗口 = 首次 install 时刻；peerDependencies 用范围（`>=0.1.0-rc.6 <0.2.0`）依赖宿主 DSH 版本匹配。

### T12 DSH web 无认证（3080）在现网的前提与边界

- **威胁描述**：DSH web（3080）无登录墙；若被本机恶意进程、浏览器中的恶意网页（localhost CSRF/DNS rebinding）、或网络暴露，即可驱动 DSH 会话。
- **攻击场景**：用户打开恶意网页，页面里的脚本向 `http://127.0.0.1:3080/...` 发请求（localhost CSRF）——若 DSH web 的 API 不校验 Origin/无 CSRF token，恶意网页可建会话、发 prompt；或恶意浏览器扩展直接 fetch 3080。
- **影响**：本机 DSH 全量会话/工作区/文件能力被劫持；恶意网页可静默建会话发 prompt（模型执行任意工具）。
- **缓解（前提与边界）**：**前提**——服务只绑 `127.0.0.1:3080`（loopback 围栏）+ DSH web 的 trustedHosts 白名单防 DNS rebinding；**边界**——Node Agent 不直接访问 3080（一切经本地 daemon 3457 MCP 语义，`LocalHelmBackend`（默认 `McpLocalHelmBackend`）），控制平面本身不把 3080 暴露给网络；单机套件的 watchdog 也只在本机探测 3080；隧道入口（3458→3457）从不触碰 3080 的 HTTP 面。
- **残余风险**：同机器上的任何进程（含浏览器标签页）都在"可信"圈内——**浏览器侧攻击面是真实存在的**（localhost CSRF、恶意扩展）；多用户机器上其他用户可访问 3080；一旦有人用反代把 3080 暴露到网络（配置失误），无认证问题直接暴露公网；trustedHosts 只防 Host 头欺骗，不防同机进程。

### T13 DoS（连接风暴、心跳洪泛、MCP 工具滥用）

- **威胁描述**：① 对 mesh 端口（3470）开大量 TCP/WS 连接（每个连接都进入握手状态机）；② 已认证节点高频心跳/高频 `catalog.reconcile`/高频 presence 上报；③ 拿到 MCP 入口（或 ChatGPT 侧）后高频调用重工具（`sessions_create`/`sessions_prompt`/`code_search_for_pattern`），在节点上制造真实负载。
- **攻击场景**：攻击者对 3470 打 SYN/WS 洪泛（每个连接最多 3 次 auth 尝试后关闭，但连接建立本身消耗 hub 资源）；攻陷节点后把 heartbeat 间隔改成 1s（`node.heartbeat` 每次都是 SQLite UPDATE）；ChatGPT 侧（或拿到 3471 入口的人）循环调用 `sessions_create` 在每个节点上建大量会话。
- **影响**：hub 资源耗尽（连接表/事件循环/日志）；SQLite 写放大（心跳/对账都是写库）；节点 DSH 被任务洪泛拖垮；合法请求饥饿。
- **缓解**：握手有 3 次 auth 上限 + 状态机轻量（未认证连接不注册、不占路由）；RPC 有超时（默认 30s、forward 60s、聚合读 15s），挂起调用会被清理；租约机制（45s）让"僵尸心跳"的节点自动 offline；节点侧 reconnect 指数退避（1s→30s + jitter）防止断连风暴自放大；presence claim 的 TTL 被 hub clamp；`supervisor_health`/`node_get` 让运维能看见节点负载（`load` 字段预留）。
- **残余风险**：**没有**全局连接数/按 IP/按节点限频器（3 次上限是每连接的）；hub MCP 3471 v1 无鉴权（loopback 默认，被暴露即无门槛滥用面）；心跳/对账/上报**每 15s/60s/20s 一次写库**，节点数量大时 SQLite 单写者可能成为瓶颈；重工具调用没有配额（ChatGPT 侧可无限 `sessions_create`）；`mcp.call` 参数没有大小上限（大 payload 直接透传）。

### T14 跨机器会话数据暴露（catalog 只存元数据）

- **威胁描述**：hub 侧聚合/存储了多台机器的会话与工作区信息；担心会话正文、prompt 内容、代码内容被 hub 泄露（hub 被攻陷/审计泄露/存储泄露）。
- **攻击场景**：hub 机器被攻陷，攻击者 dump `store.sqlite3`——拿到的是节点注册表、presence 租约、会话**标题/状态/路径**、审计与路由日志；会话正文与代码内容不在库中，除非攻击者同时持有某节点的 daemon 权限并主动去拉。
- **影响**：会话标题/状态/工作区路径等元数据泄露（含敏感命名）；**会话正文不会**因 hub 被攻陷而泄露。
- **缓解**：**设计红线**——wire（`types.ts`：`The wire carries metadata only — never DSH conversation bodies`）与存储（`db.ts`：`It never stores DSH conversation bodies`）都只承载元数据；`SessionInfo`/`WorkspaceInfo` 只有 native_id/title/status/path/计数；会话正文只在**执行路径**流动（`mcp.call` → 节点本地 daemon → 本地 DSH），hub 转发时不落盘；workspace path 被明确定义为"属性而非身份"（跨 OS 同名路径是两个 workspace，`resolve` 歧义返回 undefined 不猜测）；audit/route_log 明确"无 prompt 正文无密钥"（`audit.ts`）。
- **残余风险**：会话 **title** 由用户/模型命名，可能含敏感信息，且会进入 catalog/audit 聚合面；`sessions_get`/`sessions_prompt` 的**结果**（正文）经 mesh 明文（未上 WSS 时）与 hub 转发路径返回给调用方——hub 不落盘但**经过** hub（T1 与 T15 关联）；`code_*` 工具读到的**文件内容**同样经 hub 转发（hub 是透传者，可被嗅探/记录于网络层）。

### T15 代理 / 隧道（api.openai.com 经本地代理）信任链

- **威胁描述**：tunnel-client 控制面轮询 `api.openai.com` 必须经本地代理（如 Clash）；该代理是本地进程，可观测/篡改隧道控制面流量；代理挂了隧道整体断连。
- **攻击场景**：代理软件被替换/被注入 → 可记录 `api.openai.com` 的轮询流量特征与（若安装 MITM 证书）控制面内容；代理进程被误杀/未启动 → `tunnel-client-manual.log` 刷 poller stopped，ChatGPT 侧连接器探测失败（本机已实测的故障模式）；`CONTROL_PLANE_API_KEY` 若出现在命令行参数中会被同机 `ps` 看到（现状用 `env:` 已避免）。
- **影响**：① 代理被攻陷/恶意代理软件可读到 `CONTROL_PLANE_API_KEY` 的用途（env 注入避免 argv，但代理能看到 TLS 内的轮询目标与流量特征；若代理安装 MITM 证书可解密 api.openai.com 流量）；② 代理进程崩溃/未启动 → 控制面轮询全部超时 → ChatGPT 侧连接器探测失败（已实测的故障模式）；③ 隧道控制面凭据泄露 = 接管连接器入口。
- **缓解**：**信任链分层**——ChatGPT→api.openai.com 走平台侧 TLS；api.openai.com→tunnel-client 走 TLS（代理默认只做 CONNECT 转发，不解密）；tunnel-client→本机 daemon 是 loopback（Bearer token 保护）；凭据 `CONTROL_PLANE_TUNNEL_ID`/`CONTROL_PLANE_API_KEY` 存 `~/.dsh/.credentials.yaml`（0600，不入库不进 git），keepalive 以 `env:` 语法注入进程环境（`tunnel-client-keepalive.sh` 从凭据文件读取并 export，`--control-plane.api-key env:CONTROL_PLANE_API_KEY`）——**token 不出现在 argv**；keepalive 的双重健康探针（3458 自身 + 3457 upstream）避免"隧道活着但 daemon 挂"的假健康；`HTTPS_PROXY` 可覆盖（`${HTTPS_PROXY:-<local-proxy>}`），代理恢复后自动连通。
- **残余风险**：本地代理是**信任单点**（其进程权限即隧道控制面权限；代理不可用 = 连接器不可用）；api.openai.com 与 OpenAI 平台侧是外部信任边界（其密钥轮换、账号安全不在本项目控制内）；tunnel-client 与 daemon 之间（loopback 明文 HTTP）若本机有恶意进程可注入 MCP 调用（依赖 T10 的本机信任假设）。

## 4. 风险登记与已接受风险

### 4.1 风险登记表（可能性 × 影响，优先级供排期参考）

| 威胁 | 可能性 | 影响 | 优先级 | 主要缓解（机制） |
|---|---|---|---|---|
| T1 嗅探/MITM | 中（若 ws 明文部署） | 高 | **高** | wss 强制语义 + loopback 默认绑定 |
| T2 重放/爆破 | 低 | 高 | 中 | 双向 nonce + 3 次上限 + 常时比较 |
| T3 token 泄露 | 中 | 高 | **高** | 0600 文件 + env: 注入 + redactor + gitignore |
| T4 伪造节点 | 中（依赖 T3） | 高 | **高** | token 绑定 + UUID 校验 + blocked 状态 |
| T5 节点攻陷横向 | 中 | 中 | 中 | 星型拓扑 + 固定 RPC 面 + 元数据最小化 |
| T6 路由欺骗 | 中 | 中 | 中 | 显式 target 优先 + 15s 歧义窗口 + 不猜测解析 |
| T7 破坏性误路由 | 低 | 高 | **高** | fail-closed route_confirmation_required |
| T8 审计篡改 | 中 | 中 | 中（待补） | 只 INSERT DAO + call_id 关联；落库未接通 |
| T9 存储攻击 | 中 | 中 | 中 | WAL + schema 版本 + 无密钥存储 |
| T10 daemon 边界 | 低（本机） | 高 | 中 | Bearer + loopback + sock 协议不上网 |
| T11 供应链 | 低 | 高 | 中 | 固定 0.1.1 + lockfile；缺哈希背书 |
| T12 3080 无认证 | 中（浏览器侧） | 高 | 中 | loopback + trustedHosts；浏览器侧仍暴露 |
| T13 DoS | 中 | 中 | 中（待补） | 3 次上限 + 超时 + 租约；缺全局限频 |
| T14 元数据暴露 | 低 | 低 | 低 | 元数据红线（wire/存储均无正文） |
| T15 代理信任链 | 中 | 中 | 中 | 分层 TLS + env 注入 + 双健康探针 |

### 4.2 信任边界与已接受风险汇总

| 边界 | 信任假设 | 失效后果 | 现状 |
|---|---|---|---|
| 本机进程（每台机器） | 同 OS 用户可信 | 全量本地能力（daemon/3080/文件） | 接受（单用户假设，未做隔离） |
| 节点↔hub 网络 | 生产 wss + 可信 CA；ws 仅 loopback/隧道 | 嗅探/篡改/冒充 | 代码强制 wss 语义但**不强制**（ws 可配）；部署方负责 TLS |
| hub token 表 | `DSH_HELM_TOKEN` 环境注入的安全 | 冒充任意节点 | v1 人工运维；建议 secrets 管理 |
| hub MCP 3471 | 默认 loopback | 无鉴权指令面 | v1 无鉴权，**严禁暴露公网** |
| 上游 npm 包 | registry 与 tarball 可信 | 供应链投毒 | 固定 0.1.1 + lockfile；无哈希背书 |
| 本地代理 | 代理进程可信 | 隧道控制面泄露/断连 | 接受（本机信任）；代理故障有自愈 |
| 审计存储 | 本机文件不被篡改 | 取证失效 | DAO 就绪但**未接入执行路径**；无防篡改 |

## 5. 后续加固方向（建议，未实现）

按风险×代价排序，供后续阶段决策（均不改变当前 v1 行为）：

1. **hub MCP 3471 加鉴权**（Bearer token 或与 mesh 同源的 HMAC）——当前最大的"无认证执行面"缺口（T1/T13）。
2. **审计落库接通 + 哈希链**：把 `ControlPlane` 的执行路径接入 `AuditLog.append`/`logRoute`；可再加 `route_log` 的链式哈希（prev_hash 列）与定期导出（T8）。
3. **限频与配额**：mesh 全局连接/握手限频（按 IP）、MCP 重工具配额、`mcp.call` payload 上限（T13）。
4. **hub token 表接 secrets 管理**：`tokenLookup` 改为支持文件（0600）/secrets 服务，`rotate-token` 双 token 窗口支持（T3/T4）。
5. **mesh 强制 WSS 或显式告警**：`ws://` 非 loopback 时启动告警/拒绝（部署期防呆）（T1）。
6. **凭据入 OS 钥匙串**（macOS Keychain / Windows DPAPI）替代明文 0600 文件（T3）。
7. **PIN.md 补完整性哈希**（tarball sha256）并在 CI 校验（T11）。
8. **节点级审计**：`audit.append` 协议已预留，节点本地记录自己的执行历史（T8/T14）。

---

*维护约定：本文档事实以 `packages/` 与 `../connector/` 实现为准；若实现变更（端口/常量/类行为），先改 `docs/architecture.md` 与 `packages/protocol/src/constants.ts`，再同步本文。*
