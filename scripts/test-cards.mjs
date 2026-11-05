/**
 * 卡片 2.0 + markdown 渲染测试
 *   node scripts/test-cards.mjs          # 只跑本地断言
 *   node scripts/test-cards.mjs --live   # 额外真实发送 + patch 验证
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { loadConfig } from '../src/config.js'
import { mdToElements, mdToText } from '../src/md.js'
import { runCard, textCard, sessionsCard, permissionCard, statusCard, helpCard } from '../src/cards.js'
import { RunState } from '../src/render.js'

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

// ---------- 1. markdown 分段解析 ----------
const MD = `你好，这是结论：

| 项目 | 状态 | 备注 |
| --- | --- | --- |
| 桥接 | 完成 | 2.0 卡片 |
| 表格 | 修复 | 原生组件 |

## 下一步

- 重启服务
- 发消息验证

\`\`\`js
const a = 1
const b = 2
\`\`\`

收尾文字。`

const els = mdToElements(MD)
const table = els.find((e) => e.tag === 'table')
const code = els.find((e) => e.tag === 'markdown' && e.content?.startsWith('```js'))
const divs = els.filter((e) => e.tag === 'div')

ok(!!table, 'markdown 表格转成 table 组件')
ok(table && table.columns.length === 3, 'table 列数 = 3', JSON.stringify(table?.columns?.length))
ok(table && table.rows.length === 2, 'table 行数 = 2', JSON.stringify(table?.rows?.length))
ok(table && table.columns[0].display_name === '项目', 'table 表头文字正确', table?.columns?.[0]?.display_name)
ok(table && table.rows[0].c1 === '完成', 'table 单元格内容正确', JSON.stringify(table?.rows?.[0]))
ok(!!code, '围栏代码块转成 markdown 组件')
ok(code && code.content.includes('const a = 1') && code.content.includes('const b = 2'), 'code 内容完整')

const joined = divs.map((d) => d.text.content).join('\n')
ok(!/\|\s*---/.test(joined), '正文里不再残留表格分隔行')
ok(!joined.includes('```'), '正文里不再残留代码围栏')
ok(joined.includes('**下一步**'), '标题降级为加粗', joined.match(/下一步[^\n]*/)?.[0])
ok(joined.includes('• 重启服务'), '无序列表降级为圆点', joined.match(/重启服务[^\n]*/)?.[0])

// 无表格时不应误判
const plain = mdToElements('就是普通一句话，带个 | 竖线而已。')
ok(plain.length === 1 && plain[0].tag === 'div', '普通文本不被误判为表格')

// 收尾 markdown 空表格
const empty = mdToElements('| a | b |\n| --- | --- |')
ok(empty.length === 1 && empty[0].tag === 'div', '只有表头没数据时降级为文本')

ok(typeof mdToText(MD) === 'string' && mdToText(MD).length > 0, 'mdToText 有输出')

// ---------- 2. 卡片结构合法性 ----------
function walk(node, cb) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach((n) => walk(n, cb))
  cb(node)
  for (const v of Object.values(node)) walk(v, cb)
}

const st = new RunState('ses_test')
st.text = MD
st.status = 'done'
st.cost = 0.0123
st.tokens = { input: 1200, output: 340 }
st.tools.push({ id: 't1', name: 'bash', input: { command: 'ls' }, status: 'ok', output: '' })

const rc = runCard(st, { directory: '/Users/x/proj', model: 'stepfun/step-5', maxBodyChars: 6000 })
ok(rc.schema === '2.0', 'runCard 是 schema 2.0')
ok(Array.isArray(rc.body?.elements), 'runCard 元素在 body.elements')
ok(!('elements' in rc), 'runCard 根级没有 elements（1.0 写法）')

const bad = []
walk(rc, (n) => {
  if (n.tag === 'action') bad.push('action 容器')
  if (n.tag === 'note') bad.push('note 组件')
})
ok(bad.length === 0, '不含 2.0 不支持的 action/note', bad.join(','))

ok(!JSON.stringify(rc).includes('工具调用'), '默认不显示工具调用链路')
const rcTools = runCard(st, { showTools: true })
ok(JSON.stringify(rcTools).includes('工具调用'), 'showTools=true 时才显示工具调用')

const size = JSON.stringify(rc).length
ok(size < 30_000, `runCard 序列化 < 30KB（${size} 字节）`)

