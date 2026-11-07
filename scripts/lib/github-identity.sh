#!/bin/bash
# 本实例的 GitHub 身份注入：让 opencode serve 里的代理推送、开 PR 时，以本实例的
# GitHub App（xxx[bot]）身份行事，而不是人手里那个 gh 登录。
#
# 与 scripts/lib/feishu-identity.sh 同一套语义、同一个调用点（起 serve 前）：
#   - feishu-identity.sh 管飞书发言身份；
#   - 本文件管 GitHub 操作身份。
#
# 导出的东西（src/github-identity.js 生成，四路分工见那里的注释）：
#   GH_TOKEN                        启动时取一个有效的 installation token
#   GIT_AUTHOR_* / GIT_COMMITTER_*  提交署名
#   GIT_CONFIG_COUNT/KEY_0/VALUE_0  git 每次操作现场调凭证助手换有效 token
#   PATH                            前置本实例的 gh 包装脚本（gh 每次调用现取 token）
#
# 用法（serve.sh 与 up.sh 都这么用）：
#   . "$ROOT/scripts/lib/github-identity.sh"
#   ocb_export_github_identity "$CONFIG_DIR" "$NODE_BIN"
#
# 配置里 github.mode=off（默认）时什么都不做：serve 沿用机器级 gh 登录，
# 现有部署零改动。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 读实例配置，导出本实例的 GitHub 身份环境变量；顺带写好 gh 包装脚本。
# 参数：$1 实例配置目录（含 config.json），$2 node 可执行文件路径。
ocb_export_github_identity() {
  local config_dir="$1" node_bin="$2"
  [ -d "$config_dir" ] || return 0
  local out
  out=$("$node_bin" "$ROOT/src/github-identity.js" --config-dir "$config_dir" 2>/dev/null || echo "")

  local line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    export "${line%%=*}=${line#*=}"
  done <<< "$out"
}
