# ChatGPT ↔ DSH MCP Connector 链路容灾调研报告

- **调研日期**：2026-08-24（所有"访问日期"均指此日）
- **调研范围**：OpenAI 官方公开文档与产品能力（openai/tunnel-client 仓库、developers.openai.com、help.openai.com），**不含**任何第三方部署教程的结论
- **三档标注贯穿全文**：【官方已支持】= 官方文档原文可证；【官方未说明】= 官方无公开表述；【推断】= 基于官方机制的事实推理，不是官方承诺
- **背景链路（dsh-helm 现网）**：ChatGPT 网页版（开发者模式 app/连接器）→ OpenAI Secure MCP Tunnel（OpenAI 托管端点）→ tunnel-client（公司 Mac 本机 launchd 常驻，`--mcp.server-url http://127.0.0.1:3481`）→ dsh-helm ha-proxy（公司 Mac 本地 3481，primary=公司 hub 3471 / secondary=家里 hub，Tailscale 组网）→ hub → node agent → 本地 DSH daemon（127.0.0.1:3457）
- **事故场景**：公司 Mac 整机掉电 → 同一台机器上的 tunnel-client 与 ha-proxy 同时消失 → 即使家里 hub 还活着，tunnel 死掉后 ChatGPT 侧无任何 ingress 可达自托管 DSH

---

## 1. 执行摘要

1. **官方架构强制要求"客户侧必须有一台常驻主机跑 tunnel-client"**——ChatGPT 连接器从不直连你的 MCP server，而是打到 OpenAI 托管的 `/v1/mcp/{tunnel_id}`，由 tunnel-client 出站长轮询取活转发（【官方已支持】，来源 1/2/3）。因此"中心必须活在某台常驻机器上"不是本项目的选择，而是 OpenAI 的硬约束。
2. **公司 Mac 当中心不是"设计错误"，而是"单点放错了主机"**：官方明确认可 laptop/VM/K8s 都是 tunnel-client 的合法宿主（来源 2/4），但把唯一的 tunnel-client 与 ha-proxy 放在掉电即失联的公司 Mac 上，等于把链路最关键的入口单点放在了可用性最差的位置；ha-proxy 只解决了 hub 后端 failover，**tunnel 进程本身仍是单点**。
3. **官方对"同一 tunnel 双客户端/多实例"零文档、roadmap 也无此项**【官方未说明】；官方唯一成文的恢复语义是"client 掉线期间请求失败，直到 client 重连"（来源 2/5）。因此 tunnel 双机 failover 目前**不是可确认的官方能力**，只能作为需实测的候选方案。
4. **"自有服务器中心 + 无服务器用户本地"模式（Tunnel 跑云 VM、hub 留内网）可行**，且官方支持的部署面（VM/systemd、MCP 私服任意内网可达、代理/CA/mTLS 企业网络特性）全部覆盖此形态；ChatGPT 侧连接器绑定 tunnel_id，**迁移时零改动**。主要代价是安全（云上持 runtime key）、网络（VM↔hub 段自管）、运维（保活/轮换自建）三类，产品侧则受官方"Tunnel 仅服务私有 MCP + 开发者模式、不做公网插件分发"的策略边界约束。
5. **当前可落地的容灾顺序**：① tunnel-client+ha-proxy 整体迁往云 VM（官方已确认支持，ChatGPT 侧零改动）→ ② 双 tunnel + 双连接器作为已确认的官方冗余拓扑（ChatGPT 侧手动切换）→ ③ 同一 tunnel 双客户端 failover（官方未说明，先实测验证轮询竞争语义）→ ④ 以 `/readyz`+Prometheus 监控与掉电演练闭环。

---

## 2. 官方能力矩阵