// 卡片末尾要告诉用户「怎么找帮助」，且群里要写清楚得先 @
{
  const group = JSON.stringify(runCard(st, { directory: '/tmp', isGroup: true }))
  const dm = JSON.stringify(runCard(st, { directory: '/tmp', isGroup: false }))
  ok(group.includes('/help'), '群里：卡片带 /help 提示')
  ok(group.includes('@我'), '群里：提示里写明要先 @，否则用户会直接打字')
  ok(dm.includes('/help') && !dm.includes('@我'), '私聊：只写发送 /help，不提 @')
  ok(
    group.indexOf('/help') > group.indexOf('"tag":"action"'),
    '帮助提示排在按钮之后',
  )
}


// 失败卡片：已知错误要带一句「接下来干什么」
{
  const mk = (message) => {
    const s = new RunState('ses_err')
    s.status = 'failed'
    s.startedAt = Date.now() - 500
    s.updatedAt = Date.now()
    s.error = { message }
    return JSON.stringify(runCard(s, { directory: '/Users/x/proj' }))
  }
  const decode = mk(
    'Failed to decode message msg_1a680b70f001mTb0jsEsQXBe2v in session ses_ede75d736ffeZ57F53gCQtXRx4',
  )
  ok(decode.includes('recent'), '解码失败给出「缺 recent 字段」的定位')
  ok(decode.includes('db') || decode.includes('opencode.db'), '解码失败提示可以修数据库')
  ok(mk('RegionError: This model is not available in your country').includes('/model'), 'RegionError 提示换模型')
  ok(mk('Session.BusyError: session is busy').includes('/stop'), 'BusyError 提示 /stop')
  ok(!mk('some totally unknown failure').includes('💡'), '未知错误不加臆测提示')
}

// opencode 客户端：PATCH 改名成功时返回 204 空体，不能被当成对象解引用
{
  const { OpencodeClient } = await import('../src/oc.js')
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 204 })
  try {
    const cli = new OpencodeClient({ url: 'http://127.0.0.1:1' })
    const r = await cli.renameSession('ses_x', '新标题')
    ok(r === null, 'renameSession 兼容 204 空响应（不再抛 Cannot read properties of null）', String(r))
  } finally {
    globalThis.fetch = orig
  }
}

// 二进制选择：桌面版 CLI 优先，且要认版本号最大的那个（桌面版升级后目录名会变）
{
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { resolveOpencode, parseVersion } = await import('../src/which-opencode.js')

  ok(parseVersion('2.10.1-arm64')[1] === 10, 'parseVersion 正确解析多位数次版本', String(parseVersion('2.10.1-arm64')))

  const dir = mkdtempSync(join(tmpdir(), 'oc-pick-'))
  const fake = (name, script) => {
    mkdirSync(join(dir, name), { recursive: true })
    const p = join(dir, name, 'opencode-cli')
    writeFileSync(p, `#!/bin/sh\n${script}\n`)
    chmodSync(p, 0o755)
    return p
  }
  try {
    fake('2.9.0-arm64', 'echo opencode v2.9.0')
    const newest = fake('2.10.1-arm64', 'echo opencode v2.10.1')
    fake('2.2.5-arm64', 'echo opencode v2.2.5')

    const picked = resolveOpencode({ PATH: '/nonexistent' }, dir)
    ok(picked?.bin === newest, '多个版本目录时选版本号最大的（2.10.1 > 2.9.0）', picked?.bin)
    ok(picked?.source === 'desktop', '来源标记为 desktop')
    ok(picked?.version === '2.10.1', '能读出二进制自报的版本', picked?.version)

    const byEnv = resolveOpencode({ OPENCODE_BIN: newest, PATH: '/nonexistent' }, dir)
    ok(byEnv?.source === 'env', 'OPENCODE_BIN 优先级最高')

    ok(resolveOpencode({ PATH: '/nonexistent' }, join(dir, 'nope')) === null, '找不到时返回 null（不静默 fallback）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const [name, card] of Object.entries({
  textCard: textCard('标题', '正文 **加粗**'),
  sessionsCard: sessionsCard({
    sessions: [
      { id: 'ses_aaaaaaaaaaaaaaaaaaaa', title: '测试会话', time: { updated: Date.now() }, model: { id: 'gpt' }, cost: 0.1 },
    ],
    currentId: 'ses_aaaaaaaaaaaaaaaaaaaa',
    directory: '/tmp',
  }),
  permissionCard: permissionCard({ request: { id: 'r1', sessionID: 's1', action: 'bash', resources: ['ls'] } }),
  statusCard: statusCard({ binding: { sessionId: 's1', directory: '/tmp' }, directory: '/tmp' }),
  helpCard: helpCard(),
})) {
  const tags = []
  walk(card, (n) => n.tag === 'action' && tags.push('action'))
  ok(card.schema === '2.0' && Array.isArray(card.body?.elements) && tags.length === 0, `${name} 是合法 2.0 结构`)
}

