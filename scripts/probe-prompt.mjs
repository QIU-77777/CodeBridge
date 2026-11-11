#!/usr/bin/env node
/**
 * 提示词实测探针：把「真正发给模型的 body」原样截下来打印。
 *
 *   node scripts/probe-prompt.mjs                     # 现行 prompts.json，5 个场景
 *   node scripts/probe-prompt.mjs --proposed          # 提案副本
 *   node scripts/probe-prompt.mjs --diff              # 两版逐行差异
 *   node scripts/probe-prompt.mjs --all --out docs/prompt-samples.md
 *
 * 为什么叫「实测」而不是示意：走的是生产拼装链路——
 *   FeishuTransport.handleImMessage（含 @ 闸门与话题近况采集）
 *     → onMessage（Bridge 命令分流、白名单、去重）
 *     → runPrompt（origin / oncePrefix / topicContext 三段拼接）
 *     → oc.prompt(sessionId, body)
 * 只 stub 掉飞书 HTTP（client.request）和后端（prompt 捕获 body），
 * 前缀拼接、模板渲染、变量替换、近况快照全是真实代码。不连飞书、不发消息、
 * 不起 serve，也不写用户配置目录（store 落在临时目录）。
 *
 * 用途：改 prompts.json 的文案后重跑，直接看模型实际会收到什么。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { FeishuTransport } from '../src/feishu.js'
import { Bridge } from '../src/handler.js'
import { Store } from '../src/store.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const CURRENT = join(REPO, 'prompts.json')
const PROPOSED = join(REPO, 'docs', 'prompts-topic-context.proposed.json')

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}

// 固定时刻，保证每次跑出来的样本可对照。飞书 create_time 是**毫秒**级（13 位）
const TS_MS = new Date('2026-11-11T17:30:00+08:00').getTime()

const ME = { key: '@_user_1', id: { open_id: 'ou_self', user_id: 'ou_self' }, name: 'Lil_P' }
const HUMAN = 'ou_human'
const OTHER_BOT = 'ou_o'

function cfgOf(tpl, backendType) {
  return {
    feishu: {
      appId: 'cli_a1b2c3d4e5f6g7h8',
      appSecret: 'secret',
      requireMention: true,
      allowlist: [],
      botOpenId: 'ou_self',
      botName: 'Lil_P',
      names: { [OTHER_BOT]: 'Lil_O', [HUMAN]: '邱琪光' },
    },
    prompt: { templates: tpl, prefixes: [{ id: 'rules', mode: 'once', text: '' }] },
    behavior: {
      topicContext: true,
      topicContextMessages: 20,
      topicContextChars: 2500,
      maxParallel: 0,
      streamIntervalMs: 1800,
      idleTimeoutMs: 0,
      maxBodyChars: 6000,
    },
    opencode: { defaultDirectory: '/Users/me/proj', defaultModel: '' },
    _backendType: backendType,
  }
}

const ocStub = (captured) => ({
  health: async () => ({ ok: true }),
  location: async () => ({ directory: '/Users/me/proj' }),
  subscribe: () => () => {},
  getSession: async (id) => ({ id, location: { directory: '/Users/me/proj' } }),
  createSession: async () => ({ id: 'ses_probe', location: { directory: '/Users/me/proj' } }),
  prompt: async (sid, body) => {
    captured.push({ sid, body })
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
})

function makeHarness(tpl, backendType, dir) {
  const cfg = cfgOf(tpl, backendType)
  const captured = []
  const transport = {
    sendCard: async () => 'om_card_probe',
    sendText: async () => 'om_text_probe',
    patchCard: async () => true,
  }
  const store = new Store(join(dir, `state-${Math.random().toString(36).slice(2)}.json`))
  const bridge = new Bridge({
    oc: ocStub(captured),
    store,
    config: cfg,
    transport,
    capabilities: { type: backendType, label: backendType },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
  const msgs = []
  const ft = new FeishuTransport(cfg, {
    onMessage: async (msg) => {
      msgs.push(msg)
      return bridge.onMessage(msg)
    },
    onCardAction: async () => ({ toast: {} }),
    nameOf: (id) => cfg.feishu.names[id] || '',
    backendType,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
  ft.self = { open_id: 'ou_self', name: 'Lil_P' }
  // 只 stub 网络：群名与群成员接口返回可用数据，其余返回空对象
  ft.client.request = async ({ url }) => {
    if (url?.includes('/members')) {
      return { data: { items: [{ member_id: HUMAN, name: '邱琪光' }, { member_id: OTHER_BOT, name: 'Lil_O' }] } }
    }
    if (url?.includes('/chats/')) return { data: { name: '桥接话题探针' } }
    return {}
  }
  // 注意：不要把 bridge.t 换成 ft。runPrompt 发卡片走 bridge.t，换成真实
  // transport 会触发飞书 SDK 取 tenant_access_token（假凭证 → 10003）。
  // FeishuTransport 只负责「事件 → msg」，通过 onMessage 回调接进 Bridge。
  return { ft, bridge, captured, msgs }
}

/** 构造一条飞书 im.message.receive_v1 事件（字段按真实事件形状） */
function ev({ id, text, sender = HUMAN, senderType = 'user', root = 'om_root', thread = 'omt_topic', group = true, atMe = false, type = 'text', content = null, ms = TS_MS }) {
  return {
    sender: { sender_id: { open_id: sender }, sender_type: senderType },
    message: {
      message_id: id,
      chat_id: 'oc_eaae4e2d9fa07208665004e2b84e2a4b',
      chat_type: group ? 'group' : 'p2p',
      message_type: type,
      content: content ?? JSON.stringify({ text }),
      root_id: group ? root : '',
      parent_id: group ? root : '',
      thread_id: group ? thread : '',
      create_time: String(ms),
      mentions: atMe ? [ME] : [],
    },
  }
}

