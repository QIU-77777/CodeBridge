#!/usr/bin/env node
/**
 * 卡片 patch 串行与合并的离线测试：不连飞书、不起真后端，全部用桩。
 *   node scripts/test-patch-order.mjs
 *
 * 背景（真实事故，2026-11-07）：pi 后端跑完「阅读一下这个项目」后，飞书卡片
 * 永远停在「⏳ 执行中」——标题是执行中，正文却是完整答案，前缀还没有模型。
 * 根因：finish() 在同一时刻连发 text.delta / usage / backend.meta / succeeded
 * 四个事件，前一个触发一次立即 patch，后一个又触发一次，两个请求同时在途，
 * 飞书侧的生效顺序没有保证：「已完成」快照先到、「执行中」快照后到，卡片
 * 就停在旧状态。修复（src/handler.js 的 flushRun）：同一张卡的 patch 串行
 * 发出，在途期间到达的刷新合并，快照在发送时构建，终态一定最后生效。
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
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const { Bridge } = await import(join(REPO, 'src', 'handler.js'))
const { RunState } = await import(join(REPO, 'src', 'render.js'))

const root = mkdtempSync(join(tmpdir(), 'ocb-patch-order-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = () => sleep(0)

/**
 * 传输桩：patch 的落地时机由测试控制（autoLandMs=0 时手动 land），
 * 记录发送顺序、发送时间和最终落地顺序，用来断言「终态一定最后生效」。
 */
function makeHarness({ autoLandMs = 0, rejectPatches = false, streamIntervalMs = 1800 } = {}) {
  const bindings = new Map()
  const inflight = new Map()
  const sent = [] // { id, card, sentAt }
  const landed = [] // 按落地顺序（模拟飞书最终状态）
  const pending = [] // 未落地的 patch 的 land 函数

  const transport = {
    sendCard: async () => 'card-1',
    sendText: async () => 'text-1',
    patchCard: (id, card) =>
      new Promise((resolve, reject) => {
        sent.push({ id, card, sentAt: Date.now() })
        const land = () => {
          landed.push(card)
          if (rejectPatches) reject(new Error('模拟飞书 patch 失败'))
          else resolve(true)
        }
        if (autoLandMs > 0) setTimeout(land, autoLandMs)
        else pending.push(land)
      }),
  }
  const store = {
    get: (k) => bindings.get(k) || null,
    set: (k, v) => bindings.set(k, { ...(bindings.get(k) || {}), ...v }),
    inflightList: () => [...inflight.entries()].map(([sessionId, v]) => ({ sessionId, ...v })),
    clearInflight: (sid) => inflight.delete(sid),
    queueLength: () => 0,
  }
  const bridge = new Bridge({
    oc: { interrupt: async () => true },
    store,
    config: { feishu: { allowlist: [] }, behavior: { streamIntervalMs, maxParallel: 0 } },
    transport,
    capabilities: { type: 'pi', label: 'pi' },
    logger: { info() {}, warn() {}, error() {} },
  })
  const startRun = (sid = 'ses_a', key = 'root:om_1') => {
    const st = new RunState(sid)
    st.startedAt = Date.now() - 5000
    const run = {
      state: st,
      cardId: 'card_a',
      chatId: 'oc_g',
      replyTo: 'om_1',
      timer: null,
      lastFlush: 0,
      meta: { directory: root, title: '飞书', key, rootId: 'om_1', isGroup: true },
    }
    bridge.runs.set(sid, run)
    inflight.set(sid, { cardId: 'card_a', chatId: 'oc_g', key, directory: root, startedAt: st.startedAt })
    return run
  }
  return {
    bridge,
    store,
    transport,
    sent,
    landed,
    startRun,
    landOne: () => pending.shift()?.(),
    pendingCount: () => pending.length,
  }
}

const TITLE = (card) => card?.header?.title?.content || ''