| # | 能力项 | 官方已支持 | 官方未说明 | 推断结论 |
|---|---|---|---|---|
| 1 | Tunnel 是什么 / 工作原理 | ✅ 出站 HTTPS 长轮询代理（`GET /v1/tunnels/{tunnel_id}/poll` + `POST /v1/tunnels/{tunnel_id}/response`，MCP JSON-RPC 排队转发）〔来源 1/2/4〕 | — | 机制本身无歧义 |
| 2 | tunnel-client 可运行在哪 | ✅ laptop / VM / K8s / 私有网络，官方部署模式含 systemd、K8s sidecar/dedicated〔来源 2/4〕 | — | 云 VM 是官方认可宿主 |
| 3 | connector 的 URL 形态 | ✅ Tunnel 模式 = OpenAI 托管端点 `<OPENAI_MCP_TUNNEL_BASE_URL>/v1/mcp/<tunnel_id>`（POST-only）；HTTP URL 模式 = 任意公网 HTTPS MCP endpoint（须 `/mcp` 路径、streamable HTTP/SSE）〔来源 3/6/7〕 | 端点基址未在文档中固定写明；未见 `chatgpt.com/connector/xxx` 形态的公开文档 | 基址大概率在 api.openai.com 域下 |
| 4 | connector URL 是否硬绑定 Tunnel | ✅ 否——Connection 可选「Tunnel」或「HTTP URL」；但**私服（防火墙内/无公网）唯一官方路径是 Tunnel**〔来源 6/7/8〕 | 公网 HTTP URL 模式对自托管 server 的认证细则（除 OAuth/无认证/混合外） | 自托管公网暴露可行，但需自行 TLS+认证+白名单 |
| 5 | 掉线后 ChatGPT 侧行为 | ✅ "If the client is not connected, requests through the tunnel fail until tunnel-client reconnects"〔来源 2〕；"remote tunnel object 可独立存在，即使本地无 runtime 轮询"〔来源 5〕 | ChatGPT UI 掉线提示文案、是否需要手动"重连"动作、排队请求保留时长 | client 重启即恢复轮询，连接器无需重建；期间请求失败 |
| 6 | tunnel 生命周期 | ✅ 创建后约 25–30s 生效；tunnel 对象持久，绑定 org/workspace；删除/权限变更经 Audit logs〔来源 1/9/10〕 | tunnel 过期/自动回收策略 | 无自动回收的官方说明 |
| 7 | 多 ingress / 冗余 connector | ✅ 一个 workspace 可绑多个 tunnel；一个连接器绑一个 tunnel；「双 tunnel+双连接器」拓扑官方 UI 支持〔来源 1/9/11〕 | 多连接器并发的官方并发上限 | ChatGPT 侧手动切换是已确认的冗余手段 |
| 8 | 同一 tunnel 多 tunnel-client（HA/failover） | ❌ 官方文档（含部署指南、roadmap）通篇无多实例/HA/failover 描述〔来源 4/12/13〕 | 双客户端对同一轮询队列的竞争/互斥语义 | 不可作为已确认方案；需实测 |
| 9 | 认证能力 | ✅ 无认证 / OAuth（CIMD、DCR）/ Mixed；Authorization 头经隧道转发；MCP 侧静态 header、mTLS〔来源 2/6/14〕 | — | 现状"No Auth + 隧道 + loopback 双边界"是官方合法配置 |
| 10 | 企业版差异 | ✅ 开发者模式资格含 Pro/Plus/Business/Enterprise/Education（web）〔来源 14〕；Enterprise/Edu 由 workspace admin 授予开发者模式、admin 管控 connectors+RBAC〔来源 2/15/16〕 | Team 与个人版的连接器配额/策略差异细则 | 个人版自助开启，企业版 admin 审批——迁移企业工作区时授权模型会变 |
| 11 | 保活/可观测 | ✅ `/healthz` `/readyz` `/metrics` `/ui`、`tunnel-client runtimes` 托管、pid_file、systemd/K8s 部署指南、Prometheus 指标〔来源 2/4/9/12〕 | 官方 SLA/可用性承诺 | 无 SLA 承诺【官方未说明】 |
| 12 | 密钥管理 | ✅ runtime key（Read+Use）与 admin key（Manage）强制分离；key 支持 env:/file: 引用〔来源 9/10〕 | 自动轮换工具（roadmap 仅有 mTLS 证书自动化设想）〔来源 13〕 | 密钥轮换需自建流程 |
| 13 | 未来路标 | — | roadmap 明确"非承诺"，且无"服务器侧 connector/多实例 HA"条目〔来源 13〕 | 短期内等不到官方 HA 能力 |
| 14 | 公开分发 | ✅ 官方：Tunnel 不支持公开插件提交/分发；公开插件须稳定公网 HTTPS + 审核 + 域名验证〔来源 2/7〕 | — | 自托管 MCP 走公开插件市场不可用 Tunnel |

