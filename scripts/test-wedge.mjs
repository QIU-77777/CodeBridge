#!/usr/bin/env node
/**
 * 卡片更新卡死的测试：SDK 请求超时 + 看门狗收殓卡在终态的 run。
 *   node scripts/test-wedge.mjs
 *
 * 背景（人类实测）：pi 机器人回复成功后，飞书卡片永远停在「执行中」。
 * 根因是 SDK 底层 HTTP 请求没有超时，长驻进程里静默死亡的 keep-alive
 * socket 让终态 patch 永挂，flushRun 走不到收尾，run 卡在终态，看门狗
 * 只认 running 也收不了殓。修复：SDK 调用加超时 + 看门狗加安全网。
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
const { FeishuTransport } = await import(join(REPO, 'src', 'feishu.js'))
const { RunState } = await import(join(REPO, 'src', 'render.js'))

const root = mkdtempSync(join(tmpdir(), 'ocb-wedge-'))

function makeBridge({ patchHangs = false } = {}) {
  const store = new Store(join(root, `state-${Math.random().toString(36).slice(2)}.json`))
  const patches = []
  const transport = {
    sendCard: async () => 'card-1',
    sendText: async () => 'text-1',
    patchCard: async () => {
      patches.push(1)
      if (patchHangs) return new Promise(() => {}) // 永挂，模拟 SDK 请求卡死
      return true
    },
  }
  const oc = {
    health: async () => ({ ok: true, version: '2.2.5', pid: 1 }),
    location: async () => ({ directory: '/tmp' }),
    subscribe: () => (() => {}),
    getSession: async (id) => ({ id, location: { directory: '/tmp' } }),
    createSession: async () => ({ id: 'ses_new', location: { directory: '/tmp' } }),
    prompt: async () => ({}),
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
    behavior: { streamIntervalMs: 1800, maxParallel: 0, idleTimeoutMs: 900000, maxBodyChars: 6000 },
  }
  const bridge = new Bridge({ oc, store, config: cfg, transport, capabilities: { type: 'opencode', label: 'opencode' } })
  const startRun = (sid = 'ses_run', key = 'k1') => {
    store.set(key, { sessionId: sid, chatId: key, directory: '/tmp' })
    const state = new RunState(sid)
    state.steps = 1
    const run = { state, cardId: 'card-run', chatId: key, meta: { key }, timer: null, lastFlush: 0 }
    bridge.runs.set(sid, run)
    store.setInflight(sid, { cardId: 'card-run', chatId: key, key, directory: '/tmp', startedAt: Date.now() })
    return run
  }
  return { store, bridge, patches, startRun }
}

try {
  // 1. SDK 请求永挂 → 超时抛错，不无限等
  {
    process.env.OCB_SDK_TIMEOUT_MS = '300'
    const ft = new FeishuTransport(
      { feishu: { appId: 'cli_x', appSecret: 'y', domain: 'feishu' } },
      { onMessage() {}, onCardAction() {}, nameOf() {} },
    )
    ft.client.im.v1.message.patch = () => new Promise(() => {}) // 永挂
    const keepAlive = setInterval(() => {}, 1000) // 超时定时器是 unref 的，测试里自己保活
    const t0 = Date.now()
    let msg = ''
    await ft.patchCard('msg-1', {}).catch((e) => { msg = e.message })
    clearInterval(keepAlive)
    const waited = Date.now() - t0
    ok(/超过 0.3 秒未响应/.test(msg), 'SDK 请求超时后抛错', msg)
    ok(waited < 3000, '超时按时生效，没有多等', `${waited}ms`)
    delete process.env.OCB_SDK_TIMEOUT_MS
  }

  // 2. 终态 patch 挂住 → run 卡在终态 → 看门狗收殓
  {
    const h = makeBridge({ patchHangs: true })
    const run = h.startRun()
    h.bridge.onEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_run' } })
    ok(run.state.status === 'done', '终态事件把状态翻到 done')
    ok(run.flushed !== true, 'patch 挂住时 flushed 未置位（收尾没走完）')
    ok(h.store.inflightList().length === 1, 'inflight 记录还在（没收尾）')
    // 模拟时间过去 3 分钟，跑看门狗
    run.terminalAt = Date.now() - 3 * 60_000
    h.bridge.checkIdle(60_000)
    ok(!h.bridge.runs.get('ses_run'), '看门狗收殓了卡在终态的 run')
    ok(h.store.inflightList().length === 0, 'inflight 记录被清掉')
  }

  // 3. 正常终态（patch 成功）→ 不被看门狗误收殓
  {
    const h = makeBridge()
    const run = h.startRun()
    h.bridge.onEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_run' } })
    await new Promise((r) => setTimeout(r, 50))
    ok(run.flushed === true, 'patch 成功后 flushed 置位')
    run.terminalAt = Date.now() - 3 * 60_000
    h.bridge.checkIdle(60_000)
    ok(h.bridge.runs.get('ses_run') != null, '正常收尾的 run 不被安全网误删')
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
