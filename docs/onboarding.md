# dsh-helm 第二台机器加入控制平面（onboarding 手册）

适用场景：入口机器已跑 Hub（mesh WS 3470 + MCP 3471，WSS 或经 SSH 隧道/内网可达），现在要把一台新机器（macOS 或 Windows）作为节点接入，让 ChatGPT 能在同一个入口上发现、路由并操作这台新机器上的 DSH 会话与工作区。

本文所有命令与事实对应 `packages/` 实现（v0.1.0 / 协议 schema v1）；配套阅读 `docs/architecture.md`（架构）与 `docs/threat-model.md`（威胁模型）。

## 0. 总体流程（七步）

```
1. 前置条件检查（Node.js / pnpm / hub 可达性）
2. 安装 dsh-helm（clone 仓库 或 npm 包，二选一）
3. dsh-helm init 生成身份（node_id + token，0600）
4. hub 侧注册 token（DSH_HELM_TOKEN 注入）
5. dsh-helm-agent 前台验证 → 配置开机自启
6. 验证（nodes list / supervisor_health 分层 / 聚合列表）
7. 配置 presence（macOS 自动 / Windows 适配 / 浏览器扩展）
```

## 1. 前置条件

| 项 | 要求 | 验证命令 |
|---|---|---|
| Node.js | **>= 22.5**（`package.json` engines；hub/node-agent 用 `node:sqlite`、`node:crypto`） | `node --version` |
| pnpm | 8+（clone 路径需要；npm 包路径不需要） | `pnpm --version` |
| hub 可达 | 三选一：内网 IP / WSS 域名 / SSH 隧道 | 见下 |
| 本地 DSH + helm daemon | 新机器上先装好 deepseek-harness 与 `@beforewave/dsh-chatgpt-helm` 插件（daemon 监听 `127.0.0.1:3457`，`/healthz` 免认证可探） | `curl -s http://127.0.0.1:3457/healthz` |
| 防火墙 | **只需要出站**（agent 拨号 hub）；hub 侧需入站可达 3470/3471 | — |

**hub 地址三选一（决定 `hub_url`）**：

```bash
# A. SSH 隧道（推荐：hub 默认只绑 127.0.0.1，隧道无需改 hub 配置；ws 明文只在隧道内）
ssh -N -L 3470:127.0.0.1:3470 <user>@<hub-机器>        # 新机器上执行
#   之后 hub_url = ws://127.0.0.1:3470

# B. WSS 域名（hub 侧已配 DSH_HELM_BIND=0.0.0.0 + TLS 反代终止 wss）→ hub_url = wss://helm.example.com/
# C. 可信内网直连（仅限完全可信的 LAN；ws 明文可被同网段嗅探，见威胁模型 T1）→ hub_url = ws://192.168.x.x:3470
```

> ⚠️ 明文 `ws://` 只允许 loopback/SSH 隧道/可信内网；跨不可信网络必须 `wss://`（`node-agent/src/config.ts` 与架构决策 2）。

## 2. 安装 dsh-helm（两条路径）

### 路径 A：clone 仓库（当前 monorepo 未发布，推荐）

```bash
git clone <dsh-helm 仓库地址> ~/dsh-helm && cd ~/dsh-helm
pnpm install
pnpm build        # tsc -b packages/*/tsconfig.json，产物在 packages/*/lib/
# 安装 bin 到 PATH（可选，方便后续命令）
pnpm --filter @dsh-helm/hub --filter @dsh-helm/node-agent link --global
```

### 路径 B：npm 包（发布/打包分发后）

```bash
npm install -g @dsh-helm/cli @dsh-helm/hub @dsh-helm/node-agent     # 已发布时
# 未发布时本地打包：pnpm --filter @dsh-helm/hub --filter @dsh-helm/node-agent pack
#   再 npm install -g <tarball>.tgz
```

两种路径最终都提供三个可执行入口：

