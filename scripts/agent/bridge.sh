#!/bin/bash
# 由 launchd 托管的桥接进程。退出就被重新拉起，不依赖任何终端的生命周期。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NODE="${BRIDGE_NODE:-}"
if [ -z "$NODE" ]; then
  if [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node; else NODE="$(command -v node)"; fi
fi

CONFIG="$HOME/.config/opencode-feishu-bridge/config.json"
URL=$("$NODE" -e "try{console.log(require('$CONFIG').opencode.url)}catch{console.log('http://127.0.0.1:19876')}" 2>/dev/null || echo 'http://127.0.0.1:19876')

# 机器刚开机时 serve 可能还没起来，等一下再连，别让它退出（退出 launchd 也只会重试，白刷日志）
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$URL/api/info" 2>/dev/null || echo 000)
  [ "$code" != "000" ] && break
  [ "$i" = "60" ] && echo "[$(date '+%F %T')] 等了 60 秒 serve 还没起来，先连一次试试"
  sleep 1
done

echo "[$(date '+%F %T')] 桥接启动（node $("$NODE" -v)）"
exec "$NODE" src/index.js
