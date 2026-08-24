# dsh-helm 安全文档

本文是部署与运维视角的安全手册：凭据怎么放、服务绑在哪、Tailscale 怎么配、隧道边界在哪。完整威胁分析（15 条威胁逐条）见 [threat-model.md](threat-model.md)——本文是它的操作化摘要，先读本文再按需查细节。

## 1. 凭据存放与生命周期

dsh-helm 涉及四类密钥，存放与保护各有约定：

| 凭据 | 位置 | 权限 | 说明 |
|---|---|---|---|
| 节点 token | `~/.dsh/helm/node.json` | **0600** | `dsh-helm init` 生成（node_id + token），`verify.sh` 会校验权限 |
| daemon Bearer token | `~/.agent-chatgpt-helm/token` | 0600 | 本机 helm daemon 自动生成；`node.json` 的 `local_mcp_token` 引用它 |
| hub token 表 | 环境变量 `DSH_HELM_TOKEN`（`node_id=token,...`） | 进程环境 | **hub 不落盘**；经 launchd plist `EnvironmentVariables` / systemd `EnvironmentFile` 注入 |
| 隧道凭据（tunnel id / API key） | `~/.dsh/.credentials.yaml` 或进程环境 | 0600 | tunnel-client 用 `env:VARNAME` / `file:/path` 语法引用，**key 不出现在 argv/ps** |

铁律：

- **不提交 git**：`node.json`、token 文件、`*.sqlite3`、凭据文件均在 `.gitignore` 排除范围；提交前自查（`git status`）。
- **不进 argv/日志**：所有凭据经环境变量或 0600 文件传递；hub/agent 日志与审计表不含密钥字段。
- **不走聊天工具/明文 HTTP**：新节点 token 从节点机到 hub 机用 `ssh`/`scp` 传输（保持 0600）。
- **轮换**：`dsh-helm rotate-token` 换节点 token 后，同步更新 hub 侧 `DSH_HELM_TOKEN`（`./scripts/register-node.sh <node_id> <token>` 幂等更新并重载服务）；daemon token 泄露则删 `~/.agent-chatgpt-helm/token` 让 daemon 重建并同步 `local_mcp_token`。
- **不入云盘同步**：不要把 `~/.dsh/helm/`、`~/.agent-chatgpt-helm/` 放进 OneDrive/Time Machine 类同步。

## 2. 服务绑定与网络边界

| 服务 | 默认绑定 | 生产/多机建议 |
|---|---|---|
| hub mesh（3470） | `127.0.0.1` | 跨机绑定 **Tailscale IP**：`dsh-helm hub --bind <tailnet-ip>`；公网场景走 WSS（反代终止 TLS 或传外部 https server） |
| hub MCP（3471） | `127.0.0.1` | **保持 loopback**：`--mcp-bind 127.0.0.1` 与 mesh 绑定解耦。**严禁直接映射公网**（v1 无鉴权，映射即无认证指令入口） |
| 本地 daemon（3457） | `127.0.0.1` | 永远只绑 loopback；daemon 的 unix socket 协议绝不上网络 |
| presence listener（3472） | `127.0.0.1` | 永远 loopback |
| DSH web（3080） | `127.0.0.1` | 无登录墙，只绑 loopback + trustedHosts 围栏；不要在公网反代 3080 |

要点：

- 节点 agent **只出站**拨号 hub，不需要任何入站端口；防火墙只需放行出站。
- hub 只绑 tailnet IP 时，**本机 agent 的 `hub_url` 也要用 tailnet IP**（loopback 与 tailnet IP 是两个监听面）。
- 生产 mesh 必须 `wss://`（明文 `ws://` 仅限 loopback/SSH 隧道/可信内网，见威胁模型 T1）。

## 3. Tailscale 组网建议

多机部署推荐 Tailscale（或等价 WireGuard 组网），把「公网暴露」变成「内网可达」：

