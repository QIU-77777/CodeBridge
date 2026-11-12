#!/usr/bin/env node
/**
 * 管理后台删除操作与桥接进程的状态同步（离线测试）。
 *   node scripts/test-state-sync.mjs
 *
 * 背景：state.json 的唯一写者是桥接进程（Store 全量内存 + 300ms 防抖落盘），
 * 管理后台直接删掉文件里的一个绑定，会被下一次落盘原样写回。同步规则是单向的：
 * 只把「磁盘上已不存在的绑定」从内存删掉，不把磁盘内容灌进内存——桥接自己的
 * 新增与 queue/inflight/sessionSeq 等运行时状态因此不会丢。
 *
 * pi 侧同理：PiBackend._index 是 index.json 的内存缓存，后台删掉会话文件后
 * 要置空，否则 /sessions 还列着已删的会话。
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

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

const REPO = fileURLToPath(new URL('..', import.meta.url))
const { Store } = await import(join(REPO, 'src', 'store.js'))
const { PiBackend } = await import(join(REPO, 'src', 'pi.js'))
const { resolveRevealTarget } = await import(join(REPO, 'admin', 'server.js'))

/** 写一份 state.json（模拟桥接自己的落盘或管理后台的修改）。
 *  传对象就序列化；传字符串就原样写（用来构造损坏文件） */
function writeState(path, data) {
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8')
}

/** 等一个条件成立，最多 ms 毫秒。fs.watch 是异步的，集成用例靠它 */
async function waitFor(cond, ms = 3000) {
  const t0 = Date.now()
  for (;;) {
    if (cond()) return true
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 20))
  }
}

const baseChats = () => ({
  'oc_chat_a': { key: 'oc_chat_a', chatId: 'oc_chat_a', sessionId: 'ses_a', directory: '/tmp/a', updatedAt: 1 },
  'root:om_thread_b': { key: 'root:om_thread_b', chatId: 'oc_chat_b', replyTo: 'om_thread_b', sessionId: 'ses_b', directory: '/tmp/b', updatedAt: 2 },
})

