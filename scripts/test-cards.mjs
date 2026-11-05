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

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
