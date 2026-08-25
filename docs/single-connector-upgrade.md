# 单机 connector 升级指南（应用控制面升级能力）

> 面向：**升级前跑「单个 ChatGPT ↔ DSH connector」的机器**（tunnel-client 直连本机
> helm daemon `http://127.0.0.1:3457/mcp`，不经 dsh-helm 控制面）。升级后该机器
> 以 **dsh-helm 单机兼容模式**（本地 hub + 本地 agent，`node_id == hub defaultNodeId`）
> 对外服务，**ChatGPT 侧连接器与隧道完全不动**，即可获得升级能力。

## 1. 为什么升级：能力对照

旧单机形态（tunnel → daemon 3457 直连）使用的是上游 daemon 原样工具面，
dsh-helm 的控制面升级能力（会话瘦身 / 插队 / 响应守卫）**全部不生效**：

| 能力 | 旧单机（tunnel→3457 直连） | 升级后（单机兼容模式，tunnel→hub 3471） |
|---|---|---|
| 大上下文会话响应 | 完整历史原样返回（大 session 可达 100KB+） | **默认摘要**（~KB，含 current_goal/最近证据/history_ref），完整历史显式 `include_messages=true` 才取 |
| 运行中指令插队 | 排队等长任务结束 | **`mode=steer` 立即注入**运行中回合（`steered/queued/rejected/unavailable` 结构化返回） |
| 响应体积守卫 | 无（ChatGPT 侧可能收到超大响应） | **`MAX_RESPONSE_BYTES=50000`** 统一截断，输出保持合法 JSON + `truncated` 元数据 |
| 摘要缓存 | 无 | 60s TTL + 写操作后立即失效（不读脏） |
| 凭据边界 | 原文透传 | 疑似凭据行进入摘要前剔除（`safety_sanitized` 标记） |
| 回复溯源 | 无 | 回复带 `_route.node_name` |
| 健康/指标 | daemon `/healthz` | hub `/healthz` `/readyz` `/metrics` + dashboard |

不变量：**ChatGPT 侧零改动**——连接器绑定的 tunnel 不变，只是 tunnel-client 的
`--mcp.server-url` 指向从 3457 换成 hub MCP（3471）；19 个兼容工具（snake_case）
原样保留，行为向后兼容。

## 2. 迁移步骤

前置：Node.js ≥ 22.5、pnpm；本机 DSH + helm daemon（`127.0.0.1:3457`）继续运行。

```bash
# 1) 安装 dsh-helm CLI（构建 + 写 ~/.local/bin/{dsh-helm,...}，幂等）
cd <dsh-helm checkout> && ./scripts/install.sh

# 2) 初始化节点身份（生成 ~/.dsh/helm/node.json，0600）
dsh-helm init

# 3) 编辑 ~/.dsh/helm/node.json：
#    - hub_url: ws://127.0.0.1:3470（单机；多机/生产用 tailnet IP / wss://）
#    - local_mcp_url / local_mcp_token：默认值已指向本机 daemon 3457，无需改
#    （daemon Bearer token 自动生成：agent-helm >=0.1.2 在 ~/.agent-helm/token，
#    旧版 ~/.agent-chatgpt-helm/token 兜底，agent 自动探测）

# 4) 启动本地控制面（mesh 3470 + MCP 3471，默认只绑 127.0.0.1）
dsh-helm hub &

# 5) 启动本地 agent（出站连本地 hub；先前台验证，再装自启服务）
dsh-helm agent
./scripts/install-service.sh          # macOS launchd 服务

# 6) 切换 tunnel 指向：把 tunnel-client 的 --mcp.server-url 从
#    http://127.0.0.1:3457/mcp 改为 http://127.0.0.1:3471/mcp
#    （tunnel-client 由 connector 套件 launchd 管理；改完重启该服务）
```

> 单机模式下 hub 的 `defaultNodeId` 就是本机 `node_id`：Router 的
> explicit/session/workspace/presence/default 全部收敛到本节点
> （[architecture.md](architecture.md) §8.1）。**hub MCP（3471）v1 无鉴权——
> 严禁映射公网**（[security.md](security.md) §2）。

## 3. 验证升级能力生效

```bash
# 3.1 链路与工具面
./scripts/verify.sh                    # 0 全绿
curl -s http://127.0.0.1:3471/healthz
curl -s http://127.0.0.1:3471/mcp -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -m json.tool | grep -c '"name"'   # ≥24

# 3.2 内容瘦身：默认 sessions_get 返回摘要（无 messages、~KB 级）
curl -s http://127.0.0.1:3471/mcp -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sessions_get","arguments":{"session_id":"<你的 session id>"}}}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"]["content"][0]["text"][:200])'

# 3.3 插队：mode=steer 返回结构化状态（steered/rejected/unavailable）
curl -s http://127.0.0.1:3471/mcp -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sessions_prompt","arguments":{"session_id":"<sid>","message":"先跑 lint 再提交","mode":"steer"}}}'

# 3.4 ChatGPT 侧验收：新对话里让模型「列出会话摘要」，再对运行中长任务发纠错指令，
#     观察立即打断生效；回复查看 _route.node_name = 本机 display_name。
```

自动化验证：`tests/integration/single-node.test.ts`（单机兼容模式 e2e：工具面/路由收敛/
摘要瘦身/steer 插队/插队降级/响应守卫 6 用例）。

## 4. 回滚

```bash
# 1) tunnel-client 的 --mcp.server-url 改回 http://127.0.0.1:3457/mcp 并重启服务
# 2) launchctl unload com.dsh-helm.node-agent（agent 自启服务）
# 3) 停 hub（前台 Ctrl-C 或 kill dsh-helm-hub）
# 4) dsh-helm uninstall   # 可选：彻底卸载（--purge 连 ~/.dsh/helm 一起删）
```

回滚后即回到旧单机形态（能力全部失去），ChatGPT 侧同样零改动。

## 5. 已知边界（如实说明）

- **最近 100 条之外的历史不可达**：DSH 0.1.1 的 `beforeSeq` 无效（探测实测），
  `include_messages=true` 时 `max_messages≤100`；更早内容需摘要的 `history_ref`
  标注或未来 agent 历史归档（[fidelity-acceptance.md](fidelity-acceptance.md) §7）。
- **摘要窗口 = 最后 20 条**：`current_goal` 取窗口内行动性最高的用户指令
  （附来源 seq），更早的明确目标/红线不 claim（显式标注，不编造）。
- **steer 依赖 DSH 宿主 API**（`http://127.0.0.1:3080/api/session.prompt`，
  loopback 无鉴权）：DSH web 未运行时 steer 返回 `unavailable`，queue 路径不受影响。
- **单机形态无 HA**：hub 进程挂了 ChatGPT 入口即不可用（多机/HA 见
  [architecture.md](architecture.md) 与 README「控制面 HA」）。