---

## 3. 逐项调研结果

### 3.1 OpenAI Tunnel（Secure MCP Tunnel）

**是什么（【官方已支持】，来源 1/2/3）**

- 官方仓库为 **openai/tunnel-client**（https://github.com/openai/tunnel-client）。注：任务描述中的 `openai/chatgpt-mcp` 于 2026-08-24 验证返回 **404**，官方仓库即 tunnel-client（README 自述："the customer-run agent behind Secure MCP Tunnel. It connects a private or localhost MCP server to ChatGPT, Codex, the Responses API, and AgentKit through an OpenAI-hosted MCP tunnel endpoint, while keeping the MCP server off the public internet"）。
- 机制（官方 guide 原文流程）：① 在 Platform tunnel settings 创建 OpenAI 托管隧道端点；② 在能到达私服 MCP 的网络内运行 tunnel-client；③ 用 tunnel id + runtime API key 配置；④ OpenAI 产品把 MCP 请求发到 OpenAI 托管端点；⑤ tunnel-client 长轮询取活、本地转发 JSON-RPC、回传响应。**MCP server 不需要任何公网监听**。
- 网络要求：tunnel-client 仅需**出站** HTTPS 到 `api.openai.com:443`（`/v1/tunnel/*`；配 mTLS 时为 `mtls.api.openai.com:443`）+ 本地可达 MCP server。无入站防火墙要求。
- 身份与域名：tunnel 绑定 Platform organization + ChatGPT workspace（同一 tunnel_id 可关联多个 org/workspace；绑定 workspace 后 ChatGPT 插件页才能看到）。权限三原子：Tunnels **Read** / **Manage** / **Use**（org 级，非 project 级）。个人账号用个人 Platform organization。
- 连接器面向的 URL：`<OPENAI_MCP_TUNNEL_BASE_URL>/v1/mcp/<tunnel_id>`，**POST-only** JSON-RPC（GET 不是 SSE 诊断流）【官方已支持，来源 3】。

**生命周期（【官方已支持】+【官方未说明】）**

- 创建后约 25–30 秒生效（来源 10）；tunnel 对象是 OpenAI 侧持久资源，"A stopped local runtime leaves the remote tunnel object behind"（来源 5）；元数据变更（created/updated/deleted）进 Platform Audit logs（来源 2）。
- 单点性：官方文档只描述"一个 tunnel + 一个常驻 client"拓扑；**没有任何多实例/HA/failover/备用 client 的表述**【官方未说明，来源 4/12/13 全量检索无果】。`client_instance_id` 是进程级状态字段（来源 5），但文档未定义多实例语义。

**重连行为（【官方已支持】+【官方未说明】）**

- 官方原文："If the client is not connected, requests through the tunnel fail until `tunnel-client` reconnects."（来源 2）；"connector discovery and tool calls depend on the running client"（来源 2/9/10）；"The remote tunnel object can exist even when no local runtime is polling it"（来源 5）。
- 【推断】client 是出站长轮询模型，重启后以相同 tunnel_id + key 恢复轮询即重新接管，无注册/握手步骤，因此**掉电恢复无需重新配置连接器**；ChatGPT 侧连接器配置（绑定的 tunnel_id）不会因 client 离线而失效。
- 【官方未说明】ChatGPT UI 在 client 离线期间的提示文案、请求排队保留时长、重连延迟上限。

### 3.2 connector 配置面（ChatGPT 侧）

**新增 MCP server 的官方路径（【官方已支持】，来源 6/14）**

1. ChatGPT → **Settings → Security and login → 开启 Developer mode**（资格：Pro / Plus / Business / Enterprise / Education，web 端）。
2. **chatgpt.com/plugins** → 加号创建 developer-mode app → 填名称/描述 → **Connection** 二选一：
   - **Tunnel**：选择已绑定的 tunnel 或粘贴 `tunnel_id`（私服路径，官方唯一推荐）；
   - **HTTP URL**：输入公网 HTTPS MCP server URL（含 `/mcp` 路径）——**自托管公网 endpoint 官方支持**，但要求公网可达 + streamable HTTP/SSE。