/** 喂一串没 @ 的讨论攒近况，再喂一条 @ 我的唤醒，返回捕获到的 body 与 msg */
async function run(h, events, wake) {
  for (const e of events) await h.ft.handleImMessage(e)
  const before = h.captured.length
  await h.ft.handleImMessage(wake)
  // 静默返回上一次 body 会造出「看起来对、其实张冠李戴」的样本，直接报错
  if (h.captured.length === before) {
    throw new Error(`场景构造错误：唤醒消息 ${wake.message.message_id} 没产生 prompt（可能被排队或闸门挡住）`)
  }
  const msg = h.msgs.find((m) => m.messageId === wake.message.message_id) || h.msgs.at(-1)
  return { body: h.captured.at(-1).body, msg }
}

/** 五个场景，覆盖模板的所有分支 */
async function scenarios(tpl, dir) {
  const out = []

  // A · 群聊话题内，新会话，opencode（最完整形态）
  {
    const h = makeHarness(tpl, 'opencode', dir)
    const { body, msg } = await run(
      h,
      [
        ev({ id: 'om_1', text: '我倾向方案 A，部署顺序要先改配置', ms: TS_MS - 300_000 }),
        ev({ id: 'om_2', text: '同意，但先确认回滚路径', sender: OTHER_BOT, senderType: 'app', ms: TS_MS - 240_000 }),
        ev({ id: 'om_3', text: '@Lil_P 之前说的结论还作数吗', ms: TS_MS - 180_000 }),
        ev({ id: 'om_4', text: '补一张架构图', type: 'image', content: '{}', ms: TS_MS - 120_000 }),
      ],
      ev({ id: 'om_5', text: '@_user_1 按刚才那个方案继续改', atMe: true }),
    )
    out.push({ name: 'A · 群聊 / 话题内 / 新会话 / opencode', body, msg, note: '最完整形态：origin 四行 + once 规则 + 话题近况 + 正文。近况里含没 @ 的讨论、其他 agent 发言、图片占位（已 @ 过的指针行见场景 B）。' })
  }

  // B · 同一话题续聊（不再带 once 规则，近况继续演进）
  {
    const h = makeHarness(tpl, 'opencode', dir)
    await run(h, [ev({ id: 'om_1', text: '先把配置改了', ms: TS_MS - 200_000 })], ev({ id: 'om_2', text: '@_user_1 开个头', atMe: true, ms: TS_MS - 150_000 }))
    h.bridge.runs.get('ses_probe').state.status = 'done'
    const { body, msg } = await run(h, [ev({ id: 'om_3', text: '改完了，下一步看测试', ms: TS_MS - 60_000 })], ev({ id: 'om_4', text: '@_user_1 继续', atMe: true }))
    out.push({ name: 'B · 群聊 / 话题内 / 续聊 / opencode', body, msg, note: '同会话第二条：once 规则不再重复，近况块仍带（讨论在演进）。' })
  }

  // C · 主聊天流（scope/ids 走 main 分支，近况按 chat 聚）
  {
    const h = makeHarness(tpl, 'opencode', dir)
    const { body, msg } = await run(
      h,
      [ev({ id: 'om_1', text: '群里随口聊的一句', root: null, thread: null, ms: TS_MS - 120_000 })],
      ev({ id: 'om_2', text: '@_user_1 帮我跑个测试', root: null, thread: null, atMe: true }),
    )
    out.push({ name: 'C · 群聊 / 主聊天流 / opencode', body, msg, note: '主聊天流每次 @ 都是新会话；scope=主聊天流、ids 无 thread/root，近况按 chat 聚。' })
  }

  // D · 私聊（无 @ 闸门、无 scope、无 peers、无近况、无 once 规则）
  {
    const h = makeHarness(tpl, 'opencode', dir)
    const { body, msg } = await run(h, [], ev({ id: 'om_p1', text: '看下昨天的改动', group: false }))
    out.push({ name: 'D · 私聊 / opencode', body, msg, note: '私聊：每条都进会话，没有 @ 闸门，因此不带话题近况；协作规则只在群里拼。' })
  }

  // E · pi 后端（只差身份行，其余与 A 相同）
  {
    const h = makeHarness(tpl, 'pi', dir)
    const { body, msg } = await run(
      h,
      [ev({ id: 'om_1', text: '方案 A 先上', ms: TS_MS - 180_000 })],
      ev({ id: 'om_2', text: '@_user_1 继续', atMe: true }),
    )
    out.push({ name: 'E · 群聊 / 话题内 / pi 后端', body, msg, note: '与 A 唯一差别是 identityLine 走 pi 分支（注入点不同）。' })
  }

  return out
}

