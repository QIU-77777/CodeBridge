#!/usr/bin/env node
/**
 * 初始化本地配置。
 *
 * 为什么需要这个脚本：`.config/` 被 `.gitignore` 排除了 —— 那里有 appSecret，
 * 绝不能入库。所以 clone 下来 repo 里**没有**这个目录，新用户手里也没有可照抄的
 * 样板。模板放在仓库根目录的 `config.example.json`（不含任何真实密钥）。
 *
 * 用法：
 *   npm run init                                  # 交互式向导（终端里默认走这条）
 *   npm run init -- --app-id=cli_xx --app-secret=yy
 *   npm run init -- --no-input                    # CI 里只铺模板，不问问题
 *   npm run init -- --home                        # 写到 ~/.config/opencode-feishu-bridge/
 *   npm run init -- --force                       # 覆盖已存在的（会备份）
 *   npm run init -- --add-allow=ou_xxx            # 往已存在的配置里追加白名单
 *
 * 向导做三件手工做起来很烦的事：
 *   1. 输完凭证立刻打飞书接口验证，填错当场知道，不用等第一次发消息
 *   2. 顺手把 `feishu.botOpenId` 填好 —— 多机器人同群靠它分辨「@ 的是不是我」
 *   3. 把你的 open_id 写进白名单，省掉「先跑起来看日志再回来改」那一圈
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import * as Lark from '@larksuiteoapi/node-sdk'
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
const noInput = has('--no-input')

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

// ---------- 往已有配置里追加白名单 ----------
// 这一步刻意做成独立分支：拿到 open_id 的时刻，配置往往已经存在了，
// 为了加一个 id 重跑一遍向导（还得备份、还得重新输密钥）太蠢。
{
  const add = val('add-allow')
  if (add) {
    if (!existsSync(target)) {
      line(`❌ 配置还不存在: ${target}（先跑一次 npm run init）`)
      process.exit(1)
    }
    const cfg = JSON.parse(readFileSync(target, 'utf8'))
    const list = cfg.feishu.allowlist || (cfg.feishu.allowlist = [])
    if (list.includes(add)) {
      line(`✅ 已经在白名单里了: ${add}`)
      process.exit(0)
    }
    list.push(add)
    writeFileSync(target, JSON.stringify(cfg, null, 2), 'utf8')
    line(`✅ 已加入白名单: ${add}（现在共 ${list.length} 个）`)
    line(`   ${target}`)
    process.exit(0)
  }
}

if (existsSync(target) && !force) {
  line(`✅ 配置已存在，没动它: ${target}`)
  line()
  line('   只想改某个值，直接编辑那个文件；')
  line('   想加白名单   npm run init -- --add-allow=ou_xxx')
  line('   想重来一遍   npm run init -- --force（会先备份成 config.json.bak）')
  process.exit(0)
}

const cfg = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
if (!cfg.opencode.defaultDirectory) cfg.opencode.defaultDirectory = homedir()

let appId = val('app-id')
let appSecret = val('app-secret')

const isTTY = Boolean(process.stdin.isTTY)
const wizard = !noInput && (has('--wizard') || (isTTY && !appId && !appSecret))

/** 安静地打飞书接口：SDK 失败时会把整个 axios error 倒到 console，这里只要结论 */
async function verifyCreds(id, secret) {
  const mute = ['log', 'error', 'warn', 'info', 'debug']
  const saved = {}
  for (const k of mute) {
    saved[k] = console[k]
    console[k] = () => {}
  }
  try {
    const client = new Lark.Client({
      appId: id,
      appSecret: secret,
      domain: cfg.feishu.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.fatal,
    })
    const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
    const bot = res?.bot || res?.data?.bot || {}
    if (!bot.app_name && !bot.open_id) return { ok: false, reason: '接口通了但没返回机器人信息' }
    return { ok: true, name: bot.app_name || '(未命名应用)', openId: bot.open_id || '' }
  } catch (err) {
    const msg = err?.response?.data?.msg || err?.message || String(err)
    const rawCode = err?.response?.data?.code ?? (String(msg).match(/code[:=]\s*(\d+)/) || [])[1]
    const code = Number(rawCode) || 0
    // 10003 是「参数无效」，这一步最常见的两种原因：App ID 格式不对 / 把 Secret 粘进了 ID
    const hint =
      code === 10003 || code === 10014 || /invalid param|app secret/i.test(msg)
        ? 'App ID 应该 cli_ 开头、约 20 位；App Secret 是另一串长字符串。两个别贴反。'
        : /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed/i.test(msg)
          ? '连不上飞书，检查网络或代理。'
          : ''
    return { ok: false, reason: `${msg}${code ? ` (code=${code})` : ''}`, hint }
  } finally {
    for (const k of mute) console[k] = saved[k]
  }
}