3. 认证：OAuth / No Authentication / Mixed 三选一（Tunnel 路径还支持转发 Authorization 头、静态 header、MCP 侧 mTLS——来源 2/14）。
4. 创建后须在对话工具菜单选择该 app；写操作默认要求确认（`readOnlyHint` 可豁免）；metadata 变更后可手动 Refresh（来源 6）。

**connector URL 是否硬绑定 Tunnel（结论）**

- **否**——HTTP URL 模式存在；但**对"私服（公司内网/Tailscale 私有网段）"而言，Tunnel 是唯一官方路径**："Secure MCP Tunnel supports private MCP connections, including developer-mode testing. It does not support public plugin submission or distribution."（来源 2）。公开分发=公网 HTTPS + 审核 + 域名验证（来源 7/8）。
- 【官方未说明】文档中未见"形如 chatgpt.com/connector/xxx"的 connector URL 形态；"Connector"一词在 API 侧指 OpenAI 维护的预置集成（`connector_id`，如 connector_dropbox，来源 17），与开发者模式自建 app 是两套东西。

### 3.3 冗余能力

- **第二 ingress / 冗余 connector**：官方支持面 = 一个 workspace 可关联多个 tunnel（来源 1），一个连接器绑一个 tunnel，因此**双 tunnel + 双连接器**拓扑成立（dsh-helm README 亦将其列为备选拓扑）；ChatGPT 侧通过对话工具菜单选择连接器实现切换【推断：官方文档未描述"自动 failover"，手动选择语义明确】。
- **备用 endpoint**：tunnel-client 支持多 **channel**（`--mcp.server-url="channel=main,..."` 等）但那是"一个连接器下的多 MCP 绑定"（来源 3），且 ChatGPT 侧走 `main` 通道——**不是多后端 failover**；dsh-helm 的 ha-proxy（3481，primary/secondary 切换）正是补这个缺口，且只覆盖 hub 后端，不覆盖 tunnel 本身。
- **自托管服务器替换 Tunnel**：官方仅两条路：① 公网 HTTPS endpoint（开发者模式可用；公开插件提交需审核）——需要 TLS/认证/IP 白名单自理（官方提供 ChatGPT connectors IP ranges 文档与 OpenAI-managed mTLS 方案，来源 7/8）；② 私服继续用 Tunnel——没有第三条官方路径【官方未说明"免 Tunnel 的私有直连"方案，Codex 侧除外：Codex 支持直接本地 MCP 配置（stdio/loopback），来源 4，但 ChatGPT 侧未见同类说明】。
- **同一 tunnel 双客户端**：【官方未说明】。长轮询队列按 tunnel_id 排队（每 poll 至多取 25 条命令、本地有界队列，来源 5），两实例同时轮询会竞争同一队列，无官方互斥/选举语义；是否出现"双实例抢活/重复消费"必须实测。

### 3.4 掉电后恢复

- **恢复路径（【官方已支持】）**：tunnel 对象在 OpenAI 侧持久存在（来源 5）；tunnel-client 重新拉起（launchd/systemd KeepAlive）即恢复长轮询；连接器配置（tunnel_id 绑定）不变；ChatGPT 侧请求在 client 恢复后自动可用。官方健康面 `/healthz`（进程活）/`/readyz`（启动探针+OAuth 发现+连接就绪）用于判断"恢复完成"（来源 5/12）。
- **掉电期间（【官方已支持】+【官方未说明】）**：官方明确"请求失败直到 client 重连"（来源 2）；UI 具体提示、排队保留时长官方未说明。
- **不需要重新配置**：【推断】——client 无本地注册状态，tunnel_id+key 即全部身份；配置文件在磁盘上，掉电只影响进程不影响配置。

---

## 4. 结论

### 4.1 公司 Mac 本地当中心是否设计错误？

**不是"设计错误"，而是"单点放在了错误的机器上"。** 判定依据：