1. 各机登录同一 tailnet（`tailscale up`），确认 `tailscale status` 互见。
2. hub 只绑 tailnet IP（`--bind 100.x.x.x`，`--mcp-bind 127.0.0.1`）。
3. **Tailscale ACL 最小化**：管理台只放开 dsh 相关端口——节点机 → hub 的 **3470**（mesh）；如其他机器需要直接查 hub 状态再加 **3471**（MCP）。示例（tailnet 策略文件片段）：

```jsonc
{
  "acls": [
    // 节点 → hub：只放 mesh 端口
    { "src": ["autogroup:member"], "dst": ["100.x.x.x:3470"] }
    // 需要跨机查状态时再加：{ "src": ["autogroup:member"], "dst": ["100.x.x.x:3471"] }
  ]
}
```

4. 验证：节点机 `nc -zv <hub-tailnet-ip> 3470` 通；本机 agent 的 `hub_url` 用 tailnet IP。

## 4. 隧道安全边界（OpenAI Secure MCP Tunnel）

- tunnel 是 **OpenAI 托管端点**：ChatGPT → tunnel 走平台侧 TLS；tunnel → 本机 tunnel-client 由 `--control-plane.api-key` 鉴权（env:/file: 注入，key 不出 argv）。
- **workspace 绑定即访问控制**：只有绑定到当前 ChatGPT Workspace 的 tunnel 才会出现在该 workspace 的连接器选择器里——多 workspace 组织里，这层绑定本身就是隔离手段。
- 连接器选「无身份验证」的安全前提（两层同时成立）：① hub MCP 只监听 loopback（或 tailnet 内网）；② 公网侧唯一入口是 OpenAI 隧道。**破坏任一前提即失效**（如把 3471 反代到公网）。
- tunnel-client → hub MCP 是 loopback 明文 HTTP：依赖本机进程可信假设（威胁模型 T10/T15）。

## 5. 设备配对（enrollment / pairing）

新设备接入不再需要手工传 token：hub 生成一次性配对码，设备用配对码换取长期节点 token。

### 5.1 流程

1. **生成**：hub 主机上 `dsh-helm pair`（或 dashboard「新增 DSH 设备」/ hub `GET /pair/new`）生成配对码。
   - 格式 `dshp-` + 20 位 base36（≈104 bits 熵），默认 10 分钟有效。
   - **明文只出现一次**：hub 只存 `sha256(code)`（`enrollment_codes` 表），日志只打 hash 前 8 位。
   - 生成入口只存在于 hub 的 loopback HTTP（`GET /pair/new`、`GET /pair/list`，随 MCP server 绑定）；MCP 非 loopback 绑定时返回 403。
2. **兑换**：新设备运行 `dsh-helm join --control-plane ws://<hub>:3470 --code <code>`：
   - 校验 tailscale（未安装/未登录只提示，不阻断）；
   - 生成 node_id（UUID），以未认证身份连接 hub（见 5.2）；
   - 发送 `enrollment.consume { code, node_id, display_name }`，hub 校验通过后生成长期 token（32 字节 base64url）并**原子消费**配对码；
   - 写 `~/.dsh/helm/node.json`（0600），之后 `dsh-helm agent` 用标准 HMAC 握手连接。
3. **闭环**：token 写入 `registration_tokens` 表，hub 启动时与 `DSH_HELM_TOKEN` 合并查询——**新设备 join 后无需改任何 hub 环境变量**即可认证。

### 5.2 未认证连接的取舍（关键设计决策）

新设备 join 时还没有 token，无法走 HMAC 握手。选择：**hello 的 node_id 以 `enroll:` 前缀开头时，hub 跳过 challenge/auth 直接 welcome**，但该连接：

- 只注册一个 RPC handler：`enrollment.consume`（其余方法一律 method not found）；
- 不进入路由表（`cp.connections` 无此连接，无法被转发/调度）；
- 成功兑换一次后服务端主动断开；触发速率限制（每连接 5 次/10s）后同样断开。

