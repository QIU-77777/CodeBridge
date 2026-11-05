#!/usr/bin/env node
/**
 * 话题（thread）探针：确认飞书群消息的 thread_id / root_id 行为，并验证桥接的话题内发送。
 *
 *   node scripts/probe-thread.mjs --list                     看机器人在哪些群
 *   node scripts/probe-thread.mjs --create 探针群            建群并把白名单用户拉进来
 *   node scripts/probe-thread.mjs --send <chat_id>           发一条文本 + 一条话题串回复卡片
 *   node scripts/probe-thread.mjs --verify <chat_id> <消息id> 用桥接传输层往该消息所在话题发卡片，回查 thread_id
 *
 * 飞书行为已量完（结论见 docs/design-notes.md 第十二节）。--verify 验的是桥接这边：
 * sendCard 带 replyTo 时，卡片是否真的落进调用方指定的话题。
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { readFileSync } from 'node:fs'
import { CONFIG_PATH } from '../src/config.js'
import { homedir } from 'node:os'

const CFG = JSON.parse(
  readFileSync(CONFIG_PATH, 'utf8'),
)
const client = new Lark.Client({
  appId: CFG.feishu.appId,
  appSecret: CFG.feishu.appSecret,
  domain: CFG.feishu.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.error,
})

const die = (e) => {
  const body = e?.response?.data
  console.error('❌', body ? JSON.stringify(body).slice(0, 400) : e.message)
  process.exit(1)
}

const args = process.argv.slice(2)
const mode = args[0]

if (!mode || mode === '--help') {
  console.log('用法：--list | --create <群名> | --send <chat_id>')
  process.exit(0)
}

if (mode === '--list') {
  const r = await client.im.v1.chat.list({ params: { page_size: 50 } }).catch(die)
  for (const it of r.data?.items || []) {
    console.log(`${it.chat_id}  mode=${it.chat_mode ?? '?'}  ${it.name || '(无名)'}`)
  }
  console.log(`共 ${(r.data?.items || []).length} 个群`)
}

if (mode === '--create') {
  const name = args[1] || '桥接话题探针'
  const users = (CFG.feishu.allowlist || []).filter(Boolean)
  const r = await client.im.v1.chat
    .create({
      params: { user_id_type: 'open_id' },
      data: {
        name,
        description: '话题并行能力探针，用完可删',
        chat_mode: 'group',
        chat_type: 'private',
        user_id_list: users,
      },
    })
    .catch(die)
  console.log('✅ 建群成功')
  console.log('chat_id =', r.data?.chat_id)
  console.log('拉进来的人:', users.join(', ') || '(白名单为空)')
}

if (mode === '--send') {
  const chatId = args[1]
  if (!chatId) die(new Error('缺少 chat_id'))

  // 1. 先发一条普通消息，作为话题的根
  const root = await client.im.v1.message
    .create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: '探针：这条是话题的根消息' }),
      },
    })
    .catch(die)
  const rootId = root.data?.message_id
  console.log('根消息 message_id =', rootId)
  console.log('  回查:', await describe(rootId))

  // 2. 以 reply_in_thread 回一条卡片，看它是否自成一个话题
  const card = {
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: { elements: [{ tag: 'markdown', content: '**探针卡片**\n这条是用 reply_in_thread 发的。' }] },
  }
  const rep = await client.im.v1.message
    .reply({
      path: { message_id: rootId },
      data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true },
    })
    .catch(die)
  const threadMsgId = rep.data?.message_id
  console.log('话题回复 message_id =', threadMsgId)
  console.log('  回查:', await describe(threadMsgId))

  console.log('\n接下来请人工做两件事（在飞书里）：')
  console.log('  1. 在这条「探针卡片」下面点「回复」，发一句话')
  console.log('  2. 在群里直接 @机器人 发一句话')
  console.log('然后我看 logs/bridge.log 里两条消息各带了什么 thread_id / root_id。')
}

if (mode === '--append') {
  // 验证「再往同一个根消息回一条」是并进原话题，还是另起一个
  const rootId = args[1]
  if (!rootId) die(new Error('缺少根消息 id'))
  const r = await client.im.v1.message
    .reply({
      path: { message_id: rootId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: '探针：又一次 reply_in_thread' }),
        reply_in_thread: true,
      },
    })
    .catch(die)
  const id = r.data?.message_id
  console.log('新消息 message_id =', id)
  console.log('  回查:', await describe(id))
  console.log('  （thread_id 和上次一样 = 并进原话题；变了 = 另起了一个话题）')
}

if (mode === '--verify') {
  const chatId = args[1]
  const replyTo = args[2]
  if (!chatId || !replyTo) die(new Error('用法: --verify <chat_id> <话题内任意一条消息的 id>'))

  const { FeishuTransport } = await import('../src/feishu.js')
  const t = new FeishuTransport(CFG, { logger: { info: () => {}, warn: () => {}, error: console.error } })
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { template: 'turquoise', title: { tag: 'plain_text', content: '话题内回复验证' } },
    body: {
      elements: [
        { tag: 'markdown', content: `这条卡片由 \`FeishuTransport.sendCard(replyTo)\` 发出，应落在消息 \`${replyTo}\` 所在的话题里。` },
      ],
    },
  }
  const id = await t.sendCard(chatId, card, { replyTo }).catch(die)
  console.log('发出 message_id =', id)
  const m = await getMsg(id)
  console.log('  回查:', JSON.stringify({ thread_id: m.thread_id ?? null, root_id: m.root_id ?? null, parent_id: m.parent_id ?? null }))
  if (!m.thread_id) die(new Error('回查没有 thread_id：卡片没有落进话题'))
  console.log(`✅ 卡片已落进话题 ${m.thread_id}`)
}

async function getMsg(messageId) {
  const r = await client.im.v1.message.get({ path: { message_id: messageId } }).catch(die)
  return r.data?.items?.[0] || {}
}

async function describe(messageId) {
  const m = await getMsg(messageId)
  return JSON.stringify({ thread_id: m.thread_id ?? null, root_id: m.root_id ?? null, parent_id: m.parent_id ?? null, chat_id: m.chat_id })
}