// ---------- 3. 看门狗（idleTimeout） ----------
{
  const { Bridge } = await import('../src/handler.js')
  const b = new Bridge({
    oc: {},
    store: {},
    config: { behavior: { idleTimeoutMs: 900000 } },
    transport: {},
    logger: { info() {}, warn() {}, error() {} },
  })
  const flushed = []
  b.flushRun = (sid) => flushed.push(sid)

  const stale = new RunState('ses_idle')
  stale.status = 'running'
  stale.updatedAt = Date.now() - 20 * 60 * 1000
  b.runs.set('ses_idle', { state: stale, cardId: 'c1', chatId: 'x', meta: {} })

  const fresh = new RunState('ses_fresh')
  fresh.status = 'running'
  b.runs.set('ses_fresh', { state: fresh, cardId: 'c2', chatId: 'x', meta: {} })

  b.checkIdle(15 * 60 * 1000)

  ok(stale.status === 'failed', '看门狗把空闲超时的 run 标为失败', stale.status)
  ok(flushed.includes('ses_idle'), '看门狗触发收尾（Patch 卡片）')
  ok(fresh.status === 'running', '看门狗不动还在活动的 run', fresh.status)
  ok(/15 分钟/.test(stale.error?.message || ''), '错误信息里写明超时时长')
  ok(!flushed.includes('ses_fresh'), '活跃 run 没被误收尾')
}

// ---------- 4. 真实发送 + patch ----------
if (process.argv.includes('--live')) {
  const cfg = loadConfig()
  const chatId = process.env.PROBE_CHAT || 'oc_6603cd2922863fd16081b7fc1d9d08f0'
  const client = new Lark.Client({
    appId: cfg.feishu.appId,
    appSecret: cfg.feishu.appSecret,
    domain: cfg.feishu.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
  })

  const create = async (card) =>
    client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    })

  const patch = async (mid, card) =>
    client.im.v1.message.patch({ path: { message_id: mid }, data: { content: JSON.stringify(card) } })

  let res = await create(rc)
  ok(res?.code === 0, '真实发送 2.0 卡片', `code=${res?.code} msg=${res?.msg}`)
  const mid = res?.data?.message_id

  if (mid) {
    await new Promise((r) => setTimeout(r, 1200))
    // 模拟流式：正文追加，表格行变多
    const st2 = new RunState('ses_test')
    st2.text = MD + '\n\n新增一行：\n\n| A | B |\n| --- | --- |\n| 3 | 4 |'
    st2.status = 'running'
    st2.tokens = { input: 1500, output: 600 }
    let r2 = await patch(mid, runCard(st2, { directory: '/Users/x/proj', model: 'stepfun/step-5' }))
    ok(r2?.code === 0, 'patch 更新 2.0 卡片（流式关键）', `code=${r2?.code} msg=${r2?.msg}`)

    await new Promise((r) => setTimeout(r, 1200))
    const st3 = new RunState('ses_test')
    st3.text = '结束了，只有一个短结论。'
    st3.status = 'done'
    let r3 = await patch(mid, runCard(st3, { directory: '/Users/x/proj' }))
    ok(r3?.code === 0, 'patch 收缩内容（表格被移除）', `code=${r3?.code} msg=${r3?.msg}`)
  }
}

