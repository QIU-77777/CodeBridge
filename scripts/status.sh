#!/bin/bash
# 一眼看清现在在跑什么：opencode serve、桥接、桌面 App、最近日志
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
. "$ROOT/scripts/lib/config-dir.sh"

CONFIG="$(ocb_config_dir "$ROOT")/config.json"
URL=$(node -e "try{console.log(require('$CONFIG').opencode.url||'http://127.0.0.1:19876')}catch{console.log('http://127.0.0.1:19876')}" 2>/dev/null)
PW=$(node -e "try{console.log(require('$CONFIG').opencode.password||'')}catch{console.log('')}" 2>/dev/null)

echo "=== opencode serve  $URL"
INFO=$(curl -s -m 3 -u "opencode:${PW}" "$URL/api/info" 2>/dev/null)
if [ -n "$INFO" ]; then
  echo "$INFO" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log('   ✅ 运行中  pid='+j.pid+'  v'+(j.version||'?'))}catch{console.log('   ⚠️  有响应但不是 JSON，检查密码')}})"
else
  echo "   ❌ 没有响应（没起，或端口/密码不对）"
fi

echo
echo "=== 桥接进程"
UID_NUM="$(id -u)"
LABEL_APP="$(ocb_label app)"
if [ -n "${OCB_INSTANCE:-}" ]; then echo "   实例: $OCB_INSTANCE  ($LABEL_APP)"; fi
if [ -f "$HOME/Library/LaunchAgents/$LABEL_APP.plist" ]; then
  if launchctl print "gui/$UID_NUM/$LABEL_APP" >/dev/null 2>&1; then
    # pid 必须问 launchd 要，不能 pgrep：多实例同机时 "node src/index.js" 有
    # 好几份，pgrep | head -1 会捡到别的实例的进程，把没起来的这个说成「运行
    # 中」。真实事故（2026-11-10）：默认实例的桥接正在重启循环里，状态却显示另
    # 一个实例的 pid 正常，排查因此被带偏
    PR=$(launchctl print "gui/$UID_NUM/$LABEL_APP" 2>/dev/null)
    BPID=$(printf '%s\n' "$PR" | awk '/^[[:space:]]*pid = [0-9]+/{print $3; exit}')
    if [ -n "$BPID" ]; then
      echo "   ✅ 运行中  pid=$BPID  已跑 $(ps -o etime= -p "$BPID" | tr -d ' ')  （launchd 托管）"
    else
      echo "   ⏳ launchd 已加载但进程不在（可能在重启循环，看 logs/bridge.log）"
      printf '%s\n' "$PR" | grep -E '^[[:space:]]*(state|last exit code) = ' | sed 's/^/      /'
    fi
  else
    echo "   ⏸️  launchd 里是暂停状态（启动：./scripts/up.sh）"
  fi
elif [ -f .bridge.pid ] && kill -0 "$(cat .bridge.pid)" 2>/dev/null; then
  BPID=$(cat .bridge.pid)
  echo "   ✅ 运行中  pid=$BPID  已跑 $(ps -o etime= -p "$BPID" | tr -d ' ')"
else
  echo "   ❌ 没在运行（启动：./scripts/up.sh）"
fi

echo
echo "=== 桌面版 App"
if pgrep -f "ai\.opencode\.desktop/cli/.*opencode-cli serve --service" >/dev/null 2>&1; then
  echo "   ✅ 开着（它自己那份 serve --service 在跑，和桥接互不影响）"
else
  echo "   — 没开（不影响桥接）"
fi

echo
echo "=== 日志"
for f in logs/serve.log logs/bridge.log; do
  if [ -f "$f" ]; then
    echo "   $f  $(wc -l < "$f" | tr -d ' ') 行"
  else
    echo "   $f  不存在"
  fi
done
echo "   bridge.log 最后 3 行："
tail -3 logs/bridge.log 2>/dev/null | sed 's/^/   │ /'

echo
echo "更多：npm run doctor（体检）  tail -f logs/bridge.log（实时日志）"
