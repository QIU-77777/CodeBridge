#!/usr/bin/env node
/**
 * 自测：不依赖飞书凭证，验证 opencode 连通性、事件聚合、命令、卡片、状态持久化。
 * 用法: OC_PW=<serve密码> npm run selftest [-- --model providerID/modelID]
 */
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/config.js'
import { Store } from '../src/store.js'
import { OpencodeClient } from '../src/oc.js'
import { Bridge } from '../src/handler.js'
import { RunState } from '../src/render.js'

const argv = process.argv.slice(2)
const modelArg = argv.find((a) => a.startsWith('--model='))?.split('=')[1] || argv[argv.indexOf('--model') + 1]

let pass = 0
let fail = 0
const failures = []

function ok(name, detail = '') {
  pass++
  console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`)
}
function bad(name, err) {
  fail++
  failures.push({ name, err })
  console.log(`  ❌ ${name}  ${err?.message || err}`)
}
async function check(name, fn) {
  try {
    const r = await fn()
    ok(name, typeof r === 'string' ? r : '')
    return r
  } catch (err) {
    bad(name, err)
    return null
  }
}

class TestTransport {
  constructor() {
    this.cards = []
    this.texts = []
    this.seq = 0
    this.sendCount = 0
    this.patchCount = 0
    this.patchedIds = []
  }
  async sendCard(chatId, card, opts = {}) {
    this.sendCount++
    const id = `t-${++this.seq}`
    this.cards.push({ id, chatId, card, opts, at: Date.now() })
    return id
  }
  async patchCard(id, card) {
    this.patchCount++
    this.patchedIds.push(id)
    const rec = this.cards.find((c) => c.id === id)
    if (rec) {
      rec.card = card
      rec.patched = (rec.patched || 0) + 1
    }
    return true
  }
  async sendText(chatId, text, opts = {}) {
    this.texts.push({ chatId, text, opts })
    return `t-text-${++this.seq}`
  }
  last() {
    return this.cards[this.cards.length - 1]
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('\n=== opencode ⇄ 飞书 桥接自测 ===\n')

  const cfg = loadConfig()
  const statePath = join(tmpdir(), `oc-bridge-selftest-${Date.now()}.json`)
  console.log(`opencode: ${cfg.opencode.url}`)
  console.log(`临时状态文件: ${statePath}\n`)

  // 1. 连通性
  console.log('[1] opencode serve')
  const oc = new OpencodeClient({ url: cfg.opencode.url, password: cfg.opencode.password, logger: { warn: () => {} } })
  const health = await check('health', async () => {
    const h = await oc.health()
    return `v${h.version} pid=${h.pid}`
  })
  if (!health) {
    console.log('\n⛔ opencode serve 没起来，后面全部跳过。')
    console.log('   启动: ./scripts/up.sh（会自动选本地 CLI 并起 serve）')
    process.exit(1)
  }

  await check('auth', async () => {
    await oc.listSessions({ limit: '1' })
    return cfg.opencode.password ? '已带密码' : '无密码模式'
  })

  await check('server 就绪（等 plugin 激活）', async () => {
    for (let i = 0; i < 30; i++) {
      try {
        await oc.listModels()
        return i === 0 ? '立即就绪' : `等待 ${i}s`
      } catch (err) {
        if (!/503/.test(err.message)) throw err
        await sleep(1000)
      }
    }
    throw new Error('30 秒内 server 仍未就绪（Location plugins did not finish activating）')
  })

  await check('listModels', async () => {
    const m = await oc.listModels()
    return `${m.length} 个模型`
  })

  await check('listAgents', async () => {
    const a = await oc.listAgents()
    return a.map((x) => x.id).join(', ')
  })

  // 2. Store
  console.log('\n[2] 状态持久化')
  await check('写入 + 重读', async () => {
    const s1 = new Store(statePath)
    s1.set('chat-A', { sessionId: 'ses_test', directory: '/tmp' })
    s1.flush()
    const s2 = new Store(statePath)
    const got = s2.get('chat-A')
    if (got?.sessionId !== 'ses_test') throw new Error('重读失败: ' + JSON.stringify(got))
    return 'ok'
  })

  // 3. 卡片 JSON
  console.log('\n[3] 卡片结构与大小')
  await check('runCard 可序列化且 < 30KB', async () => {
    const st = new RunState('ses_x')
    st.text = 'x'.repeat(20000)
    st.tools = [{ id: '1', name: 'shell', input: { command: 'ls' }, status: 'ok', output: '' }]
    st.status = 'running'
    const { runCard } = await import('../src/cards.js')
    const card = runCard(st, { directory: '/tmp', model: 'a/b', maxBodyChars: 6000 })
    const json = JSON.stringify(card)
    if (json.length > 30000) throw new Error(`卡片 ${json.length} 字节，超过飞书 30KB 限制`)
    return `${json.length} 字节`
  })

  await check('sessionsCard 分页', async () => {
    const { sessionsCard } = await import('../src/cards.js')
    const fake = Array.from({ length: 20 }, (_, i) => ({
      id: `ses_${i}`,
      title: `会话 ${i}`,
      time: { updated: Date.now() - i * 60000 },
      model: { id: 'm' },
      cost: 0.01,
    }))
    const c0 = sessionsCard({ sessions: fake, currentId: 'ses_0', directory: '/tmp', page: 0 })
    const c2 = sessionsCard({ sessions: fake, currentId: 'ses_0', directory: '/tmp', page: 2 })
    if (JSON.stringify(c0) === JSON.stringify(c2)) throw new Error('翻页没变化')
    return '3 页可切换'
  })

  // 4. 真实会话 + 事件聚合
  console.log('\n[4] 真实会话与流式聚合')
  const store = new Store(statePath)
  const transport = new TestTransport()
  const bridge = new Bridge({ oc, store, config: cfg, transport, logger: { info: () => {}, warn: () => {}, error: console.error } })

  await check('订阅事件流', async () => {
    await bridge.start()
    await sleep(800)
    return '已连接'
  })

  let session = null
  const modelStr = modelArg || cfg.opencode.defaultModel || ''
  await check('创建会话', async () => {
    const model = modelStr
      ? { providerID: modelStr.split('/')[0], id: modelStr.split('/').slice(1).join('/') }
      : undefined
    if (!model) {
      console.log('     ⚠️  没指定模型，会用 opencode 默认（大陆可能是 RegionError）')
      console.log('     传 --model stepfun-step-plan/step-3.5-flash 或在配置里设 defaultModel')
    }
    session = await oc.createSession({
      title: 'bridge-selftest',
      directory: '/tmp',
      model,
    })
    if (!session?.id) throw new Error('没有返回 session id')
    return `${session.id} model=${session.model?.providerID}/${session.model?.id}`
  })

  if (session) {
    const TARGET = '桥接测试通过'
    await check('发送 prompt 并收集流式事件', async () => {
      const state = new RunState(session.id)
      const run = { state, cardId: null, chatId: 'test', timer: null, lastFlush: 0, meta: {} }
      bridge.runs.set(session.id, run)
      const cardId = await transport.sendCard('test', { header: { title: { content: 'x' } }, elements: [] })
      run.cardId = cardId

      await oc.prompt(session.id, `只回复四个字：${TARGET}。不要调用任何工具。`)

      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        if (['done', 'failed', 'aborted'].includes(state.status)) break
        await sleep(500)
      }
      if (state.status === 'running') throw new Error('90 秒未结束')
      if (state.status !== 'done') throw new Error(`执行失败: ${JSON.stringify(state.error)}`)
      if (!state.text.includes(TARGET)) throw new Error(`回答不含预期内容，实际: ${state.text.slice(0, 200)}`)
      return `text="${state.text.slice(0, 40)}" 工具 ${state.tools.length} 个`
    })

    await check('卡片被增量 patch', async () => {
      await sleep(300)
      const rec = transport.cards.find((c) => c.id === bridge.runs.get(session.id)?.cardId)
      if (!rec) throw new Error('找不到卡片记录')
      if (!rec.patched) throw new Error('卡片从未被更新')
      return `patch ${rec.patched} 次`
    })

    await check('历史消息可读', async () => {
      const msgs = await oc.listMessages(session.id)
      if (!msgs.length) throw new Error('没有消息')
      return `${msgs.length} 条`
    })
  }

  // 5. 命令
  console.log('\n[5] 命令与卡片回调')
  const chatId = 'chat-test'
  // 测试用假 userId，先清空白名单；白名单拦截项会单独临时设置
  cfg.feishu.allowlist = []
  store.set(chatId, { directory: cfg.opencode.defaultDirectory })
  const before = transport.cards.length

  await check('/help', async () => {
    await bridge.onMessage({ chatId, userId: 'u1', text: '/help', messageId: 'm1' })
    if (transport.cards.length === before) throw new Error('没有发卡片')
    return '卡片已发'
  })

  await check('/new 绑定会话', async () => {
    await bridge.onMessage({ chatId, userId: 'u1', text: '/new /tmp', messageId: 'm2' })
    const b = store.get(chatId)
    if (!b?.sessionId) throw new Error('没有写入绑定')
    return b.sessionId
  })

  await check('/sessions 列表', async () => {
    await bridge.onMessage({ chatId, userId: 'u1', text: '/sessions', messageId: 'm3' })
    const card = transport.last()
    const txt = JSON.stringify(card.card)
    if (!txt.includes('会话')) throw new Error('卡片内容异常')
    return 'ok'
  })

  await check('/status', async () => {
    await bridge.onMessage({ chatId, userId: 'u1', text: '/status', messageId: 'm4' })
    return 'ok'
  })

  await check('卡片回调: 切换会话', async () => {
    const b = store.get(chatId)
    const other = session?.id || b.sessionId
    const res = await bridge.onCardAction({ chatId, userId: 'u1', action: { a: 'switch', s: other }, messageId: 'om_test' })
    if (!res?.toast) throw new Error('没有返回 toast')
    // 回传体里绝不能有 card：飞书对 card 字段格式要求极严，稍偏就报 200672
    if ('card' in res) throw new Error('回调返回了 card 字段，会触发飞书 200672')
    return res.toast.content || 'ok'
  })

  await check('卡片回调: 新建', async () => {
    const res = await bridge.onCardAction({ chatId, userId: 'u1', action: { a: 'new' }, messageId: 'om_x' })
    if (res?.toast?.type !== 'success') throw new Error('失败: ' + JSON.stringify(res))
    await sleep(500) // 等延迟 sendCard 落地，免得算进下一项的计数
    return res.toast.content
  })

  await check('回调结果走新消息，不覆盖历史', async () => {
    const before = { send: transport.sendCount, patch: transport.patchCount, ids: [...transport.patchedIds] }
    await bridge.onCardAction({ chatId, userId: 'u1', action: { a: 'sessions' }, messageId: 'om_history' })
    await sleep(500)
    if (transport.sendCount !== before.send + 1) throw new Error('没有新发消息')
    if (transport.patchedIds.includes('om_history')) throw new Error('历史消息被 patch 覆盖了')
    return '新发 1 条，原消息未动'
  })

  await check('列表翻页只更新自己', async () => {
    const beforePatch = transport.patchCount
    await bridge.onCardAction({ chatId, userId: 'u1', action: { a: 'sessions', p: 0 }, messageId: 'om_list' })
    await sleep(500)
    if (transport.patchCount !== beforePatch + 1) throw new Error('翻页没有 patch 列表自身')
    if (!transport.patchedIds.includes('om_list')) throw new Error('patch 了别的消息')
    return '只 patch 列表自己'
  })

  await check('白名单拦截', async () => {
    const saved = cfg.feishu.allowlist
    cfg.feishu.allowlist = ['only-me']
    const n = transport.texts.length
    await bridge.onMessage({ chatId, userId: 'stranger', text: '/help', messageId: 'm9' })
    cfg.feishu.allowlist = saved
    if (transport.texts.length !== n) throw new Error('白名单没生效')
    return '已拦截'
  })

  await check('未知命令有提示', async () => {
    const n = transport.texts.length
    await bridge.onMessage({ chatId, userId: 'u1', text: '/nonsense', messageId: 'm10' })
    if (transport.texts.length === n) throw new Error('没有提示')
    return transport.texts[transport.texts.length - 1].text
  })

  // 6. 话题内回复（群聊）：一条话题一个绑定，输出全部落进话题
  console.log('\n[6] 话题内回复（群聊）')
  const topicKey = 'root:om_topic_root'
  const topicChat = 'chat-topic-group'
  const topicMsg = (id) => ({
    chatId: topicChat,
    userId: 'u1',
    messageId: id,
    chatType: 'group',
    isGroup: true,
    rootId: 'om_topic_root',
    key: topicKey,
    threadId: 'omt_topic',
  })

  await check('话题消息：执行卡片带 replyTo', async () => {
    const before = transport.cards.length
    const done = bridge.onMessage({ ...topicMsg('om_topic_first'), text: '只回复两个字：好的。不要调用任何工具。' })
    await sleep(1500) // 卡片先于模型响应发出，不用等整轮跑完
    const rec = transport.cards.slice(before).find((c) => c.opts?.replyTo === 'om_topic_root')
    if (!rec) throw new Error('执行卡片没有带 replyTo，会落到群主聊天流')
    await done
    return `replyTo=om_topic_root`
  })

  await check('话题绑定独立记录，chatId 不被键污染', async () => {
    const b = store.get(topicKey)
    if (!b?.sessionId) throw new Error('话题没有绑定会话')
    if (b.chatId !== topicChat) throw new Error(`chatId 应为 ${topicChat}，实际 ${b.chatId}`)
    return `key=${topicKey} chatId=${b.chatId}`
  })

  await check('isKnownTopic：绑过的话题免 @', async () => {
    if (!bridge.isKnownTopic({ key: topicKey })) throw new Error('已绑定的话题未被识别')
    if (bridge.isKnownTopic({ key: 'root:om_unknown' })) throw new Error('陌生话题被误判为已知')
    return 'ok'
  })

  await check('话题内命令也带 replyTo', async () => {
    const before = transport.cards.length
    await bridge.onMessage({ ...topicMsg('om_topic_second'), text: '/status' })
    const rec = transport.cards[before]
    if (!rec) throw new Error('没有发卡片')
    if (rec.opts?.replyTo !== 'om_topic_root') throw new Error('命令回复没有进话题')
    return 'ok'
  })

  await check('卡片回调按按钮里的 k/rt 回到话题', async () => {
    const before = transport.cards.length
    const res = await bridge.onCardAction({
      chatId: topicChat,
      userId: 'u1',
      action: { a: 'sessions', k: topicKey, rt: 'om_topic_root' },
      messageId: 'om_card_topic',
    })
    if (!res?.toast) throw new Error('没有 toast')
    await sleep(500)
    const rec = transport.cards[before]
    if (rec?.opts?.replyTo !== 'om_topic_root') throw new Error('回调结果没有进话题')
    return 'ok'
  })

  await check('老卡片回调：按 message_id 反查绑定键', async () => {
    const run = [...bridge.runs.values()].find((r) => r.meta?.key === topicKey)
    if (!run?.cardId) throw new Error('找不到话题 run')
    if (!session?.id) throw new Error('没有可切换的会话')
    await bridge.onCardAction({
      chatId: topicChat,
      userId: 'u1',
      action: { a: 'switch', s: session.id },
      messageId: run.cardId,
    })
    const b = store.get(topicKey)
    if (b?.sessionId !== session.id) throw new Error('没有按 run 反查到话题键')
    if (b?.chatId !== topicChat) throw new Error(`反查后 chatId 应为 ${topicChat}，实际 ${b.chatId}`)
    return `key=${topicKey}`
  })

  await check('私聊回调不进话题', async () => {
    const before = transport.cards.length
    await bridge.onCardAction({ chatId, userId: 'u1', action: { a: 'sessions' }, messageId: 'om_plain_card' })
    await sleep(500)
    const rec = transport.cards[before]
    if (rec?.opts?.replyTo) throw new Error('私聊回调错误地进了话题')
    return 'ok'
  })

  bridge.stop()
  store.flush()

  // 6. 清理
  if (session) await oc.deleteSession(session.id).catch(() => {})
  const b = store.get(chatId)
  if (b?.sessionId) await oc.deleteSession(b.sessionId).catch(() => {})
  const tb = store.get(topicKey)
  if (tb?.sessionId) await oc.deleteSession(tb.sessionId).catch(() => {})
  if (existsSync(statePath)) rmSync(statePath)

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`)
  if (fail) {
    for (const f of failures) console.log(`  ✗ ${f.name}: ${f.err?.message || f.err}`)
    process.exit(1)
  }
  console.log('全部通过。可以配飞书凭证后 npm start。\n')
  process.exit(0)
}

main().catch((e) => {
  console.error('自测崩溃: ' + (e?.stack || e))
  process.exit(1)
})
