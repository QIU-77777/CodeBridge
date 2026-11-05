#!/bin/bash
# 卸载 launchd agent，并停掉进程。之后要再跑就用 ./scripts/up.sh（nohup 方式）。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UID_NUM="$(id -u)"
for label in ai.qiguang.ocbridge.serve ai.qiguang.ocbridge.app; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null && echo "已卸载 $label" || echo "$label 未在运行"
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done

# 清掉可能残留的进程
pkill -f "node src/index.js" 2>/dev/null && echo "已清理桥接进程"
pkill -f "(opencode|opencode-cli) serve --port" 2>/dev/null && echo "已清理 serve 进程"
rm -f .bridge.pid .serve.pid
echo "完成。重新启动：./scripts/up.sh"
