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

  // 6. 连发两条忙等消息：旧的不丢、旧卡片点不动新内容
  {
    const h = makeHarness()
    const key = 'chat-two'
    h.store.set(key, { sessionId: 'ses_run', chatId: key, directory: '/tmp' })
    h.bridge.runs.set('ses_run', {
      state: { status: 'running', startedAt: Date.now(), updatedAt: Date.now() },
      cardId: 'c1',
      chatId: key,
      meta: { key },
    })
    await h.bridge.onMessage({ chatId: key, userId: 'ou_x', text: '第一条', messageId: 'm-a', chatType: 'p2p' })
    await h.bridge.onMessage({ chatId: key, userId: 'ou_x', text: '第二条', messageId: 'm-b', chatType: 'p2p' })
    ok(h.store.getPending(key)?.text === '第二条', '后到的消息成为当前 pending')
    ok(h.store.queueLength(key) === 1, '先到的那条没有丢，进了队列')
    const oldQ = h.store.data.queue[key][0].qid
    const newQ = h.store.getPending(key).qid
    const r1 = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'enqueue', k: key, q: oldQ }, messageId: 'c1' })
    ok(r1?.toast?.content?.includes('已被更新的消息取代'), '旧卡片的按钮点不动新消息（被拒并提示）')
    ok(h.store.queueLength(key) === 1, '被拒后队列还是一条（没有重复入队）')
    const r2 = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'enqueue', k: key, q: newQ }, messageId: 'c1' })
    ok(r2?.toast?.content?.includes('已加入队列'), '新卡片的按钮正常入队')
    ok(h.store.queueLength(key) === 2, '两条消息都在队列里，按到达顺序')
  }

  // 7. 任务结束后才点加入队列：补一次排空，不用等下一次任务
  {
    const h = makeHarness()
    const key = 'chat-late'
    h.store.setPending(key, { text: '迟到的点击', userId: 'ou_x', messageId: 'm-late', chatId: key })
    const qid = h.store.getPending(key).qid
    const r = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'enqueue', k: key, q: qid }, messageId: 'c1' })
    ok(r?.toast?.content?.includes('已加入队列'), '迟到点击也能入队')
    ok(h.prompts.length === 0, '刚点击还没发（等 1.5 秒让卡片落定）')
    await new Promise((res) => setTimeout(res, 2200))
    ok(h.prompts.some((p) => p.text?.includes('迟到的点击')), '任务已结束，补排空把消息发出去了')
  }

  // 8. 撞并发上限：消息留在队首，不丢
  {
    const h = makeHarness()
    h.bridge.cfg.behavior.maxParallel = 1
    const key = 'chat-cap'
    h.store.set(key, { sessionId: 'ses_run', chatId: key, directory: '/tmp' })
    h.bridge.runs.set('ses_run', {
      state: { status: 'running', startedAt: Date.now(), updatedAt: Date.now() },
      cardId: 'c1',
      chatId: key,
      meta: { key },
    })
    h.store.enqueue(key, { text: '排在后面的', userId: 'ou_x', messageId: 'm-cap', chatId: key })
    await h.bridge.drainQueue(key)
    ok(h.store.queueLength(key) === 1, '撞 maxParallel 上限时消息留在队首')
    ok(h.prompts.length === 0, '撞上限没有真发')
  }

  // 9. 重启 reconcile：队列里躺的消息被补发
  {
    const h = makeHarness()
    const key = 'chat-restart'
    h.store.enqueue(key, { text: '重启前排的', userId: 'ou_x', messageId: 'm-rs', chatId: key })
    await h.bridge.start()
    await new Promise((res) => setTimeout(res, 2200))
    ok(h.prompts.some((p) => p.text?.includes('重启前排的')), '重启后 reconcile 把队列里的消息补发出去')
  }

  // 10. 落盘：pending 与 queue 重启（重新 load）不丢
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