- 官方架构**必然要求**一个常驻主机运行 tunnel-client（connector 不直连 MCP server，来源 2/3）——"tunnel 必须活在某台常驻机器上"是官方设计，不是本项目引入的缺陷；
- 官方明确把 laptop / developer machine / VM / K8s 都列为合法宿主（来源 1/2/4），所以"跑在公司 Mac"本身在官方支持面内；
- 问题在于：① 公司 Mac 是可用性最差的一环（掉电/关机/断网即整条链路消失）；② tunnel-client 与 ha-proxy 同机，**入口的两个单点（tunnel 进程 + 本地代理）叠在同一故障域**；③ ha-proxy 只冗余了 hub 后端（家里 hub），**tunnel 进程本身没有冗余**，事故场景完全成立。
- **正确位置**：tunnel-client（+ha-proxy）应放在"可用性最高 + 能出站 api.openai.com + 能私网到达 hub"的常驻主机上——**云 VM 优先**（官方 VM/systemd 部署模式已确认，来源 2/4）；hub 与节点按数据面约束继续留内网，经 Tailscale 被 VM 可达即可。ChatGPT 侧零改动（tunnel_id 不变）。

### 4.2 "自有服务器中心 + 无服务器用户本地模式"（Tunnel 跑云服务器）是否可行？

**可行**【官方已支持的核心面全部覆盖】：官方要求的只是"tunnel-client 与 MCP server 在同一信任边界内可互达"（来源 2/4），云 VM + Tailscale 回连内网 hub 完全满足；企业网络特性（出站代理、自定义 CA、控制面 mTLS、MCP 侧 mTLS）官方均有文档（来源 1/2）。限制按四类列出：

**安全**
- 凭证暴露面：云 VM 需持有 `CONTROL_PLANE_API_KEY`（runtime key）。官方强制最小权限：runtime key 仅 Read+Use、admin key 分离且禁止进常驻 daemon（来源 9/10）；云上应走 secrets manager / 0600 文件 + `env:` 引用（官方支持 file:/env: 语法）。【推断】runtime key 泄漏=可轮询并劫持该 tunnel 的 MCP 流量，因此云 VM 的 IAM/密钥隔离要按此威胁建模。
- TLS：官方隧道段全程 HTTPS 出站（来源 2）；**VM↔hub 段（Tailscale 或公网）完全自管**——若走公网暴露 hub，需自行 TLS + 认证；官方给出两条已确认的加固路径：OpenAI-managed mTLS 认证 ChatGPT 客户端 + 官方发布的 ChatGPT connectors IP ranges 做白名单（来源 7/8）。
- 认证边界变化：现状"No Auth"的安全前提是"隧道 + hub 仅 loopback"双边界（dsh-helm security.md 自述）；上云后 hub 必须被 VM 可达，边界变成"隧道 + VM 网络"，**建议给 hub 的 MCP 加 mTLS 或静态 header 认证**（官方支持 `MCP_EXTRA_HEADERS`/mTLS，来源 2/4）——否则任何能进 VM 网络的实体都可调用无鉴权 hub。

**网络**
- 隧道回连：出站长轮询（api.openai.com:443），云服务器无 NAT/入站防火墙问题，反而比公司 Mac 更干净；大陆/公司网络访问 api.openai.com 仍需出站代理（dsh-helm 现网经验；官方支持 `TUNNEL_CLIENT_HTTP_PROXY`/`CONTROL_PLANE_HTTP_PROXY` 等，来源 3）。
- Tailscale vs 公网：VM↔hub 推荐 Tailscale（dsh-helm mesh 已有 Tailscale 先例，hub 仍不出公网）；公网方案须前置反代 + mTLS + IP 白名单，且 OAuth 授权服务器必须公网可达（官方明确 authorization server 不自动 tunnel，来源 2/4）。
- 时延：多一跳公网/Tailscale 转发，官方无时延承诺【官方未说明】。

**运维**
- 保活：官方支持 `/healthz` `/readyz` `/metrics` `/ui`、`tunnel-client runtimes` 托管、pid_file、systemd/K8s 部署指南（来源 2/4/9/12）；云 VM 用 systemd Restart=always + 外部探活（TCP 层探活 + Prometheus 拉取）。
- 监控：官方 Prometheus 指标 + 结构化日志 + 脱敏支持导出（来源 5/12）；`/readyz` 区分"进程活"与"连接就绪"（来源 5）。
- 密钥轮换：官方无自动轮换工具【官方未说明】；roadmap 仅设想 mTLS 证书自动化（来源 13）。轮换 runbook 需自建：新 runtime key → 重启 daemon → 验证 /readyz → 吊销旧 key（官方 key 撤销面在 Platform API keys，来源 9）。

