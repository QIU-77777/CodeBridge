#!/bin/bash
# 停止桥接与 serve
cd "$(dirname "$0")/.." || exit 1

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
pkill -f "node src/index.js" 2>/dev/null && echo "已清理残留桥接进程"
pkill -f "opencode serve --port" 2>/dev/null && echo "已清理残留 serve 进程"
exit 0
