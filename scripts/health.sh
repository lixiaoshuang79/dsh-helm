#!/usr/bin/env bash
# health.sh — dsh-helm 节点状态查看（hub supervisor_health 简化版）
#
# 用途：输出控制面节点状态表（node_id / name / status / channel / adapter /
#       datapath）。数据来源按优先级：
#       1. hub MCP（127.0.0.1:3471 /mcp，tools/call supervisor_health）
#          —— 最完整：含各层健康（channel/adapter/datapath）
#       2. 本地 store（~/.dsh/helm/store.sqlite3 的 nodes 表，需 sqlite3 CLI）
#          —— 退化视图：只有 node_id/name/status/last_seen（分层健康在 hub
#             内存态，不落库，显示 n/a）
#
# 用法：
#   ./scripts/health.sh               # 标准输出
#   ./scripts/health.sh --json        # MCP 原始 JSON（调试用）
#   ./scripts/health.sh --store       # 强制走本地 store（跳过 MCP）
#
# 退出码：
#   0  成功（MCP 或 store 至少一条路径拿到数据）
#   1  MCP 不可达、退化为 store 且成功（警告级）
#   2  两条路径都不可用（hub 不在本机？未启动？）
#
# 只读：仅 GET/POST 探测与查询，不修改任何服务、端口或数据。

set -eu
set -o pipefail 2>/dev/null || true

HOME_DIR="$HOME"
MCP_BASE="http://127.0.0.1:3471"
MCP_URL="$MCP_BASE/mcp"
STORE_FILE="$HOME_DIR/.dsh/helm/store.sqlite3"

JSON=0
FORCE_STORE=0
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    --store) FORCE_STORE=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -30; exit 0 ;;
    *) echo "[dsh-helm] ✗ 未知参数: $a（支持 --json / --store）" >&2; exit 1 ;;
  esac
done

say()  { echo "  $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ⚠ $*"; }
die()  { echo "  ✗ $*"; exit 2; }

echo "[dsh-helm] ==== dsh-helm 节点状态 ===="

# ---------- 1. hub MCP ----------
mcp_ok=0
if [ "$FORCE_STORE" = "0" ]; then
  # hub MCP 是 Streamable HTTP（同单机 daemon 形状）：initialize 拿 session-id
  if curl -sS --max-time 3 "$MCP_BASE/healthz" -o /dev/null 2>/dev/null; then
    mcp_ok=1
    TMP_HDR="$(mktemp)"
    trap 'rm -f "$TMP_HDR"' EXIT
    curl -sS --max-time 5 -D "$TMP_HDR" -X POST "$MCP_URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"dsh-helm-health","version":"0.1.0"}}}' \
      -o /dev/null 2>/dev/null || true
    SID="$(grep -i '^mcp-session-id:' "$TMP_HDR" 2>/dev/null | tr -d '\r' | awk '{print $2}' || true)"
    [ -z "$SID" ] && SID="health-$(date +%s)"
    HEALTH_BODY="$(curl -sS --max-time 5 -X POST "$MCP_URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json' \
      -H "Mcp-Session-Id: $SID" \
      -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"supervisor_health","arguments":{}}}' 2>/dev/null || true)"
    if printf '%s' "$HEALTH_BODY" | grep -q '"nodes"'; then
      if [ "$JSON" = "1" ]; then
        printf '%s\n' "$HEALTH_BODY"
        exit 0
      fi
      # 用 python3 解包 MCP 结果（content[0].text 是 JSON 字符串），无 python3 时退化为 grep
      if command -v python3 >/dev/null 2>&1; then
        if printf '%s' "$HEALTH_BODY" | python3 -c '
import json, sys
resp = json.load(sys.stdin)
try:
    text = resp["result"]["content"][0]["text"]
    obj = json.loads(text)
except Exception:
    sys.exit(1)
nodes = obj.get("nodes", [])
if not nodes:
    print("  （无注册节点）")
for n in nodes:
    nid = n.get("node_id", "?")
    name = n.get("display_name", "?")
    st = n.get("status", "?")
    ch = (n.get("channel") or {}).get("status", "?")
    ad = (n.get("adapter") or {}).get("status", "?")
    dp = (n.get("datapath") or {}).get("status", "?")
    print(f"  {nid}\t{name}\t{st}\t{ch}\t{ad}\t{dp}")
' 2>/dev/null; then
          mcp_ok=2
        else
          warn "python3 解析失败，尝试 grep 抽取"
          printf '%s' "$HEALTH_BODY" | tr ',' '\n' | grep -o '"node_id":"[^"]*"\|"display_name":"[^"]*"\|"status":"[^"]*"' | head -60
        fi
      else
        warn "hub MCP 返回了 nodes 但本机无 python3 无法格式化（建议 brew install python3）"
        printf '%s' "$HEALTH_BODY" | tr ',' '\n' | grep -o '"node_id":"[^"]*"\|"display_name":"[^"]*"\|"status":"[^"]*"' | head -60
      fi
    else
      warn "hub MCP 可达但 supervisor_health 调用异常：$(printf '%s' "$HEALTH_BODY" | head -c 200)"
    fi
  else
    warn "hub MCP 不可达（$MCP_BASE/healthz 无响应）——本机不是 hub？或 hub 未启动"
  fi
fi

# ---------- 2. 本地 store 退化 ----------
store_ok=0
if [ "$mcp_ok" != "2" ]; then
  echo ""
  if [ -f "$STORE_FILE" ] && command -v sqlite3 >/dev/null 2>&1; then
    echo "[dsh-helm] --- 退化：本地 store（$STORE_FILE）---"
    echo "[dsh-helm]  node_id / name / status / channel / adapter / datapath"
    echo "[dsh-helm]  （channel/adapter/datapath 分层健康在 hub 内存态，store 中为 n/a）"
    if sqlite3 -separator $'\t' "$STORE_FILE" \
      "SELECT node_id, display_name, status, 'n/a', 'n/a', 'n/a' FROM nodes ORDER BY node_id;" 2>/dev/null; then
      store_ok=1
    else
      warn "store 读取失败（$STORE_FILE）"
    fi
    echo ""
    echo "[dsh-helm]   提示：要完整分层健康，请在 hub 所在机运行本脚本（走 MCP）"
  else
    warn "本地 store 不可用（$STORE_FILE 不存在或未装 sqlite3 CLI）"
  fi
fi

# ---------- 汇总 ----------
echo ""
if [ "$mcp_ok" = "2" ]; then
  echo "[dsh-helm] 数据来源: hub MCP（完整分层健康）"
  exit 0
elif [ "$store_ok" = "1" ]; then
  echo "[dsh-helm] 数据来源: 本地 store（退化视图）"
  exit 1
else
  die "两条路径都不可用——hub 不在本机或未启动（dsh-helm hub），且本地无 store/sqlite3"
fi