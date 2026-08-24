# ChatGPT Web 连接器（ChatGPT 侧）

本文是「ChatGPT ↔ dsh-helm」接入教程的 **ChatGPT Web 侧**：开启开发者模式、创建连接器（应用）、选择隧道、无身份验证、创建后别忘了「连接」。OpenAI Platform 侧的 tunnel 创建见 [chatgpt-tunnel-setup.md](chatgpt-tunnel-setup.md)。

> 前置：tunnel 已创建并绑定到本 workspace（[chatgpt-tunnel-setup.md §2-3](chatgpt-tunnel-setup.md#3-绑定-chatgpt-workspace最关键漏了看不到-tunnel)），tunnel-client 已在入口机器运行（[§6-7](chatgpt-tunnel-setup.md#6-运行-tunnel-client完整参数参考)）。以下 UI 路径以当前版本为准，按菜单名查找即可。

## 1. 开启开发者模式

chatgpt.com → 左下角设置 → 找到「开发者模式」并开启（开发者模式是创建自定义连接器的前置开关；也可直接访问 `/plugins` 页按提示开启）。开启后刷新页面。

## 2. 创建应用（连接器）

1. 打开插件页（`chatgpt.com/plugins`，或设置里的插件入口）。
2. 点「创建应用」/「新建插件」。
3. 填**名称**（如 `dsh-hub`，将显示在对话的连接器选择器里）。
4. **连接方式选「隧道」（Tunnel）**——不选 HTTP URL。
5. 在**隧道选择器**里选刚创建的 tunnel（§1 前置；看不到 → [troubleshooting.md](troubleshooting.md#2-插件页隧道选择器看不到-tunnel)），或直接填 tunnel id。

## 3. 身份验证：选「无身份验证」

连接器的认证方式选**「无身份验证」（No authentication）**。为什么安全：

- hub 的 MCP（3471）默认只绑定 `127.0.0.1`，**从不直接暴露公网**；
- ChatGPT 到本机的唯一通道是 OpenAI Secure MCP Tunnel——OpenAI 托管端点（TLS），且只转发到本机 tunnel-client 的 `--mcp.server-url`；
- 因此「无身份验证」的前提是两个边界同时成立：① MCP 只监听 loopback/Tailscale 内网；② 公网侧只有 OpenAI 隧道这一个入口。任何把 3471 映射到公网的做法都会破坏该前提（[security.md](security.md)）。

按界面提示勾选风险确认（如「我知道 MCP 服务器无鉴权」类选项）。

## 4. 创建 + 连接（两步，别漏第二步）

1. 点「创建」——此时连接器只是**建好**，还没装进 ChatGPT。
2. 创建后弹出的确认框里点**「连接」/「添加到 ChatGPT」**——这一步才是真正安装。

**漏掉第二步的症状**：插件列表里有该连接器，但对话里选不到、或连接器不可用。连接成功后，对话界面的连接器选择器里会出现它。

## 5. 测试

连接器装好后，在新对话里选中该连接器（右上角/输入框上方的连接器菜单），依次试：

1. **「列出所有 DSH 设备」**——应触发 `nodes_list`，返回每个节点的 node_id / display_name / 连接状态 / 分层健康。
2. **「让 node-a 回复 hello」**——模型会带 `target_node=node-a` 调用 `sessions_prompt`；或先 `presence_claim` pin 住某节点再直接发话。
3. **看回复里的 `_route.node_name`**——每次转发的回复都附 `_route` 决策信息（`node_name` = 执行节点的 display_name，缺省回退 node_id 前 8 位）。多节点场景用它确认「到底哪台机器在执行」，也是排查路由的第一现场。

常用验证句：

```
列出所有 DSH 设备
让 <display_name 或 node_id> 执行 ls /tmp（或读某个文件）
刚才的回复是在哪台机器上执行的？
```

> 破坏性操作（`sessions_prompt`/`sessions_resume`）在目标不明确时会被 hub 拒绝（`route_confirmation_required`）——这是 fail-closed 设计，不是故障；此时让模型带上 `target_node` 或先 `presence_claim` 即可（见 [troubleshooting.md](troubleshooting.md#9-路由拒绝)）。

## 6. 多连接器 vs 单 hub 连接器（拓扑取舍）

| | 每台 daemon 一个 tunnel+连接器 | 一个 hub tunnel + 一个连接器（推荐） |
|---|---|---|
| 结构 | N 台机器 = N 个 tunnel + N 个连接器 | 1 个 tunnel + 1 个连接器，hub 管 N 台节点 |
| 隔离 | 各管各，单点故障互不影响 | 入口单点（hub 挂了全部不可用） |
| 目标选择 | 对话里手动切换连接器 | `target_node` / 路由规则（session/workspace/presence） |
| 回复溯源 | 无（连接器即机器） | 带 `_route.node_name` 标注来源 |
| 适用 | 每台机器都想要独立入口/独立 key | 统一入口、统一路由与审计（本项目主推） |

**推荐**：单 hub 连接器。hub 的路由（显式 target → session owner → workspace owner → presence → default）与 fail-closed 正是为多节点设计的，回复带 `node_name` 可溯源；多连接器拓扑仅在需要严格隔离（如不同 key、不同组织）时使用。

## 7. 常见问题

- 隧道 not ready / 探活失败 → [troubleshooting.md](troubleshooting.md#1-tunnel-一直-not-ready)
- 插件页看不到 tunnel → [troubleshooting.md](troubleshooting.md#2-插件页隧道选择器看不到-tunnel)
- 路由被拒、节点 offline → [troubleshooting.md](troubleshooting.md#9-路由拒绝)
- OpenAI Platform 侧问题（key/代理/参数）→ [chatgpt-tunnel-setup.md](chatgpt-tunnel-setup.md)