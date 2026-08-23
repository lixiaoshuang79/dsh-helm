#!/usr/bin/env bash
# verify.sh — dsh-helm 部署自检（macOS 优先；Linux/bash 4+ 亦可）
#
# 用途：分层次检查本机 dsh-helm 部署健康度：
#   L0 环境    node >= 22.5（缺失/过低 → 严重）
#   L1 安装    ~/.local/bin/dsh-helm wrapper 可执行（缺失 → 严重）
#   L2 身份    ~/.dsh/helm/node.json 存在且权限 0600（缺失/权限错 → 严重）
#   L3 本机    本地 daemon MCP 3457 可达性：200/401 均算可达（可达 → 绿；
#             401 是 MCP 无 token 的正常认证拒绝，连接失败才是真故障 → 警告）
#   L4 控制面  hub mesh 3470 / hub MCP 3471 端口探测（未开 → 警告，可能本机
#             不是 hub 所在机）
#
# 用法：
#   ./scripts/verify.sh              # 标准自检
#   ./scripts/verify.sh --quiet     # 只输出失败项（供脚本调用）
#
# 退出码：
#   0  全绿（可正常运行）
#   1  有警告（可运行但有隐患：3457 不可达 / hub 端口未开 / PATH 缺 ~/.local/bin）
#   2  严重（缺 node / wrapper / node.json 或权限错误，无法正常使用）
#
# 只探测，不修改任何服务与端口。

set -eu
set -o pipefail 2>/dev/null || true

HOME_DIR="$HOME"
WRAPPER_PATH="$HOME_DIR/.local/bin/dsh-helm"
NODE_CONFIG="$HOME_DIR/.dsh/helm/node.json"
MCP_URL="http://127.0.0.1:3457/healthz"
HUB_MESH_PORT=3470
HUB_MCP_PORT=3471

QUIET=0
for a in "$@"; do
  case "$a" in
    --quiet) QUIET=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -30; exit 0 ;;
    *) echo "[dsh-helm] ✗ 未知参数: $a（支持 --quiet）" >&2; exit 1 ;;
  esac
done

say()   { [ "$QUIET" = "1" ] || echo "  $*"; }
ok()    { [ "$QUIET" = "1" ] || echo "  ✓ $*"; }
warn()  { echo "  ⚠ $*"; }
fail()  { echo "  ✗ $*"; }

SEVERE=0
WARN=0

echo "[dsh-helm] ==== dsh-helm 自检 ===="

# ---------- L0 环境 ----------
echo "[dsh-helm] --- L0 环境 ---"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  fail "node 未找到（which node 为空）——请先安装 Node.js >= 22.5"
  SEVERE=$((SEVERE+1))
