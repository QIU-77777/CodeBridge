#!/bin/bash
# 一键启动 serve + 桥接（后台常驻，日志在 logs/）
set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs

CONFIG="${HOME}/.config/opencode-feishu-bridge/config.json"
[ -f "$CONFIG" ] || { echo "❌ 配置不存在: $CONFIG"; exit 1; }

read_cfg() {
  node -e "const c=JSON.parse(require('fs').readFileSync('$CONFIG','utf8'));const v=$1;console.log(v===undefined?'':v)" 2>/dev/null
}

PW=$(read_cfg "c.opencode.password")
URL=$(read_cfg "c.opencode.url")
PORT=$(echo "$URL" | sed -E 's|.*:([0-9]+).*|\1|')

echo "=== opencode ⇄ 飞书 桥接 启动 ==="

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
