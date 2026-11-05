#!/bin/bash
# 把 serve 和桥接装成 launchd 用户级 agent：登录自启、挂了自动拉起、不依赖任何终端。
#
#   ./scripts/install-agent.sh      安装并立即启动
#   ./scripts/install-agent.sh -f   重装（覆盖已有 plist）
#
# 卸载：./scripts/uninstall-agent.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LABEL_SERVE="ai.qiguang.ocbridge.serve"
LABEL_APP="ai.qiguang.ocbridge.app"
PLIST_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

mkdir -p "$PLIST_DIR" logs
chmod +x scripts/agent/serve.sh scripts/agent/bridge.sh

NODE="${BRIDGE_NODE:-}"
if [ -z "$NODE" ]; then
  if [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node; else NODE="$(command -v node)"; fi
fi

write_plist() {
  local label="$1" script="$2" log="$3"
  cat > "$PLIST_DIR/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/agent/$script</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>BRIDGE_NODE</key><string>$NODE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$ROOT/logs/$log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/$log</string>
</dict>
</plist>
PLIST
}

# 先停掉手工 nohup 起的实例，否则桥接的单实例锁会让 agent 一直重启
for f in .bridge.pid .serve.pid; do
  if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then
    kill "$(cat "$f")" 2>/dev/null || true
    echo "已停止手工启动的进程 $(cat "$f")"
  fi
  rm -f "$f"
done

write_plist "$LABEL_SERVE" serve.sh serve.log
write_plist "$LABEL_APP" bridge.sh bridge.log
echo "已写入 $PLIST_DIR/$LABEL_SERVE.plist"
echo "已写入 $PLIST_DIR/$LABEL_APP.plist"

for label in "$LABEL_SERVE" "$LABEL_APP"; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$PLIST_DIR/$label.plist"
  launchctl enable "gui/$UID_NUM/$label" 2>/dev/null || true
done

# 等 serve 就绪，再让飞书长连接那边确认没问题
for i in $(seq 1 30); do
  PW=$("$NODE" -e "try{console.log(require('$HOME/.config/opencode-feishu-bridge/config.json').opencode.password||'')}catch{console.log('')}" 2>/dev/null || echo '')
  if curl -s -m 2 -u "opencode:$PW" http://127.0.0.1:19876/api/info >/dev/null 2>&1; then
    echo "✅ serve 已就绪"
    break
  fi
  [ "$i" = "30" ] && echo "⚠️  serve 30 秒未就绪，看 logs/serve.log"
  sleep 1
done

sleep 4
echo
echo "现在两个进程由 launchd 托管：登录自动起、被杀自动起，关终端/退出 WorkBuddy 都不影响。"
./scripts/status.sh | head -12
