#!/usr/bin/env bash
# install.sh — dsh-helm CLI 安装（macOS 优先；Linux/bash 4+ 亦可）
#
# 用途：
#   1. 解析 node 路径（which node），校验版本 >= 22.5
#   2. pnpm install + build（或复用已编译产物 packages/cli/lib/cli.js）
#   3. 写 ~/.local/bin/dsh-helm 可执行 wrapper（exec node lib/cli.js "$@"）
#   4. 检查 ~/.dsh/helm/node.json 是否存在，否则提示先运行 dsh-helm init
#   5. 输出安装摘要
#
# 用法：
#   ./scripts/install.sh                  # 标准安装（幂等，可重复运行）
#   [环境变量覆盖]
#     DSH_WRAPPER_DIR=~/.local/bin         # wrapper 安装目录（默认 ~/.local/bin）
#     DSH_SKIP_BUILD=1                     # 跳过 pnpm build（lib 已编译时）
#     DSH_PNPM_BIN=/path/to/pnpm          # 覆盖 pnpm 路径
#
# 退出码：
#   0  安装完成（全绿）
#   1  依赖/构建失败（node 缺失、node 版本过低、构建失败）
#   2  用法错误或不可执行条件（非 macOS 且无 node 时）
#
# 幂等：重复运行安全；已安装项跳过，wrapper 每次重新生成（内容不变）。
# 安全：只写 wrapper 与构建产物；不触碰生产端口（3080/3457/3458）与
#       已有 DSH 配置（~/.dsh/ 下仅读取 node.json，不修改）。

set -eu
# macOS bash 3.2 无 pipefail：有则启用，没有则静默跳过
set -o pipefail 2>/dev/null || true

# ---- 路径 ----
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"
WRAPPER_DIR="${DSH_WRAPPER_DIR:-$HOME_DIR/.local/bin}"
HELM_CONFIG_DIR="$HOME_DIR/.dsh/helm"
NODE_CONFIG="$HELM_CONFIG_DIR/node.json"
CLI_JS="$REPO_DIR/packages/cli/lib/cli.js"

# ---- 输出助手（统一 [dsh-helm] 前缀） ----
say()   { echo "  $*"; }
ok()    { echo "  ✓ $*"; }
warn()  { echo "  ⚠ $*"; }
die()   { echo "  ✗ $*"; exit 1; }

echo "[dsh-helm] ==== dsh-helm CLI 安装 ===="
echo "[dsh-helm] 仓库:   $REPO_DIR"
echo "[dsh-helm] wrapper: $WRAPPER_DIR/dsh-helm"
echo ""

# ---------- 1. node 检查 ----------
echo "[dsh-helm] --- 1/4 node 检查 ---"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  die "未找到 node（which node 为空）。请先安装 Node.js >= 22.5（推荐 nvm 或官方安装包），再重试"
fi
ok "node: $NODE_BIN ($("$NODE_BIN" --version))"

NODE_MAJOR="$("$NODE_BIN" -e 'console.log(process.versions.node.split(".")[0])')"
# 版本比较：按 "主.次" 数值比较（仅关注 22.5 门槛）
node_min_ok() {
  local major="$1"
  if [ "$major" -lt 22 ]; then return 1; fi
  if [ "$major" -gt 22 ]; then return 0; fi
  # major == 22：检查 minor >= 5
  local minor
  minor="$("$NODE_BIN" -e 'console.log(process.versions.node.split(".")[1])')"
  [ "$minor" -ge 5 ]
}
if ! node_min_ok "$NODE_MAJOR"; then
  warn "node 版本过低: $("$NODE_BIN" --version)（要求 >= 22.5，见根 package.json engines）。仍继续，但可能无法运行"
else
  ok "node 版本满足要求（engines: >=22.5）"
fi

# ---------- 2. 构建 ----------
echo ""
echo "[dsh-helm] --- 2/4 构建 ---"
if [ -f "$CLI_JS" ]; then
  ok "已编译产物存在: $CLI_JS（跳过构建）"
elif [ "${DSH_SKIP_BUILD:-0}" = "1" ]; then
  die "DSH_SKIP_BUILD=1 但 $CLI_JS 不存在。请先运行 pnpm install && pnpm build"
