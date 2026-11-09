#!/usr/bin/env node
/**
 * 命令分流的离线测试：不连飞书、不起真后端，全部用桩。
 *   node scripts/test-cmd-route.mjs
 *
 * 覆盖「@ 还原」与「命令分流」的交互。真实事故形态：@ 占位符从删除改为
 * 还原之后，群里「@Lil_P /help」的正文变成「@Lil_P /help」，不再以 / 开头，
 * handler 的 startsWith('/') 认不出它，命令被当普通消息发给模型——help
 * 卡片、/new、/stop 全部失效且不报错。修法是 feishu.js 额外给 cmdText
 * （剥掉开头 @ 的版本），handler 用它判命令。
 */
import { mkdtempSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'ocb-cmd-'))

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
    health: async () => ({ ok: true, version: '2.2.5', pid: 1 }),
    location: async () => ({ directory: '/tmp' }),
    subscribe: () => (() => {}),
    getSession: async (id) => ({ id, location: { directory: '/tmp' }, model: null, title: 't' }),
    createSession: async () => ({ id: 'ses_new', location: { directory: '/tmp' }, model: null }),
    prompt: async (id, text) => {
      prompts.push({ id, text })
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
  const bridge = new Bridge({ oc, store, config: cfg, transport, capabilities: { type: 'opencode', label: 'opencode' } })
  // 命令路径只验证「分流是否走到 onCommand」：onCommand 自身另有测试，
  // 这里换成一个记录桩，避免真去解析命令、回卡片
  const commands = []
  bridge.onCommand = async (msg, ctx) => {
    commands.push({ text: msg.text, key: ctx.key })
  }
  return { store, transport, oc, bridge, prompts, sent, commands }
}

try {
  // 1. 群里「@我 /help」：text 带 @，cmdText 剥掉 @，走命令不走 prompt
  {
    const h = makeHarness()
    await h.bridge.onMessage({
      chatId: 'oc_g',
      userId: 'ou_x',
      text: '@Lil_O /help',
      cmdText: '/help',
      messageId: 'm1',
      chatType: 'group',
      key: 'root:om_r1',
      rootId: 'om_r1',
    })
    ok(h.commands.length === 1, '「@我 /help」走 onCommand，不被当普通消息')
    ok(h.commands[0]?.text === '/help', 'onCommand 收到剥干净的 /help', JSON.stringify(h.commands[0]))
    ok(h.prompts.length === 0, '没有把命令当 prompt 发给后端')
    h.store.flush()
  }

  // 2. 不带 @ 的普通命令：cmdText 与 text 相同，照旧走命令
  {
    const h = makeHarness()
    await h.bridge.onMessage({
      chatId: 'oc_g',
      userId: 'ou_x',
      text: '/stop',
      cmdText: '/stop',
      messageId: 'm2',
      chatType: 'group',
      key: 'root:om_r2',
      rootId: 'om_r2',
    })
    ok(h.commands.length === 1 && h.commands[0].text === '/stop', '不带 @ 的 /stop 照旧走命令')
    h.store.flush()
  }

  // 3. 私聊命令：没有 @ 占位符，cmdText 就是 text
  {
    const h = makeHarness()
    await h.bridge.onMessage({
      chatId: 'oc_dm',
      userId: 'ou_x',
      text: '/new',
      cmdText: '/new',
      messageId: 'm3',
      chatType: 'p2p',
    })
    ok(h.commands.length === 1 && h.commands[0].text === '/new', '私聊 /new 走命令')
    ok(h.prompts.length === 0, '私聊命令不发 prompt')
    h.store.flush()
  }

  // 4. 老调用方没有 cmdText（fallback 路径）：text 以 / 开头照旧走命令
  {
    const h = makeHarness()
    await h.bridge.onMessage({
      chatId: 'oc_dm',
      userId: 'ou_x',
      text: '/help',
      messageId: 'm4',
      chatType: 'p2p',
    })
    ok(h.commands.length === 1 && h.commands[0].text === '/help', '没有 cmdText 时退回 text 判定，行为不回归')
    h.store.flush()
  }

  // 5. 普通消息：不以 / 开头，走 prompt 不走命令
  {
    const h = makeHarness()
    await h.bridge.onMessage({
      chatId: 'oc_g',
      userId: 'ou_x',
      text: '@Lil_O 帮我看下',
      cmdText: '帮我看下',
      messageId: 'm5',
      chatType: 'group',
      key: 'root:om_r5',
      rootId: 'om_r5',
    })
    ok(h.commands.length === 0, '普通消息不走命令')
    ok(h.prompts.length === 1, '普通消息走 prompt')
    h.store.flush()
  }
} catch (err) {
  fail++
  console.log(`❌ 测试执行异常: ${err.stack}`)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 命令分流：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
