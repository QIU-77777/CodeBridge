#!/usr/bin/env node
/**
 * 运行失败即转报错卡片的离线测试：不连飞书、不起真后端，全部用桩。
 *   node scripts/test-runfail.mjs
 *
 * 背景：模型提供商报错时，opencode 各版本抛出的事件名与载荷形状不一致，
 * 曾经出现过卡片停在「执行中」直到看门狗超时才收尾。兜底规则：任何带
 * error/failed 又不是工具级的事件，都把运行态翻失败并原地转卡片。
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
const { RunState } = await import(join(REPO, 'src', 'render.js'))

const root = mkdtempSync(join(tmpdir(), 'ocb-runfail-'))

function makeHarness() {
  const store = new Store(join(root, `state-${Math.random().toString(36).slice(2)}.json`))
  const calls = { cards: [], texts: [], patches: [] }
  const transport = {
    sendCard: async (chatId, card) => {
      calls.cards.push(card)
      return 'card-1'
    },
    sendText: async (chatId, text) => {
      calls.texts.push(text)
      return 'text-1'
    },
    patchCard: async (messageId, card) => {
      calls.patches.push(card)
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
    behavior: { streamIntervalMs: 1800, maxParallel: 0, idleTimeoutMs: 0, maxBodyChars: 6000 },
  }
  const bridge = new Bridge({ oc, store, config: cfg, transport, capabilities: { type: 'opencode', label: 'opencode' } })
  const startRun = (sid = 'ses_run', key = 'k1') => {
    store.set(key, { sessionId: sid, chatId: key, directory: '/tmp' })
    const state = new RunState(sid)
    state.steps = 1
    const run = { state, cardId: 'card-run', chatId: key, meta: { key }, timer: null, lastFlush: 0 }
    bridge.runs.set(sid, run)
    return run
  }
  return { store, transport, oc, bridge, calls, startRun }
}

try {
  // 1. 已知形状：session.execution.failed → 翻失败 + 原地转卡片
  {
    const h = makeHarness()
    h.startRun()
    h.bridge.onEvent({ type: 'session.execution.failed', data: { sessionID: 'ses_run', error: { message: '模型提供商报错' } } })
    ok(h.bridge.runs.get('ses_run').state.status === 'failed', 'execution.failed 把运行态翻成失败')
    ok(h.calls.patches.length === 1, '原地 patch 了执行中的卡片（没有新发卡片）')
    ok(h.calls.cards.length === 0, '没有新发消息')
    ok(JSON.stringify(h.calls.patches[0]).includes('模型提供商报错'), '报错卡片里带上错误信息')
  }

  // 2. 未知形状：message.updated 带着 error 载荷（提供商拒输入那条的真实形态）
  {
    const h = makeHarness()
    h.startRun()
    h.bridge.onEvent({
      type: 'message.updated',
      data: {
        sessionID: 'ses_run',
        error: { type: 'provider.invalid-request', message: 'The input you provided is invalid', status: 400 },
      },
    })
    ok(h.bridge.runs.get('ses_run').state.status === 'failed', '载荷带 error 的未知事件名也能翻失败')
    ok(h.calls.patches.length === 1, '同样原地转报错卡片')
    ok(
      JSON.stringify(h.calls.patches[0]).includes('/new'),
      'input invalid 类错误在卡片上给 /new 续命提示',
    )
  }

  // 3. 工具级错误不终结整个 run
  {
    const h = makeHarness()
    h.startRun()
    h.bridge.onEvent({ type: 'session.tool.error', data: { sessionID: 'ses_run', id: 't1', error: { message: '命令退出码 1' } } })
    ok(h.bridge.runs.get('ses_run').state.status === 'running', '工具级错误不把 run 判失败')
    ok(
      h.calls.patches.every((c) => !JSON.stringify(c).includes('"label":"失败"')),
      '工具级错误不把卡片转成运行失败（只更新工具状态）',
    )
  }

  // 4. 普通事件不误判
  {
    const h = makeHarness()
    h.startRun()
    h.bridge.onEvent({ type: 'session.text.delta', data: { sessionID: 'ses_run', delta: '正常输出' } })
    ok(h.bridge.runs.get('ses_run').state.status === 'running', '普通事件不影响运行态')
  }

  // 5. 已结束的 run 不被迟到的错误事件二次翻动
  {
    const h = makeHarness()
    const run = h.startRun()
    run.state.status = 'done'
    h.bridge.onEvent({ type: 'message.error', data: { sessionID: 'ses_run', error: { message: '迟到的错误' } } })
    ok(h.bridge.runs.get('ses_run').state.status === 'done', '已 done 的 run 不被迟到错误改成失败')
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
