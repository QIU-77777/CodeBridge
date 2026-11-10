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

# 给命令套超时。macOS 没有 timeout 命令，而 launchctl 对「程序路径错误」的
# label 会无限期卡住（kickstart 等一个永远起不来的进程，不返回）——不套超时
# 会把 up.sh 连同 admin 的 HTTP 请求一起挂死。真实事故：2026-11-10 两次跑
# start_label 都被空闲看门狗杀掉，原因就是 kickstart 挂住不放。
# 用法：run_with_timeout <秒> <命令...>
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  # 看门狗：到点杀掉主命令，然后自己也退，不留野进程
  (
    sleep "$secs"
    kill "$pid" 2>/dev/null
  ) &
  local killer=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$killer" 2>/dev/null
  wait "$killer" 2>/dev/null
  return "$rc"
}

# 起一个 launchd 服务，三条路依次试，最后一条不吞错误：
#   1. 已加载 → kickstart -k 重启它；kickstart 失败或超时就接着往下试
#   2. 没加载（或上一条失败）→ bootstrap
#   3. 还失败 → 等 2 秒再 bootstrap 一次，错误照实打出来
#
# 为什么不能只看 launchctl print 判「要不要 bootstrap」：down.sh 刚 bootout
# 的服务在 launchd 里还会停留一小会儿（进程已收到 SIGTERM、launchd 排定的清理
# 还没执行），这时 print 是成功的，于是走 kickstart——而 kickstart 对一个正在
# 拆除的服务必然失败，错误又被 >/dev/null 吞掉。现象是 up.sh 打印「已重启」、
# 状态却显示没起来，且不留任何线索。真实事故（2026-11-10）：重启默认实例时
# serve 的 label 再没被加载过，桥接进入「连不上 opencode serve」的重启循环。
start_label() {
  local label="$1"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  if agent_loaded "$label" && run_with_timeout 10 launchctl kickstart -k "gui/$UID_NUM/$label" 2>/dev/null; then
    return 0
  fi
  if run_with_timeout 10 launchctl bootstrap "gui/$UID_NUM" "$plist" 2>/dev/null; then
    return 0
  fi
  # bootout 的清理没做完时 bootstrap 会失败，等一会儿再来。这条既不套超时也
  # 不吞错误：它是最后一次尝试，失败必须把 launchctl 的原话亮出来
  sleep 2
  launchctl bootstrap "gui/$UID_NUM" "$plist"
}

if agent_installed "$LABEL_APP"; then
  FAILED=0
  for label in $AGENT_LABELS; do
    agent_installed "$label" || continue
    if ! start_label "$label"; then
      echo "❌ 起不来: $label"
      echo "   手工看: launchctl print gui/$UID_NUM/$label"
      FAILED=1
    fi
  done
  echo "→ 这两个进程由 launchd 托管，已重启"
  sleep 6
  ./scripts/status.sh
  [ "$FAILED" = 0 ] || exit 1
  exit 0
fi

CONFIG="$(ocb_config_dir "$ROOT")/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "❌ 配置不存在: $CONFIG"
  echo
  echo "   配置目录在仓库外（~/.config/opencode-feishu-bridge），里面有 appSecret，不能入库。"
  echo "   跑一次初始化，它会照 config.example.json 铺一份："
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
  # 本实例的飞书身份：serve 里的代理用 CLI 发言时以本实例应用发出，不读机器级
  # 配置里别的机器人应用。没有配置凭证时什么都不注入，沿用机器级配置
  . "$ROOT/scripts/lib/feishu-identity.sh"
  ocb_export_feishu_identity "$(dirname "$CONFIG")" node
  echo "   飞书身份：${FEISHU_APP_ID:-（未配置，沿用机器级 CLI 配置）}"
  # 本实例的 GitHub 身份：serve 里的代理推送、开 PR 时以本实例的 GitHub App
  # （xxx[bot]）行事。没配（github.mode=off，默认）时什么都不注入
  . "$ROOT/scripts/lib/github-identity.sh"
  ocb_export_github_identity "$(dirname "$CONFIG")" node
  echo "   GitHub 身份：${GIT_AUTHOR_NAME:-（未配置，沿用机器级 gh 登录）}"
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
  echo "→ 后端 ${BACKEND_TYPE}：跳过 opencode serve"
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
