#!/usr/bin/env node
/**
 * 反查飞书消息：这条到底是「谁」发的。
 *
 * 桥接只在自己发的卡片上有记忆，群里别人（另一个机器人、别的成员）说了什么，
 * 日志里只有一个 msg id。这个脚本拿 id 去飞书要原文，并把发送者类型标出来。
 *
 * 用法：
 *   node scripts/probe-msg.mjs om_xxx [om_yyy ...]      # 按消息 id 查
 *   node scripts/probe-msg.mjs --thread omt_xxx         # 按话题拉一批（需要权限）
 *   node scripts/probe-msg.mjs --chat oc_xxx            # 按群拉一批（需要权限）
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { readFileSync } from 'node:fs'
import { CONFIG_PATH } from '../src/config.js'

// SDK 会把失败请求的整个 axios error 打到 console，这里只要结论
const out = (...a) => process.stdout.write(a.join(' ') + '\n')
console.log = () => {}
console.error = () => {}
console.warn = () => {}
console.info = () => {}
console.debug = () => {}

const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const f = cfg.feishu
const client = new Lark.Client({
  appId: f.appId,
  appSecret: f.appSecret,
  domain: f.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.fatal,
})

const names = f.names || {}
const who = (id) => {
  if (!id) return '?'
  const n = names[id]
  return n ? `${n}(${id})` : id
}

const SENDER_TYPE = {
  user: '人类用户',
  app: '机器人/应用',
  anonymous: '匿名',
  system: '系统',
}

function body(msg) {
  const raw = msg.body?.content
  if (!raw) return ''
  try {
    const j = JSON.parse(raw)
    if (j.text !== undefined) return j.text
    if (j.content !== undefined) return JSON.stringify(j.content)
    if (j.title || j.elements) return `[卡片] ${j.title || ''}`
    return JSON.stringify(j).slice(0, 300)
  } catch {
    return String(raw).slice(0, 300)
  }
}

function show(msg) {
  const st = msg.sender?.sender_type
  out('─'.repeat(70))
  out(`消息   ${msg.message_id}`)
  out(`时间   ${msg.create_time ? new Date(Number(msg.create_time)).toLocaleString('zh-CN') : '?'}`)
  out(`发送者 ${who(msg.sender?.id)}  「${SENDER_TYPE[st] || st || '?'}」`)
  out(`类型   ${msg.msg_type}   会话 ${msg.chat_id}   话题 ${msg.thread_id || '-'}`)
  const mentions = (msg.mentions || []).map((m) => `${m.name}(${m.id?.open_id || m.id})`)
  if (mentions.length) out(`@      ${mentions.join(', ')}`)
  const b = body(msg).replace(/\n/g, ' ⏎ ')
  out(`正文   ${b.slice(0, 400)}`)
}

const args = process.argv.slice(2)
if (!args.length) {
  out('用法: node scripts/probe-msg.mjs om_xxx ... | --thread omt_xxx | --chat oc_xxx')
  process.exit(1)
}

if (args[0] === '--thread' || args[0] === '--chat') {
  const kind = args[0] === '--thread' ? 'thread' : 'chat'
  const id = args[1]
  if (!id) {
    out(`缺少 id：--${kind} <id>`)
    process.exit(1)
  }
  try {
    const res = await client.request({
      method: 'GET',
      url: '/open-apis/im/v1/messages',
      params: {
        container_id_type: kind,
        container_id: id,
        sort_type: 'ByCreateTimeDesc',
        page_size: 20,
      },
    })
    const items = res?.data?.items || []
    out(`拿到 ${items.length} 条（${kind} ${id}）`)
    for (const m of items) show(m)
  } catch (err) {
    out(`拉列表失败: ${err?.response?.data?.msg || err.message}`)
    out('（通常缺 im:message.group_msg 或 im:message:readonly 权限，改用消息 id 单查即可）')
  }
} else {
  for (const id of args) {
    try {
      const res = await client.request({
        method: 'GET',
        url: `/open-apis/im/v1/messages/${id}`,
      })
      const items = res?.data?.items || []
      if (!items.length) out(`─\n${id}  没查到`)
      for (const m of items) show(m)
    } catch (err) {
      out('─'.repeat(70))
      out(`${id}  查询失败: ${err?.response?.data?.msg || err.message}`)
    }
  }
}
