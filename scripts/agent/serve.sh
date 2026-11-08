#!/bin/bash
# 由 launchd 托管的 opencode serve。
# launchd 盯着这个进程：退出了就再拉一次，所以这里是「前台运行」，不是 nohup。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NODE="${BRIDGE_NODE:-}"
if [ -z "$NODE" ]; then
  if [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node; else NODE="$(command -v node)"; fi
fi

. "$ROOT/scripts/lib/config-dir.sh"
CONFIG="$(ocb_config_dir "$ROOT")/config.json"
URL=$("$NODE" -e "try{console.log(require('$CONFIG').opencode.url)}catch{console.log('http://127.0.0.1:19876')}" 2>/dev/null || echo 'http://127.0.0.1:19876')
PW=$("$NODE" -e "try{console.log(require('$CONFIG').opencode.password||'')}catch{console.log('')}" 2>/dev/null || echo '')
PORT=$(printf '%s' "$URL" | sed -E 's#.*:([0-9]+).*#\1#')
[ -z "$PORT" ] && PORT=19876

# 密码的权威源是配置，且不能为空。为空时生成一个写回去——这条路补的是
# 「存量配置被清空」：新建实例时 admin/create.js 已经会生成，但配置之后被
# 直接改文件清掉 password 时没有人生成。真实故障：serve 带着旧密码跑，桥接
# 拿着空密码全程 401，现象是「毫无反应」而不是报错，最后靠 ps eww 从 serve
# 进程环境里把旧密码挖出来才对上。
#
# 只在为空时生成，绝不改动已有密码：那会悄无声息换掉一个正在工作的值。
# 写回失败不让 serve 起不来（本地回环服务，没密码也能跑），所以这里不能
# 让 set -e 把脚本带下去。写回与 admin 的 writeConfigAtomic 同规格：原子
# 写入、留 .bak、chmod 0600、尾换行；配置读失败时整个不写——坏 JSON 被
# 覆盖成只剩 password 的文件比不写更糟
if [ -z "$PW" ]; then
  GEN=$("$NODE" -e "console.log(require('crypto').randomBytes(24).toString('hex'))" 2>/dev/null || echo '')
  if [ -n "$GEN" ]; then
    if "$NODE" -e '
      const fs = require("fs")
      const p = process.argv[1], pw = process.argv[2]
      let cur
      try { cur = JSON.parse(fs.readFileSync(p, "utf8")) } catch { process.exit(1) }
      cur.opencode = cur.opencode || {}
      cur.opencode.password = pw
      if (fs.existsSync(p)) fs.copyFileSync(p, p + ".bak")
      const tmp = p + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n")
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, p)
    ' "$CONFIG" "$GEN" 2>/dev/null; then
      PW="$GEN"
      echo "[$(date '+%F %T')] serve 密码为空，已生成并写回配置（48 位十六进制）"
    else
      echo "[$(date '+%F %T')] serve 密码写回配置失败，本次以无密码运行"
    fi
  fi
fi

# 本实例的飞书身份：serve 里的代理用 CLI 发言时以本实例应用发出，不读机器级
# 配置里别的机器人应用（真实事故：Lil_P 的代理发出的问候以 Lil_O 的应用到达
# 群里）。没有配置凭证时什么都不注入，沿用机器级配置
. "$ROOT/scripts/lib/feishu-identity.sh"
ocb_export_feishu_identity "$(dirname "$CONFIG")" "$NODE"

# 本实例的 GitHub 身份：serve 里的代理推送、开 PR 时以本实例的 GitHub App
# （xxx[bot]）行事。没配（github.mode=off，默认）时什么都不注入
. "$ROOT/scripts/lib/github-identity.sh"
ocb_export_github_identity "$(dirname "$CONFIG")" "$NODE"

BIN=$("$NODE" scripts/which-opencode.mjs)
export OPENCODE_SERVER_PASSWORD="$PW"

echo "[$(date '+%F %T')] serve 启动：$BIN :$PORT"
echo "[$(date '+%F %T')] serve 飞书身份：${FEISHU_APP_ID:-（未配置，沿用机器级 CLI 配置）}"
echo "[$(date '+%F %T')] serve GitHub 身份：${GIT_AUTHOR_NAME:-（未配置，沿用机器级 gh 登录）}"
exec "$BIN" serve --port "$PORT" --hostname 127.0.0.1