**产品**
- 官方策略边界：Tunnel 仅服务私有 MCP + 开发者模式，不做公开插件分发（来源 2/7）；若未来要把 DSH 能力做成公开 ChatGPT 插件，必须换公网 HTTPS + 审核流程。
- 未来路标：官方 roadmap 明示"非承诺"，且**无服务器侧 connector / 多实例 HA 条目**【官方未说明，来源 13】——短期内不能指望官方给 HA 能力。
- Enterprise/Team 差异：开发者模式在 Enterprise/Edu 由 workspace admin 授予（来源 2/15）；Enterprise/Edu 的 connectors 由 admin 管控 + RBAC（来源 16）；Business/Team 经开发者模式获得 full MCP 读写 connectors（来源 18）。若 dsh-helm 未来迁入企业工作区，授权模型从"个人自助"变"admin 审批"，Tunnel 需绑定企业 workspace 并由账号团队处理手动关联（来源 2）。

---

## 5. 对 dsh-helm 项目的建议（仅建议，不实施）

> 每条标注其依赖的官方能力状态：✅=官方已确认；⚠️=官方未说明，需实测；自管=本项目自控范围。

| 阶梯 | 动作 | 官方能力依赖 | 说明 |
|---|---|---|---|
| 0 | **维持现状并明确风险登记**：公司 Mac = tunnel-client+ha-proxy 单故障域 | — | 事故场景（掉电）成立；ha-proxy 只冗余 hub 后端，不冗余 tunnel |
| 1 | **tunnel-client + ha-proxy 整体迁往云 VM（首选容灾动作）**：VM 上 systemd 常驻，`--mcp.server-url http://127.0.0.1:3481` 不变，ha-proxy primary 指向经 Tailscale 可达的公司 hub、secondary 指向家里 hub；ChatGPT 侧连接器零改动 | ✅ 官方支持 VM/systemd 宿主（来源 2/4）；✅ 同一 tunnel_id 任意主机轮询（来源 5）；✅ 企业网络特性（代理/CA）（来源 1/2） | 云 VM 掉电概率远低于办公 Mac；同时消除"公司断网/关机"故障域。hub 仍留内网，出网仅 VM |
| 2 | **云 VM 高可用化**：两台云 VM（不同可用区）各跑一份 tunnel-client + ha-proxy，均连同一 tunnel_id | ⚠️ 同一 tunnel 双客户端语义官方未说明（来源 4/12/13），必须先实测：双实例是否互斥、队列竞争是否丢活/重复消费 | 若实测双客户端不可行，退到阶梯 3 拓扑 |
| 3 | **双 tunnel + 双连接器（已确认的官方冗余拓扑）**：建第二个 tunnel（绑同一 workspace），家里 Mac 或第二台 VM 跑第二个 tunnel-client；ChatGPT 侧建第二个连接器 | ✅ 一个 workspace 可绑多个 tunnel、多连接器（来源 1/9/11） | 冗余是"手动切换"级别：ChatGPT 对话工具菜单选择连接器（【推断】官方无自动 failover 语义） |
| 4 | **家里 Mac 做 tunnel 备机（条件清单）**：① 家庭网络出站 api.openai.com 稳定（自管，参考现网代理经验）；② Tailscale 可达 hub（自管）；③ 开机自启（launchd KeepAlive，dsh-helm platform 已有模板）；④ 独立 runtime key 或同一 key（推荐独立，便于轮换吊销） | ⚠️ 若复用同一 tunnel_id 需先实测（同阶梯 2）；若走独立 tunnel 则 ✅（阶梯 3） | 家庭 Mac 仍是"个人设备"，只宜作第二选择，不宜作主中心 |
| 5 | **监控与演练闭环**：VM 上以 `/readyz`（非仅 `/healthz`）+ Prometheus 指标建告警（官方支持）；月度过一次"停 tunnel-client"与"停 ha-proxy"演练；密钥轮换 runbook（新 key → 重启 → 验证 → 吊销旧 key） | ✅ 健康/指标面官方支持（来源 2/5/12）；⚠️ 密钥自动轮换官方无工具（来源 13） | 演练目标：确认 ChatGPT 侧在 client 恢复后无需任何人工重连动作 |
| 6 | **跟踪官方路标**：定期复查 openai/tunnel-client roadmap 与 releases，若出现多实例/HA 语义再升级阶梯 2 为正式方案 | ❌ 当前 roadmap 无此项（来源 13） | 在此之前不把"tunnel 双机 failover"写进任何 SLA 承诺 |