try {
  // 1. 事故时刻：文本和终态在同一刻到达，patch 必须串行，终态最后生效
  {
    const h = makeHarness()
    h.startRun('ses_a')
    h.bridge.onEvent({ type: 'session.text.delta', data: { sessionID: 'ses_a', delta: '项目已经读完。' } })
    h.bridge.onEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } })
    await tick()
    ok(h.sent.length === 1, '同一时刻到达的多次刷新只发起一个 patch（旧实现这里有两个同时在途）')
    ok(h.pendingCount() === 1, '第一个 patch 在途')
    ok(h.sent.every((p) => p.id === 'card_a'), 'patch 打在这张运行卡片上，不发错消息')
    ok(/执行中/.test(TITLE(h.sent[0]?.card)), '在途的那个带刚收到的正文，状态还是执行中')

    h.landOne()
    await tick()
    ok(h.sent.length === 2, '在途 patch 落地后，积压的终态刷新才发出（串行，不并发）')
    ok(h.pendingCount() === 1, '第二个 patch 在途')

    h.landOne()
    await tick()
    ok(/已完成/.test(TITLE(h.landed.at(-1))), '最后落地的是终态快照，不是执行中')
    ok(/项目已经读完/.test(JSON.stringify(h.landed.at(-1))), '终态快照带正文')
    ok(/执行中/.test(TITLE(h.landed[0])), '第一个落地的是运行中快照，顺序正确')
    ok(h.store.inflightList().length === 0, '终态落地后 inflight 记录被清掉（重启不会误标成中断）')
  }

  // 2. 终态 patch 排在在途 patch 之后发出：飞书按完成顺序生效也盖不掉终态
  {
    const h = makeHarness()
    h.startRun('ses_b')
    h.bridge.onEvent({ type: 'session.text.delta', data: { sessionID: 'ses_b', delta: '答案' } })
    h.bridge.onEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_b' } })
    await tick()
    const t = Date.now()
    h.landOne()
    await sleep(30) // 故意多等：旧实现第二个 patch 早在在途期间就已发出
    ok(h.sent.length === 2 && h.sent[1].sentAt >= t, '第二个 patch 在第一个落地之后才发出（发送顺序即落地顺序）')
    h.landOne()
    await tick()
    ok(/已完成/.test(TITLE(h.landed.at(-1))), '无论飞书侧处理快慢，终态都是最后一个生效的')
  }

  // 3. 在途期间积压的多次刷新合并：快照在发送时构建，永远最新
  {
    // streamIntervalMs=0：每个事件都立即走 flushRun，在途期间到达的刷新
    // 只标记 patchDue，由在途那次落地后带上最新快照一起发（合并）
    const h = makeHarness({ autoLandMs: 30, streamIntervalMs: 0 })
    h.startRun('ses_c')
    for (let i = 1; i <= 6; i++) {
      h.bridge.onEvent({ type: 'session.text.delta', data: { sessionID: 'ses_c', delta: `第${i}段` } })
    }
    await tick()
    ok(h.sent.length === 1, '在途期间积压的 5 次刷新没有各自发 patch，合并到在途那次之后')
    await sleep(150) // 等自动落地把队列排空
    ok(h.sent.length === 2, `6 次刷新一共只发 2 个 patch（实际 ${h.sent.length} 个）`)
    ok(/第6段/.test(JSON.stringify(h.landed.at(-1))), '合并后发出的快照带最新文本，不发陈旧快照')
    ok(/第1段/.test(JSON.stringify(h.landed[0])) && !/第6段/.test(JSON.stringify(h.landed[0])), '第一个快照是它发送时的状态，不掺杂后来的文本')
  }

  // 3b. 节流仍然生效：窗口内的刷新不逐个发，最新文本在下一个窗口落地
  {
    const h = makeHarness({ autoLandMs: 30, streamIntervalMs: 200 })
    h.startRun('ses_c2')
    for (let i = 1; i <= 6; i++) {
      h.bridge.onEvent({ type: 'session.text.delta', data: { sessionID: 'ses_c2', delta: `第${i}段` } })
    }
    await tick()
    ok(h.sent.length === 1, '节流窗口内的连续刷新只发第一个')
    await sleep(500) // 等节流定时器把最新状态发出去
    ok(h.sent.length === 2, `节流窗口过后补发一次最新快照（实际 ${h.sent.length} 次）`)
    ok(/第6段/.test(JSON.stringify(h.landed.at(-1))), '补发的快照带最新文本')
  }

  // 4. patch 失败不卡住收尾：状态照常进终态，inflight 照常清
  {
    const h = makeHarness({ autoLandMs: 10, rejectPatches: true })
    const run = h.startRun('ses_d')
    h.bridge.onEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_d' } })
    await sleep(40)
    ok(run.flushed === true, 'patch 失败也照样收尾，不卡在终态（看门狗的安全网之外多一道保证）')
    ok(h.store.inflightList().length === 0, 'inflight 被清掉')
    ok(run.state.status === 'done', '运行态仍然是 done，没有被失败拖成 running')
  }

  // 5. 中止按钮：内存里有 run 时也是同一条串行队列，不会和在途 patch 抢
  {
    const h = makeHarness()
    h.startRun('ses_e')
    h.bridge.onEvent({ type: 'session.text.delta', data: { sessionID: 'ses_e', delta: '半句' } })
    await tick()
    await h.bridge.onCardAction({
      chatId: 'oc_g',
      userId: 'ou_u',
      messageId: 'card_a',
      action: { a: 'abort', s: 'ses_e', k: 'root:om_1', rt: 'om_1' },
    })
    h.landOne()
    await tick()
    h.landOne()
    await tick()
    ok(/已中止/.test(TITLE(h.landed.at(-1))), '中止后落地的终态是已中止')
    ok(/半句/.test(JSON.stringify(h.landed.at(-1))), '中止卡片带上已经流到的正文，不是空白')
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
