#!/usr/bin/env bash
# uninstall.sh — dsh-helm 卸载（macOS 优先；Linux/bash 4+ 亦可）
#
# 用途：
#   1. 停止并移除 node agent 服务（launchctl bootout + 删除 plist）
#   2. 停止并移除 watchdog（若有运行实例）
#   3. 删除 ~/.local/bin/dsh-helm wrapper
#   4. 问询是否删除 ~/.dsh/helm 配置（node.json / store.sqlite3 / 日志，默认保留）
#
# 用法：
#   ./scripts/uninstall.sh           # 标准卸载（保留配置，交互式确认）
#   ./scripts/uninstall.sh --purge   # 非交互：连配置一起删（相当于全部回答 yes）
#
# 退出码：
#   0  卸载完成
#   1  出错（参数非法 / 关键步骤失败）
#
# 幂等：重复运行安全；不存在的项直接跳过。
# 安全：绝不触碰生产端口（3080/3457/3458）相关服务；只清理本套件自己装的东西。

set -eu
set -o pipefail 2>/dev/null || true

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"
WRAPPER_PATH="$HOME_DIR/.local/bin/dsh-helm"
HELM_CONFIG_DIR="$HOME_DIR/.dsh/helm"
LAUNCH_AGENTS="$HOME_DIR/Library/LaunchAgents"
SERVICE_LABEL="com.dsh-helm.node-agent"
WATCHDOG_LABEL="com.dsh-helm.watchdog"
PURGE=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20; exit 0 ;;
    *) echo "[dsh-helm] ✗ 未知参数: $a（支持 --purge）" >&2; exit 1 ;;
  esac
done

say()   { echo "  $*"; }
ok()    { echo "  ✓ $*"; }
warn()  { echo "  ⚠ $*"; }

echo "[dsh-helm] ==== dsh-helm 卸载 ===="
echo "[dsh-helm] 仓库:   $REPO_DIR"
echo "[dsh-helm] wrapper: $WRAPPER_PATH"
echo ""

# ---------- 1. 停止并移除 launchd 服务 ----------
echo "[dsh-helm] --- 1/4 launchd 服务 ---"
if launchctl list 2>/dev/null | grep -q "$SERVICE_LABEL"; then
  launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null \
    && ok "已停止并移除 $SERVICE_LABEL" \
    || warn "$SERVICE_LABEL bootout 失败（可能已停止）"
else
  ok "$SERVICE_LABEL 未在运行（无需处理）"
fi
if [ -f "$LAUNCH_AGENTS/$SERVICE_LABEL.plist" ]; then
  rm -f "$LAUNCH_AGENTS/$SERVICE_LABEL.plist" && ok "已删除 $LAUNCH_AGENTS/$SERVICE_LABEL.plist"
else
  ok "$LAUNCH_AGENTS/$SERVICE_LABEL.plist 不存在（无需处理）"
fi

# ---------- 2. 停止 watchdog ----------
echo ""
echo "[dsh-helm] --- 2/4 watchdog ---"
if [ -f "$HELM_CONFIG_DIR/logs/watchdog.pid" ]; then
  WPID="$(cat "$HELM_CONFIG_DIR/logs/watchdog.pid" 2>/dev/null || true)"
  if [ -n "$WPID" ] && kill -0 "$WPID" 2>/dev/null; then
    kill "$WPID" 2>/dev/null && ok "已停止 watchdog（pid $WPID）" || warn "watchdog 停止失败"
  else
    ok "watchdog 未在运行（pid 文件过期）"
  fi
  rm -f "$HELM_CONFIG_DIR/logs/watchdog.pid"
else
  ok "watchdog 未安装（无 pid 文件）"
fi
# 兜底：若 pid 文件丢失但进程仍在，锚定模式清理（绝不误杀别的进程）
pkill -f '[d]sh-helm-watchdog\.sh' 2>/dev/null && warn "已兜底清理残留 watchdog 进程" || ok "无残留 watchdog 进程"
if [ -f "$LAUNCH_AGENTS/$WATCHDOG_LABEL.plist" ]; then
  launchctl bootout "gui/$(id -u)/$WATCHDOG_LABEL" 2>/dev/null || true
  rm -f "$LAUNCH_AGENTS/$WATCHDOG_LABEL.plist" && ok "已删除 watchdog plist"
fi

# ---------- 3. 删除 wrapper ----------
echo ""
echo "[dsh-helm] --- 3/4 wrapper ---"
if [ -f "$WRAPPER_PATH" ]; then
  rm -f "$WRAPPER_PATH" && ok "已删除 $WRAPPER_PATH"
else
  ok "$WRAPPER_PATH 不存在（无需处理）"
fi

# ---------- 4. 配置（默认保留，问询） ----------
echo ""
echo "[dsh-helm] --- 4/4 配置 ---"
DELETE_CONFIG=0
if [ -d "$HELM_CONFIG_DIR" ]; then
  if [ "$PURGE" = "1" ]; then
    DELETE_CONFIG=1
  else
    printf "[dsh-helm]   是否删除配置目录 %s ？（node.json 含节点 token，删除后不可恢复）[y/N] " "$HELM_CONFIG_DIR"
    read -r ANSWER
    case "$ANSWER" in
      y|Y|yes|YES) DELETE_CONFIG=1 ;;
      *) DELETE_CONFIG=0 ;;
    esac
  fi
  if [ "$DELETE_CONFIG" = "1" ]; then
    rm -rf "$HELM_CONFIG_DIR" && ok "已删除 $HELM_CONFIG_DIR"
  else
    say "已保留 $HELM_CONFIG_DIR（如需彻底清除请加 --purge）"
  fi
else
  ok "$HELM_CONFIG_DIR 不存在（无需处理）"
fi

echo ""
echo "[dsh-helm] ==== 卸载完成 ===="
echo "[dsh-helm] 残留检查："
echo "[dsh-helm]   launchctl list | grep dsh-helm    （应无输出）"
echo "[dsh-helm]   ls ~/Library/LaunchAgents | grep dsh-helm （应无输出）"
echo "[dsh-helm]   command -v dsh-helm               （应无输出）"
echo "[dsh-helm] 如需恢复：重新运行 ./scripts/install.sh"