**底线建议**：以阶梯 1（云 VM 接管 tunnel+ha-proxy）为第一步落地，它把"事故场景"从"公司 Mac 掉电全断"降级为"云 VM 故障（概率低得多）"，且不依赖任何未确认的官方能力；阶梯 2/4 的同一 tunnel 双客户端方案在实测出结果前，只作为备选拓扑记录，不承诺。

---

## 6. 参考来源清单（全部访问于 2026-08-24）

**官方（OpenAI / openai org）**

1. [openai/tunnel-client README（GitHub）](https://github.com/openai/tunnel-client) —— 官方仓库首页：tunnel-client 定位（连接 ChatGPT/Codex/Responses API/AgentKit 的客户侧代理）、安装、文档地图。*支撑：Tunnel 是什么、合法宿主、部署模式。*
2. [Secure MCP Tunnel 官方指南（developers.openai.com）](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) —— 核心官方文档：工作流程（长轮询/排队/回传）、网络要求（api.openai.com:443 出站）、权限（Read/Manage/Use）、org+workspace 绑定、掉线重连原文、部署位置、Harpoon、OAuth 边界。*支撑：矩阵 #1/#2/#5/#9/#10/#11/#14 与 3.1/3.4 全部核心结论。*
3. [tunnel-client docs/architecture.md（GitHub）](https://github.com/openai/tunnel-client/blob/master/docs/architecture.md) —— 信任边界图、connector 面向端点 `<OPENAI_MCP_TUNNEL_BASE_URL>/v1/mcp/<tunnel_id>`、认证与数据流矩阵、部署模式。*支撑：connector URL 形态、信任边界。*
4. [tunnel-client docs/onboarding.md（GitHub）](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md) —— 零到一接入、key 分离、"keep the daemon running for connector discovery and every MCP call"、Codex 直连与 Tunnel 的取舍。*支撑：生命周期、Codex 侧差异。*
5. [tunnel-client docs/troubleshooting.md（GitHub）](https://github.com/openai/tunnel-client/blob/master/docs/troubleshooting.md) —— /healthz vs /readyz、client_instance_id、remote tunnel object 独立存在、队列/并发参数（每 poll ≤25、默认 10 并发）。*支撑：重连语义、单点性、容量参数。*
6. [Connect and test your plugin（developers.openai.com/plugins/deploy/connect-chatgpt）](https://developers.openai.com/plugins/deploy/connect-chatgpt) —— ChatGPT 侧接入步骤：Settings→Security and login→Developer mode、chatgpt.com/plugins 创建、Connection 二选一（HTTP URL / Tunnel）、Refresh 流程。*支撑：connector 配置面全部。*
7. [Build an MCP server（developers.openai.com/apps-sdk/deploy）](https://developers.openai.com/apps-sdk/deploy) —— 公开插件提交要求（稳定公网 HTTPS、域名验证）、私服经公网 HTTPS 代理 + OpenAI-managed mTLS + ChatGPT connectors IP ranges。*支撑：自托管替换 Tunnel 的官方边界。*
8. [MCP and Connectors（developers.openai.com/api/docs/guides/tools-connectors-mcp）](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) —— "Remote MCP servers can be any server on the public Internet"、server_url 形态、Connector（connector_id）与远程 MCP 的区别、审批机制。*支撑：公网 MCP 支持面、Connector 术语辨析。*
9. [tunnel-client docs/permissions.md（GitHub）](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md) —— 权限原子、runtime/admin key 分离、tunnel 创建后 25–30s 生效。*支撑：权限模型、密钥管理、生命周期。*
10. [tunnel-client docs/configuration.md（GitHub）](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md) —— 配置参考：poll-timeout、pid_file、代理/CA/mTLS、runtimes 命令族。*支撑：运维面（保活/代理/密钥引用）。*
11. [tunnel-client docs/connectors.md（GitHub）](https://github.com/openai/tunnel-client/blob/master/docs/connectors.md) —— "connector 不直连 MCP server"、请求生命周期（poll/response）、channel 模型、MCP_CONNECTION_MAX_TTL=10m。*支撑：冗余/多通道边界、掉电语义。*
12. [tunnel-client docs/deployment/overview.md（GitHub）](https://github.com/openai/tunnel-client/blob/master/docs/deployment/overview.md) —— K8s sidecar / dedicated / systemd VM 三类部署。*支撑：云 VM 部署路径。*
13. [tunnel-client docs/roadmap.md（GitHub）](https://github.com/openai/tunnel-client/blob/master/docs/roadmap.md) —— 官方路标（进度转发、readiness、mTLS 证书自动化、allowlist、tracing），明示"非承诺"，无 HA/多实例/服务器侧 connector 条目。*支撑：产品路标结论。*
14. [ChatGPT Developer mode（developers.openai.com/api/docs/guides/developer-mode）](https://developers.openai.com/api/docs/guides/developer-mode) —— 官方开发者模式文档：资格（Pro/Plus/Business/Enterprise/Education，web）、开启路径、创建 app、SSE/streaming HTTP、认证（OAuth/无认证/Mixed）、写操作确认。*支撑：企业版/个人版差异、配置面。*
15. [RBAC 指南（developers.openai.com/api/docs/guides/rbac）](https://developers.openai.com/api/docs/guides/rbac) —— Tunnels 权限行（Read/Use/Manage，org 级）。*支撑：权限模型。*
16. [ChatGPT Enterprise & Edu - Release Notes（help.openai.com）](https://help.openai.com/en/articles/10128477-chatgpt-enterprise-edu-release-notes) —— "Admins enable connectors for the workspace and can manage access with RBAC"（经该文多语言版本搜索摘要交叉确认，页面本身有反爬无法直接抓取）。*支撑：企业版 admin 管控。*
17. [ChatGPT Business（Team）Release Notes（help.openai.com）](https://help.openai.com/zh-hant/articles/11391654-chatgpt-business版更新) —— Business/Team 经开发者模式推出 full MCP 读写 connectors（经多语言摘要确认）。*支撑：Team 版差异。*
18. [Making private MCP servers reachable without making them public（developers.openai.com 官方博客）](https://developers.openai.com/blog/connect-private-mcp-servers-to-openai-products) —— 设计动机与取舍（出站-only、长轮询反压、laptop→生产、开源可审计 client、authorization server 不自动隧道）。*支撑：官方设计意图、Harpoon、安全边界。*

**官方提及但未直接抓取的入口（引用自上述官方文档）**

- [Platform Tunnels 设置页](https://platform.openai.com/settings/organization/tunnels)（来源 2/9 引用）
- [ChatGPT 插件页](https://chatgpt.com/plugins)（来源 6/14 引用）
- [ChatGPT connectors IP ranges](https://developers.openai.com/api/docs/guides/ip-addresses)（来源 7 引用）
- [Developer-mode Help Center 文章](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)（来源 2 引用，页面反爬无法直接抓取，plan 差异以来源 2/14 转述为准）

**第三方背景（非官方结论来源，仅用于时间线佐证）**

- [TechCrunch：OpenAI 采纳 MCP（2025-03-26）](https://techcrunch.com/2025/03/26/openai-adopts-rival-anthropics-standard-for-connecting-ai-models-to-data/) —— ChatGPT 侧 MCP/Connectors 支持的时间线起点。
- [InfoQ：OpenAI Adds Full MCP Support to ChatGPT Developer Mode（2025-10）](https://www.infoq.com/news/2025/10/chat-gpt-mcp/) —— 开发者模式 full MCP 的时间线佐证。

---

### 附：调研方法与可信度说明

- developers.openai.com 全部页面以其官方 `.md` 输出抓取原文（页面 URL 追加 `.md`），GitHub 文档以 raw 原文抓取；help.openai.com 有反爬（curl 与阅读器均被拦截），涉及条目仅采用"官方文档直接引用"或"多语言版本搜索摘要交叉一致"的内容，其余细节一律标注【官方未说明】。
- 所有【推断】均基于官方机制事实（长轮询模型、tunnel_id 即身份、队列按 tunnel 排队）推导，非官方承诺；落地前应实测验证（尤其是同一 tunnel 双客户端语义）。
