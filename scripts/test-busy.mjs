#!/usr/bin/env node
/**
 * 忙等三选一卡片的离线测试：不连飞书、不起真后端，全部用桩。
 *   node scripts/test-busy.mjs
 *
 * 覆盖：忙等时消息不再被丢弃（存 pending + 回卡片）、加入队列、
 * 中止当前改发这条（插队 + interrupt）、取消、任务收尾后自动排空、
 * pending 与 queue 落盘重启不丢。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'ocb-busy-'))

function makeHarness({ interruptOk = true } = {}) {
  const store = new Store(join(root, `state-${Math.random().toString(36).slice(2)}.json`))
  const sent = []
  const transport = {
    sendCard: async (chatId, card, opts) => {
      sent.push({ kind: 'card', chatId, card, opts })
      return 'card-1'
    },
    sendText: async (chatId, text, opts) => {
      sent.push({ kind: 'text', chatId, text, opts })
      return 'text-1'
    },
    patchCard: async () => true,
  }
  const prompts = []
  const oc = {
    health: async () => ({ ok: true, version: '2.2.5', pid: 1 }),
    location: async () => ({ directory: '/tmp' }),
    subscribe: () => (() => {}),
    getSession: async (id) => ({ id, location: { directory: '/tmp' }, model: null, title: 't' }),
    createSession: async () => ({ id: 'ses_new', location: { directory: '/tmp' }, model: null }),
    prompt: async (id, text) => {
      prompts.push({ id, text })
      return {}
    },
    interrupt: async (id) => {
      prompts.push({ interrupt: id })
      return interruptOk
    },
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
  const bridge = new Bridge({ oc, store, config: cfg, transport, capabilities: { type: 'opencode', label: 'opencode' } })
  return { store, transport, oc, bridge, prompts, sent }
}

try {
  // 1. 忙等：消息进 pending，回的是卡片不是纯文本
  {
    const h = makeHarness()
    const key = 'chat-busy'
    h.store.set(key, { sessionId: 'ses_run', chatId: key, directory: '/tmp' })
    h.bridge.runs.set('ses_run', {
      state: { status: 'running', startedAt: Date.now(), updatedAt: Date.now() },
      cardId: 'c1',
      chatId: key,
      meta: { key },
    })
    await h.bridge.onMessage({ chatId: key, userId: 'ou_x', text: '帮我改个 bug', messageId: 'm1', chatType: 'p2p' })
    const last = h.sent[h.sent.length - 1]
    ok(last?.kind === 'card', '忙等时回的是交互卡片，不是纯文本提示')
    ok(last?.card?.header?.title?.content?.includes('上一条任务还在执行'), '卡片标题说明上一条还在执行')
    const btns = JSON.stringify(last?.card)
    ok(btns.includes('加入队列') && btns.includes('中止当前，改发这条') && btns.includes('取消'), '卡片带三个选项按钮')
    ok(h.store.getPending(key)?.text === '帮我改个 bug', '被挡下的消息存进 pending（不再丢弃）')
    ok(h.prompts.length === 0, '忙等时没有真发消息给后端')
    h.store.flush()
  }

  // 2. 加入队列：pending 移入 queue
  {
    const h = makeHarness()
    const key = 'chat-q'
    h.store.setPending(key, { text: '第二条', userId: 'ou_x', messageId: 'm2', chatId: key })
    const r = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'enqueue', k: key }, messageId: 'c1' })
    ok(r?.toast?.content?.includes('已加入队列'), '加入队列有成功提示')
    ok(h.store.queueLength(key) === 1 && h.store.getPending(key) === null, '消息从 pending 移入 queue')
    ok(h.store.dequeue(key)?.text === '第二条', 'queue 里取回同一条消息')
    ok(h.store.queueLength(key) === 0, '取走后队列清空')
  }

  // 3. 中止当前改发这条：插队首 + interrupt
  {
    const h = makeHarness()
    const key = 'chat-s'
    h.store.set(key, { sessionId: 'ses_run', chatId: key, directory: '/tmp' })
    h.bridge.runs.set('ses_run', {
      state: { status: 'running', startedAt: Date.now(), updatedAt: Date.now() },
      cardId: 'c1',
      chatId: key,
      meta: { key },
    })
    h.store.setPending(key, { text: '插队消息', userId: 'ou_x', messageId: 'm3', chatId: key })
    h.store.enqueue(key, { text: '排队已久的', userId: 'ou_x', messageId: 'm0', chatId: key })
    const r = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'steer', k: key }, messageId: 'c1' })
    ok(r?.toast?.content?.includes('已中止当前任务'), '插队时先中止当前任务')
    ok(h.prompts.some((p) => p.interrupt === 'ses_run'), 'interrupt 打到了当前会话上')
    ok(h.store.dequeue(key)?.text === '插队消息', '插队消息排在队首（先于排队已久的）')
  }

  // 4. 取消：pending 清掉，不进队列
  {
    const h = makeHarness()
    const key = 'chat-d'
    h.store.setPending(key, { text: '算了', userId: 'ou_x', messageId: 'm4', chatId: key })
    const r = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'drop', k: key }, messageId: 'c1' })
    ok(r?.toast?.content?.includes('已取消'), '取消有提示')
    ok(h.store.getPending(key) === null && h.store.queueLength(key) === 0, '取消后 pending 与 queue 都是空的')
  }

  // 5. 排空：drainQueue 把消息真的发给后端
  {
    const h = makeHarness()
    const key = 'chat-drain'
    h.store.set(key, { sessionId: 'ses_run', chatId: key, directory: '/tmp' })
    h.store.enqueue(key, { text: '排队内容', userId: 'ou_x', messageId: 'm5', chatId: key, origin: '[来源]' })
    await h.bridge.drainQueue(key)
    ok(h.prompts.some((p) => p.text?.includes('排队内容')), 'drainQueue 把排队消息发给后端')
    ok(h.store.queueLength(key) === 0, '发过后队列清空')
  }

  // 6. 落盘：pending 与 queue 重启（重新 load）不丢
  {
    const h = makeHarness()
    const path = join(root, 'state-persist.json')
    const s1 = new Store(path)
    s1.setPending('k1', { text: '待处理', userId: 'ou_x', messageId: 'm6', chatId: 'k1' })
    s1.enqueue('k1', { text: '排队', userId: 'ou_x', messageId: 'm7', chatId: 'k1' })
    s1.flush()
    const s2 = new Store(path)
    ok(s2.getPending('k1')?.text === '待处理', 'pending 落盘后可恢复')
    ok(s2.queueLength('k1') === 1, 'queue 落盘后可恢复')
  }
} catch (err) {
  fail++
  console.log(`❌ 测试本身出错: ${err.stack || err.message}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
