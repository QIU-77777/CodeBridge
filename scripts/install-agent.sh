#!/bin/bash
# 把 serve 和桥接装成 launchd 用户级 agent：登录自启、挂了自动拉起、不依赖任何终端。
#
#   ./scripts/install-agent.sh      安装并立即启动
#   ./scripts/install-agent.sh -f   重装（覆盖已有 plist）
#
# 多机器人同机部署（每个机器人 = 一个飞书应用 + 一份配置 + 一个进程）：
#   ./scripts/install-agent.sh --instance pi --config-dir "$HOME/.config/opencode-feishu-bridge-pi"
#   OCB_INSTANCE=pi ./scripts/up.sh          # 之后重启/查看也带上同一个 OCB_INSTANCE
#
# 卸载：./scripts/uninstall-agent.sh（同样支持 OCB_INSTANCE）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/lib/config-dir.sh"
. "$ROOT/scripts/lib/launchd-path.sh"
cd "$ROOT"

while [ $# -gt 0 ]; do
  case "$1" in
    -f|--force) shift ;;
    --instance) OCB_INSTANCE="${2:-}"; shift 2 ;;
    --config-dir) OCB_CONFIG_DIR="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done
# status.sh / up.sh 由本脚本调用时要看到同一个实例名与配置目录
: "${OCB_INSTANCE:=}"
: "${OCB_CONFIG_DIR:=}"
export OCB_INSTANCE OCB_CONFIG_DIR

LABEL_SERVE="$(ocb_label serve)"
LABEL_APP="$(ocb_label app)"
CONFIG="$(ocb_config_dir "$ROOT")/config.json"
CONFIG_DIR_VAL="$(dirname "$CONFIG")"
PLIST_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

mkdir -p "$PLIST_DIR" logs
chmod +x scripts/agent/serve.sh scripts/agent/bridge.sh

NODE="${BRIDGE_NODE:-}"
if [ -z "$NODE" ]; then
  if [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node; else NODE="$(command -v node)"; fi
fi

# plist 的 PATH：系统目录加当前用户的常见 bin 目录。只写系统目录的话，
# launchd 拉起的桥接找不到用户自己装的 CLI（pi 装在 npm 全局 bin，实测踩过）
LAUNCHD_PATH="$(ocb_launchd_path)"

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
    <key>PATH</key><string>$LAUNCHD_PATH</string>
    <key>BRIDGE_NODE</key><string>$NODE</string>
    <key>OCB_CONFIG_DIR</key><string>$CONFIG_DIR_VAL</string>
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

BACKEND_TYPE=$("$NODE" -e "try{console.log((require('$CONFIG').backend||{}).type||'opencode')}catch{console.log('opencode')}" 2>/dev/null || echo opencode)

# 只有 opencode 实例需要 serve；pi / dsh 是一次性子进程，不需要常驻服务
NEED_SERVE=0
if [ "$BACKEND_TYPE" = "opencode" ]; then
  write_plist "$LABEL_SERVE" serve.sh serve.log
  echo "已写入 $PLIST_DIR/$LABEL_SERVE.plist"
  NEED_SERVE=1
else
  echo "后端 ${BACKEND_TYPE}：跳过 opencode serve（只有 opencode 实例需要）"
fi
write_plist "$LABEL_APP" bridge.sh bridge.log
echo "已写入 $PLIST_DIR/$LABEL_APP.plist"

# 起一个 label：先 bootout 再 bootstrap，最后 enable
boot_label() {
  local label="$1"
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$PLIST_DIR/$label.plist"
  launchctl enable "gui/$UID_NUM/$label" 2>/dev/null || true
}

# 启动顺序：先把 serve 拉起来并等它就绪，最后才 bootstrap 桥接。
# 反过来（先 app 后 serve）会让桥接第一次启动时连不上 serve：src/index.js 的
# 启动检查直接退出 1，launchd 要等 ThrottleInterval 10 秒才拉起第二次，这十几秒
# 里机器人不应答，日志里还留一行「❌ 连不上 opencode serve」。真实事故：
# 2026-11-10 把默认实例改名成 lil-o 后全新安装，桥接第一次启动即失败
if [ "$NEED_SERVE" = "1" ]; then
  boot_label "$LABEL_SERVE"
  # 就绪检查打本实例配置里的地址，不写死 19876：实例可以换端口
  SERVE_URL=$("$NODE" -e "try{console.log(require('$CONFIG').opencode.url||'http://127.0.0.1:19876')}catch{console.log('http://127.0.0.1:19876')}" 2>/dev/null || echo 'http://127.0.0.1:19876')
  for i in $(seq 1 30); do
    PW=$("$NODE" -e "try{console.log(require('$CONFIG').opencode.password||'')}catch{console.log('')}" 2>/dev/null || echo '')
    # 必须 200：端口上换成别的服务也会应答（404），那样不算 serve 就绪
    CODE=$(curl -s -m 2 -o /dev/null -w '%{http_code}' -u "opencode:$PW" "$SERVE_URL/api/info" 2>/dev/null || echo 000)
    if [ "$CODE" = "200" ]; then
      echo "✅ serve 已就绪"
      break
    fi
    [ "$i" = "30" ] && echo "⚠️  serve 30 秒未就绪，看 logs/serve.log"
    sleep 1
  done
fi
boot_label "$LABEL_APP"

sleep 4
echo
echo "现在两个进程由 launchd 托管：登录自动起、被杀自动起，关终端/退出 WorkBuddy 都不影响。"
./scripts/status.sh | head -12 || true   # 展示用，head 掐断管道的 SIGPIPE 不拖垮安装
