#!/usr/bin/env node
/**
 * 初始化本地配置。
 *
 * 为什么需要这个脚本：`.config/` 被 `.gitignore` 排除了 —— 那里有 appSecret，
 * 绝不能入库。所以 clone 下来 repo 里**没有**这个目录，新用户手里也没有可照抄的
 * 样板。模板放在仓库根目录的 `config.example.json`（不含任何真实密钥），由这个
 * 脚本复制到配置目录，再让人把两个占位符填掉。
 *
 * 用法：
 *   npm run init                      # 写到项目内 .config/opencode-feishu-bridge/
 *   npm run init -- --home            # 写到 ~/.config/opencode-feishu-bridge/
 *   npm run init -- --app-id=cli_xx --app-secret=yy   # 顺手把密钥填好
 *   npm run init -- --force           # 覆盖已存在的 config.json（会备份）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { TEMPLATE_PATH } from '../src/config.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = TEMPLATE_PATH

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}

const useHome = has('--home')
const force = has('--force')

const targetDir =
  process.env.OCB_CONFIG_DIR ||
  (useHome
    ? join(homedir(), '.config', 'opencode-feishu-bridge')
    : join(REPO, '.config', 'opencode-feishu-bridge'))
const target = join(targetDir, 'config.json')

const line = (s = '') => process.stdout.write(s + '\n')

if (!existsSync(TEMPLATE)) {
  line(`❌ 找不到模板: ${TEMPLATE}`)
  process.exit(1)
}

if (existsSync(target) && !force) {
  line(`✅ 配置已存在，没动它: ${target}`)
  line()
  line('   想重来一遍用 --force（会先备份成 config.json.bak）；')
  line('   只想改某个值直接编辑这个文件即可。')
  process.exit(0)
}

const cfg = JSON.parse(readFileSync(TEMPLATE, 'utf8'))

// 占位符照抄过来没意义，能定下来的先定下来
if (!cfg.opencode.defaultDirectory) cfg.opencode.defaultDirectory = homedir()
const appId = val('app-id')
const appSecret = val('app-secret')
if (appId) cfg.feishu.appId = appId
if (appSecret) cfg.feishu.appSecret = appSecret

mkdirSync(targetDir, { recursive: true })
if (existsSync(target)) {
  const bak = `${target}.bak`
  copyFileSync(target, bak)
  line(`已备份旧配置 → ${bak}`)
}
writeFileSync(target, JSON.stringify(cfg, null, 2), 'utf8')

const missingId = /^cli_x+$/i.test(cfg.feishu.appId) || !cfg.feishu.appId
const missingSecret = /^x+$/i.test(cfg.feishu.appSecret) || !cfg.feishu.appSecret

line(`✅ 已生成: ${target}`)
line()
if (missingId || missingSecret) {
  line('还差这些，去飞书开放平台「凭证与基础信息」抄过来：')
  if (missingId) line('   feishu.appId      还是 cli_xxxx 占位符')
  if (missingSecret) line('   feishu.appSecret  还是 xxxx 占位符')
  line()
}
line('接下来：')
line(`  1. 编辑配置   open "${target}"`)
line(`  2. 体检       npm run doctor`)
line(`  3. 启动       npm run up`)
line()
line('别忘了飞书后台这几项（漏了会静默不响应）：')
line('   · 事件订阅   im.message.receive_v1，用长连接接收')
line('   · 回调配置   card.action.trigger，用长连接接收')
line('   · 权限       im:message / im:message:send_as_bot / im:chat:readonly')
line('   · 白名单     把你自己 open_id 填进 feishu.allowlist')
line()
line(`配置目录优先级：$OCB_CONFIG_DIR > 项目内 ${join(REPO, '.config', 'opencode-feishu-bridge')} > ~/.config/opencode-feishu-bridge`)
if (!useHome && existsSync(join(homedir(), '.config', 'opencode-feishu-bridge', 'config.json'))) {
  line()
  line('⚠️  home 下还有一份旧配置。项目内这份优先，但建议把旧的挪走免得日后看错：')
  line(`   ${join(homedir(), '.config', 'opencode-feishu-bridge')}`)
}