/** 段落来源：让人知道每一行是哪段模板拼出来的，改文案时找得到地方 */
function provenance(msg) {
  const l = (msg.origin || '').split('\n')
  return [
    ['always.origin（where + scope + sender + senderType + when）', l[0] || ''],
    ['always.ids（thread / main / private）', l[1] || ''],
    ['always.identityLine（pi / opencode）', l[2] || ''],
    ['always.peers.list', l[3] || ''],
    ['once.rules（协作规则 + 上下文策略）', msg.oncePrefix || ''],
    ['always.topicContext（头 + 近况行）', msg.topicContext || ''],
    ['用户正文', msg.text || ''],
  ]
}

function renderOne(label, tplPath, list) {
  const chunks = []
  chunks.push(`## ${label}\n`)
  chunks.push(`文案文件：\`./${relative(REPO, tplPath)}\`\n`)
  for (const s of list) {
    chunks.push(`### ${s.name}\n`)
    chunks.push(`${s.note}\n`)
    chunks.push('**发给模型的 body（原样，未截断）**\n')
    chunks.push('```text')
    chunks.push(s.body)
    chunks.push('```\n')
    chunks.push('| 段 | 内容 | 字数 |')
    chunks.push('|---|---|---|')
    for (const [k, v] of provenance(s.msg)) {
      const sample = v.length > 70 ? v.slice(0, 70) + '…' : v
      chunks.push(`| ${k} | ${sample ? `\`${sample.replace(/\|/g, '\\|')}\`` : '—'} | ${v.length} |`)
    }
    // once.rules 与 topicContext 的字数按 msg 字段计，不是展示样串
    chunks.push(`| **合计** | body 总字数 | **${s.body.length}** |`)
    chunks.push('')
  }
  return chunks.join('\n')
}

function renderDiff(cur, prop) {
  const lines = ['## 两版逐行差异\n', '只列出不同的行（按场景与行号对齐）。\n']
  for (let i = 0; i < cur.length; i++) {
    const a = cur[i].body.split('\n')
    const b = prop[i].body.split('\n')
    lines.push(`### ${cur[i].name}\n`)
    lines.push('```diff')
    for (let j = 0; j < Math.max(a.length, b.length); j++) {
      if (a[j] === b[j]) continue
      if (a[j] !== undefined) lines.push(`- ${a[j]}`)
      if (b[j] !== undefined) lines.push(`+ ${b[j]}`)
    }
    lines.push('```\n')
  }
  return lines.join('\n')
}

const dir = mkdtempSync(join(tmpdir(), 'ocb-probe-prompt-'))
try {
  const curTpl = JSON.parse(readFileSync(CURRENT, 'utf8'))
  const propTpl = JSON.parse(readFileSync(PROPOSED, 'utf8'))
  const cur = await scenarios(curTpl, dir)
  const prop = await scenarios(propTpl, dir)

  const mode = argv.includes('--diff') ? 'diff' : argv.includes('--all') ? 'all' : argv.includes('--proposed') ? 'proposed' : 'current'
  let out = ''
  if (mode === 'current' || mode === 'proposed') {
    out = renderOne(mode === 'proposed' ? '提案版 · 实测样本' : '现行版 · 实测样本', mode === 'proposed' ? PROPOSED : CURRENT, mode === 'proposed' ? prop : cur)
  } else if (mode === 'diff') {
    out = renderDiff(cur, prop)
  } else {
    out = [
      '# 发给桥接 Agent 的上下文实测样本',
      '',
      '> 由 `node scripts/probe-prompt.mjs --all --out docs/prompt-samples.md` 生成。',
      '> 走生产拼装链路（真实 `handleImMessage` / `runPrompt` / 模板渲染），只 stub 飞书 HTTP 与后端；不连飞书、不发消息。',
      '> 样本里的 id、群名、人名、凭证都是夹具数据；`when` 固定为 2026/11/11 17:30:00 便于对照。',
      '',
      renderOne('一、现行版（prompts.json）', CURRENT, cur),
      renderOne('二、提案版（docs/prompts-topic-context.proposed.json）', PROPOSED, prop),
      renderDiff(cur, prop),
    ].join('\n')
  }

  const outPath = argOf('--out')
  if (outPath) {
    writeFileSync(outPath, out, 'utf8')
    console.log(`已写入 ${outPath}（${out.length} 字）`)
  } else {
    console.log(out)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