// ---------- 5. 群里一条话题一个会话 ----------
{
  const { Bridge } = await import('../src/handler.js')
  const b = new Bridge({
    oc: {},
    store: {},
    config: { behavior: { maxParallel: 2, idleTimeoutMs: 0 } },
    transport: {},
    logger: { info() {}, warn() {}, error() {} },
  })

  const p2p = b.ctxOf({ chatId: 'oc_dm', chatType: 'p2p', messageId: 'om_1' })
  ok(p2p.key === 'oc_dm' && p2p.replyTo === null, '私聊：键仍是 chat_id，不发到话题')

  const fresh = b.ctxOf({ chatId: 'oc_g', chatType: 'group', messageId: 'om_1' })
  ok(fresh.key === 'root:om_1' && fresh.replyTo === 'om_1', '群里新 @ 的消息：它自己就是新话题的根')

  const inThread = b.ctxOf({ chatId: 'oc_g', chatType: 'group', messageId: 'om_2', rootId: 'om_1', threadId: 'omt_1' })
  ok(inThread.key === fresh.key, '同一话题里的后续消息落到同一个键（开话题后不用改绑）')

  const other = b.ctxOf({ chatId: 'oc_g', chatType: 'group', messageId: 'om_3' })
  ok(other.key !== fresh.key, '群里另起一条 @ 是另一个键 → 另一个会话，可以并行')
}