else
  NODE_VER="$("$NODE_BIN" --version)"
  NODE_MAJOR="$("$NODE_BIN" -e 'console.log(process.versions.node.split(".")[0])')"
  if [ "$NODE_MAJOR" -lt 22 ]; then
    fail "node 版本过低: $NODE_VER（要求 >= 22.5）"
    SEVERE=$((SEVERE+1))
  else
    NODE_MINOR="$("$NODE_BIN" -e 'console.log(process.versions.node.split(".")[1])')"
    if [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; then
      fail "node 版本过低: $NODE_VER（要求 >= 22.5）"
      SEVERE=$((SEVERE+1))
    else
      ok "node: $NODE_BIN ($NODE_VER)"
    fi
  fi
fi

# ---------- L1 安装 ----------
echo ""
echo "[dsh-helm] --- L1 安装 ---"
if [ -x "$WRAPPER_PATH" ]; then
  ok "dsh-helm wrapper: $WRAPPER_PATH"
elif [ -f "$WRAPPER_PATH" ]; then
  fail "$WRAPPER_PATH 存在但不可执行（chmod +x 修复）"
  SEVERE=$((SEVERE+1))
else
  fail "dsh-helm 未安装（$WRAPPER_PATH 不存在）——运行 ./scripts/install.sh"
  SEVERE=$((SEVERE+1))
fi
if ! echo ":$PATH:" | grep -q ":$HOME_DIR/.local/bin:"; then
  warn "~/.local/bin 不在 PATH 中（dsh-helm 命令需全路径或 export PATH）"
  WARN=$((WARN+1))
fi

# ---------- L2 身份 ----------
echo ""
echo "[dsh-helm] --- L2 身份 ---"
if [ -f "$NODE_CONFIG" ]; then
  MODE="$(stat -f '%Lp' "$NODE_CONFIG" 2>/dev/null || stat -c '%a' "$NODE_CONFIG" 2>/dev/null || echo '?')"
  if [ "$MODE" = "600" ]; then
    ok "node.json: $NODE_CONFIG (0600)"
  else
    fail "node.json 权限错误: $MODE（应为 0600，含节点 token）——执行: chmod 600 $NODE_CONFIG"
    SEVERE=$((SEVERE+1))
  fi
  # 基础字段检查（hub_url 可后补，不判错；node_id/token 必须有）
  if grep -q '"node_id"' "$NODE_CONFIG" && grep -q '"token"' "$NODE_CONFIG"; then
    ok "node.json 含 node_id 与 token"
  else
    warn "node.json 缺少 node_id 或 token 字段——重新运行: dsh-helm init"
    WARN=$((WARN+1))
  fi
else
  fail "node.json 不存在（$NODE_CONFIG）——运行: dsh-helm init"
  SEVERE=$((SEVERE+1))
fi

# ---------- L3 本机 daemon MCP 3457 ----------
echo ""
echo "[dsh-helm] --- L3 本地 daemon MCP (3457) ---"
# 可达性判定：任何 HTTP 响应（200/401/403...）都算服务活着；
# 401 是无 token 时 MCP 的正常认证拒绝，不是连接故障。
# curl 失败时 -w 输出 "000"，用 || true 兜底（不要 echo '000'，会得到 000000）
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$MCP_URL" 2>/dev/null || true)"
case "$HTTP_CODE" in
  000|"")
    warn "3457 不可达（连接失败）——本机 helm daemon 未运行？agent 的 datapath 会不可用"
    WARN=$((WARN+1))
    ;;
  401)
    ok "3457 可达（HTTP 401 = MCP 认证拒绝，服务在线；无 token 属正常）"
    ;;
  *)
    ok "3457 可达（HTTP $HTTP_CODE）"
    ;;
esac

# ---------- L4 控制面 hub 端口 ----------
echo ""
echo "[dsh-helm] --- L4 控制面 hub (3470/3471) ---"
port_open() {
  local port="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 127.0.0.1 "$port" 2>/dev/null
  else
    # bash 内置 /dev/tcp 兜底（无 nc 时）
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
  fi
}
if port_open "$HUB_MESH_PORT"; then
  ok "hub mesh (3470) 端口开放"
else
  warn "hub mesh (3470) 未开放——本机不是 hub？或 hub 未启动（dsh-helm hub）"
  WARN=$((WARN+1))
fi
if port_open "$HUB_MCP_PORT"; then
  ok "hub MCP (3471) 端口开放"
else
  warn "hub MCP (3471) 未开放——本机不是 hub？或 hub 未启动（dsh-helm hub）"
  WARN=$((WARN+1))
fi

# ---------- 汇总 ----------
echo ""
echo "[dsh-helm] ==== 自检汇总 ===="
if [ "$SEVERE" -gt 0 ]; then
  echo "[dsh-helm] 结果: 严重问题 $SEVERE 个，警告 $WARN 个 —— 需修复后重跑"
  exit 2
elif [ "$WARN" -gt 0 ]; then
  echo "[dsh-helm] 结果: 警告 $WARN 个 —— 可运行，建议处理"
  exit 1
else
  echo "[dsh-helm] 结果: 全部就绪 ✅"
  exit 0
fi