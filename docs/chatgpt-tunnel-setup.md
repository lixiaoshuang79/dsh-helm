# ChatGPT 隧道接入（OpenAI Platform 侧）

本文是「ChatGPT ↔ dsh-helm」接入教程的 **OpenAI Platform 侧**：创建 Secure MCP Tunnel、绑定 ChatGPT Workspace、创建项目级 API key、运行 tunnel-client。ChatGPT Web 侧的连接器创建与测试见 [chatgpt-connector.md](chatgpt-connector.md)。

目标链路（本文覆盖前两段）：

```
ChatGPT Web（连接器/插件）
   │ OpenAI Secure MCP Tunnel（OpenAI 托管端点，TLS）
   ▼
tunnel-client（本机进程，出站轮询 api.openai.com，经本地 HTTPS 代理）
   │ Streamable HTTP MCP（http://127.0.0.1:3471/mcp）
   ▼
dsh-helm Hub ── mesh ──▶ node-agent ──▶ 本地 helm daemon（3457）──▶ DSH
```

> 前置：OpenAI 组织账号（组织 Owner/Developer），能访问 platform.openai.com；以下界面路径以当前 UI 为准，若入口变化按菜单名查找即可。

## 1. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| OpenAI 组织账号 | 组织级权限 | 创建 tunnel 与查看项目需要 |
| 网络 | 能访问 api.openai.com | 中国大陆/公司网络需本地代理，见 [§5](#5-网络代理中国大陆公司网络必读) |
| tunnel-client | 官方 `openai/tunnel-client` | 从官方发布页下载对应平台的二进制（安装方式以官方 README 为准），验证 `tunnel-client --help` 可执行并输出参数说明 |
| hub 正在运行 | `dsh-helm hub` 已启动 | MCP 入口 `127.0.0.1:3471/mcp`，见 [README 快速开始](../README.md) |

## 2. 创建 Tunnel（OpenAI Platform）

1. 打开 **https://platform.openai.com/settings/organization/tunnels**（组织设置 → Tunnels）。
2. 点击「新建 Tunnel」/「Create tunnel」，填写：
   - **名称**：如 `dsh-hub`（建议与用途对应，多 tunnel 时好区分）。
   - **描述**：可选，写清它接的是什么（如「dsh-helm 控制平面入口」）。
   - **Organizations**：选当前组织。
3. 创建后拿到 **tunnel id**，形如 `tunnel_abc123...`——记录备用（[§6](#6-运行-tunnel-client完整参数参考) 要用）。

Tunnel 是 OpenAI 托管的转发端点：ChatGPT 侧流量经它安全回连到本机 tunnel-client。**tunnel id 属于凭据，不要提交进 git。**

## 3. 绑定 ChatGPT Workspace（最关键，漏了看不到 tunnel）

创建 tunnel 后**必须**把它绑定到你的 ChatGPT Workspace：

1. 在 Tunnels 列表点进刚建的 tunnel → **Edit**。
2. 找到 **ChatGPT workspaces** 字段，选择要绑定的 workspace id——形如 `cd65baf6-5dcc-4916-88ef-ef7a1fafacc0` 的 UUID。
3. 保存。

**为什么**：ChatGPT 插件页的「隧道」选择器只列出**已绑定到当前 workspace** 的 tunnel。不绑定的症状 = 插件页看不到这个 tunnel（见 [troubleshooting.md](troubleshooting.md#2-插件页隧道选择器看不到-tunnel)）。

要点：

- 一个 workspace 可以绑定多个 tunnel（对应多连接器拓扑）；一个 tunnel 也可以服务多个 workspace（如企业多 workspace 共用入口），按需配置。
- 绑定后如仍不生效，刷新插件页/退出重进 ChatGPT。

## 4. 创建项目级 API key（org 级 Not Available 的绕行）

tunnel-client 轮询控制面需要 API key 鉴权。**如果组织级 API keys 页面显示「Not Available」**（缺 `api.organization.projects.api_keys.write` 权限，常见于普通成员账号），改用**项目级** key：

1. 打开 **https://platform.openai.com/settings/proj_xxx/api-keys**（把 `proj_xxx` 换成你的项目 id；Default project 亦可）。
2. 点「Create API key」/「创建密钥」，类型选 **Runtime key**。
3. 权限选择 **「Read and write API resources」**。
4. 创建后 key 只显示一次，形如 `sk-proj-xxxxx...`——立即存入凭据文件（如 `~/.dsh/.credentials.yaml`，0600），**不要提交进 git、不要贴进聊天工具**。

> 组织级页面显示 Not Available 是权限不足的正常表现，不是故障——直接走项目级即可。

## 5. 网络代理（中国大陆/公司网络必读）

**症状**：tunnel-client 日志反复出现控制面轮询超时（`context deadline exceeded`），连接器一直 not ready。原因：api.openai.com 在大陆/公司网络直连不通。

**解决**（三处配套）：

```bash
# 1. 出网代理（示例 127.0.0.1:7897，按本机代理实际端口替换）
export HTTPS_PROXY=http://127.0.0.1:7897

# 2. 本地流量不要绕代理（关键：hub MCP 在 127.0.0.1，绕代理会连不上）
export NO_PROXY=127.0.0.1,localhost

# 3. tunnel-client 显式使用该代理（env: 语法，见下节）
#    --control-plane.http-proxy env:HTTPS_PROXY
```

`NO_PROXY=127.0.0.1,localhost` 不能省：tunnel-client 到 hub MCP（127.0.0.1:3471）的流量若被代理接管会全部失败。

## 6. 运行 tunnel-client（完整参数参考）

### 6.1 参数规则：API key 不能传裸值

`--control-plane.api-key` **不接受裸字符串**（传裸值直接报 `invalid control-plane.api-key`），必须用两种前缀之一：

- `env:VARNAME`——从进程环境读取（推荐，key 不进命令行/ps）
- `file:/path/to/file`——从文件读取

同理 `--mcp.extra-headers` 里的 Authorization 头也是 `env:VARNAME` 或 `file:` 形式。

### 6.2 命令模板（连接 dsh-helm hub）

```bash
# 凭据放环境（或 0600 凭据文件来源）
export OPENAI_API_KEY=sk-proj-xxxxx
export TUNNEL_ID=tunnel_abc123
export HTTPS_PROXY=http://127.0.0.1:7897      # 不需要代理的机器可省略
export NO_PROXY=127.0.0.1,localhost

tunnel-client run \
  --control-plane.tunnel-id "$TUNNEL_ID" \
  --control-plane.api-key env:OPENAI_API_KEY \
  --control-plane.http-proxy env:HTTPS_PROXY \
  --control-plane.poll-timeout=10000ms \
  --control-plane.poll-deadline-guardrail=3000ms \
  --mcp.server-url http://127.0.0.1:3471/mcp \
  --health.listen-addr 127.0.0.1:3468 \
  --log.level=info
```

参数说明：

| 参数 | 值（示例） | 说明 |
|---|---|---|
| `--control-plane.tunnel-id` | `tunnel_abc123` | §2 创建的 tunnel id |
| `--control-plane.api-key` | `env:OPENAI_API_KEY` | **必须带 env:/file: 前缀**（§6.1） |
| `--control-plane.http-proxy` | `env:HTTPS_PROXY` | 出网代理；不需要代理的机器省略整个参数 |
| `--control-plane.poll-timeout` | `10000ms` | 控制面轮询超时（示例值，可按网络状况调） |
| `--control-plane.poll-deadline-guardrail` | `3000ms` | 轮询截止保护（示例值） |
| `--mcp.server-url` | `http://127.0.0.1:3471/mcp` | **默认指向 hub MCP**（多节点入口）；单机直连模式可指 `http://127.0.0.1:3457/mcp` |
| `--mcp.extra-headers` | `"Authorization: env:TOKEN"` | **仅在 MCP server 有 Bearer 鉴权时需要**；hub MCP 默认 loopback 无鉴权，不需要 |
| `--health.listen-addr` | `127.0.0.1:3468` | 健康端口（示例值，可配置；旧 connector 套件用 3458） |
| `--log.level` | `info` | 日志级别 |

### 6.3 以 launchd 服务运行（macOS）

进程内 `env:` 引用要求环境变量先注入进程；launchd 下在 plist 的 `EnvironmentVariables` 里写 key（或由 wrapper 脚本 export）。示例 label：`com.dsh-helm.tunnel-client`，日志到 `~/.dsh/helm/logs/tunnel-client.log`。生产建议：凭据从 0600 凭据文件读取后 export，`env:` 语法保证 key 不出现在 argv/ps。

## 7. 验证

```bash
# 1. tunnel-client 健康端口（本地）
curl -s http://127.0.0.1:3468/healthz

# 2. 日志应出现控制面连接成功/隧道就绪类信息（--log.level=info）
tail -f ~/.dsh/helm/logs/tunnel-client.log
```

再验证 ChatGPT 侧：插件页的「隧道」选择器能看到该 tunnel（看不到 → [troubleshooting.md](troubleshooting.md#2-插件页隧道选择器看不到-tunnel)）。然后进入下一步：[chatgpt-connector.md](chatgpt-connector.md) 创建连接器。

## 8. 相关链接

- 连接器创建与测试：[chatgpt-connector.md](chatgpt-connector.md)
- 故障排查：[troubleshooting.md](troubleshooting.md)
- 凭据与安全边界：[security.md](security.md)
- 架构与端口：[architecture.md](architecture.md)