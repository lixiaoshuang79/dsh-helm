#!/usr/bin/env bash
# dsh-helm-watchdog.sh — dsh-helm node agent 轻量自愈（纯 shell）
#
# 架构决策：watchdog 只做进程级自愈（拉起挂掉的 node agent），datapath 探测
# 属于 TS 层健康（HealthAggregator 的 adapter/datapath 层），本脚本不越权。
#
# 职责：
#   每 15s：
#     1. 检查 node agent 进程（锚定 pgrep 'cli.js agent' / 'dsh-helm agent'）
#     2. 探测本地 daemon MCP（127.0.0.1:3457/healthz）
#   自愈（确定性顺序）：
#     - agent 挂 & daemon 活  → 拉起 agent（nohup 脱离会话）
#     - agent 挂 & daemon 也挂 → 不拉起（拉起也没用），记日志并提示人工处理
#     - 其余情况一律不动作；绝不 kill 任何正常服务
#
# 单实例：pid 文件（~/.dsh/helm/logs/watchdog.pid）+ 存活校验（kill -0），
#   防止双 watchdog 并发拉起双 agent。
#
# 用法：
#   ./scripts/dsh-helm-watchdog.sh           # 前台运行
#   ./scripts/dsh-helm-watchdog.sh --stop    # 停止正在运行的实例
#   作为 launchd/手动后台：nohup ./scripts/dsh-helm-watchdog.sh >> log 2>&1 &
#
# 退出码：0 正常退出（--stop / SIGTERM）；1 锁冲突；2 前置检查失败
# 日志：~/.dsh/helm/logs/watchdog.log

set -eu
set -o pipefail 2>/dev/null || true

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"
HELM_CONFIG_DIR="$HOME_DIR/.dsh/helm"
LOG_DIR="$HELM_CONFIG_DIR/logs"
LOG_FILE="$LOG_DIR/watchdog.log"
PID_FILE="$LOG_DIR/watchdog.pid"
NODE_CONFIG="$HELM_CONFIG_DIR/node.json"
NODE_BIN="$(command -v node || true)"
CLI_JS="$REPO_DIR/packages/cli/lib/cli.js"
DAEMON_URL="http://127.0.0.1:3457/healthz"
CHECK_INTERVAL=15

log() { printf '%s [dsh-helm-watchdog] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"; }

# ---------- 参数 ----------
STOP=0
for a in "$@"; do
  case "$a" in
    --stop) STOP=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -25; exit 0 ;;
    *) echo "[dsh-helm] ✗ 未知参数: $a（支持 --stop）" >&2; exit 1 ;;
  esac
done

mkdir -p "$LOG_DIR"

# ---------- --stop 分支 ----------
if [ "$STOP" = "1" ]; then
  if [ -f "$PID_FILE" ]; then
    WPID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$WPID" ] && kill -0 "$WPID" 2>/dev/null; then
      kill "$WPID" 2>/dev/null && echo "[dsh-helm] ✓ 已发送停止信号给 watchdog（pid $WPID）"
    else
      echo "[dsh-helm] watchdog 未在运行（pid 文件过期）"
    fi
    rm -f "$PID_FILE"
  else
    echo "[dsh-helm] watchdog 未在运行（无 pid 文件）"
  fi
  exit 0
fi

# ---------- 前置检查 ----------
[ -n "$NODE_BIN" ] || { echo "[dsh-helm] ✗ 未找到 node" >&2; exit 2; }
[ -f "$CLI_JS" ]   || { echo "[dsh-helm] ✗ CLI 未构建: $CLI_JS（先运行 ./scripts/install.sh）" >&2; exit 2; }
[ -f "$NODE_CONFIG" ] || { echo "[dsh-helm] ✗ node.json 不存在（先运行: dsh-helm init）" >&2; exit 2; }

# ---------- 单实例锁（pid 文件 + 存活校验） ----------
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[dsh-helm] ✗ 已有 watchdog 在运行（pid $OLD_PID）。如需重启: $0 --stop" >&2
    exit 1
  fi
  log "检测到过期 pid 文件（$OLD_PID），接管"
fi
echo "$$" > "$PID_FILE"
# 清理钩子：正常退出/被杀都删锁
cleanup() {
  if [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$PID_FILE"
  fi
  log "watchdog 退出"
  exit 0
}
trap cleanup EXIT INT TERM

# ---------- 探测函数 ----------
# 本地 daemon MCP 是否可达（200/401 均算可达；只有连接失败才算挂）
daemon_alive() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$DAEMON_URL" 2>/dev/null || echo '000')"
  [ "$code" != "000" ]
}

# node agent 是否在跑（锚定 pgrep，防误匹配其他进程）
agent_alive() {
  pgrep -f "cli\.js agent" >/dev/null 2>&1 || pgrep -f "[d]sh-helm agent" >/dev/null 2>&1
}

# 拉起 agent（nohup 脱离会话，直接 node 启动，cmdline 固定为 "node cli.js agent"，
# 与 launchd plist 的 ProgramArguments 一致，锚定 pgrep 可识别；绝不在前台阻塞）
start_agent() {
  nohup "$NODE_BIN" "$CLI_JS" agent >> "$LOG_DIR/agent.log" 2>&1 &
  log "已拉起 agent（pid $!）"
}

log "watchdog 启动（interval=${CHECK_INTERVAL}s，pid $$）"

# ---------- 主循环 ----------
while true; do
  if agent_alive; then
    :
  else
    if daemon_alive; then
      log "agent 未运行且 daemon(3457) 正常 → 拉起 agent"
      start_agent
    else
      log "⚠ agent 未运行且 daemon(3457) 也不可达 → 不拉起，需人工处理"
      log "   检查: DSH web 是否运行（3080）、helm daemon 是否正常（3457）、node.json hub_url 是否配置"
      log "   daemon 恢复后本 watchdog 会自动拉起 agent，无需手动干预"
    fi
  fi
  sleep "$CHECK_INTERVAL"
done