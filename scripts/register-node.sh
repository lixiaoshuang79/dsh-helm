#!/usr/bin/env bash
# register-node.sh — 在 hub 机上注册/更新节点 token（多节点加入）
#
# 用途：
#   把一台新节点机的身份（node_id + token）注册进 hub 的 DSH_HELM_TOKEN，
#   使该节点可通过 mesh 认证握手加入控制面。适合第二台/更多台机器加入。
#
# 用法（在 hub 所在机器执行）：
#   ./scripts/register-node.sh <node_id> <token>
#     node_id  节点机的 node_id（该机 ~/.dsh/helm/node.json 的 node_id）
#     token    节点机的 token（同一文件的 token 字段）
#
# 行为：
#   1. 探测 hub 的 DSH_HELM_TOKEN 来源（优先 launchd plist EnvironmentVariables，
#      其次当前 shell 环境，最后提示手动配置）
#   2. 在现有 token 表上追加/更新 <node_id>=<token>（逗号分隔，幂等：已存在则替换）
#   3. 若是 launchd 服务（com.dsh-helm.hub* / 其他显式 label），重载该服务；
#      否则仅提示手动重启 hub 进程
#   4. 不触碰任何其他进程/端口（3080/3457/3458 等 live 组件一律不动）
#
# 退出码：
#   0  注册完成（launchd 已重载 / 已写入提示文件）
#   1  参数错误 / node_id 或 token 为空
#   2  hub 服务未找到且无法自动注入（仅提示）

set -eu
set -o pipefail 2>/dev/null || true

if [ $# -ne 2 ]; then
  echo "用法: $0 <node_id> <token>" >&2
  echo "  在 hub 所在机器执行；参数来自节点机 ~/.dsh/helm/node.json" >&2
  exit 1
fi

NODE_ID="$1"
TOKEN="$2"
if [ -z "$NODE_ID" ] || [ -z "$TOKEN" ]; then
  echo "错误: node_id 与 token 均不能为空" >&2
  exit 1
fi

# 校验 node_id 形状（UUID）
if ! echo "$NODE_ID" | grep -qE '^[0-9a-fA-F-]{8,64}$'; then
  echo "警告: node_id 不像 UUID（$NODE_ID），仍继续"
fi

HUB_LABEL=""
PLIST_PATH=""

# --- 1. 探测 hub 服务（launchd label 候选） -------------------------------
for cand in com.dsh-helm.hub com.dsh-helm.hub-server io.dsh-helm.hub; do
  if launchctl list 2>/dev/null | grep -q "$cand"; then
    HUB_LABEL="$cand"
    break
  fi
done

# 兜底：按 plist 文件名探测
if [ -z "$HUB_LABEL" ]; then
  for p in "$HOME/Library/LaunchAgents/com.dsh-helm.hub.plist" \
           "$HOME/Library/LaunchAgents/io.dsh-helm.hub.plist" \
           /Library/LaunchDaemons/com.dsh-helm.hub.plist; do
    if [ -f "$p" ]; then
      PLIST_PATH="$p"
      HUB_LABEL="$(basename "$p" .plist)"
      break
    fi
  done
fi

# --- 2. 读取现有 token 表 ------------------------------------------------
CURRENT=""
if [ -n "$PLIST_PATH" ]; then
  # plist EnvironmentVariables.DSH_HELM_TOKEN
  CURRENT=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:DSH_HELM_TOKEN" "$PLIST_PATH" 2>/dev/null || true)
fi
if [ -z "$CURRENT" ]; then
  CURRENT="${DSH_HELM_TOKEN:-}"
fi
if [ -z "$CURRENT" ] && [ -z "$HUB_LABEL" ]; then
  echo "未找到 hub 服务（launchd label/plist）且当前环境无 DSH_HELM_TOKEN。" >&2
  echo "请手动为 hub 进程配置环境变量后再重启：" >&2
  echo "  DSH_HELM_TOKEN=\"$NODE_ID=$TOKEN\"" >&2
  exit 2
fi

# --- 3. 追加/更新 <node_id>=<token>（幂等） ------------------------------
if [ -z "$CURRENT" ]; then
  NEW="$NODE_ID=$TOKEN"
else
  # 去掉旧条目（如果有），再追加
  REST=""
  IFS=',' read -ra ENTRIES <<< "$CURRENT"
  for e in "${ENTRIES[@]}"; do
    id="${e%%=*}"
    if [ "$id" != "$NODE_ID" ]; then
      REST="${REST:+$REST,}$e"
    fi
  done
  NEW="${REST:+$REST,}$NODE_ID=$TOKEN"
fi

echo "hub 服务: ${HUB_LABEL:-<无>}"
echo "token 表更新完成（node_id 前 8 位: ${NODE_ID:0:8}）"

# --- 4. 写入 + 重载 --------------------------------------------------------
if [ -n "$PLIST_PATH" ]; then
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:DSH_HELM_TOKEN '$NEW'" "$PLIST_PATH" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:DSH_HELM_TOKEN string '$NEW'" "$PLIST_PATH"
  echo "已写入 $PLIST_PATH"
  launchctl bootout "gui/$(id -u)/$HUB_LABEL" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  echo "已重载 launchd 服务 $HUB_LABEL"
elif [ -n "$HUB_LABEL" ]; then
  echo "已更新（launchd label: $HUB_LABEL）但 plist 路径未识别，请手动重启该服务："
  echo "  launchctl kickstart -k gui/$(id -u)/$HUB_LABEL"
else
  echo "当前 shell 的 DSH_HELM_TOKEN 已更新为："
  echo "  export DSH_HELM_TOKEN=\"$NEW\""
  echo "请用该环境变量重启 hub 进程（前台: dsh-helm hub）。"
fi

echo "完成。新节点（$NODE_ID）应能通过 mesh 认证握手加入。"
