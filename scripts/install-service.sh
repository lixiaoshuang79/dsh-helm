#!/usr/bin/env bash
# install-service.sh — 安装 node agent 为 launchd 服务（macOS）
#
# 用途：
#   生成 ~/Library/LaunchAgents/com.dsh-helm.node-agent.plist（模板思路与
#   packages/platform 的 launchdPlist 一致：ProgramArguments = [node, cli.js,
#   agent]，RunAtLoad + KeepAlive，日志到 ~/.dsh/helm/logs/），随后
#   launchctl bootstrap 并验证。
#
# 用法：
#   ./scripts/install-service.sh            # 安装/重装（幂等）
#   ./scripts/install-service.sh --stop     # 停止并卸载服务（bootout + 删 plist）
#   [环境变量覆盖]
#     DSH_NODE_BIN=/path/to/node             # 覆盖 node 路径（默认 which node）
#
# 退出码：
#   0  成功
#   1  前置检查失败（非 macOS / node 缺失 / node.json 缺失）
#   2  launchd bootstrap 失败
#
# 幂等：重复运行先 bootout 再 bootstrap；已运行则跳过 bootstrap。
# 只管理自己的 LaunchAgent，不触碰生产端口（3080/3457/3458）。

set -eu
set -o pipefail 2>/dev/null || true

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"
LAUNCH_AGENTS="$HOME_DIR/Library/LaunchAgents"
LABEL="com.dsh-helm.node-agent"
PLIST_PATH="$LAUNCH_AGENTS/$LABEL.plist"
HELM_CONFIG_DIR="$HOME_DIR/.dsh/helm"
LOG_DIR="$HELM_CONFIG_DIR/logs"
NODE_CONFIG="$HELM_CONFIG_DIR/node.json"
NODE_BIN="${DSH_NODE_BIN:-$(command -v node || true)}"
CLI_JS="$REPO_DIR/packages/cli/lib/cli.js"

STOP=0
for a in "$@"; do
  case "$a" in
    --stop) STOP=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -25; exit 0 ;;
    *) echo "[dsh-helm] ✗ 未知参数: $a（支持 --stop）" >&2; exit 1 ;;
  esac
done

say()  { echo "  $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ⚠ $*"; }
die()  { echo "  ✗ $*"; exit 1; }

echo "[dsh-helm] ==== node agent 服务安装 ===="

# ---------- --stop 分支 ----------
if [ "$STOP" = "1" ]; then
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null \
      && ok "已停止 $LABEL" || warn "$LABEL bootout 失败"
  else
    ok "$LABEL 未在运行"
  fi
  if [ -f "$PLIST_PATH" ]; then
    rm -f "$PLIST_PATH" && ok "已删除 $PLIST_PATH"
  else
    ok "$PLIST_PATH 不存在"
  fi
  echo "[dsh-helm] ==== 完成 ===="
  exit 0
fi

# ---------- 1. 前置检查 ----------
echo "[dsh-helm] --- 1/4 前置检查 ---"
if [ "$(uname -s)" != "Darwin" ]; then
  die "launchd 仅 macOS。Linux 请用 packages/platform 的 systemd 模板（systemdUnit），Windows 用 windowsTaskXml"
fi
[ -n "$NODE_BIN" ] || die "未找到 node（which node 为空）"
[ -x "$NODE_BIN" ] || die "node 不可执行: $NODE_BIN"
ok "node: $NODE_BIN ($("$NODE_BIN" --version))"
[ -f "$CLI_JS" ] || die "CLI 未构建: $CLI_JS（先运行 ./scripts/install.sh）"
ok "CLI: $CLI_JS"

if [ -f "$NODE_CONFIG" ]; then
  ok "node.json 存在"
  if grep -q '"hub_url": *""' "$NODE_CONFIG" || ! grep -q '"hub_url"' "$NODE_CONFIG"; then
    warn "node.json 未设置 hub_url——agent 启动后无法连接 hub。请编辑 $NODE_CONFIG"
  fi
else
  die "node.json 不存在（$NODE_CONFIG）——先运行: dsh-helm init"
fi

# ---------- 2. 生成 plist ----------
echo ""
echo "[dsh-helm] --- 2/4 生成 plist ---"
mkdir -p "$LOG_DIR"
cat > "$PLIST_PATH" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CLI_JS}</string>
    <string>agent</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/agent.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/agent.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME_DIR}</string>
  </dict>
</dict>
</plist>
PLISTEOF
# plist 语法校验（macOS 自带 plutil）
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$PLIST_PATH" >/dev/null 2>&1 && ok "plist 语法正确" || die "plist 语法错误: $PLIST_PATH"
else
  ok "plist 已写入（无 plutil，跳过 lint）"
fi

# ---------- 3. bootstrap ----------
echo ""
echo "[dsh-helm] --- 3/4 launchctl bootstrap ---"
# 幂等：先 bootout 旧 job（若存在），再 bootstrap
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
  ok "已 bootstrap $LABEL"
else
  # bootstrap 失败可能是已加载
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    ok "$LABEL 已在运行（无需重复 bootstrap）"
  else
    die "bootstrap 失败。手动重试: launchctl bootstrap gui/$(id -u) $PLIST_PATH"
  fi
fi

# ---------- 4. 验证 ----------
echo ""
echo "[dsh-helm] --- 4/4 验证 ---"
sleep 2
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  ok "launchd 已加载: $LABEL"
else
  warn "launchctl print 未找到 $LABEL（可能启动即退出，看 $LOG_DIR/agent.err.log）"
fi
if pgrep -f "cli\.js agent" >/dev/null 2>&1; then
  ok "agent 进程运行中（pgrep 'cli.js agent'）"
else
  warn "未检测到 agent 进程——检查 $LOG_DIR/agent.err.log（常见原因：hub_url 未配置）"
fi

echo ""
echo "[dsh-helm] ==== 完成 ===="
echo "[dsh-helm]   plist:  $PLIST_PATH"
echo "[dsh-helm]   日志:   $LOG_DIR/agent.log / agent.err.log"
echo "[dsh-helm]   管理:   launchctl kickstart -k gui/$(id -u)/$LABEL （重启）"
echo "[dsh-helm]           脚本 --stop 卸载；./scripts/uninstall.sh 一并清理"