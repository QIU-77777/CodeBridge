/**
 * 端到端：真实模型 → 真实事件流 → 真实飞书卡片，检查表格是否被渲染成 table 组件。
 * 只在 /tmp 建临时会话，跑完就删，不碰用户的会话。
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { Store } from '../src/store.js'
import { OpencodeClient } from '../src/oc.js'
import { Bridge } from '../src/handler.js'
import { FeishuTransport } from '../src/feishu.js'

const cfg = loadConfig()
const CHAT = 'oc_6603cd2922863fd16081b7fc1d9d08f0'
const USER = cfg.feishu.allowlist?.[0] || 'ou_test'
const statePath = join(tmpdir(), `bridge-e2e-${Date.now()}.json`)

const log = {
  info: (m) => console.log('[info]', m),
  warn: (m) => console.log('[warn]', m),
  error: (m) => console.log('[error]', m),
}

const oc = new OpencodeClient({ url: cfg.opencode.url, password: cfg.opencode.password, logger: log })
const store = new Store(statePath)
const transport = new FeishuTransport(cfg, { onMessage: async () => {}, onCardAction: async () => ({}) })
const bridge = new Bridge({ oc, store, config: cfg, transport, logger: log })

const session = await oc.createSession({
  title: 'bridge-e2e-table',
  directory: '/tmp',
  model: cfg.opencode.defaultModel
    ? { providerID: cfg.opencode.defaultModel.split('/')[0], id: cfg.opencode.defaultModel.split('/').slice(1).join('/') }
    : undefined,
})
console.log('临时会话', session.id)

store.set(CHAT, { sessionId: session.id, directory: '/tmp' })
await bridge.start()
await new Promise((r) => setTimeout(r, 800))

await bridge.onMessage({
  chatId: CHAT,
  userId: USER,
  text: '用一张 markdown 表格对比 3 个 JavaScript 包管理器（npm/pnpm/yarn），列出：包名、安装速度、磁盘占用。表格下面再跟一个 js 代码块示例。不要调用任何工具，直接回答。',
  messageId: 'e2e-' + Date.now(),
})

// 等执行结束
const deadline = Date.now() + 180_000
let run = null
while (Date.now() < deadline) {
  run = bridge.runs.get(session.id)
  if (run && ['done', 'failed', 'aborted'].includes(run.state.status)) break
  await new Promise((r) => setTimeout(r, 1000))
}

if (!run) {
  console.log('❌ 没有拿到 run')
} else {
  const st = run.state
  console.log('\n状态:', st.status, '耗时:', st.elapsed + 'ms', '步数:', st.steps)
  const { mdToElements } = await import('../src/md.js')
  const els = mdToElements(st.text)
  const tags = els.map((e) => e.tag)
  console.log('正文元素序列:', tags.join(' → '))
  const tables = els.filter((e) => e.tag === 'table')
  console.log('表格数量:', tables.length)
  for (const t of tables) {
    console.log('  列:', t.columns.map((c) => c.display_name).join(' | '))
    for (const r of t.rows) console.log('  行:', t.columns.map((c) => r[c.name]).join(' | '))
  }
  console.log('代码块数量:', els.filter((e) => e.tag === 'markdown' && e.content?.startsWith('```')).length)
  console.log('正文前 200 字:\n' + st.text.slice(0, 200))
}

// 清理：只删自己刚建的会话
try {
  await oc.deleteSession(session.id)
  console.log('\n已删除临时会话', session.id)
} catch (e) {
  console.log('删除临时会话失败', e.message)
}
store.clearSession?.(CHAT)
if (store.flush) await store.flush()
rmSync(statePath, { force: true })
process.exit(0)
