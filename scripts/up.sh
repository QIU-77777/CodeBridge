#!/bin/bash
# 一键启动 serve + 桥接（后台常驻，日志在 logs/）
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
. "$ROOT/scripts/lib/config-dir.sh"
mkdir -p logs

# 装了 launchd agent 的话，别在这儿再起一份（桥接有单实例锁，起来会互相打架）。
# agent 自己会常驻、会自启，重启用 kickstart。
UID_NUM="$(id -u)"
LABEL_APP="$(ocb_label app)"
AGENT_LABELS="$(ocb_label serve) $LABEL_APP"
agent_installed() { [ -f "$HOME/Library/LaunchAgents/$1.plist" ]; }
agent_loaded() { launchctl print "gui/$UID_NUM/$1" >/dev/null 2>&1; }

if agent_installed "$LABEL_APP"; then
  for label in $AGENT_LABELS; do
    agent_installed "$label" || continue
    if agent_loaded "$label"; then
      launchctl kickstart -k "gui/$UID_NUM/$label" >/dev/null 2>&1
    else
      launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/$label.plist" >/dev/null 2>&1
    fi
  done
  echo "→ 这两个进程由 launchd 托管，已重启"
  sleep 6
  ./scripts/status.sh
  exit 0
fi

CONFIG="$(ocb_config_dir "$ROOT")/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "❌ 配置不存在: $CONFIG"
  echo
  echo "   .config/ 里有 appSecret，没入库，所以刚 clone 下来是空的。"
  echo "   跑一次初始化，它会把 config.example.json 复制过去："
  echo
  echo "     npm run init"
  echo
  echo "   然后填上 feishu.appId / feishu.appSecret，再回来 npm run up。"
  exit 1
fi

read_cfg() {
  node -e "const c=JSON.parse(require('fs').readFileSync('$CONFIG','utf8'));const v=$1;console.log(v===undefined?'':v)" 2>/dev/null
}

PW=$(read_cfg "c.opencode.password")
URL=$(read_cfg "c.opencode.url")
PORT=$(echo "$URL" | sed -E 's|.*:([0-9]+).*|\1|')

BACKEND_TYPE=$(node -e "try{console.log((require('$CONFIG').backend||{}).type||'opencode')}catch{console.log('opencode')}" 2>/dev/null || echo opencode)
echo "=== $BACKEND_TYPE ⇄ 飞书 桥接 启动 ==="

# pi / dsh 是一次性子进程，不需要 opencode serve，也不该要求本机装了 opencode
if [ "$BACKEND_TYPE" = "opencode" ]; then

# 0. 选 opencode 可执行文件：桌面版自带 CLI 优先（与桌面版同版本、同数据库）
IFS=$'\t' read -r OC_BIN OC_VER OC_SRC <<< "$(node scripts/which-opencode.mjs --tsv)" || true
if [ -z "${OC_BIN:-}" ]; then
  echo "❌ 找不到 opencode：桌面版 OpenCode.app 没装，PATH 里也没有 opencode"
  echo "   装了但想手动指定：OPENCODE_BIN=/path/to/opencode ./scripts/up.sh"
  exit 1
fi
echo "→ opencode: ${OC_SRC} v${OC_VER}"
echo "   ${OC_BIN}"

# 1. serve
RUN_VER=$(curl -s -m 2 -u "opencode:${PW}" "${URL}/api/info" 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).version||'')}catch{console.log('')}})" 2>/dev/null)

if [ -n "$RUN_VER" ]; then
  echo "✅ opencode serve 已在运行 (${URL}) v${RUN_VER}"
  # 两个版本共用一个数据库最容易出问题，这里显式拦一道
  if [ -n "$OC_VER" ] && [ "$RUN_VER" != "$OC_VER" ]; then
    echo "⚠️  正在跑的 serve 是 v${RUN_VER}，和 ${OC_SRC} v${OC_VER} 不一致。"
    echo "    两个版本写同一个数据库会出现 schema 漂移（旧版本读不出新记录）。"
    echo "    建议：./scripts/down.sh 之后再跑一次本脚本。"
  fi
else
  echo "→ 启动 opencode serve :${PORT}"
  OPENCODE_SERVER_PASSWORD="$PW" nohup "$OC_BIN" serve --port "$PORT" --hostname 127.0.0.1 \
    >> logs/serve.log 2>&1 &
  echo $! > .serve.pid
  for i in $(seq 1 30); do
    sleep 1
    if curl -s -o /dev/null -m 2 -u "opencode:${PW}" "${URL}/api/info"; then
      echo "✅ serve 就绪（${i}s）"
      break
    fi
    [ "$i" = "30" ] && { echo "❌ serve 30 秒未就绪，看 logs/serve.log"; exit 1; }
  done
fi
else
  echo "→ 后端 $BACKEND_TYPE：跳过 opencode serve"
fi

# 2. 桥接
if [ -f .bridge.pid ] && kill -0 "$(cat .bridge.pid)" 2>/dev/null; then
  echo "✅ 桥接已在运行 (pid $(cat .bridge.pid))"
else
  echo "→ 启动桥接"
  nohup node src/index.js >> logs/bridge.log 2>&1 &
  echo $! > .bridge.pid
  sleep 6
  if kill -0 "$(cat .bridge.pid)" 2>/dev/null; then
    echo "✅ 桥接已启动 (pid $(cat .bridge.pid))"
  else
    echo "❌ 桥接启动失败，最后 20 行日志："
    tail -20 logs/bridge.log
    exit 1
  fi
fi

echo
echo "日志: logs/serve.log  logs/bridge.log"
echo "停止: ./scripts/down.sh"
