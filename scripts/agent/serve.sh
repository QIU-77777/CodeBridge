#!/bin/bash
# 由 launchd 托管的 opencode serve。
# launchd 盯着这个进程：退出了就再拉一次，所以这里是「前台运行」，不是 nohup。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NODE="${BRIDGE_NODE:-}"
if [ -z "$NODE" ]; then
  if [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node; else NODE="$(command -v node)"; fi
fi

. "$ROOT/scripts/lib/config-dir.sh"
CONFIG="$(ocb_config_dir "$ROOT")/config.json"
URL=$("$NODE" -e "try{console.log(require('$CONFIG').opencode.url)}catch{console.log('http://127.0.0.1:19876')}" 2>/dev/null || echo 'http://127.0.0.1:19876')
PW=$("$NODE" -e "try{console.log(require('$CONFIG').opencode.password||'')}catch{console.log('')}" 2>/dev/null || echo '')
PORT=$(printf '%s' "$URL" | sed -E 's#.*:([0-9]+).*#\1#')
[ -z "$PORT" ] && PORT=19876

# 本实例的飞书身份：serve 里的代理用 CLI 发言时以本实例应用发出，不读机器级
# 配置里别的机器人应用（真实事故：Lil_P 的代理发出的问候以 Lil_O 的应用到达
# 群里）。没有配置凭证时什么都不注入，沿用机器级配置
. "$ROOT/scripts/lib/feishu-identity.sh"
ocb_export_feishu_identity "$(dirname "$CONFIG")" "$NODE"

# 本实例的 GitHub 身份：serve 里的代理推送、开 PR 时以本实例的 GitHub App
# （xxx[bot]）行事。没配（github.mode=off，默认）时什么都不注入
. "$ROOT/scripts/lib/github-identity.sh"
ocb_export_github_identity "$(dirname "$CONFIG")" "$NODE"

BIN=$("$NODE" scripts/which-opencode.mjs)
export OPENCODE_SERVER_PASSWORD="$PW"

echo "[$(date '+%F %T')] serve 启动：$BIN :$PORT"
echo "[$(date '+%F %T')] serve 飞书身份：${FEISHU_APP_ID:-（未配置，沿用机器级 CLI 配置）}"
echo "[$(date '+%F %T')] serve GitHub 身份：${GIT_AUTHOR_NAME:-（未配置，沿用机器级 gh 登录）}"
exec "$BIN" serve --port "$PORT" --hostname 127.0.0.1
