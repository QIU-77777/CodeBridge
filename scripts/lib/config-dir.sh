#!/bin/bash
# 配置目录解析。规则必须和 src/config.js 的 resolveConfigDir() 保持一致：
#   1. $OCB_CONFIG_DIR
#   2. <repo>/.config/opencode-feishu-bridge  （存在 config.json 就用它）
#   3. ~/.config/opencode-feishu-bridge
#
# 用法：
#   . "$ROOT/scripts/lib/config-dir.sh"
#   CONFIG="$(ocb_config_dir "$ROOT")/config.json"

ocb_config_dir() {
  local root="${1:-}"
  if [ -n "${OCB_CONFIG_DIR:-}" ]; then
    printf '%s\n' "$OCB_CONFIG_DIR"
    return 0
  fi
  if [ -n "$root" ] && [ -f "$root/.config/opencode-feishu-bridge/config.json" ]; then
    printf '%s\n' "$root/.config/opencode-feishu-bridge"
    return 0
  fi
  printf '%s\n' "$HOME/.config/opencode-feishu-bridge"
}

# launchd 服务名。多个机器人同机部署时，第二个实例如果不换 label，
# install-agent.sh 的 bootout 会把第一个实例一起停掉。
# 用法: ocb_label serve   →  ai.qiguang.ocbridge[.<实例>].serve
ocb_label() {
  local part="$1"
  if [ -n "${OCB_INSTANCE:-}" ]; then
    printf 'ai.qiguang.ocbridge.%s.%s' "$OCB_INSTANCE" "$part"
  else
    printf 'ai.qiguang.ocbridge.%s' "$part"
  fi
}
