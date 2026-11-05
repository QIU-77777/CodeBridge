#!/bin/bash
# 停止桥接与 serve
cd "$(dirname "$0")/.." || exit 1

# 由 launchd 托管的话，bootout 它就是「停止」；下次 ./scripts/up.sh 会再 bootstrap
UID_NUM="$(id -u)"
if [ -f "$HOME/Library/LaunchAgents/ai.qiguang.ocbridge.app.plist" ]; then
  for label in ai.qiguang.ocbridge.app ai.qiguang.ocbridge.serve; do
    launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null && echo "已暂停 launchd $label" || echo "$label 未在运行"
  done
  rm -f .bridge.pid .serve.pid
  echo "想重新启动：./scripts/up.sh"
  exit 0
fi

for name in bridge serve; do
  f=".${name}.pid"
  if [ -f "$f" ]; then
    pid=$(cat "$f")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      echo "已停止 ${name} (pid $pid)"
    else
      echo "${name} 未在运行"
    fi
    rm -f "$f"
  else
    echo "${name} 没有 pid 文件"
  fi
done

# 兜底：按命令行特征清理
# 注意：桌面版自带的是 opencode-cli，PATH 里的是 opencode，两个都要覆盖
pkill -f "node src/index.js" 2>/dev/null && echo "已清理残留桥接进程"
pkill -f "(opencode|opencode-cli) serve --port" 2>/dev/null && echo "已清理残留 serve 进程"
exit 0