let botInfo = null

/**
 * 两种提问方式。
 *
 * 终端里用 readline 一行一问；管道输入（脚本、测试、CI）不能用 readline ——
 * 管道里的所有行会在同一个 tick 内全部到齐，而 readline 的 question 是逐个注册的，
 * 后面几行还没等到监听者就被丢掉了，表现为第二个问题永远悬着。
 * 所以非 TTY 改成先把 stdin 读完，再按行顺序取。
 */
function makeAsker() {
  if (isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return {
      ask: (q, { def = '', secret = false } = {}) =>
        new Promise((res) => {
          if (secret) rl._writeToOutput = () => {}
          const suffix = def ? `（回车用 ${def}）` : ''
          rl.question(`${q}${suffix}: `, (a) => {
            if (secret) {
              delete rl._writeToOutput
              process.stdout.write('\n')
            }
            res((a || '').trim() || def)
          })
        }),
      close: () => rl.close(),
    }
  }
  const buf = readFileSync(0, 'utf8').split('\n')
  let i = 0
  return {
    ask: async (q, { def = '', secret = false } = {}) => {
      const raw = (buf[i++] ?? '').trim()
      process.stdout.write(`${q}: ${raw ? (secret ? '****' : raw) : '(空)'}\n`)
      return raw || def
    },
    close: () => {},
  }
}

if (wizard) {
  const { ask, close } = makeAsker()

  line()
  line('=== 初始化向导 ===')
  line('凭证在飞书开放平台 → 你的应用 → 「凭证与基础信息」。')
  line()

  if (!appId) appId = await ask('App ID')
  if (!appSecret) appSecret = await ask('App Secret', { secret: true })

  if (appId && appSecret) {
    process.stdout.write('验证凭证… ')
    botInfo = await verifyCreds(appId, appSecret)
    line(botInfo.ok ? `✅ ${botInfo.name}` : `❌ ${botInfo.reason}`)
    if (!botInfo.ok) {
      if (botInfo.hint) line(`   ${botInfo.hint}`)
      const go = await ask('仍然保存这份配置吗？(y/N)', { def: 'N' })
      if (!/^y/i.test(go)) {
        close()
        line('已放弃，什么都没写。')
        process.exit(1)
      }
    } else if (botInfo.openId) {
      line(`   机器人 open_id ${botInfo.openId}（自动填进 feishu.botOpenId）`)
    }
    line()
  }

  const myId = await ask('你自己的 open_id（可留空，留空则谁私聊机器人都能用）', {
    def: cfg.feishu.allowlist?.[0] || '',
  })
  if (myId) cfg.feishu.allowlist = [...new Set([...(cfg.feishu.allowlist || []), myId])]

  const dir = await ask('默认工作目录', { def: cfg.opencode.defaultDirectory || homedir() })
  if (dir) cfg.opencode.defaultDirectory = dir

  close()
  line()
}

if (appId) cfg.feishu.appId = appId
if (appSecret) cfg.feishu.appSecret = appSecret
if (botInfo?.ok && botInfo.openId) cfg.feishu.botOpenId = botInfo.openId

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
  line(`   填好后再跑一次 npm run init 就能验证：凭证对不对、botOpenId 是多少。`)
  line()
}
if (!cfg.feishu.allowlist?.length) {
  line('⚠️ 白名单还是空的：任何人私聊机器人都能操作你本机的 shell 和文件。')
  line('   拿自己的 open_id：给机器人发一条消息，日志里会出现 ou_ 开头的 id')
  line('     tail -f logs/bridge.log | grep 拒绝非白名单')
  line('   然后一条命令加进去：')
  line('     npm run init -- --add-allow=ou_你的openid')
  line()
}
line('接下来：')
line(`  1. 体检   npm run doctor`)
line(`  2. 启动   npm run up`)
line()
line('飞书后台这四项漏一个都会「静默不响应」：')
line('   · 事件订阅   im.message.receive_v1，订阅方式选「使用长连接接收事件」')
line('   · 回调配置   card.action.trigger，选「使用长连接接收回调」')
line('   · 权限       im:message / im:message:send_as_bot / im:chat:readonly')
line('   · 发布版本   权限和事件改完必须发版才生效')
line()
line(`配置目录优先级：$OCB_CONFIG_DIR > 项目内 ${join(REPO, '.config', 'opencode-feishu-bridge')} > ~/.config/opencode-feishu-bridge`)
if (!useHome && existsSync(join(homedir(), '.config', 'opencode-feishu-bridge', 'config.json'))) {
  line()
  line('⚠️  home 下还有一份旧配置。项目内这份优先，但建议把旧的挪走免得日后看错：')
  line(`   ${join(homedir(), '.config', 'opencode-feishu-bridge')}`)
}