| 命令 | 来源 | 用途 |
|---|---|---|
| `dsh-helm` | `@dsh-helm/cli`（`bin: lib/cli.js`） | init / status / nodes / route-explain / presence 等运维命令 |
| `dsh-helm-hub` | `@dsh-helm/hub`（`bin: lib/hub-cli.js`） | **仅入口机器**：启动 hub（mesh + MCP） |
| `dsh-helm-agent` | `@dsh-helm/node-agent`（`bin: lib/agent-cli.js`） | **每台节点机器**：前台运行节点 agent |

## 3. dsh-helm init 生成身份

```bash
dsh-helm init
# 生成 ~/.dsh/helm/node.json（0600）：
#   node_id     = UUID（首次安装生成，稳定身份；hostname 只是 display_name）
#   token       = 32B base64url（随机；hub 侧需要同一份）
ls -l ~/.dsh/helm/node.json        # 期望 -rw-------（0600）
```

然后编辑 `node.json` 补两个字段（`loadConfig` 会合并磁盘配置并在下次加载时按 0600 重写）：

```jsonc
{
  "node_id": "<生成的UUID>",
  "token": "<生成的32B token>",
  "hub_url": "ws://127.0.0.1:3470",        // ← 按 §1 选定的地址填（wss:// 或 ws://）
  "local_mcp_url": "http://127.0.0.1:3457/mcp",   // 默认值，可不动
  "local_mcp_token": "<本地 daemon 的 Bearer token>", // ← 必须填：读 ~/.agent-chatgpt-helm/token 的内容
  "display_name": "<展示名，默认 hostname>"
}
```

> `local_mcp_token` 与 hub 无关，它是**本机** helm daemon（`127.0.0.1:3457/mcp`）的 Bearer token，内容在 `~/.agent-chatgpt-helm/token`（daemon 首次启动自动生成，0600）。node agent 的 `LocalHelmBackend`（默认 `McpLocalHelmBackend`）只走这个认证端点，**不碰** daemon 的 unix socket adapter 协议（`~/.agent-chatgpt-helm/run/daemon.sock`，无认证、绝不上网）。
> 可用环境变量覆盖（`agent-cli.ts` 支持，适合 service 场景）：`DSH_HELM_HUB` / `DSH_HELM_MCP_URL` / `DSH_HELM_MCP_TOKEN`。

## 4. hub 侧注册 token

hub 的 token 表 v1 由 **`DSH_HELM_TOKEN` 环境变量**注入（`hub-cli.ts` 的 `tokenLookupFromEnv`：`node_id=token,...` 逗号分隔）。在**入口机器**上：

```bash
# 1. 在 hub 进程的环境里加入新节点（与已有节点并存）
export DSH_HELM_TOKEN="<已有node_id>=<已有token>,<新node_id>=<新token>"

# 2. 启动/重启 hub（mesh 3470 + MCP 3471；默认 bind 127.0.0.1）
dsh-helm-hub --mesh-port 3470 --mcp-port 3471 --store ~/.dsh/helm/store.sqlite3 \
    [--default-node <hub自身node_id>] [--bind 0.0.0.0]   # --bind 0.0.0.0 仅 WSS 反代场景
```

要点与说明：

- **token 表就是这一份环境变量**：hub 不落盘 token、不读配置文件；`tokenLookup(node_id)` 找不到 → 握手必失败（`AUTH_FAILED`），所以新节点必须先注入再连。
- 生产建议用 **secrets 管理**（代码注释原话）：systemd `EnvironmentFile`、launchd plist 的 `EnvironmentVariables`、或密钥服务注入——不要写死在 shell 历史里。
- 换 token / 移除节点 / `rotate-token`：改 `DSH_HELM_TOKEN` 后重启 hub 生效（轮换窗口内新旧 token 可并存）。
- hub 的 MCP（3471）v1 **无鉴权**，默认只绑 loopback——**严禁**把 3471 映射到公网（威胁模型 T1/T13）。

## 5. 启动 agent 并配置自启

### 5.1 前台验证