防御纵深（无 token 也安全）：配对码 ~104 bits 熵无法猜测；`consume` 原子消费（`UPDATE ... WHERE status='pending'`，并发重放必失败）；同一 hash 连续失败 5 次锁定（`status='locked'`）；每个 peer 速率限制。代价：`enroll:` 前缀的未认证连接在 mesh 端口可达——若把 mesh 绑到公网，攻击者只能在这些连接上做无效的码猜测（每连接 5 次），拿不到任何 hub 能力；mesh 依然应只绑 tailnet/loopback。

### 5.3 配对码只换 token，不承担长期秘密

配对码是**一次性换取凭证**，绝不作为长期共享密钥：长期秘密是 `enrollment.consume` 成功时由 hub 现场生成的节点 token（存于 `registration_tokens`，语义同 node.json 的 0600 token）。配对码泄露 = 10 分钟窗口内的一次性兑换机会，不是长期后门；码被消费后立即失效，重复提交返回 `already_used`。

### 5.4 运维要点

- dashboard `/api/pair*` 需要 `X-Dashboard-Token`（启动时随机生成、服务端注入页面），防跨站调用；dashboard 只绑 loopback。
- `dsh-helm pair` 与 dashboard 生成入口都依赖 hub MCP 绑 loopback（安全要求本来如此）。
- 轮换/吊销：`rotate-token` 换节点 token 后，如需让 enrollment 路径失效，删除对应 `registration_tokens` 行即可（配对码本身一次性，无需吊销）。

## 6. 威胁模型摘要（详见 [threat-model.md](threat-model.md)）

| 威胁面 | 风险等级 | 主要缓解 |
|---|---|---|
| 网络嗅探/MITM（ws 明文） | 高 | 生产 wss；loopback 默认绑定；HMAC 挑战（token 永不上线） |
| token 泄露 | 高 | 0600 文件 + env:/file: 注入 + redactor + 不入库/不入 git |
| 伪造节点加入 | 高 | token 绑定 node_id + UUID 校验 + blocked 状态 + 握手 3 次上限 |
| 破坏性操作误路由 | 高 | fail-closed（`route_confirmation_required`），绝不静默换节点 |
| 路由欺骗（presence 伪造） | 中 | 显式 target 永远优先 + 15s 歧义窗口 + 裸 id 歧义不猜测 |
| 节点被攻陷后横向 | 中 | 星型拓扑（节点间无通道）+ hub 固定 RPC handler 表 |
| 配对码暴力/重放 | 低 | ~104 bits 熵 + 原子消费 + hash 连续失败锁定 + per-peer 速率限制 |
| hub MCP 无鉴权 | 中（默认 loopback） | 绑定围栏；**严禁公网暴露**；后续加固方向：加 Bearer/HMAC |
| 审计篡改 | 中 | 只 INSERT DAO + call_id 关联；无防篡改设计（已接受） |
| 会话正文泄露 | 低 | 设计红线：wire 与存储只承载元数据，hub 从不落正文 |

## 7. 部署前检查清单

- [ ] `~/.dsh/helm/node.json` 权限 0600（`./scripts/verify.sh` 会查）
- [ ] 仓库无真实凭据（`git grep -i "sk-proj\|tunnel_"` 自查）
- [ ] hub：`--bind` 只绑 tailnet/内网 IP，`--mcp-bind 127.0.0.1`；3471 未映射公网（配对端点 `/pair/*` 依赖 loopback）
- [ ] daemon（3457）只绑 loopback；3080 未反代公网
- [ ] Tailscale ACL 只放开 3470（必要时 3471）
- [ ] 节点 token 传输走 ssh/scp（0600），hub 侧经 launchd EnvironmentVariables / EnvironmentFile 注入
- [ ] 生产 mesh 用 `wss://`（反代或 https server 终止 TLS）
- [ ] 隧道凭据用 `env:`/`file:` 语法，`ps aux` 看不到 key
- [ ] 云同步/备份工具未纳入 `~/.dsh/helm/` 与 `~/.agent-chatgpt-helm/`

---

*维护约定：本文是威胁模型的操作化摘要；事实以 [threat-model.md](threat-model.md) 与 `packages/` 实现为准。*
