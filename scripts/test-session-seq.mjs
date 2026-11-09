#!/usr/bin/env node
/**
 * 会话默认名与按天序号的离线测试：不连飞书、不起后端。
 *
 *   node scripts/test-session-seq.mjs
 *
 * 背景（真实需求形态）：会话默认名原来是「飞书 · 2026/11/9 20:07:27」，
 * 列表里多个群、多个话题的会话分不清。改成「飞书·YYYYMMDD·新建会话n」，
 * n 按天从 1 开始只增不减：删会话、改会话名都不回收序号，否则新名字会和
 * 历史上的重名。计数器落盘（state.json 的 sessionSeq），重启不丢。
 */
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const { Store } = await import(`${REPO}src/store.js`)
const { Bridge, dayStamp } = await import(`${REPO}src/handler.js`)

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const quiet = { info() {}, warn() {}, error() {} }
const root = mkdtempSync(join(tmpdir(), 'ocb-seq-'))

// ---------- 1. 日期戳：本地时区 YYYYMMDD，月日补零 ----------
{
  ok(dayStamp(new Date(2026, 10, 9, 23, 59)) === '20261109', '月日补零：11 月 9 日', dayStamp(new Date(2026, 10, 9)))
  ok(dayStamp(new Date(2026, 0, 1, 0, 0)) === '20260101', '跨年补零：1 月 1 日', dayStamp(new Date(2026, 0, 1)))
  ok(/^\d{8}$/.test(dayStamp()), '默认取当前时间，八位数字', dayStamp())
}

// ---------- 2. 序号：同天累加、跨天归 1 ----------
{
  const st = new Store(join(root, 'a.json'))
  ok(st.nextSessionSeq('20261109') === 1, '当天第一个会话是 1')
  ok(st.nextSessionSeq('20261109') === 2, '同天第二个是 2')
  ok(st.nextSessionSeq('20261109') === 3, '同天第三个是 3')
  ok(st.nextSessionSeq('20261110') === 1, '换了日期从 1 重新记')
  ok(st.nextSessionSeq('20261110') === 2, '新一天继续累加')
}

// ---------- 3. 序号落盘：重启后接着涨，不重发 ----------
{
  const path = join(root, 'b.json')
  const st = new Store(path)
  st.nextSessionSeq('20261109')
  st.nextSessionSeq('20261109')
  // 不等防抖定时器，直接读盘：占号必须当场落盘，否则这中间进程被杀，
  // 重启会把同一个号再发一次，撞上已建成的同名会话
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  ok(onDisk.sessionSeq?.day === '20261109' && onDisk.sessionSeq?.n === 2, '占号后立即落盘', JSON.stringify(onDisk.sessionSeq))

  const st2 = new Store(path)
  ok(st2.nextSessionSeq('20261109') === 3, '重启后接着涨，不重发 3 之前的号')
}

// ---------- 4. 序号与后端会话无联动：删了、改名了都不回收 ----------
{
  const path = join(root, 'c.json')
  const st = new Store(path)
  st.nextSessionSeq('20261109') // 1
  st.nextSessionSeq('20261109') // 2
  st.nextSessionSeq('20261109') // 3
  // 模拟人为删掉会话 2、把会话 1 改名：store 侧没有任何路径碰 sessionSeq
  st.clearSession('root:om_x') // 只是证明聊天绑定操作不波及计数器
  ok(st.nextSessionSeq('20261109') === 4, '删过会话、改过名，下一个还是 4')
}

// ---------- 5. createAndBind：标题格式与占号 ----------
function makeBridge(store, behavior = {}) {
  const created = []
  const oc = {
    async createSession({ title }) {
      created.push(title)
      return { id: `ses_${created.length}`, title, location: { directory: '/tmp' } }
    },
  }
  const b = new Bridge({
    oc,
    store,
    config: { behavior, feishu: {}, opencode: {} },
    transport: {},
    logger: quiet,
  })
  return { b, created }
}

{
  const { b, created } = makeBridge(new Store(join(root, 'd.json')))
  const ctx = { key: 'root:om_1', chatId: 'oc_1', replyTo: 'om_1' }
  await b.createAndBind(ctx, '/tmp')
  await b.createAndBind(ctx, '/tmp')
  ok(created[0] === `飞书·${dayStamp()}·新建会话1`, '第一个会话名带 1', created[0])
  ok(created[1] === `飞书·${dayStamp()}·新建会话2`, '第二个会话名带 2', created[1])
}

