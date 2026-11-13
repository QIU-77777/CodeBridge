#!/usr/bin/env node
/**
 * 加塞消息的离线测试：不连飞书、不起真后端，全部用桩。
 *   node scripts/test-busy.mjs
 *
 * 覆盖：忙等时消息默认按 follow-up 排进队列（不用用户点）、卡片带两个改主意
 * 的按钮（中止当前改发这条 / 取消）、按 qid 定位同一条、任务收尾后自动排空、
 * 队列落盘重启不丢。
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

/** 造一个「上一条还在跑」的现场，返回绑定键 */
function busyRun(h, key, sessionId = 'ses_run') {
  h.store.set(key, { sessionId, chatId: key, directory: '/tmp' })
  h.bridge.runs.set(sessionId, {
    state: { status: 'running', startedAt: Date.now(), updatedAt: Date.now() },
    cardId: 'c1',
    chatId: key,
    meta: { key },
  })
  return key
}

function makeHarness({ interruptOk = true, caps = { type: 'opencode', label: 'opencode', steer: true } } = {}) {
  const store = new Store(join(root, `state-${Math.random().toString(36).slice(2)}.json`))
  const sent = []
  const patched = []
  const transport = {
    sendCard: async (chatId, card, opts) => {
      sent.push({ kind: 'card', chatId, card, opts })
      return `card-${sent.length}`
    },
    sendText: async (chatId, text, opts) => {
      sent.push({ kind: 'text', chatId, text, opts })
      return 'text-1'
    },
    patchCard: async (messageId, card) => {
      patched.push({ messageId, card })
      return true
    },
  }
  const prompts = []
  const oc = {
    health: async () => ({ ok: true, version: '2.2.5', pid: 1 }),
    location: async () => ({ directory: '/tmp' }),
    subscribe: () => (() => {}),
    getSession: async (id) => ({ id, location: { directory: '/tmp' }, model: null, title: 't' }),
    createSession: async () => ({ id: 'ses_new', location: { directory: '/tmp' }, model: null }),
    prompt: async (id, text, opts = {}) => {
      prompts.push({ id, text, delivery: opts.delivery })
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
  const bridge = new Bridge({ oc, store, config: cfg, transport, capabilities: caps })
  return { store, transport, oc, bridge, prompts, sent, patched }
}

try {
  // 1. 忙等：消息默认排进队列，回的是卡片不是纯文本
  {
    const h = makeHarness()
    const key = busyRun(h, 'chat-busy')
    await h.bridge.onMessage({ chatId: key, userId: 'ou_x', text: '帮我改个 bug', messageId: 'm1', chatType: 'p2p' })
    const last = h.sent[h.sent.length - 1]
    ok(last?.kind === 'card', '忙等时回的是交互卡片，不是纯文本提示')
    ok(last?.card?.header?.title?.content?.includes('已加入队列'), '卡片标题说明已加入队列')
    const btns = JSON.stringify(last?.card)
    ok(btns.includes('引导') && btns.includes('取消'), '卡片带两个改主意的按钮')
    // 按钮标签收在这里：标题里的「已加入队列」不是按钮，不能拿来证明有第三个按钮
    const btnLabels = []
    const walk = (o) => {
      if (Array.isArray(o)) o.forEach(walk)
      else if (o && typeof o === 'object') {
        if (o.tag === 'button') btnLabels.push(o.text?.content || '')
        Object.values(o).forEach(walk)
      }
    }
    walk(last?.card)
    ok(btnLabels.length === 2, '整张卡片只有两个按钮', JSON.stringify(btnLabels))
    ok(!btnLabels.some((l) => l.includes('加入队列')), '没有「加入队列」按钮——它已经是默认动作，不用点')
    ok(h.store.queueLength(key) === 1, '消息默认进队列，不需要用户点任何按钮')
    // 排队条目要记下这张卡的 ID，否则消息发出去后没人能翻新它
    ok(Boolean(h.store.data.queue[key]?.[0]?.cardId), '排队条目记下了卡片的 ID')
    ok(h.store.dequeue(key)?.text === '帮我改个 bug', '队列里就是这条消息')
    ok(h.prompts.length === 0, '忙等时没有真发消息给后端')
    h.store.flush()
  }

  // 2. 连发两条：都按顺序排进队列，各自一张卡片，排位各不相同
  {
    const h = makeHarness()
    const key = busyRun(h, 'chat-two')
    await h.bridge.onMessage({ chatId: key, userId: 'ou_x', text: '第一条', messageId: 'm-a', chatType: 'p2p' })
    await h.bridge.onMessage({ chatId: key, userId: 'ou_x', text: '第二条', messageId: 'm-b', chatType: 'p2p' })
    ok(h.store.queueLength(key) === 2, '两条消息都进了队列，按到达顺序')
    ok(h.store.dequeue(key)?.text === '第一条', '先到的排在前面')
    ok(h.store.dequeue(key)?.text === '第二条', '后到的排在后面')
    const cards = h.sent.filter((s) => s.kind === 'card')
    ok(cards.length === 2, '每条消息各回一张卡片')
    const body2 = JSON.stringify(cards[1].card)
    ok(body2.includes('第 2 位'), '第二张卡片告诉用户排在第 2 位')
  }

  // 2b. 不支持 steer 的后端（桩后端，caps.steer=false；真实 pi 现在也有 steer）：
  // 排队卡片只有取消，没有引导
  {
    const h = makeHarness({ caps: { type: 'pi', label: 'pi', steer: false } })
    const key = busyRun(h, 'chat-nosteer')
    await h.bridge.onMessage({ chatId: key, userId: 'ou_x', text: '帮我跑个测试', messageId: 'm-ns', chatType: 'p2p' })
    const last = h.sent[h.sent.length - 1]
    ok(last?.kind === 'card', '不支持 steer 时回的也是卡片')
    const btnLabels = []
    const walk = (o) => {
      if (Array.isArray(o)) o.forEach(walk)
      else if (o && typeof o === 'object') {
        if (o.tag === 'button') btnLabels.push(o.text?.content || '')
        Object.values(o).forEach(walk)
      }
    }
    walk(last?.card)
    ok(btnLabels.length === 1 && btnLabels[0].includes('取消'), '不支持 steer 的排队卡片只有取消一个按钮', JSON.stringify(btnLabels))
    ok(!btnLabels.some((l) => l.includes('引导')), '不支持 steer 的排队卡片没有「引导」按钮')
    ok(JSON.stringify(last?.card).includes('不支持中途引导'), '不支持 steer 的排队卡片说明为什么不给引导')
    ok(h.store.queueLength(key) === 1, '不支持 steer 时消息同样默认进队列')
  }

  // 3. 引导（支持 steer 的后端）：消息出队，以 delivery=steer 注入正在跑的
  // 会话，不中止、不清除已有工作——这是行业里 steer 的定义
  {
    const h = makeHarness()
    const key = busyRun(h, 'chat-s')
    h.store.enqueue(key, { text: '排队已久的', userId: 'ou_x', messageId: 'm0', chatId: key })
    h.store.enqueue(key, { text: '插队消息', userId: 'ou_x', messageId: 'm3', chatId: key })
    h.store.setQueuedCard(key, h.store.data.queue[key][1].qid, 'card-steer')
    const qid = h.store.data.queue[key][1].qid
    const r = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'steer', k: key, q: qid }, messageId: 'c1' })
    ok(r?.toast?.content?.includes('已引导'), 'steer 的提示说已引导')
    ok(h.prompts.some((p) => p.text === '插队消息' && p.delivery === 'steer'), '消息以 delivery=steer 注入当前会话')
    ok(!h.prompts.some((p) => p.interrupt === 'ses_run'), 'steer 不中止当前任务')
    ok(h.store.queueLength(key) === 1, '被引导的消息出队（不留在队列里重复发送）')
    ok(h.store.dequeue(key)?.text === '排队已久的', '队列里剩下的那条没被动')
    const patch = h.patched.find((p) => p.messageId === 'card-steer')
    ok(Boolean(patch), '引导后翻新排队卡片')
    ok(patch?.card?.header?.title?.content?.includes('已引导'), '翻新后的标题说明已引导', patch?.card?.header?.title?.content)
    ok(!JSON.stringify(patch?.card).includes('取消'), '翻新后撤掉按钮')
  }

  // 3b. steer 注入失败：消息不丢，放回队首并按老路数中止改发
  {
    const h = makeHarness()
    const key = busyRun(h, 'chat-s-fail')
    h.store.enqueue(key, { text: '注入会失败', userId: 'ou_x', messageId: 'm-f', chatId: key })
    h.store.setQueuedCard(key, h.store.data.queue[key][0].qid, 'card-steer-fail')
    h.oc.prompt = async () => { throw new Error('serve 不认识 delivery') }
    const qid = h.store.data.queue[key][0].qid
    const r = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'steer', k: key, q: qid }, messageId: 'c1' })
    ok(r?.toast?.content?.includes('注入失败'), '注入失败有明确提示')
    ok(h.store.queueLength(key) === 1, '注入失败的消息放回队列，不丢')
    ok(h.store.dequeue(key)?.text === '注入会失败', '放回的是同一条')
    ok(h.prompts.some((p) => p.interrupt === 'ses_run'), '注入失败后退回中断改发')
  }

  // 3c. bot 之间的 @ 忙时直接 steer：不入队、不中断、群里看得到反馈。
  // 群消息的 key 由 rootId 推出（与生产一致：feishu.js 的 root: 前缀）
  {
    const h = makeHarness()
    const key = busyRun(h, 'root:om_bot_root')
    await h.bridge.onMessage({
      chatId: 'oc_group',
      rootId: 'om_bot_root',
      userId: 'ou_bot_p',
      text: 'Lil_O 顺便看下这个',
      messageId: 'm-bot-1',
      chatType: 'group',
      isBot: true,
    })
    ok(
      h.prompts.some((p) => p.id === 'ses_run' && p.text === 'Lil_O 顺便看下这个' && p.delivery === 'steer'),
      'bot 的 @ 以 delivery=steer 注入当前会话',
    )
    ok(!h.prompts.some((p) => p.interrupt === 'ses_run'), 'steer 不中止当前任务')
    ok(h.store.queueLength(key) === 0, 'bot 的 @ 不进队列——没有二次唤醒')
    ok(h.sent.filter((s) => s.kind === 'card').length === 0, '不弹排队卡片')
    const last = h.sent[h.sent.length - 1]
    ok(last?.kind === 'text' && /已引导/.test(last.text), '群里收到一条注入反馈', last?.text)
    ok(last?.opts?.replyTo === 'om_bot_root', '反馈发在话题里')
  }

  // 3d. bot @ 的 steer 注入失败：消息不丢，退回排队（人类的默认路）
  {
    const h = makeHarness()
    const key = busyRun(h, 'chat-bot-fail')
    h.oc.prompt = async () => { throw new Error('serve 返回 400') }
    await h.bridge.onMessage({ chatId: key, userId: 'ou_bot_p', text: '注不进去的那条', messageId: 'm-bot-2', chatType: 'p2p', isBot: true })
    ok(h.prompts.length === 0, '注入失败没有把消息发给后端')
    ok(h.store.queueLength(key) === 1, '注入失败退回排队，消息不丢')
    ok(h.store.dequeue(key)?.text === '注不进去的那条', '排队的是同一条')
    const last = h.sent[h.sent.length - 1]
    ok(last?.kind === 'card' && JSON.stringify(last.card).includes('已加入队列'), '退回排队时补一张排队卡片')
  }

  // 3e. 人类的 @ 忙时仍然排队：steer 只分给 bot，不改变人的默认行为
  {
    const h = makeHarness()
    const key = busyRun(h, 'chat-human')
    await h.bridge.onMessage({ chatId: key, userId: 'ou_x', text: '人的消息', messageId: 'm-human', chatType: 'p2p' })
    ok(!h.prompts.some((p) => p.delivery === 'steer'), '人类的 @ 不被 steer 分流')
    ok(h.store.queueLength(key) === 1, '人类的 @ 照旧进队列')
    ok(h.sent[h.sent.length - 1]?.kind === 'card', '人类的 @ 照旧回排队卡片')
  }

  // 3f. 不支持 steer 的后端（桩后端，caps.steer=false）：bot 的 @ 也按排队处理
  {
    const h = makeHarness({ caps: { type: 'pi', label: 'pi', steer: false } })
    const key = busyRun(h, 'chat-bot-pi')
    await h.bridge.onMessage({ chatId: key, userId: 'ou_bot_p', text: 'pi 侧的 @', messageId: 'm-bot-3', chatType: 'p2p', isBot: true })
    ok(h.prompts.length === 0, '没有注入通道时不假装 steer')
    ok(h.store.queueLength(key) === 1, '没有注入通道时 bot 的 @ 照旧排队')
  }

  // 3g. 不忙时 bot 的 @ 走正常 prompt，不带 delivery
  {
    const h = makeHarness()
    const key = 'chat-bot-idle'
    h.store.set(key, { sessionId: 'ses_run', chatId: key, directory: '/tmp' })
    await h.bridge.onMessage({ chatId: key, userId: 'ou_bot_p', text: '不忙时的 @', messageId: 'm-bot-4', chatType: 'p2p', isBot: true })
    ok(h.prompts.length === 1 && h.prompts[0].delivery === undefined, '不忙时按普通消息发给后端', JSON.stringify(h.prompts))
    ok(h.store.queueLength(key) === 0, '不忙时不入队')
  }

  // 4. 取消：按 qid 从队列里摘掉
  {
    const h = makeHarness()
    const key = 'chat-d'
    h.store.enqueue(key, { text: '算了', userId: 'ou_x', messageId: 'm4', chatId: key })
    h.store.enqueue(key, { text: '还要', userId: 'ou_x', messageId: 'm4b', chatId: key })
    const qid = h.store.data.queue[key][0].qid
    h.store.setQueuedCard(key, h.store.data.queue[key][0].qid, 'card-drop')
    const r = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'drop', k: key, q: qid }, messageId: 'c1' })
    ok(r?.toast?.content?.includes('已取消'), '取消有提示')
    ok(h.store.queueLength(key) === 1, '只摘掉被点的那条')
    ok(h.store.dequeue(key)?.text === '还要', '队列里剩下的那条没被动')
    // 取消后那张「已加入队列」也得翻新，不然它还挂着两个点不动的按钮
    const patch = h.patched.find((p) => p.messageId === 'card-drop')
    ok(Boolean(patch), '取消时翻新了排队卡片')
    ok(patch?.card?.header?.title?.content?.includes('已取消'), '翻新后的标题说明已取消', patch?.card?.header?.title?.content)
    ok(!JSON.stringify(patch?.card).includes('引导'), '翻新后撤掉「引导」')
  }

  // 5. 按钮点的是已经发出去的消息：明确提示，不静默
  {
    const h = makeHarness()
    const key = 'chat-gone'
    const r = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'steer', k: key, q: 'q-nope' }, messageId: 'c1' })
    ok(r?.toast?.content?.includes('不在队列里'), '队列里没有这条时按钮给明确提示')
  }

  // 6. 排空：drainQueue 把消息真的发给后端
  {
    const h = makeHarness()
    const key = 'chat-drain'
    h.store.set(key, { sessionId: 'ses_run', chatId: key, directory: '/tmp' })
    h.store.enqueue(key, { text: '排队内容', userId: 'ou_x', messageId: 'm5', chatId: key, origin: '[来源]' })
    h.store.setQueuedCard(key, h.store.data.queue[key][0].qid, 'card-queued')
    await h.bridge.drainQueue(key)
    ok(h.prompts.some((p) => p.text?.includes('排队内容')), 'drainQueue 把排队消息发给后端')
    ok(h.store.queueLength(key) === 0, '发过后队列清空')

    // 排队卡片要翻新：它还挂着「已加入队列」和两个按钮，而消息已经发出去了
    const patch = h.patched.find((p) => p.messageId === 'card-queued')
    ok(Boolean(patch), '出队时翻新了排队卡片')
    ok(patch?.card?.header?.title?.content?.includes('已开始处理'), '翻新后的标题说明已开始处理', patch?.card?.header?.title?.content)
    ok(!JSON.stringify(patch?.card).includes('引导'), '翻新后撤掉「引导」——消息已发出，点不动了')
    ok(!JSON.stringify(patch?.card).includes('取消'), '翻新后撤掉「取消」')
  }

  // 6b. 排队卡片翻新失败不影响消息发出
  {
    const h = makeHarness()
    const key = 'chat-drain-fail'
    h.store.set(key, { sessionId: 'ses_run', chatId: key, directory: '/tmp' })
    h.store.enqueue(key, { text: '内容', userId: 'ou_x', messageId: 'm6', chatId: key })
    h.store.setQueuedCard(key, h.store.data.queue[key][0].qid, 'card-x')
    h.transport.patchCard = async () => {
      throw new Error('飞书 400')
    }
    await h.bridge.drainQueue(key)
    ok(h.prompts.some((p) => p.text?.includes('内容')), '卡片翻新失败消息照样发出去')
  }

  // 6c. 没有 cardId 的存量条目（改动前入的队）不翻新，也不报错
  {
    const h = makeHarness()
    const key = 'chat-drain-nocard'
    h.store.set(key, { sessionId: 'ses_run', chatId: key, directory: '/tmp' })
    h.store.enqueue(key, { text: '老条目', userId: 'ou_x', messageId: 'm7', chatId: key })
    await h.bridge.drainQueue(key)
    ok(h.patched.length === 0, '没有 cardId 的条目跳过翻新')
  }

  // 7. 任务结束后才点改发：补一次排空，不用等下一次任务
  {
    const h = makeHarness()
    const key = 'chat-late'
    h.store.enqueue(key, { text: '迟到的点击', userId: 'ou_x', messageId: 'm-late', chatId: key })
    const qid = h.store.data.queue[key][0].qid
    const r = await h.bridge.onCardAction({ chatId: key, userId: 'ou_x', action: { a: 'steer', k: key, q: qid }, messageId: 'c1' })
    ok(r?.toast?.content?.includes('当前任务已结束'), '任务已经结束也有提示')
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

  // 10. 落盘：队列重新 load 不丢，qid 也带回来（按钮还点得动）
  {
    const path = join(root, 'state-persist.json')
    const s1 = new Store(path)
    s1.enqueue('k1', { text: '排队', userId: 'ou_x', messageId: 'm7', chatId: 'k1' })
    const qid = s1.data.queue.k1[0].qid
    s1.flush()
    const s2 = new Store(path)
    ok(s2.queueLength('k1') === 1, 'queue 落盘后可恢复')
    ok(s2.data.queue.k1[0].qid === qid, 'qid 一起落盘，重启后按钮仍对得上同一条')
    ok(s2.removeQueued('k1', qid)?.text === '排队', '按 qid 摘得掉落盘恢复的那条')
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