try {
  // ---------- 1. Store 单向同步 ----------
  {
    const dir = mkdtempSync(join(tmpdir(), 'ocb-sync-'))
    const path = join(dir, 'state.json')
    writeState(path, { version: 1, chats: baseChats() })
    const st = new Store(path)
    // 单元断言不受异步监听干扰（监听触发后的行为在本节末尾单独测）
    st.watcher?.close()
    ok(Object.keys(st.data.chats).length === 2, 'Store 加载到两个绑定')

    // 外部（管理后台）删掉一个绑定：内存跟上
    writeState(path, { version: 1, chats: { 'oc_chat_a': baseChats()['oc_chat_a'] } })
    ok(st.syncExternalDeletes() === true, '磁盘上少的绑定被同步删除')
    ok(!('root:om_thread_b' in st.data.chats), '被删的绑定从内存消失')
    ok('oc_chat_a' in st.data.chats, '磁盘上还在的绑定保留')

    // 反向不传播：内存里有、还没落盘的（桥接刚建的绑定）保留。判据是
    // knownKeys——只用「磁盘上没有」区分会把桥接未落盘的新绑定误删
    st.set('oc_new', { sessionId: 'ses_new', directory: '/tmp/new' })
    writeState(path, { version: 1, chats: { 'oc_chat_a': baseChats()['oc_chat_a'] } })
    ok(st.syncExternalDeletes() === false, '没有新的外部删除时返回无变更')
    ok('oc_new' in st.data.chats, '桥接自己刚建、未落盘的绑定不被同步清掉')

    // 落盘后新绑定进入 knownKeys：此后它再被外部删掉，照样能同步
    st.flush()
    const flushed = JSON.parse(readFileSync(path, 'utf8'))
    ok('oc_new' in flushed.chats, 'flush 把新绑定写回磁盘')
    writeState(path, { version: 1, chats: { 'oc_chat_a': baseChats()['oc_chat_a'] } })
    ok(st.syncExternalDeletes() === true, '落盘后的绑定被外部删除同样同步')
    ok(!('oc_new' in st.data.chats), '落盘后被删的绑定从内存消失')

    // 磁盘读不到 / 解析失败 / 形状不对：不动内存
    const before = Object.keys(st.data.chats).join(',')
    rmSync(path)
    ok(st.syncExternalDeletes() === false, 'state.json 不存在时不做任何事')
    ok(Object.keys(st.data.chats).join(',') === before, '读不到磁盘时内存原样保留')
    writeState(path, '{ 坏掉的 json')
    ok(st.syncExternalDeletes() === false, 'state.json 解析失败时不做任何事')
    ok(Object.keys(st.data.chats).join(',') === before, '解析失败时内存原样保留')
    writeState(path, { version: 1, chats: 'not-an-object' })
    ok(st.syncExternalDeletes() === false, 'chats 形状不对时不做任何事')
    ok(Object.keys(st.data.chats).join(',') === before, '形状不对时内存原样保留')

    // flush 吸收外部删除：防抖窗口里后台删的 key，不能被子进程写回
    writeState(path, { version: 1, chats: baseChats() })
    const st2 = new Store(path)
    st2.watcher?.close()
    st2.set('oc_fresh', { sessionId: 'ses_fresh', directory: '/tmp/fresh' }) // 内存脏了
    const withoutB = { version: 1, chats: { 'oc_chat_a': baseChats()['oc_chat_a'] } }
    writeState(path, withoutB) // 后台同时删掉 root:om_thread_b
    st2.flush()
    const afterFlush = JSON.parse(readFileSync(path, 'utf8'))
    ok(!('root:om_thread_b' in afterFlush.chats), 'flush 先把外部删除吸收进内存再落盘，删除不被写回')
    ok('oc_fresh' in afterFlush.chats, 'flush 不丢桥接自己未落盘的新绑定')
    ok('oc_chat_a' in afterFlush.chats, 'flush 保留其余绑定')

    // 目录监听：外部改写文件后内存自动跟上（不显式调 syncExternalDeletes）
    writeState(path, { version: 1, chats: baseChats() })
    const st3 = new Store(path)
    ok(Object.keys(st3.data.chats).length === 2, '新 Store 读到两个绑定')
    writeState(path, withoutB)
    ok(await waitFor(() => !('root:om_thread_b' in st3.data.chats)), '监听触发后内存同步删除')
    ok('oc_chat_a' in st3.data.chats, '监听同步不误删其余绑定')

    rmSync(dir, { recursive: true, force: true })
  }

  // ---------- 2. pi 索引缓存失效 ----------
  {
    const dir = mkdtempSync(join(tmpdir(), 'ocb-piwatch-'))
    const sessionDir = join(dir, 'pi-sessions')
    const backend = new PiBackend({
      cfg: { backend: { type: 'pi', pi: {} }, opencode: {}, behavior: {} },
      sessionDir,
      logger: { warn() {}, info() {} },
    })
    const sid = 'pi-aaaa1111'
    writeFileSync(join(sessionDir, `2026-11-12T00-00-00_${sid}.jsonl`), '{"type":"session"}\n')
    writeFileSync(join(sessionDir, 'index.json'), JSON.stringify({
      [sid]: { id: sid, title: '旧标题', location: { directory: '/tmp/x' }, time: { updated: 1 } },
    }))
    ok(Boolean(backend._load()[sid]), '索引缓存里读到会话')

    // 管理后台删掉这个会话：索引条目与文件都没了
    rmSync(join(sessionDir, `2026-11-12T00-00-00_${sid}.jsonl`))
    writeFileSync(join(sessionDir, 'index.json'), '{}')
    ok(await waitFor(() => !backend._load()[sid]), '目录外部改动后索引缓存置空，重读即新内容')
    ok(!backend._load()[sid], '重读后的索引里没有已删的会话')

    // 后台改索引（不是删）：同样要能读到新值
    writeFileSync(join(sessionDir, 'index.json'), JSON.stringify({
      [sid]: { id: sid, title: '新标题', location: { directory: '/tmp/x' }, time: { updated: 2 } },
    }))
    ok(await waitFor(() => backend._load()[sid]?.title === '新标题'), '索引被外部改写后缓存同样失效')

    rmSync(dir, { recursive: true, force: true })
  }

  // ---------- 3. reveal 路径解析 ----------
  {
    const dir = mkdtempSync(join(tmpdir(), 'ocb-reveal-'))
    const sessionDir = join(dir, 'pi-sessions')
    const piCfg = { backend: { type: 'pi', pi: {} } }
    const ocCfg = { backend: { type: 'opencode' } }
    const sid = 'pi-bbbb2222'
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, `2026-11-12T01-00-00_${sid}.jsonl`), '{"type":"session"}\n')
    const state = { chats: { 'oc_x': { key: 'oc_x', sessionId: sid } } }

    const file = await resolveRevealTarget({ dir, cfg: piCfg, target: 'session', sidOrKey: sid, state })
    ok(file.kind === 'file' && file.path.endsWith(`_${sid}.jsonl`), 'pi 会话解析到 jsonl 文件', file.path)
    ok(file.path.startsWith(sessionDir), 'pi 文件在 pi-sessions 目录内')

    const byBinding = await resolveRevealTarget({ dir, cfg: piCfg, target: 'binding', sidOrKey: 'oc_x', state })
    ok(byBinding.kind === 'file' && byBinding.path === file.path, '绑定行查看解析到它绑定的会话文件')

    // 绑定没有会话：报错（页面按钮此时本就是禁用的）
    let err = null
    try {
      await resolveRevealTarget({ dir, cfg: piCfg, target: 'binding', sidOrKey: 'oc_none', state: { chats: { oc_none: { key: 'oc_none' } } } })
    } catch (e) { err = e }
    ok(err?.message === '这个绑定还没有会话', '没有绑定会话时给出可读错误', err?.message)

    // 会话不存在
    err = null
    try { await resolveRevealTarget({ dir, cfg: piCfg, target: 'session', sidOrKey: 'pi-nope', state }) } catch (e) { err = e }
    ok(err?.message === '找不到会话 pi-nope 的文件', '找不到会话文件时给出可读错误', err?.message)

    // 空 id
    err = null
    try { await resolveRevealTarget({ dir, cfg: piCfg, target: 'session', sidOrKey: '  ', state }) } catch (e) { err = e }
    ok(err?.message === '缺少会话 id', '空会话 id 被拒绝')

    // opencode：解析到数据库目录；会话不存在与 serve 无响应分别报错
    const dir2 = await resolveRevealTarget({
      dir, cfg: ocCfg, target: 'session', sidOrKey: 'ses_x', state,
      sessionExists: async () => ({ data: {} }),
    })
    ok(dir2.kind === 'dir' && dir2.path.endsWith('.local/share/opencode'), 'opencode 会话解析到数据库目录', dir2.path)

    err = null
    try {
      await resolveRevealTarget({ dir, cfg: ocCfg, target: 'session', sidOrKey: 'ses_gone', state, sessionExists: async () => { throw Object.assign(new Error('x'), { status: 404 }) } })
    } catch (e) { err = e }
    ok(err?.message === '会话 ses_gone 不存在', 'serve 404 时报会话不存在', err?.message)

    err = null
    try {
      await resolveRevealTarget({ dir, cfg: ocCfg, target: 'session', sidOrKey: 'ses_x', state, sessionExists: async () => { throw new Error('connect ECONNREFUSED') } })
    } catch (e) { err = e }
    ok(err?.message.startsWith('serve 无响应'), 'serve 连不上时说明原因', err?.message)

    // serve 有响应但报错（400 等）：如实转述状态码，不说成「无响应」
    err = null
    try {
      await resolveRevealTarget({ dir, cfg: ocCfg, target: 'session', sidOrKey: 'ses_bad', state, sessionExists: async () => { throw Object.assign(new Error('/api/session/ses_bad -> 400'), { status: 400 }) } })
    } catch (e) { err = e }
    ok(/serve 返回 400/.test(err?.message || ''), 'serve 返回错误状态码时如实转述', err?.message)

    // 不传 sessionExists（serve 未接线）时也要能给出目录
    const noCheck = await resolveRevealTarget({ dir, cfg: ocCfg, target: 'session', sidOrKey: 'ses_x', state })
    ok(noCheck.kind === 'dir', '没接存在性检查时直接给数据库目录')

    rmSync(dir, { recursive: true, force: true })
  }
} catch (err) {
  fail++
  console.log(`❌ 测试本身出错: ${err.stack || err.message}`)
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