else
  PNPM_BIN="${DSH_PNPM_BIN:-$(command -v pnpm || true)}"
  if [ -z "$PNPM_BIN" ]; then
    die "未找到 pnpm，且 $CLI_JS 不存在。请先安装 pnpm（npm i -g pnpm）并运行: (cd $REPO_DIR && pnpm install && pnpm build)"
  fi
  ok "pnpm: $PNPM_BIN"
  if [ ! -d "$REPO_DIR/node_modules" ]; then
    say "首次安装依赖（pnpm install）……"
    (
      cd "$REPO_DIR"
      "$PNPM_BIN" install
    ) || die "pnpm install 失败"
  else
    ok "node_modules 已存在（跳过 pnpm install）"
  fi
  say "构建（pnpm build）……"
  (
    cd "$REPO_DIR"
    "$PNPM_BIN" build
  ) || die "pnpm build 失败"
  [ -f "$CLI_JS" ] || die "构建完成但 $CLI_JS 不存在，请检查 packages/cli"
  ok "构建完成: $CLI_JS"
fi

# ---------- 3. wrapper ----------
echo ""
echo "[dsh-helm] --- 3/4 wrapper 安装 ---"
mkdir -p "$WRAPPER_DIR"
WRAPPER_PATH="$WRAPPER_DIR/dsh-helm"
# 幂等：每次覆盖写相同内容的 wrapper（内容由下列变量决定，重跑结果一致）
cat > "$WRAPPER_PATH" <<WRAPEOF
#!/usr/bin/env bash
# dsh-helm wrapper（由 scripts/install.sh 生成，请勿手改；重跑 install.sh 可恢复）
exec "$NODE_BIN" "$CLI_JS" "\$@"
WRAPEOF
chmod +x "$WRAPPER_PATH"
ok "已写入 wrapper: $WRAPPER_PATH"

if ! echo ":$PATH:" | grep -q ":$WRAPPER_DIR:"; then
  warn "$WRAPPER_DIR 不在 PATH 中。可执行: export PATH=\"$WRAPPER_DIR:\$PATH\"（或写入 ~/.zshrc）"
fi

# ---------- 4. 配置与摘要 ----------
echo ""
echo "[dsh-helm] --- 4/4 配置检查 ---"
if [ -f "$NODE_CONFIG" ]; then
  MODE="$(stat -f '%Lp' "$NODE_CONFIG" 2>/dev/null || stat -c '%a' "$NODE_CONFIG" 2>/dev/null || echo '?')"
  ok "node.json 已存在: $NODE_CONFIG (权限 $MODE)"
  if [ "$MODE" != "600" ]; then
    warn "node.json 权限应为 0600（含 node token）。可执行: chmod 600 $NODE_CONFIG"
  fi
else
  warn "~/.dsh/helm/node.json 不存在——请先初始化节点身份:"
  say "    $WRAPPER_PATH init"
  say "    （生成 node_id + token，写入 $NODE_CONFIG，权限 0600）"
  say "    然后编辑 $NODE_CONFIG 设置 hub_url（wss://hub.example.com/）"
fi

echo ""
echo "[dsh-helm] ==== 安装摘要 ===="
echo "[dsh-helm]   wrapper:   $WRAPPER_PATH"
echo "[dsh-helm]   CLI 源码:  $CLI_JS"
echo "[dsh-helm]   node:      $NODE_BIN ($("$NODE_BIN" --version))"
echo "[dsh-helm]   配置:      $NODE_CONFIG"
echo "[dsh-helm] 下一步："
echo "[dsh-helm]   1. $WRAPPER_PATH init        （首次）生成节点身份"
echo "[dsh-helm]   2. 编辑 $NODE_CONFIG 设置 hub_url"
echo "[dsh-helm]   3. $WRAPPER_PATH agent       （前台运行节点代理；或 scripts/install-service.sh 装 launchd）"
echo "[dsh-helm]   4. ./scripts/verify.sh       （自检）"
echo "[dsh-helm] ==== 安装完成（幂等，可重复运行） ===="