```bash
# 新机器上执行（--hub 可覆盖 node.json 的 hub_url）
dsh-helm-agent --hub ws://127.0.0.1:3470
# 期望日志：
#   node agent started (node_id=<UUID>, hub=ws://127.0.0.1:3470)
#   connected to hub <hub_id>
#   local probe ok (serena connected)
```

前台跑通（日志无 `handshake failed` / `local probe failed`）后再做自启；Ctrl-C 优雅停止。新节点上 `dsh-helm status` 可随时查看本地配置。

### 5.2 macOS：launchd（模板在 `@dsh-helm/platform` 的 `launchdPlist`：RunAtLoad + KeepAlive）

`~/Library/LaunchAgents/com.dsh-helm.node-agent.plist`（按实际路径填 node 与 agent-cli）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh-helm.node-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/packages/node-agent/lib/agent-cli.js</string>
    <string>--hub</string>
    <string>ws://127.0.0.1:3470</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/<you>/.dsh/helm/logs/agent.log</string>
  <key>StandardErrorPath</key><string>/Users/<you>/.dsh/helm/logs/agent.err.log</string>
</dict>
</plist>
```

```bash
mkdir -p ~/.dsh/helm/logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dsh-helm.node-agent.plist
launchctl kickstart -k gui/$(id -u)/com.dsh-helm.node-agent   # 重启
launchctl print gui/$(id -u)/com.dsh-helm.node-agent | head    # 状态
tail -f ~/.dsh/helm/logs/agent.log                             # 日志
```

### 5.3 Windows：计划任务（模板在 `@dsh-helm/platform` 的 `windowsTaskXml`：LogonTrigger、LeastPrivilege、RestartOnFailure 1min×3）

生成 `task.xml`（要点与模板一致）：

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\Program Files\nodejs\node.exe</Command>
      <Arguments>C:\path\to\node-agent\lib\agent-cli.js --hub ws://127.0.0.1:3470</Arguments>
      <WorkingDirectory>C:\path\to\dsh-helm</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```

```powershell
schtasks /Create /TN "dsh-helm-node-agent" /XML "C:\path\to\task.xml" /F
schtasks /Run /TN "dsh-helm-node-agent"
schtasks /Query /TN "dsh-helm-node-agent"
```

### 5.4 Linux：systemd user unit（模板 `systemdUnit`：Restart=always、RestartSec=10）

```ini
# ~/.config/systemd/user/dsh-helm-node-agent.service
[Unit]
Description=dsh-helm node agent
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/node-agent/lib/agent-cli.js --hub ws://127.0.0.1:3470
Restart=always
RestartSec=10
StandardOutput=append:%h/.dsh/helm/logs/agent.log
StandardError=append:%h/.dsh/helm/logs/agent.err.log

[Install]
WantedBy=default.target
```

```bash
mkdir -p ~/.dsh/helm/logs
systemctl --user daemon-reload && systemctl --user enable --now dsh-helm-node-agent
systemctl --user status dsh-helm-node-agent
```

## 6. 验证

新节点上线后，在**入口机器**（或任一能访问 hub MCP 3471 的机器）验证（也可以只用 CLI：`dsh-helm nodes list` / `node get` / `route-explain`）：

```bash
# 1. hub 健康（control 层）
curl -s http://127.0.0.1:3471/healthz        # {"ok":true,"nodes":N}，N 应含新节点

# 2. nodes list：看到新节点（连接/能力/状态）
curl -s -X POST http://127.0.0.1:3471/mcp -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"nodes_list","arguments":{}}}'
# 期望：新节点 connected:true、status:online、versions.protocol:1

# 3. supervisor_health：分层全绿
curl -s -X POST http://127.0.0.1:3471/mcp -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":2,"method":"tools/call",
  "params":{"name":"supervisor_health","arguments":{}}}'
# 期望（分层健康，绝不折叠成单一 status）：
#   control: ok（hub 进程+store）│ channel: ok（WS+lease，45s）│ adapter: ok（本地 daemon 可达）
#   datapath: ok（sessions_list 端到端）│ serena: connected/ok（workspace 运行时）

# 4. 聚合列表：新节点的会话/工作区出现（global key = node_id:native_id）
curl -s -X POST http://127.0.0.1:3471/mcp -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":3,"method":"tools/call",
  "params":{"name":"sessions_list","arguments":{}}}'
curl -s -X POST http://127.0.0.1:3471/mcp -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":4,"method":"tools/call",
  "params":{"name":"workspaces_list","arguments":{}}}'
```

