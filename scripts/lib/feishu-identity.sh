#!/bin/bash
# 本实例的飞书身份注入：让 opencode serve 里的代理用 CLI 发言时，以本实例的
# 应用身份发出，而不是机器级配置里别的机器人应用。
#
# 与 src/pi.js 的 childEnv() 同一套语义——pi 后端在起子进程前注入，这里在起
# serve 前注入（opencode 的代理跑在常驻 serve 里，桥接没法向已启动的进程注入，
# 只能把注入点挪到 serve 的启动处）：
#   - feishu-cli 认 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_DOMAIN 环境变量，
#     凭证优先级是 --bot-app-id > 环境变量 > 配置文件，注入即盖过机器级配置；
#   - lark-cli 认 LARKSUITE_CLI_CONFIG_DIR，指向一份只含本实例应用的配置。
#
# 用法（serve.sh 与 up.sh 都这么用）：
#   . "$ROOT/scripts/lib/feishu-identity.sh"
#   ocb_export_feishu_identity "$CONFIG_DIR" "$NODE_BIN"
#
# 配置里没有飞书凭证时什么都不做：serve 沿用机器级配置，老部署零改动。
# 换绑机器人只改实例配置里的 appId/appSecret，重启 serve 即跟随——plist 不用
# 重新生成（身份是启动时现读的，不是安装时焊死的）。

# 读实例配置，导出本实例的飞书身份环境变量；顺带生成 lark-cli 实例配置。
# 参数：$1 实例配置目录（含 config.json），$2 node 可执行文件路径。
# node 负责读 JSON、写配置（转义与权限都在它手里），bash 只拿结果导出。
ocb_export_feishu_identity() {
  local config_dir="$1" node_bin="$2"
  [ -d "$config_dir" ] || return 0
  local out
  out=$("$node_bin" -e '
    const fs = require("node:fs")
    const path = require("node:path")
    const dir = process.argv[1]
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) } catch {}
    const f = cfg.feishu || {}
    const lines = []
    if (f.appId) lines.push("FEISHU_APP_ID=" + f.appId)
    if (f.appSecret) lines.push("FEISHU_APP_SECRET=" + f.appSecret)
    if (f.domain) lines.push("FEISHU_DOMAIN=" + f.domain)
    if (f.appId && f.appSecret) {
      const larkDir = path.join(dir, "lark-cli")
      const file = path.join(larkDir, "config.json")
      const want = JSON.stringify({ strictMode: "bot", apps: [{ appId: f.appId, appSecret: f.appSecret }] })
      try {
        if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== want) {
          fs.mkdirSync(larkDir, { recursive: true })
          fs.writeFileSync(file, want, { mode: 0o600 })
          fs.chmodSync(file, 0o600)
        }
        lines.push("LARKSUITE_CLI_CONFIG_DIR=" + larkDir)
      } catch (err) {
        console.error("生成 lark-cli 实例配置失败，子进程将沿用机器级配置: " + err.message)
      }
    }
    console.log(lines.join("\n"))
  ' "$config_dir" 2>/dev/null || echo "")

  local line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    export "${line%%=*}=${line#*=}"
  done <<< "$out"
}
