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

CONFIG="$HOME/.config/opencode-feishu-bridge/config.json"
URL=$("$NODE" -e "try{console.log(require('$CONFIG').opencode.url)}catch{console.log('http://127.0.0.1:19876')}" 2>/dev/null || echo 'http://127.0.0.1:19876')
PW=$("$NODE" -e "try{console.log(require('$CONFIG').opencode.password||'')}catch{console.log('')}" 2>/dev/null || echo '')
PORT=$(printf '%s' "$URL" | sed -E 's#.*:([0-9]+).*#\1#')
[ -z "$PORT" ] && PORT=19876

BIN=$("$NODE" scripts/which-opencode.mjs)
export OPENCODE_SERVER_PASSWORD="$PW"

echo "[$(date '+%F %T')] serve 启动：$BIN :$PORT"
exec "$BIN" serve --port "$PORT" --hostname 127.0.0.1
