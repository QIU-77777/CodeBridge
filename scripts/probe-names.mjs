#!/usr/bin/env node
/**
 * 探测「open_id 能不能反查名字」。
 *
 * 飞书这块比较绕：人类走通讯录接口，机器人压根没有官方反查接口。
 * 这个脚本把每条可能的路子都打一遍，告诉你现在哪些能用、缺哪个权限。
 *
 * 用法：
 *   node scripts/probe-names.mjs              # 用配置里的第一个群
 *   node scripts/probe-names.mjs oc_xxx       # 指定群
 *   node scripts/probe-names.mjs oc_xxx ou_x  # 再额外查一个 open_id
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = join(homedir(), '.config', 'opencode-feishu-bridge', 'config.json')
const STATE = join(homedir(), '.config', 'opencode-feishu-bridge', 'state.json')

// 飞书 SDK 会把每个失败请求的整个 axios error 打到 console，
// 这里只要结论，不要那堆对象。先接管 console，输出走 out()。
const out = (...a) => process.stdout.write(a.join(' ') + '\n')
console.log = () => {}
console.error = () => {}
console.warn = () => {}
console.info = () => {}
console.debug = () => {}

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
const f = cfg.feishu
const client = new Lark.Client({
  appId: f.appId,
  appSecret: f.appSecret,
  domain: f.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.fatal,
})

const line = (s = '') => out(s)
const head = (s) => {
  line()
  line('─'.repeat(64))
  line(s)
  line('─'.repeat(64))
}

function fail(e) {
  const d = e?.response?.data || {}
  if (d.code) return `code=${d.code} ${String(d.msg || '').slice(0, 160)}`
  return e?.message || String(e)
}

async function call(label, url) {
  try {
    const r = await client.request({ method: 'GET', url })
    line(`  ✅ ${label}`)
    return r
  } catch (e) {
    line(`  ❌ ${label}  ${fail(e)}`)
    return null
  }
}

// 默认群：state.json 里出现过的 oc_ 开头的 chatId
function guessChatId() {
  try {
    const st = JSON.parse(readFileSync(STATE, 'utf8'))
    // 只认群：群里的键是 root:<消息 id>，私聊键是 chat_id 本身
    for (const [k, v] of Object.entries(st.chats || {})) {
      if (k.startsWith('root:') && v?.chatId?.startsWith('oc_')) return v.chatId
    }
    for (const v of Object.values(st.chats || {})) {
      if (v?.chatId?.startsWith('oc_')) return v.chatId
    }
  } catch {
    /* ignore */
  }
  return ''
}

const chatId = process.argv[2] || guessChatId()
const extraId = process.argv[3] || ''

head('0. 自己的身份')
await call('GET /open-apis/bot/v3/info（只能查自己）', '/open-apis/bot/v3/info')

if (chatId) {
  head(`1. 群信息  ${chatId}`)
  const info = await call('GET /im/v1/chats/:chat_id', `/open-apis/im/v1/chats/${chatId}`)
  if (info?.data) {
    const d = info.data
    line(`     群名: ${d.name}   人类成员: ${d.user_count}   机器人: ${d.bot_count}`)
  }

  head('2. 群成员列表（名字的主要来源）')
  const members = await call(
    'GET /im/v1/chats/:chat_id/members',
    `/open-apis/im/v1/chats/${chatId}/members?member_id_type=open_id&page_size=50`,
  )
  if (members?.data?.items) {
    line(`     拿到 ${members.data.items.length} 个成员：`)
    for (const m of members.data.items) {
      line(`       - ${m.name || '(无名字)'}  ${m.member_id}  ${m.tenant_key ? '' : '(机器人?)'}`)
    }
    line('     ↑ 看这里有没有两个机器人。有 = 开 im:chat.members:read 就够用了')
  }
}

head('3. 通讯录反查（只对人类有效）')
const ids = [f.allowlist?.[0], f.allowlist?.[1], extraId].filter(Boolean)
if (!ids.length) {
  line('  配置里 allowlist 是空的，跳过。用法：node scripts/probe-names.mjs <chat_id> <open_id>')
}
for (const id of ids) {
  const r = await call(
    `GET /contact/v3/users/${id.slice(0, 12)}…`,
    `/open-apis/contact/v3/users/${id}?user_id_type=open_id`,
  )
  if (r?.data?.user) {
    const u = r.data.user
    line(`     name=${u.name ?? '(没返回 name → 缺 contact:user.base:readonly)'}  en_name=${u.en_name ?? '-'}`)
  }
}

head('结论怎么读')
line('  · 第 3 组对人类返回 name → 通讯录权限已开，人类名字能自动拿到')
line('  · 第 3 组对人类 code=41050 → 这个 id 是机器人，通讯录接口不认机器人，正常')
line('  · 第 2 组列表里出现机器人 → 开 im:chat.members:read 后就能自动拿机器人名字')
line('  · 第 2 组只有人类 → 机器人名字拿不到，只能写进 feishu.names 或等它被 @ 时攒下来')
line()
