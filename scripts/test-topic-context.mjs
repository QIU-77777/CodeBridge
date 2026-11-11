#!/usr/bin/env node
/**
 * 话题近况的离线测试：不连飞书、不起后端。
 *   node scripts/test-topic-context.mjs
 *
 * 三层：
 *   1. 纯函数：flattenContent（text/post 拉平、占位）、TopicLog（双键缓冲）、
 *      renderTopicContext（原文行、指针行、两级截断、保尾）
 *   2. FeishuTransport 集成：采集发生在 @ 闸门**之前**（没 @ 的轮次被留下），
 *      被唤醒时快照随消息下发、自身排除；私聊不带；主聊天流按群聚
 *   3. Bridge 集成：runPrompt 把近况拼进 prompt（规则在前、近况贴正文），
 *      排队条目也带上快照
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FeishuTransport } from '../src/feishu.js'
import { flattenContent, contextKeyOf, TopicLog, renderTopicContext } from '../src/topic-context.js'
import { Bridge } from '../src/handler.js'
import { Store } from '../src/store.js'

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name} ${extra}`)
  }
}

// ---------- flattenContent ----------

{
  const f1 = flattenContent('text', '{"text":"@_user_1 你好"}', [
    { key: '@_user_1', id: { open_id: 'ou_a', user_id: 'ou_a' }, name: '张三' },
  ])
  ok(f1?.text === '@张三 你好', 'text 的 @ 占位符还原成 @姓名', JSON.stringify(f1))

  ok(flattenContent('text', '{"text":"  "}') === null, 'text 空内容返回 null')
  ok(flattenContent('text', 'not json') === null, 'text 非法 JSON 返回 null')

  const post = JSON.stringify({
    title: 't',
    content: [
      [
        { tag: 'text', text: '看这份 ' },
        { tag: 'a', text: '文档', href: 'https://x' },
      ],
      [
        { tag: 'text', text: '叫 ' },
        { tag: 'at', user_id: 'ou_b' },
        { tag: 'text', text: ' 评估' },
      ],
    ],
  })
  const f2 = flattenContent('post', post, [
    { key: '@_user_1', id: { open_id: 'ou_b', user_id: 'ou_b' }, name: '李四' },
  ])
  ok(f2?.kind === 'post' && f2?.text === '看这份 文档\n叫 @李四 评估', 'post 按段拉平、链接取文字、at 按名字还原', JSON.stringify(f2))

  ok(flattenContent('image', '{}')?.kind === '图片', 'image 给占位标签')
  ok(flattenContent('interactive', '{}')?.kind === '卡片', 'interactive 给占位标签（不展开）')
  ok(flattenContent('file', '{}')?.kind === '文件', 'file 给占位标签')
  ok(flattenContent('audio', '{}')?.kind === '语音', 'audio 给占位标签')
  ok(flattenContent('whatever_new_type', '{}')?.kind === '消息', '未知类型兜底为「消息」')
}

// ---------- contextKeyOf ----------

{
  ok(contextKeyOf({ root_id: 'om_r', chat_id: 'oc_c' }) === 'root:om_r', '话题内按 root 键')
  ok(contextKeyOf({ root_id: '', chat_id: 'oc_c' }) === 'chat:oc_c', '主聊天流按 chat 键')
}

// ---------- TopicLog ----------

{
  const log = new TopicLog()
  const mk = (id, text) => ({ messageId: id, ts: 1700000000000, senderId: `ou_${id}`, senderType: 'user', kind: 'text', text, atMe: false })
  log.push('root:om_r', mk('a', '1'))
  log.push('root:om_r', mk('b', '2'))
  log.push('root:om_r', mk('c', '3'))
  const snap = log.snapshot('root:om_r', { limit: 2 })
  ok(snap.length === 2 && snap[0].text === '2' && snap[1].text === '3', 'snapshot 取最近 N 条且保持时间正序')
  ok(log.snapshot('root:om_r', { excludeId: 'c' }).length === 2, 'excludeId 排除指定消息')
  log.push('root:om_r', { messageId: 'c', ts: 1, senderId: '', senderType: '', kind: 'text', text: 'dup', atMe: false })
  ok(log.snapshot('root:om_r', { limit: 10 }).length === 3, '重推按 messageId 去重')
  ok(log.snapshot('chat:oc_x', {}).length === 0, '空键返回空数组')

  const capped = new TopicLog({ maxPerKey: 2 })
  capped.push('k', mk('a', '1'))
  capped.push('k', mk('b', '2'))
  capped.push('k', mk('c', '3'))
  const cs = capped.snapshot('k', { limit: 10 })
  ok(cs.length === 2 && cs[0].text === '2', '单桶封顶丢最旧（防长刷屏话题膨胀）')

  const fewKeys = new TopicLog({ maxKeys: 1 })
  fewKeys.push('k1', mk('a', '1'))
  fewKeys.push('k2', mk('b', '2'))
  ok(fewKeys.snapshot('k1', {}).length === 0 && fewKeys.snapshot('k2', {}).length === 1, '桶数封顶逐掉最旧未活跃的桶')
}

// ---------- renderTopicContext ----------

{
  const nameOf = (id) => ({ ou_u1: '张三', ou_u2: '李四' }[id] || '')
  const items = [
    { messageId: 'm1', ts: new Date('2026-11-11T10:00:00').getTime(), senderId: 'ou_u1', senderType: 'user', kind: 'text', text: '我觉得方案A更好', atMe: false },
    { messageId: 'm2', ts: new Date('2026-11-11T10:01:00').getTime(), senderId: 'ou_u2', senderType: 'app', kind: 'text', text: '同意，但部署顺序要先改配置', atMe: false },
    { messageId: 'm3', ts: new Date('2026-11-11T10:05:00').getTime(), senderId: 'ou_u1', senderType: 'user', kind: 'text', text: '那按这个来吧' + 'z'.repeat(60), atMe: true },
    { messageId: 'm4', ts: new Date('2026-11-11T10:06:00').getTime(), senderId: 'ou_u1', senderType: 'user', kind: '图片', text: '', atMe: false },
  ]
  const { text, count } = renderTopicContext(items, nameOf, { maxChars: 2500 })
  const lines = text.split('\n')
  ok(count === 4, 'count 报实际条数')
  ok(lines[0].includes('10:00') && lines[0].includes('张三') && lines[0].includes('方案A更好'), '普通轮次带时间、名字、原文')
  ok(lines[1].includes('李四（机器人）'), '机器人发送者带标注')
  ok(lines[2].startsWith('→ ') && lines[2].includes('（已 @ 我）') && !lines[2].includes('z'.repeat(41)), '@ 过我的只给指针行（40 字截断，不给全文）')
  ok(lines[3].includes('[图片]'), '非文本给占位符')

  // 名字取不到给完整 open_id（@ 回去要完整 id）
  const { text: t2 } = renderTopicContext([items[0]], () => '', { maxChars: 2500 })
  ok(t2.includes('ou_u1'), '名字取不到时给完整 open_id')

  // 单条截断
  const long = 'x'.repeat(500)
  const { text: t3 } = renderTopicContext([{ ...items[0], text: long }], nameOf, { maxChars: 2500 })
  ok(t3.includes('x'.repeat(400) + '…') && !t3.includes(long), '单条正文截断到 400')

  // 指针行截断
  const { text: t4 } = renderTopicContext([{ ...items[2], text: 'y'.repeat(100) }], nameOf, { maxChars: 2500 })
  ok(t4.includes('y'.repeat(40) + '…'), '指针行截断到 40')

  // 总量保尾 + 省略注记
  const many = Array.from({ length: 12 }, (_, i) => ({ ...items[0], messageId: `mm${i}`, text: `msg${i}` }))
  const { text: t5, count: c5 } = renderTopicContext(many, nameOf, { maxChars: 120 })
  ok(t5.startsWith('（更早的'), '超总量时开头注明省略条数')
  ok(t5.includes('msg11') && !t5.includes('msg0'), '超总量保尾（最近的优先）')
  ok(c5 < 12, 'count 只数实际带上的')

  ok(renderTopicContext([], nameOf, {}) === undefined || renderTopicContext([], nameOf, {}).text === '', '空输入给空文本')
}

// ---------- FeishuTransport 集成：采集在闸门之前，快照随唤醒下发 ----------

function mkTransport({ behavior = {} } = {}) {
  const seen = []
  const t = new FeishuTransport(
    {
      feishu: { appId: 'cli_test', appSecret: 'secret', requireMention: true, allowlist: [], names: {} },
      behavior,
    },
    {
      onMessage: async (msg) => seen.push(msg),
      nameOf: (id) => ({ ou_u1: '张三', ou_u2: '李四' }[id] || ''),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  )
  t.self = { open_id: 'ou_me', name: 'me' }
  t.client.request = async () => ({})
  return { t, seen }
}

function ev({ id, text, senderId = 'ou_u1', senderType = 'user', rootId = 'om_r', chatId = 'oc_c', mentions = [], type = 'text', content = null }) {
  return {
    sender: { sender_id: { open_id: senderId }, sender_type: senderType },
    message: {
      message_id: id,
      chat_id: chatId,
      chat_type: 'group',
      message_type: type,
      content: content ?? JSON.stringify({ text }),
      root_id: rootId,
      thread_id: rootId ? 'omt_1' : null,
      create_time: String(Math.floor(new Date('2026-11-11T10:00:00').getTime() / 1000)),
      mentions,
    },
  }
}

const ME = [{ key: '@_user_1', id: { open_id: 'ou_me', user_id: 'ou_me' }, name: 'me' }]

{
  // 话题内：没 @ 我的两条被采集（闸门之前），@ 我的唤醒时带上，自身排除
  const { t, seen } = mkTransport()
  await t.handleImMessage(ev({ id: 'om_1', text: '方案A更好' }))
  await t.handleImMessage(
    ev({ id: 'om_2', senderId: 'ou_u2', senderType: 'app', text: '同意，但先改配置' }),
  )
  await t.handleImMessage(ev({ id: 'om_3', text: '@_user_1 按刚才的方案继续', mentions: ME }))
  ok(seen.length === 1, '没 @ 我的消息不触发 onMessage（闸门语义不变）')
  const ctx = seen[0]?.topicContext || ''
  ok(ctx.includes('[话题近况'), '唤醒消息带上话题近况头')
  ok(ctx.includes('方案A更好'), '没 @ 我的轮次原文在近况里')
  ok(ctx.includes('李四（机器人）') && ctx.includes('先改配置'), '其他 agent 的发言在近况里（带机器人标注）')
  ok(!ctx.includes('按刚才的方案继续'), '当前消息自身不在近况里（它就是 prompt）')
  ok((ctx.match(/（已 @ 我）/g) || []).length === 0, '本条之前没有别的 @ 我的轮次')
}

{
  // 话题里更早 @ 过我的轮次：正文已在会话历史，近况只给指针行
  const { t, seen } = mkTransport()
  await t.handleImMessage(ev({ id: 'om_1', text: '方案A更好' }))
  await t.handleImMessage(ev({ id: 'om_2', text: '@_user_1 先查一下现状', mentions: ME }))
  await t.handleImMessage(ev({ id: 'om_3', text: '@_user_1 好了继续', mentions: ME }))
  const ctx = seen.at(-1)?.topicContext || ''
  ok(ctx.includes('→ ') && ctx.includes('（已 @ 我）') && ctx.includes('先查一下现状'), '更早 @ 我的轮次给指针行')
  ok(!ctx.includes('好了继续'), '当前消息排除')
  ok(ctx.includes('方案A更好'), '没 @ 我的轮次仍给全文')
}

{
  // 自己发的消息（卡片回流）不进近况
  const { t, seen } = mkTransport()
  await t.handleImMessage(ev({ id: 'om_1', text: '方案A更好' }))
  await t.handleImMessage(ev({ id: 'om_2', senderId: 'ou_me', senderType: 'app', type: 'interactive', content: '{}' }))
  await t.handleImMessage(ev({ id: 'om_3', text: '@_user_1 继续', mentions: ME }))
  const ctx = seen[0]?.topicContext || ''
  ok(!ctx.includes('[卡片]'), '自己的卡片不进近况（模型知道自己说过什么）')
}

{
  // 主聊天流：root_id 为空，按 chat 键聚
  const { t, seen } = mkTransport()
  await t.handleImMessage(ev({ id: 'om_1', text: '主聊天流闲聊', rootId: null }))
  await t.handleImMessage(ev({ id: 'om_2', text: '@_user_1 帮我干个活', rootId: null, mentions: ME }))
  const ctx = seen[0]?.topicContext || ''
  ok(ctx.includes('主聊天流闲聊'), '主聊天流的近况按群聚（那里每次 @ 都是新会话，近况是唯一上下文）')
}

{
  // 话题隔离：别的 root 的消息不该串进来
  const { t, seen } = mkTransport()
  await t.handleImMessage(ev({ id: 'om_1', text: '别的话题的讨论', rootId: 'om_other' }))
  await t.handleImMessage(ev({ id: 'om_2', text: '@_user_1 开始', rootId: 'om_r', mentions: ME }))
  const ctx = seen[0]?.topicContext || ''
  ok(!ctx.includes('别的话题的讨论'), '别的话题（root）的近况不串扰')
}

{
  // 私聊：不带近况（每条都进会话，没有盲区）
  const { t, seen } = mkTransport()
  const priv = (id, text) => ({ ...ev({ id, text, rootId: null }), message: { ...ev({ id, text, rootId: null }).message, chat_type: 'p2p' } })
  await t.handleImMessage(priv('om_1', '私聊第一句'))
  await t.handleImMessage(priv('om_2', '私聊第二句'))
  ok(seen.length === 2, '私聊消息条条都处理（无 @ 闸门）')
  ok(seen.every((m) => !m.topicContext), '私聊不带话题近况')
}

{
  // behavior.topicContext = false 关闭
  const { t, seen } = mkTransport({ behavior: { topicContext: false } })
  await t.handleImMessage(ev({ id: 'om_1', text: '方案A更好' }))
  await t.handleImMessage(ev({ id: 'om_2', text: '@_user_1 继续', mentions: ME }))
  ok(!seen[0].topicContext, 'topicContext=false 时不带近况')
}

{
  // post 消息也进近况（拉平）
  const { t, seen } = mkTransport()
  await t.handleImMessage(
    ev({
      id: 'om_1',
      type: 'post',
      content: JSON.stringify({ content: [[{ tag: 'text', text: '富文本讨论内容' }]] }),
    }),
  )
  await t.handleImMessage(ev({ id: 'om_2', text: '@_user_1 继续', mentions: ME }))
  ok(seen[0].topicContext.includes('富文本讨论内容'), 'post 富文本拉平后进近况')
}

// ---------- Bridge 集成：runPrompt 拼进 prompt ----------

{
  const root = mkdtempSync(join(tmpdir(), 'ocb-topic-'))
  const store = new Store(join(root, 'state.json'))
  const promptCalls = []
  const transport = {
    sendCard: async () => 'card-1',
    sendText: async () => 'text-1',
    patchCard: async () => true,
  }
  const oc = {
    health: async () => ({ ok: true }),
    location: async () => ({ directory: '/tmp' }),
    subscribe: () => () => {},
    getSession: async (id) => ({ id, location: { directory: '/tmp' } }),
    createSession: async () => ({ id: 'ses_1', location: { directory: '/tmp' } }),
    prompt: async (sid, body) => {
      promptCalls.push(body)
      return {}
    },
    interrupt: async () => true,
    listSessions: async () => [],
    listModels: async () => [],
    listAgents: async () => [],
    deleteSession: async () => true,
    renameSession: async () => null,
    switchModel: async () => true,
    switchAgent: async () => true,
    replyPermission: async () => true,
  }
  const cfg = {
    feishu: { allowlist: [], names: {} },
    opencode: { defaultDirectory: '/tmp', defaultModel: '' },
    behavior: { streamIntervalMs: 1800, maxParallel: 0, idleTimeoutMs: 0, maxBodyChars: 6000 },
  }
  const bridge = new Bridge({ oc, store, config: cfg, transport, capabilities: { type: 'opencode' } })
  const ctx = { key: 'root:om_r', chatId: 'oc_c', replyTo: 'om_r' }

  const block = '[话题近况 · 本话题最近 2 条消息原文，按时间序。没 @ 我的轮次我原本收不到，这段是桥接替我带上的；→ 开头的已 @ 过我，正文我已收到过]\n[10:00] 张三: 方案A更好\n[10:05] 李四: 先改配置'
  await bridge.runPrompt(
    { text: '按刚才的方案继续', origin: '[飞书 · 群「X」]', oncePrefix: 'RULES', topicContext: block, isGroup: true, messageId: 'om_9', userId: 'ou_u1' },
    ctx,
  )
  const body1 = promptCalls[0] || ''
  ok(body1.includes('[飞书 · 群「X」]'), 'origin 前缀进 prompt')
  ok(body1.includes('RULES'), '新会话首条带 once 规则')
  ok(body1.includes('方案A更好') && body1.includes('话题近况'), '话题近况块进 prompt')
  const iOrigin = body1.indexOf('[飞书')
  const iRules = body1.indexOf('RULES')
  const iCtx = body1.indexOf('话题近况')
  const iBody = body1.indexOf('按刚才的方案继续')
  ok(iOrigin < iRules && iRules < iCtx && iCtx < iBody, '拼装顺序：来源→规则→近况→正文')

  // 第二条（同会话）：规则不重复，近况仍带
  bridge.runs.get('ses_1').state.status = 'done'
  await bridge.runPrompt(
    { text: '继续改', origin: '', oncePrefix: 'RULES', topicContext: block, isGroup: true, messageId: 'om_10', userId: 'ou_u1' },
    ctx,
  )
  const body2 = promptCalls[1] || ''
  ok(!body2.includes('RULES'), '后续消息不重复 once 规则')
  ok(body2.includes('话题近况'), '后续消息近况照带（讨论在演进）')

  // 忙碌排队：快照跟着队列条目走
  bridge.runs.get('ses_1').state.status = 'running'
  await bridge.runPrompt(
    { text: '再补一句', origin: '', oncePrefix: '', topicContext: block, isGroup: true, messageId: 'om_11', userId: 'ou_u1' },
    ctx,
  )
  const queued = store.data?.queue?.['root:om_r']?.[0]
  ok(queued?.topicContext === block, '排队条目带上入队时的近况快照')

  rmSync(root, { recursive: true, force: true })
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
