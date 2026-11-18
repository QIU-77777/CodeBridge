#!/usr/bin/env node
/**
 * 等待类状态的作用域测试：不连飞书、不起真后端，全部用桩。
 *   node scripts/test-oar-scope.mjs
 *
 * 背景：登录等待与 ask_human 都只收同一个作用域里的答案。只按 chatId 收会把
 * 同一个群里别的话题的消息吞掉——那边的人 @ 了我，消息却没了，agent 永远看不到。
 *
 * 覆盖：同 chat 不同 thread 的消息互不吞、跨 chat 不吞、同作用域的被消费、
 * 跨作用域的照常进任务链路。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

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

const { Store } = await import(join(REPO, 'src', 'store.js'))
const { Bridge } = await import(join(REPO, 'src', 'handler.js'))

const root = mkdtempSync(join(tmpdir(), 'ocb-scope-'))

function makeHarness() {
  const store = new Store(join(root, `state-${Math.random().toString(36).slice(2)}.json`))
  const sent = []
  const transport = {
    sendCard: async (chatId, card, opts) => {
      sent.push({ kind: 'card', chatId, card, opts })
      return `card-${sent.length}`
    },
    sendText: async (chatId, text, opts) => {
      sent.push({ kind: 'text', chatId, text, opts })
      return 'text-1'
    },
    patchCard: async () => true,
  }
  const prompts = []
  const oc = {
    health: async () => ({ ok: true, version: '1', pid: 1 }),
    location: async () => ({ directory: '/tmp' }),
    subscribe: () => (() => {}),
    getSession: async (id) => ({ id, location: { directory: '/tmp' }, model: null, title: 't' }),
    createSession: async () => ({ id: 'ses_new', location: { directory: '/tmp' }, model: null }),
    prompt: async (id, text, opts = {}) => {
      prompts.push({ id, text, delivery: opts.delivery })
      return 'prompted'
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
  const bridge = new Bridge({ oc, store, config: cfg, transport, capabilities: { type: 'oar', label: 'Kimi Code', steer: true } })
  return { store, transport, oc, bridge, prompts, sent }
}

/** 群里一条消息。rootId 是话题根，没有就是主聊天流 */
const groupMsg = (chatId, rootId, text) => ({ chatId, userId: 'ou_x', text, messageId: `m-${Math.random()}`, chatType: 'group', rootId })

// ---------- 1. 作用域键 ----------

{
  const { bridge } = makeHarness()
  ok(bridge._scopeKey(groupMsg('oc_a', 'om_1', 'x')) === 'chat:oc_a|thread:om_1', '群里有话题：键带 thread')
  ok(bridge._scopeKey(groupMsg('oc_a', '', 'x')) === 'chat:oc_a|thread:', '群里主聊天流：thread 为空')
  ok(bridge._scopeKey({ chatId: 'oc_a', chatType: 'p2p' }) === 'chat:oc_a', '私聊：只有 chat')
}

// ---------- 2. ask_human 只收同作用域的答案 ----------

{
  const { bridge, prompts, sent } = makeHarness()
  // 问在 oc_a 的 om_1 话题下
  const answer = bridge.askHuman('chat:oc_a|thread:om_1', '选 A 还是 B？', 5000)
  await new Promise((r) => setTimeout(r, 10))
  ok(bridge.pendingAsks.has('chat:oc_a|thread:om_1'), '提问记在作用域键上')

  // 同一个群另一个话题的消息：不能被吞，照常进任务链路
  await bridge.onMessage(groupMsg('oc_a', 'om_2', '别的话题找我'))
  ok(prompts.length === 1 && prompts[0].text === '别的话题找我', '别的话题照常走到 prompt', JSON.stringify(prompts))
  ok(bridge.pendingAsks.has('chat:oc_a|thread:om_1'), '别的话题没有顶掉等待中的提问')

  // 主聊天流的消息同样不被吞
  await bridge.onMessage(groupMsg('oc_a', '', '主聊天流找我'))
  ok(prompts.length === 2 && prompts[1].text === '主聊天流找我', '主聊天流照常走到 prompt', JSON.stringify(prompts))

  // 别的群更不吞
  await bridge.onMessage(groupMsg('oc_b', 'om_1', '别的群找我'))
  ok(prompts.length === 3 && prompts[2].text === '别的群找我', '别的群照常走到 prompt', JSON.stringify(prompts))

  // 同作用域的消息才是答案
  await bridge.onMessage(groupMsg('oc_a', 'om_1', '选 A'))
  ok((await answer) === '选 A', '同作用域的消息被当成回答', String(await answer))
  ok(!bridge.pendingAsks.size, '回答之后等待清空')
  ok(prompts.length === 3, '答案本身不再进任务链路')
  ok(sent.some((s) => s.kind === 'text' && s.text === '选 A 还是 B？'), '问题本身发到目标会话')
}

// ---------- 3. 私聊里的 ask ----------

{
  const { bridge, prompts } = makeHarness()
  const answer = bridge.askHuman('chat:oc_a', '私聊里问', 5000)
  await new Promise((r) => setTimeout(r, 10))
  await bridge.onMessage({ chatId: 'oc_a', userId: 'ou_x', text: '私聊回答', messageId: 'm-p', chatType: 'p2p' })
  ok((await answer) === '私聊回答', '私聊里同作用域被消费')
  ok(prompts.length === 0, '答案不进任务链路')
}

// ---------- 4. 登录等待同样按作用域 ----------

{
  const { bridge, prompts } = makeHarness()
  // 假装一个登录流程等在 oc_a 的 om_1 话题下
  let answered = null
  bridge.loginFlow = {
    awaitingText: true,
    answer: (t) => {
      answered = t
      return true
    },
    cancel: () => {},
    state: { phase: 'prompt', prompt: { kind: 'text', message: '把回执码发到群里' }, info: [], url: '' },
  }
  bridge.loginScope = { chatId: 'oc_a', threadId: 'om_1' }

  await bridge.onMessage(groupMsg('oc_a', 'om_2', '别的话题 @ 我'))
  ok(answered === null, '别的话题没有顶掉登录等待')
  ok(prompts.length === 1, '别的话题照常走到 prompt', JSON.stringify(prompts))

  await bridge.onMessage(groupMsg('oc_a', 'om_1', 'MY-CODE'))
  ok(answered === 'MY-CODE', '同作用域的消息被当成登录答案', String(answered))
  ok(prompts.length === 1, '答案不进任务链路')
}

// ---------- 5. /取消 也按作用域 ----------

{
  const { bridge, prompts, sent } = makeHarness()
  let cancelled = false
  bridge.loginFlow = {
    awaitingText: true,
    answer: () => true,
    cancel: () => {
      cancelled = true
    },
    state: { phase: 'prompt', prompt: { kind: 'text', message: 'x' }, info: [], url: '' },
  }
  bridge.loginScope = { chatId: 'oc_a', threadId: 'om_1' }

  await bridge.onMessage(groupMsg('oc_a', 'om_2', '/取消'))
  ok(cancelled === false, '别的话题发 /取消 不取消别人的登录')
  ok(prompts.length === 0, '别的话题的 /取消 不进任务链路（是未知命令）')
  ok(sent.some((x) => x.kind === 'text' && String(x.text).includes('未知命令')), '别的话题的 /取消 得到反馈，消息没被吞')

  await bridge.onMessage(groupMsg('oc_a', 'om_1', '/取消'))
  ok(cancelled === true, '同作用域的 /取消 才取消')
}

rmSync(root, { recursive: true, force: true })

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