// ---------- 6. 全局并行上限 ----------
{
  const { Bridge } = await import('../src/handler.js')
  const sent = []
  const b = new Bridge({
    oc: { getSession: async () => ({ id: 'ses_me', location: { directory: '/tmp' } }) },
    store: { get: () => ({ sessionId: 'ses_me', directory: '/tmp', chatId: 'oc_g', replyTo: 'om_9' }) },
    config: { behavior: { maxParallel: 1 }, opencode: { defaultDirectory: '/tmp' } },
    transport: {
      sendText: async (chatId, text, opt) => sent.push({ chatId, text, opt }),
      sendCard: async () => 'card_x',
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  const busy = new RunState('ses_busy')
  busy.status = 'running'
  b.runs.set('ses_busy', { state: busy, cardId: 'c0', meta: {} })

  const msg = { chatId: 'oc_g', chatType: 'group', messageId: 'om_9', text: '干活' }
  await b.runPrompt(msg, b.ctxOf(msg))

  ok(sent.length === 1 && /上限/.test(sent[0].text), '超过 maxParallel 时拒绝并说明上限', JSON.stringify(sent))
  ok(sent[0]?.opt?.replyTo === 'om_9', '拒绝提示也发进同一条话题，不落到主群')
  ok(b.runs.get('ses_busy').state.status === 'running', '被拒绝的请求没有顶掉正在跑的任务')
}

// ---------- 6.1 被上限拒掉时，不能让 opencode 里多出一个空会话 ----------
{
  const { Bridge } = await import('../src/handler.js')
  const sent = []
  let created = 0
  const b = new Bridge({
    oc: {
      getSession: async () => ({ id: 'ses_old', location: { directory: '/tmp' } }),
      createSession: async () => {
        created++
        return { id: 'ses_new', location: { directory: '/tmp' } }
      },
    },
    // 话题还没建会话（等价于刚 /cd 清空绑定的状态）
    store: { get: () => ({ directory: '/tmp', chatId: 'oc_g', replyTo: 'om_9' }), set() {} },
    config: { behavior: { maxParallel: 1 }, opencode: { defaultDirectory: '/tmp' } },
    transport: {
      sendText: async (chatId, text, opt) => sent.push({ chatId, text, opt }),
      sendCard: async () => 'card_x',
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  const busy = new RunState('ses_busy')
  busy.status = 'running'
  b.runs.set('ses_busy', { state: busy, cardId: 'c0', meta: {} })

  const msg = { chatId: 'oc_g', chatType: 'group', messageId: 'om_9', text: '干活' }
  await b.runPrompt(msg, b.ctxOf(msg))

  ok(/上限/.test(sent[0]?.text || ''), '上限满时仍然拒绝')
  ok(created === 0, '被拒的那条没有去 opencode 建空会话', `createSession 调用 ${created} 次`)
}

// ---------- 6.2 只响应 @ 我本人（多机器人同群的前提） ----------
{
  const { FeishuTransport } = await import('../src/feishu.js')
  const got = []
  const t = new FeishuTransport(
    { feishu: { appId: 'cli_x', appSecret: 'sec_x', requireMention: true } },
    {
      onMessage: async (m) => got.push(m),
      onCardAction: async () => {},
      logger: { info() {}, warn() {}, error() {} },
    },
  )
  t.resolveSelf = async () => ({ open_id: 'ou_me', name: 'Lil_O' })

  let seq = 0
  const ev = (text, mentions, extra = {}) => ({
    message: {
      message_type: 'text',
      chat_type: 'group',
      chat_id: 'oc_g',
      message_id: 'om_' + ++seq,
      content: JSON.stringify({ text }),
      mentions,
      ...extra,
    },
    sender: { sender_id: { open_id: 'ou_u1' } },
  })
  const me = [{ key: '@_user_1', id: { open_id: 'ou_me' }, name: 'Lil_O' }]

  await t.handleImMessage(
    ev('@_user_1 你看下', [{ key: '@_user_1', id: { open_id: 'ou_other_bot' }, name: '小助' }]),
  )
  ok(got.length === 0, '@ 别的机器人 → 不处理（否则多机器人同群会抢答）')

  await t.handleImMessage(ev('大家早', []))
  ok(got.length === 0, '完全没有 @ → 不处理')

  await t.handleImMessage(ev('接着聊', [], { root_id: 'om_root', thread_id: 'omt_1' }))
  ok(got.length === 0, '话题里也必须 @，不再免 @')

  await t.handleImMessage(ev('@_user_1 你好', me))
  ok(got.length === 1 && got[0].text === '你好', '@ 我本人 → 处理，且自己的占位符被抹掉')

  await t.handleImMessage(
    ev('@_user_1 你看下 @_user_2', [
      ...me,
      { key: '@_user_2', id: { open_id: 'ou_u2' }, name: '张三' },
    ]),
  )
  ok(got.length === 2 && got[1].text === '你看下 @张三', '@ 了我和别人 → 别人保留成 @名字，模型知道在跟谁说话')

  await t.handleImMessage(
    ev('hi', [], { chat_type: 'p2p', chat_id: 'oc_dm' }),
  )
  ok(got.length === 3, '私聊不受影响，不需要 @')
}

// ---------- 6.3 拿不到自身 open_id 时退化为「@ 谁都算」（并在启动时告警） ----------
{
  const { FeishuTransport } = await import('../src/feishu.js')
  const got = []
  const warns = []
  const t = new FeishuTransport(
    { feishu: { appId: 'cli_x', appSecret: 'sec_x', requireMention: true } },
    {
      onMessage: async (m) => got.push(m),
      onCardAction: async () => {},
      logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    },
  )
  t.client = { request: async () => { throw new Error('no permission') } }
  const self = await t.resolveSelf()

  ok(self.open_id === null, '取不到 open_id 时降级为 null，不抛异常挡住启动')
  ok(warns.some((w) => /botOpenId/.test(w)), '降级时明确提示去配 feishu.botOpenId')

  await t.handleImMessage({
    message: {
      message_type: 'text',
      chat_type: 'group',
      chat_id: 'oc_g',
      message_id: 'om_deg',
      content: JSON.stringify({ text: '@_user_1 hi' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_x' }, name: 'X' }],
    },
    sender: { sender_id: { open_id: 'ou_u1' } },
  })
  ok(got.length === 1, '降级后 @ 任何人都会响应（已知风险）')
}

// ---------- 6.4 给模型的来源标注 ----------
{
  const { FeishuTransport } = await import('../src/feishu.js')
  const got = []
  const seen = []
  const names = new Map([['ou_lild', '小d']])
  const t = new FeishuTransport(
    { feishu: { appId: 'cli_x', appSecret: 'sec_x', requireMention: true } },
    {
      onMessage: async (m) => got.push(m),
      onCardAction: async () => {},
      nameOf: (id) => names.get(id) || '',
      onSeenNames: (list) => seen.push(...list),
      logger: { info() {}, warn() {}, error() {} },
    },
  )
  t.resolveSelf = async () => ({ open_id: 'ou_me', name: 'LiLO' })
  t.client = {
    request: async ({ url }) => {
      if (/\/chats\/oc_g$/.test(url)) return { data: { name: '桥接话题探针' } }
      throw new Error('no permission')
    },
  }
  const me = [{ key: '@_user_1', id: { open_id: 'ou_me' }, name: 'LiLO' }]

  await t.handleImMessage({
    message: {
      message_type: 'text',
      chat_type: 'group',
      chat_id: 'oc_g',
      message_id: 'om_o1',
      create_time: '1793879885000',
      content: JSON.stringify({ text: '@_user_1 你好' }),
      mentions: me,
    },
    sender: { sender_id: { open_id: 'ou_lild' }, sender_type: 'app' },
  })
  const o1 = got[0]?.origin || ''
  ok(/群「桥接话题探针」/.test(o1), '来源标注带群名', o1)
  ok(/主聊天流/.test(o1), '来源标注区分主聊天流 / 话题内', o1)
  ok(/ou_lild（机器人）/.test(o1), '来源标注带发送者 open_id 和「人 / 机器人」', o1)
  ok(/小d · ou_lild/.test(o1), '知道名字时显示「名字 · open_id」，id 保持完整以便 @ 回去', o1)
  ok(
    seen.some((x) => x.openId === 'ou_me' && x.name === 'LiLO'),
    '把消息里被 @ 的 (open_id, 名字) 交给上层攒起来',
  )

  await t.handleImMessage({
    message: {
      message_type: 'text',
      chat_type: 'group',
      chat_id: 'oc_g',
      message_id: 'om_o2',
      content: JSON.stringify({ text: '@_user_1 继续' }),
      mentions: me,
      root_id: 'om_o1',
      thread_id: 'omt_1',
    },
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
  })
  ok(/话题内/.test(got[1]?.origin || ''), '话题里的消息标注为「话题内」')
  ok(/ou_user（用户）/.test(got[1]?.origin || ''), '人类发送者标为「用户」')

  await t.handleImMessage({
    message: {
      message_type: 'text',
      chat_type: 'p2p',
      chat_id: 'oc_dm',
      message_id: 'om_o3',
      content: JSON.stringify({ text: '私聊一句' }),
    },
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
  })
  ok(/私聊/.test(got[2]?.origin || ''), '私聊标注为「私聊」')

  const cached = await t.resolveChatName('oc_g')
  ok(cached === '桥接话题探针' && t.chatNames.size === 1, '群名只取一次，后续走缓存')
}

// ---------- 6.5 来源标注确实拼进了 prompt ----------
{
  const { Bridge } = await import('../src/handler.js')
  let sentText = ''
  const b = new Bridge({
    oc: {
      getSession: async () => ({ id: 'ses_x', location: { directory: '/tmp' } }),
      prompt: async (id, text) => {
        sentText = text
      },
    },
    store: { get: () => ({ sessionId: 'ses_x', directory: '/tmp', chatId: 'oc_g', replyTo: 'om_1' }), set() {} },
    config: { behavior: {}, opencode: { defaultDirectory: '/tmp' } },
    transport: { sendCard: async () => 'card_1', sendText: async () => {} },
    logger: { info() {}, warn() {}, error() {} },
  })
  const msg = {
    chatId: 'oc_g',
    chatType: 'group',
    messageId: 'om_1',
    text: '帮我看下',
    origin: '[飞书 · 群「探针」 · 主聊天流 · 发送者 ou_x（用户） · 2026/11/5 20:18:05]',
  }
  await b.runPrompt(msg, b.ctxOf(msg))
  ok(sentText.startsWith('[飞书 · '), 'prompt 第一行是来源标注', sentText.slice(0, 40))
  ok(sentText.includes('帮我看下'), '正文没丢')
  ok(sentText.indexOf(']') < sentText.indexOf('帮我看下'), '来源标注在正文之前')
}

// ---------- 6.6 名字从哪来：配置 > @ 攒的 > 空 ----------
{
  const { Store } = await import('../src/store.js')
  const { Bridge } = await import('../src/handler.js')
  const { unlinkSync } = await import('node:fs')
  const path = '/tmp/ocb-names-test-' + Date.now() + '.json'

  const st = new Store(path)
  ok(st.getName('ou_x') === '', '没有记录时返回空串')

  st.setName('ou_x', '小d')
  ok(st.getName('ou_x') === '小d', 'setName 之后读得到')
  st.flush()

  const st2 = new Store(path)
  ok(st2.getName('ou_x') === '小d', '名字落盘并能在下次启动读回来')

  const b = new Bridge({
    oc: {},
    store: st2,
    config: { behavior: {}, feishu: { names: { ou_x: '声明名' } } },
    transport: {},
    logger: { info() {}, warn() {}, error() {} },
  })
  ok(b.nameOf('ou_x') === '声明名', '配置里的 feishu.names 优先于 @ 攒到的名字')
  ok(b.nameOf('ou_nobody') === '', '两处都没有时为空，标注退回只显示 open_id')

  unlinkSync(path)
}

// ---------- 6.7 开了 im:chat.members:read 之后自动补名字 ----------
{
  const { FeishuTransport } = await import('../src/feishu.js')
  const got = []
  const learned = []
  const known = new Map()
  const t = new FeishuTransport(
    { feishu: { appId: 'cli_x', appSecret: 'sec_x', requireMention: true } },
    {
      onMessage: async (m) => got.push(m),
      onCardAction: async () => {},
      nameOf: (id) => known.get(id) || '',
      onSeenNames: (list) => {
        learned.push(...list)
        for (const x of list) known.set(x.openId, x.name)
      },
      logger: { info() {}, warn() {}, error() {} },
    },
  )
  t.resolveSelf = async () => ({ open_id: 'ou_me', name: 'LiLO' })
  let memberCalls = 0
  t.client = {
    request: async ({ url }) => {
      if (/\/members\?/.test(url)) {
        memberCalls++
        return {
          data: {
            items: [
              { member_id: 'ou_lild', name: '小d' },
              { member_id: 'ou_human', name: '邱璟光' },
            ],
            has_more: false,
          },
        }
      }
      if (/\/chats\/oc_g$/.test(url)) return { data: { name: '桥接话题探针' } }
      throw new Error('no permission')
    },
  }

  await t.handleImMessage({
    message: {
      message_type: 'text',
      chat_type: 'group',
      chat_id: 'oc_g',
      message_id: 'om_m1',
      content: JSON.stringify({ text: '@_user_1 你好' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_me' }, name: 'LiLO' }],
    },
    sender: { sender_id: { open_id: 'ou_lild' }, sender_type: 'app' },
  })
  ok(/小d · ou_lild/.test(got[0]?.origin || ''), '成员列表可用时，发送者名字自动补上', got[0]?.origin)
  ok(
    learned.some((x) => x.openId === 'ou_human' && x.name === '邱璟光'),
    '拉一次成员列表就把所有人的名字都存下来',
  )
  ok(memberCalls === 1, '同一个群只拉一次成员列表', `调用了 ${memberCalls} 次`)

  await t.handleImMessage({
    message: {
      message_type: 'text',
      chat_type: 'group',
      chat_id: 'oc_g',
      message_id: 'om_m2',
      content: JSON.stringify({ text: '@_user_1 再来' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_me' }, name: 'LiLO' }],
    },
    sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' },
  })
  ok(/邱璟光 · ou_human/.test(got[1]?.origin || ''), '第二个人也直接命中缓存')
  ok(memberCalls === 1, '没有重复打接口')
}

// ---------- 6.8 没有成员权限时，只警告一次并退回攒名字 ----------
{
  const { FeishuTransport } = await import('../src/feishu.js')
  const warns = []
  let calls = 0
  const t = new FeishuTransport(
    { feishu: { appId: 'cli_x', appSecret: 'sec_x', requireMention: true } },
    {
      onMessage: async () => {},
      onCardAction: async () => {},
      nameOf: () => '',
      onSeenNames: () => {},
      logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    },
  )
  t.resolveSelf = async () => ({ open_id: 'ou_me', name: 'LiLO' })
  t.client = {
    request: async ({ url }) => {
      if (/\/members\?/.test(url)) {
        calls++
        throw new Error('99991672 Access denied')
      }
      return { data: { name: '群' } }
    },
  }
  const ev = (id) => ({
    message: {
      message_type: 'text',
      chat_type: 'group',
      chat_id: 'oc_g',
      message_id: id,
      content: JSON.stringify({ text: '@_user_1 hi' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_me' }, name: 'LiLO' }],
    },
    sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' },
  })
  await t.handleImMessage(ev('om_n1'))
  await t.handleImMessage(ev('om_n2'))
  ok(calls === 1, '被拒一次后不再重试，避免每条消息都撞 403', `调用了 ${calls} 次`)
  ok(warns.filter((w) => /members:read/.test(w)).length === 1, '只警告一次，并说明缺哪个权限')
}

// ---------- 6.9 进程重启后，遗留的执行卡片要收尾 ----------
{
  const { Store } = await import('../src/store.js')
  const { Bridge } = await import('../src/handler.js')
  const { unlinkSync } = await import('node:fs')
  const path = '/tmp/ocb-inflight-test-' + Date.now() + '.json'

  const st = new Store(path)
  st.setInflight('ses_z', { cardId: 'om_card', chatId: 'oc_g', replyTo: 'om_1', key: 'root:om_1', directory: '/tmp' })
  st.flush()
  const st2 = new Store(path)
  ok(st2.inflightList().length === 1, 'inflight 记录落盘，重启后还在')
  ok(st2.inflightList()[0].cardId === 'om_card', '记录里带着卡片 id')

  const calls = []
  const cleared = []
  const b = new Bridge({
    oc: {},
    store: {
      ...st2,
      get: () => null,
      set() {},
      inflightList: () => st2.inflightList(),
      clearInflight: (sid) => cleared.push(sid),
    },
    config: { behavior: {} },
    transport: { patchCard: async (id, card) => calls.push({ id, card }) },
    logger: { info() {}, warn() {}, error() {} },
  })
  await b.reconcileInflight()

  ok(calls.length === 1 && calls[0].id === 'om_card', '启动时把遗留卡片 patch 成已中止')
  const body = JSON.stringify(calls[0]?.card || {})
  ok(/中断/.test(body), '卡片上写清楚是被中断，不是还在跑', '')
  ok(/已中止/.test(body), '状态标签是「已中止」')
  ok(cleared.includes('ses_z'), '收尾后清掉 inflight 记录，下次不再重复处理')

  const b2 = new Bridge({
    oc: {},
    store: { get: () => null, set() {}, inflightList: () => [], clearInflight() {} },
    config: { behavior: {} },
    transport: { patchCard: async () => { throw new Error('不该被调用') } },
    logger: { info() {}, warn() {}, error() {} },
  })
  await b2.reconcileInflight()
  ok(true, '没有遗留时什么都不做')

  unlinkSync(path)
}

// ---------- 7. 按钮要带上话题上下文 ----------
{
  const st = new RunState('ses_a')
  st.status = 'running'
  const card = runCard(st, { directory: '/tmp', key: 'root:om_1', rootId: 'om_1' })
  const json = JSON.stringify(card)
  ok(json.includes('"k":"root:om_1"'), '执行卡片按钮带绑定键 k')
  ok(json.includes('"rt":"om_1"'), '执行卡片按钮带话题根 rt')
  ok(!JSON.stringify(runCard(st, { directory: '/tmp' })).includes('"k":'), '没有话题上下文时不塞空字段')

  const list = sessionsCard({ sessions: [], directory: '/tmp', k: 'root:om_1', rt: 'om_1' })
  ok(JSON.stringify(list).includes('"k":"root:om_1"'), '会话列表按钮也带绑定键')
}

// ---------- 8. 群消息走 reply_in_thread ----------
{
  const { FeishuTransport } = await import('../src/feishu.js')
  const ft = new FeishuTransport(
    { feishu: { appId: 'a', appSecret: 'b', domain: 'feishu' } },
    { onMessage() {}, onCardAction() {} },
  )
  const calls = []
  ft.client = {
    im: { v1: { message: {
      reply: async (a) => {
        calls.push(['reply', a])
        return { code: 0, data: { message_id: 'om_reply' } }
      },
      create: async (a) => {
        calls.push(['create', a])
        return { code: 0, data: { message_id: 'om_create' } }
      },
    } } },
  }

  const id1 = await ft.sendCard('oc_g', { schema: '2.0' }, { replyTo: 'om_1' })
  ok(calls[0][0] === 'reply' && calls[0][1].data.reply_in_thread === true, '群里发卡片走 reply_in_thread（进话题）')
  ok(calls[0][1].path.message_id === 'om_1', '回复挂在话题根消息下', calls[0][1]?.path?.message_id)
  ok(id1 === 'om_reply', '返回新建卡片的 message_id')

  await ft.sendText('oc_g', 'hi')
  ok(calls[1][0] === 'create' && calls[1][1].data.receive_id === 'oc_g', '没有话题根时仍走 create（私聊/主群）')
}

// ---------- 9. 绑定键与真实 chat_id 分开存 ----------
{
  const { Store } = await import('../src/store.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'oc-store-'))
  try {
    const st = new Store(join(dir, 'state.json'))
    st.set('root:om_1', { chatId: 'oc_g', replyTo: 'om_1', sessionId: 'ses_a', directory: '/tmp' })
    const r = st.get('root:om_1')
    ok(r.key === 'root:om_1' && r.chatId === 'oc_g', '绑定记录同时保留 key 和真实 chat_id')

    st.set('root:om_1', { sessionId: 'ses_b' })
    ok(st.get('root:om_1').chatId === 'oc_g', '再次写入不会把 chat_id 覆盖成绑定键')

    st.clearSession('root:om_1')
    const c = st.get('root:om_1')
    ok(!c.sessionId && c.chatId === 'oc_g' && c.replyTo === 'om_1', '换会话后还知道该发到哪个群哪条话题')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
