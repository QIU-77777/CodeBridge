#!/bin/bash
# 由 launchd 托管的桥接进程。退出就被重新拉起，不依赖任何终端的生命周期。
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

# 机器刚开机时 serve 可能还没起来，等一下再连，别让它退出（退出 launchd 也只会重试，白刷日志）。
# pi / dsh 是一次性子进程，压根不需要 serve，别在这儿白等 60 秒。
BACKEND_TYPE=$("$NODE" -e "try{console.log((require('$CONFIG').backend||{}).type||'opencode')}catch{console.log('opencode')}" 2>/dev/null || echo opencode)
if [ "$BACKEND_TYPE" = "opencode" ]; then
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$URL/api/info" 2>/dev/null || echo 000)
    [ "$code" != "000" ] && break
    [ "$i" = "60" ] && echo "[$(date '+%F %T')] 等了 60 秒 serve 还没起来，先连一次试试"
    sleep 1
  done
else
  echo "[$(date '+%F %T')] 后端 $BACKEND_TYPE：不需要 opencode serve"
fi

echo "[$(date '+%F %T')] 桥接启动（node $("$NODE" -v)）"
exec "$NODE" src/index.js