// ---------- 6. 并发新建不撞号 ----------
{
  const { b, created } = makeBridge(new Store(join(root, 'e.json')))
  const mk = (k) => ({ key: `root:${k}`, chatId: 'oc_1', replyTo: k })
  const [s1, s2] = await Promise.all([
    b.createAndBind(mk('om_a'), '/tmp'),
    b.createAndBind(mk('om_b'), '/tmp'),
  ])
  const nums = created.map((t) => Number(t.match(/新建会话(\d+)$/)[1])).sort((x, y) => x - y)
  ok(nums.length === 2 && nums[0] !== nums[1], '两个话题同时建会话不撞号', created.join(' | '))
  ok(s1.id !== s2.id, '两个会话 id 不同')
}

// ---------- 6b. 创建交叠时也不撞号 ----------
//
// 上一项的 createSession 立即返回，两次占号被微任务队列串开，覆盖不到
// 「两个建会话请求真的在后端那头重叠」的形态。这里让 createSession 内部
// await 20ms 再返回，两个 createAndBind 同时发起：占号段在第一个 await
// 之前且全程同步，重叠时拿到的号仍然是 1 和 2
{
  const path = join(root, 'e2.json')
  const created = []
  const oc = {
    async createSession({ title }) {
      await new Promise((r) => setTimeout(r, 20))
      created.push(title)
      return { id: `ses_${created.length}`, title, location: { directory: '/tmp' } }
    },
  }
  const b = new Bridge({ oc, store: new Store(path), config: { behavior: {}, feishu: {}, opencode: {} }, transport: {}, logger: quiet })
  const mk = (k) => ({ key: `root:${k}`, chatId: 'oc_1', replyTo: k })
  await Promise.all([b.createAndBind(mk('om_a'), '/tmp'), b.createAndBind(mk('om_b'), '/tmp')])
  const nums = created.map((t) => Number(t.match(/新建会话(\d+)$/)[1])).sort((x, y) => x - y)
  ok(nums[0] === 1 && nums[1] === 2, '创建请求重叠时号仍然是 1、2', created.join(' | '))
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  ok(onDisk.sessionSeq?.n === 2, '落盘计数器记到 2', JSON.stringify(onDisk.sessionSeq))
}

// ---------- 6c. 旧版 state.json 没有 sessionSeq 字段 ----------
//
// 存量文件只有 version + chats：load 整对象替换后 cur 为 undefined，走 else
// 分支返回 1，既有绑定一个不丢；day 是旧日期的 sessionSeq 同样归 1
{
  const path = join(root, 'g.json')
  writeFileSync(
    path,
    JSON.stringify({ version: 1, chats: { 'root:om_old': { sessionId: 'ses_old', chatId: 'oc_1', replyTo: 'om_old', key: 'root:om_old' } } }),
    'utf8',
  )
  const st = new Store(path)
  ok(st.nextSessionSeq(dayStamp()) === 1, '旧文件（无 sessionSeq）首个序号是 1')
  ok(st.get('root:om_old')?.sessionId === 'ses_old', '旧文件的会话绑定不丢')

  const path2 = join(root, 'h.json')
  writeFileSync(path2, JSON.stringify({ version: 1, chats: {}, sessionSeq: { day: '20260101', n: 57 } }), 'utf8')
  const st2 = new Store(path2)
  ok(st2.nextSessionSeq(dayStamp()) === 1, '计数器是旧日期时序号归 1')
}

// ---------- 7. 创建失败跳号，不回填 ----------
{
  const path = join(root, 'f.json')
  const created = []
  let calls = 0
  const oc = {
    async createSession({ title }) {
      created.push(title)
      if (++calls === 1) throw new Error('后端创建失败')
      return { id: 'ses_ok', title, location: { directory: '/tmp' } }
    },
  }
  const b = new Bridge({ oc, store: new Store(path), config: { behavior: {}, feishu: {}, opencode: {} }, transport: {}, logger: quiet })
  const ctx = { key: 'root:om_1', chatId: 'oc_1', replyTo: 'om_1' }
  let threw = false
  try {
    await b.createAndBind(ctx, '/tmp')
  } catch {
    threw = true
  }
  ok(threw, '后端创建失败时异常上抛')
  await b.createAndBind(ctx, '/tmp')
  ok(created[1].endsWith('新建会话2'), '失败跳过一个号，下一个从 2 继续，不回填 1', created.join(' | '))
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