## 7. presence（"人现在在哪台机器"信号）

presence 影响**未显式指定目标**的调用路由（第 4 优先级）。节点 agent 的 presence 链（`agent-cli.ts`）：manual > desktop（macOS）> browser listener。

| 来源 | 新机器上的配置 | 机制 |
|---|---|---|
| manual | 无需配置；随时可用 | `presence_claim` 工具 / CLI `presence claim <node>`：confidence 1.0、pinned、默认 TTL 10min |
| desktop（macOS，**自动**） | agent 启动即启用 | `DesktopSidecarPresenceProvider`：`osascript` 查 System Events 前台应用；ChatGPT/浏览器前台 → confidence 0.9，否则 0.2；每 10s 探测。**首次需授予「辅助功能」权限**（System Events） |
| desktop（Windows） | 接 agent 时启用适配器 | `WindowsDesktopPresenceProvider` scaffold：PowerShell + user32 `GetForegroundWindow` 取前台进程名；chatgpt/msedge/chrome/firefox/brave → 0.9 |
| browser | 手动加载扩展 | `packages/presence/src/browser.ts` 生成 MV3 扩展 scaffold（manifest/background/content，host_permissions 仅 `127.0.0.1`）；chrome://extensions → 开发者模式 → 加载已解压扩展；上报 chatgpt.com 焦点到本机 `PresenceListener`（`127.0.0.1:3472/presence/...`）。注意 `content.js` 里上报端口是常量，需与 listener 端口（默认 3472）一致 |
| idle | 预留 | 显式低置信来源（协议保留） |

机制要点（`protocol/src/constants.ts`）：renew 20s / TTL 60s（hub clamp）；**15s 歧义窗口**内两台 fresh high-confidence → 路由视为 ambiguous 不自动选；`pinned` manual claim 直接胜出；显式 `target_node` 永远优先于 presence。

## 8. 多节点日常使用（ChatGPT 侧）

- **指定目标**：任何可路由工具都带可选 `target_node` 参数（`node_id` 见 `nodes_list`）——显式目标优先级第一，破坏性操作（`sessions_prompt`/`sessions_resume`）拿不准时**务必带上**。
- **会话归属**：会话有强亲和（session owner），**不静默迁移**——会话永远回到 owner 节点执行；global key 是 `node_id:native_session_id`，裸 native id 跨节点歧义时 hub 返回 undefined 而非猜测。跨节点搬会话 v1 不支持（`handoff` 诚实返回 unsupported）。
- **工作区归属**：`code_*` 工具按 workspace owner 路由（`workspace` 参数传 native id 或 path；hub 不实现代码智能，只代理到 owner 节点）。
- **排查路由**：`route_explain`（`op` 必填，可带 `session_id`/`workspace`/`target_node`）只解释不执行，返回决策、evidence、candidates——多节点场景的第一排查工具。
- **手动 pin**：想让后续未指定调用都落到某台机器：`presence_claim`（`node_id` 必填，默认 10min pinned）；用完 `presence_release`。
- **聚合视图**：`projects_list` / `workspaces_list` / `sessions_list`（可 `node_id` 过滤）/ `agents_list` 返回多节点扁平结果，每条带 `node_id`。

## 9. 安全注意（读威胁模型后再操作）

1. **token 传输渠道**：新节点 token（`node.json` 的 token）从新机器到 hub 机器用 `ssh`/`scp` 且保持 0600——**绝不**通过聊天工具、邮件、明文 HTTP 传；hub 侧注入 `DSH_HELM_TOKEN` 时避免写进 shell 历史（用 EnvironmentFile/launchd env）。
2. **防火墙**：agent 只需**出站**（拨号 hub 3470）；hub 机器按 §1 方式开放入站（SSH 隧道只开 22；WSS 反代只开 443）；**不要把 3470/3471 直接暴露公网**（mesh 默认 ws 明文、MCP 无鉴权）。
3. **凭据落盘**：`node.json`、`~/.agent-chatgpt-helm/token`、`~/.dsh/.credentials.yaml` 全部 0600，且不在 git 里（`.gitignore` 已排除 `*.sqlite3` 与凭据）；不要把它们同步进云盘。
4. **怀疑泄露**：`dsh-helm rotate-token` 换新 token，同时更新 hub 侧 `DSH_HELM_TOKEN`；daemon token 泄露则删 `~/.agent-chatgpt-helm/token` 让 daemon 重建。
5. **DSH web（3080）无认证**：只绑 loopback + trustedHosts 围栏——不要在公网反代 3080；本机浏览器/恶意扩展仍能碰它（威胁模型 T12）。本地代理同理：若新机器还要跑 ChatGPT 隧道，`tunnel-client` 必须带 `HTTPS_PROXY=<local-proxy>`（出网代理），凭据从 `~/.dsh/.credentials.yaml` 以 `env:` 语法注入。

## 10. 常见问题排查表

| 症状 | 原因 | 处理 |
|---|---|---|
| `handshake failed: -32002 authentication failed` | token 不匹配 / hub 未注册该 node_id | 核对 node.json token 与 hub `DSH_HELM_TOKEN`；改完重启 hub 与 agent |
| `handshake failed: -32001 protocol version mismatch` | 协议版本不一致（`hello.v` ≠ hub `schemaVersion`） | 两端升级到同一版本（`versions.protocol` 应为 1）；**绝不静默降级** |
| 节点 `offline` / `channel: lease-expired` | 45s 无心跳（断网/agent 退出/防火墙拦出站） | 看 agent 日志是否在退避重连（1s→30s）；恢复后自动全量 re-register + reconcile |
| 节点显示 `blocked` | 身份冲突 / 版本不兼容被运维封锁 | hub 侧 `registry.unblock` 恢复（回 offline 重新注册），或升级后重启 |
| `route rejected (route_confirmation_required)` | destructive/write 无明确目标且无 presence/default | 加 `target_node`（或 `session_id`/`workspace`）；先用 `route_explain` 看决策 |
| `route rejected (no_route)` | 只读操作也无目标 | 检查节点在线（lease）与 presence 是否过期；`presence_claim` 或 `target_node` |
| `route rejected (unknown_node)` | `target_node` 拼错 / 未注册 | `nodes_list` 拿真实 node_id |
| `node_unavailable` | 路由选中的节点无活动连接（刚离线） | 等重连或换目标；`node_get` 看分层健康 |
| `local probe failed / adapter-unreachable` | 本机 daemon 没起 / `local_mcp_token` 不对 | 确认 3457 `/healthz` 通；核对 `local_mcp_token` 与 `~/.agent-chatgpt-helm/token`；serena 未连是 `serena-disconnected`（degraded 不算 down） |
| `ws connection refused` | hub 没起 / 端口错 / 隧道没建 | 入口机器确认 `dsh-helm-hub` 在跑（3470 监听）；SSH 隧道确认 `ssh -L` 存活 |
| ChatGPT 里看不到新节点工具 | 入口连接器还指向旧 daemon（3457）而非 hub MCP（3471） | 隧道/连接器 MCP server-url 指向 `http://127.0.0.1:3471/mcp`（单机兼容模式下 hub 与 daemon 并存，入口必须是 hub） |

---

*维护约定：命令与字段对应 `packages/node-agent/src/agent-cli.ts`、`packages/hub/src/hub-cli.ts`、`packages/platform/src/index.ts`；端口/常量以 `packages/protocol/src/constants.ts` 为准；若实现变更请同步本文与 `docs/architecture.md`。*
