#!/usr/bin/env node
/**
 * admin HTTP 接口的端到端测试：临时配置目录起一个真服务（随机端口），
 * 用 fetch 打接口，断言落盘的 config.json。不碰飞书、不起停桥接进程。
 *   node scripts/test-admin-api.mjs
 *
 * 覆盖两条写路径：白名单增删（含加入时带名字）与名字对照增改删，
 * 外加保存备份、密钥掩码、参数校验与写操作防护头。
 * 纯函数的用例在 scripts/test-admin.mjs，这里钉的是接口到落盘的整条路。
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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

// 整套测试跑在一个假家目录里：PLIST_DIR 与 CONFIG_BASE 都是 import 时按
// homedir() 算出来的，只改 OCB_CONFIG_DIR 不够——缺 OCB_CONFIG_DIR 的
// plist 会回落到 defaultConfigDir()，把真实实例错认成测试实例。改 HOME
// 才能同时隔开 plist 扫描与配置目录扫描，测试全程不碰真实实例
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'ocb-api-'))
const FAKE_HOME = join(TMP_ROOT, 'home')
const INSTANCE_DIR = join(FAKE_HOME, '.config', 'opencode-feishu-bridge-apitest')
mkdirSync(INSTANCE_DIR, { recursive: true })
delete process.env.OCB_CONFIG_DIR
process.env.HOME = FAKE_HOME

const CONFIG_PATH = join(INSTANCE_DIR, 'config.json')
writeFileSync(
  CONFIG_PATH,
  JSON.stringify(
    {
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 600000, extraArgs: [] } },
      feishu: {
        appId: 'cli_test0000000000000a',
        appSecret: 'sec',
        domain: 'feishu',
        allowlist: [],
        requireMention: true,
        botOpenId: '',
        names: {},
      },
      opencode: { url: 'http://127.0.0.1:19876', password: '', defaultDirectory: '/tmp', defaultModel: '' },
      behavior: { streamIntervalMs: 1800, showReasoning: false, showTools: false, maxBodyChars: 6000, idleTimeoutMs: 900000, maxParallel: 2 },
    },
    null,
    2,
  ),
)

const { startAdmin } = await import('../admin/server.js')
const server = startAdmin({ host: '127.0.0.1', port: 0 })
// listen 是异步的，等监听事件回来再取端口，否则 address() 还是 null
await new Promise((res, rej) => {
  server.once('listening', res)
  server.once('error', rej)
})
const BASE = `http://127.0.0.1:${server.address().port}`
// 目录名推出实例名（instanceNameOf 的规则），接口按名字寻址
const NAME = 'apitest'

const readCfg = () => {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (err) {
    // 读不出来就让断言带着路径和原因失败，比静默返回空对象好排查
    throw new Error(`读取 ${CONFIG_PATH} 失败: ${err.message}`)
  }
}

async function call(path, body, withHeader = true) {
  const headers = { 'Content-Type': 'application/json' }
  if (withHeader) headers['X-OCB-Admin'] = '1'
  const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

try {
  // 白名单加一条，不带名字
  let r = await call(`/api/instances/${NAME}/allowlist`, { op: 'add', openId: 'ou_test000000000000000000a1' })
  ok(r.status === 200 && r.json.allowlist?.length === 1, '加白名单（不带名字）成功')
  ok(readCfg().feishu.allowlist[0] === 'ou_test000000000000000000a1', 'config.json 里写上 open_id')

  // 同一条再带名字加一次：名单不重复，名字写进 feishu.names
  r = await call(`/api/instances/${NAME}/allowlist`, { op: 'add', openId: 'ou_test000000000000000000a1', name: '测试用户' })
  ok(r.status === 200 && r.json.allowlist?.length === 1, '重复添加白名单幂等')
  ok(readCfg().feishu.names?.['ou_test000000000000000000a1'] === '测试用户', '加入时填的名字落进 feishu.names')

  // 新条目带名字加入
  r = await call(`/api/instances/${NAME}/allowlist`, { op: 'add', openId: 'ou_test000000000000000000a2', name: '第二名' })
  ok(r.status === 200 && r.json.allowlist?.length === 2, '带名字加新条目成功')

  // 移除白名单不碰名字：这个名字可能还给非白名单用户的标注用着
  r = await call(`/api/instances/${NAME}/allowlist`, { op: 'remove', openId: 'ou_test000000000000000000a2' })
  ok(r.status === 200 && r.json.allowlist?.length === 1, '移除白名单成功')
  ok(readCfg().feishu.names?.['ou_test000000000000000000a2'] === '第二名', '移除白名单保留名字声明')

  // 名字对照增、改、删
  r = await call(`/api/instances/${NAME}/names`, { op: 'set', openId: 'ou_test000000000000000000a3', name: '第三名' })
  ok(r.status === 200 && readCfg().feishu.names?.['ou_test000000000000000000a3'] === '第三名', '名字对照新增落盘')
  r = await call(`/api/instances/${NAME}/names`, { op: 'set', openId: 'ou_test000000000000000000a3', name: '第三名改' })
  ok(r.status === 200 && readCfg().feishu.names?.['ou_test000000000000000000a3'] === '第三名改', '名字对照修改落盘')
  r = await call(`/api/instances/${NAME}/names`, { op: 'remove', openId: 'ou_test000000000000000000a3' })
  ok(r.status === 200 && !('ou_test000000000000000000a3' in readCfg().feishu.names), '名字对照移除落盘')

  // 保存前备份；详情接口掩码密钥
  ok(existsSync(CONFIG_PATH + '.bak'), '保存前生成 config.json.bak')
  const detail = await fetch(`${BASE}/api/instances/${NAME}`, { headers: { Accept: 'application/json' } }).then((x) => x.json())
  ok(detail.config?.feishu?.appSecret === '********', '详情接口掩码 appSecret')

  // 参数校验
  ok((await call(`/api/instances/${NAME}/allowlist`, { op: 'add', openId: '' })).status === 400, '空 open_id 返回 400')
  ok(
    (await call(`/api/instances/${NAME}/allowlist`, { op: 'add', openId: 'ou_x', name: 'x'.repeat(51) })).status === 400,
    '超长名字返回 400',
  )
  ok((await call(`/api/instances/${NAME}/names`, { op: 'set', openId: 'ou_x' })).status === 400, 'set 不带名字返回 400')
  ok((await call(`/api/instances/${NAME}/names`, { op: 'bogus', openId: 'ou_x', name: 'x' })).status === 400, '未知 op 返回 400')

  // 写操作防护头：缺 X-OCB-Admin 一律 403，且不产生任何写入
  const before = readFileSync(CONFIG_PATH, 'utf8')
  const noHeader = await call(`/api/instances/${NAME}/names`, { op: 'remove', openId: 'ou_test000000000000000000a1' }, false)
  ok(noHeader.status === 403, '缺少 X-OCB-Admin 头的写操作返回 403')
  ok(readFileSync(CONFIG_PATH, 'utf8') === before, '被 403 挡回的写操作没有落盘')

  // 会话列表：pi 后端读配置目录的 pi-sessions/index.json（桥接写的本地索引）。
  // 先测「从没建过会话」：索引文件不存在时返回空列表，而不是「不适用」
  const sessionsEmpty = await fetch(`${BASE}/api/instances/${NAME}/sessions`, { headers: { Accept: 'application/json' } }).then((x) => x.json())
  ok(sessionsEmpty.applicable === true && sessionsEmpty.sessions?.length === 0, 'pi 无会话索引时返回空列表')

  // 造一份索引，形状与 src/pi.js 写的一致；按最近更新倒序返回
  mkdirSync(join(INSTANCE_DIR, 'pi-sessions'), { recursive: true })
  writeFileSync(
    join(INSTANCE_DIR, 'pi-sessions', 'index.json'),
    JSON.stringify({
      'pi-old0001': { id: 'pi-old0001', title: '飞书 · 2026/11/6 15:11:34', location: { directory: '/tmp/old' }, model: null, time: { created: 1000, updated: 2000 } },
      'pi-new0002': { id: 'pi-new0002', title: '飞书 · 2026/11/6 17:44:07', location: { directory: '/tmp/new' }, model: { providerID: 'deepseek', id: 'deepseek-v4-pro' }, time: { created: 3000, updated: 9000 } },
    }),
  )
  const sessions = await fetch(`${BASE}/api/instances/${NAME}/sessions`, { headers: { Accept: 'application/json' } }).then((x) => x.json())
  ok(sessions.applicable === true && sessions.sessions?.length === 2, 'pi 会话索引读出两条')
  ok(sessions.sessions?.[0]?.id === 'pi-new0002', '按最近更新倒序（新的在前）')
  ok(sessions.sessions?.[0]?.directory === '/tmp/new' && sessions.sessions?.[0]?.title.includes('17:44'), '会话字段完整（标题、目录）')
  ok(sessions.sessions?.[0]?.model === 'deepseek/deepseek-v4-pro', '模型拼成 provider/id')
  ok(sessions.sessions?.[0]?.updatedAt === 9000, '更新时间带回')

  // 索引里 model 为 null 的老会话（建会话时没配默认模型）：模型从会话文件头部的
  // model_change 行解析，不必等它再跑一次。桥接只对跑起来的会话补写索引
  writeFileSync(
    join(INSTANCE_DIR, 'pi-sessions', '2026-11-06T07-11-35-911Z_pi-old0001.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'pi-old0001', timestamp: '2026-11-06T07:11:35.911Z', cwd: '/tmp/old' }) +
      '\n' +
      JSON.stringify({ type: 'model_change', id: 'a1', parentId: null, provider: 'deepseek', modelId: 'deepseek-v4-pro' }) +
      '\n' +
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: '读一下' } }) +
      '\n',
  )
  const sessionsDerived = await fetch(`${BASE}/api/instances/${NAME}/sessions`, { headers: { Accept: 'application/json' } }).then((x) => x.json())
  ok(
    sessionsDerived.sessions?.find((x) => x.id === 'pi-old0001')?.model === 'deepseek/deepseek-v4-pro',
    '索引没写模型时从会话文件头部解析（老会话也有模型）',
  )
  ok(
    sessionsDerived.sessions?.find((x) => x.id === 'pi-new0002')?.model === 'deepseek/deepseek-v4-pro',
    '索引写了模型时仍以索引为准',
  )

  // 索引损坏时明确报错，不静默返回空列表
  writeFileSync(join(INSTANCE_DIR, 'pi-sessions', 'index.json'), '{ 这不是 JSON')
  const sessionsBad = await fetch(`${BASE}/api/instances/${NAME}/sessions`, { headers: { Accept: 'application/json' } }).then((x) => x.json())
  ok(sessionsBad.applicable === true && sessionsBad.error && sessionsBad.sessions?.length === 0, '会话索引损坏时带回错误')

  // 本地 coding agent 扫描：配置页与新建弹窗的选项来源。GET，不需要写操作头
  const backends = await fetch(`${BASE}/api/backends`, { headers: { Accept: 'application/json' } }).then((x) => x.json())
  ok(Array.isArray(backends.backends) && backends.backends.length === 2, 'GET /api/backends 返回两个后端')
  ok(
    backends.backends.every((b) => typeof b.type === 'string' && typeof b.available === 'boolean' && typeof b.summary === 'string'),
    '每个后端带类型、可用性与一句话说明',
  )
  ok(
    backends.backends.filter((b) => b.available).every((b) => typeof b.bin === 'string' && b.bin.length > 0),
    '可用的后端带解析到的路径',
  )
  ok(
    backends.backends.filter((b) => !b.available).every((b) => typeof b.reason === 'string' && b.reason.length > 0),
    '不可用的后端带原因',
  )
  ok(
    (
      await fetch(`${BASE}/api/backends`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OCB-Admin': '1' },
      })
    ).status === 405,
    'backends 接口只接受 GET',
  )

  // 站点图标：/favicon.svg 要能取到，且页面里真的引用了它。少了这一步，
  // 浏览器标签页只会显示默认图标，而 index.html 里的 link 会 404
  {
    const svg = await fetch(`${BASE}/favicon.svg`)
    ok(svg.status === 200, 'favicon.svg 路由可取', String(svg.status))
    ok(
      (svg.headers.get('content-type') || '').includes('image/svg+xml'),
      'Content-Type 是 image/svg+xml',
      svg.headers.get('content-type') || '',
    )
    const body = await svg.text()
    ok(body.includes('<svg') && body.includes('</svg>'), '返回的是完整 SVG')
    // XML 注释里不能出现连续两个连字符，否则整个文件解析失败、图标不显示
    // （实测过一次：注释里写了 CSS 变量名 --accent，五个尺寸全部加载失败）
    const comments = [...body.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1])
    ok(
      comments.every((c) => !c.includes('--')),
      '注释里没有连续连字符（否则 SVG 解析失败）',
      comments.find((c) => c.includes('--')) || '',
    )
    const html = await (await fetch(`${BASE}/`)).text()
    ok(html.includes('href="/favicon.svg"'), '页面引用了 favicon.svg')
    ok(html.includes('rel="icon"'), '引用带 rel="icon"')
  }
  // serve 密码变更必须提示重启 serve：serve 是长跑进程，启动时把密码读进
  // 自己的环境，之后改配置不会跟着变。不提示的话用户以为改完就生效，而桥接
  // 拿着新密码连旧 serve，全程 401——现象是「毫无反应」而不是报错
  {
    const put = async (body) => {
      const res = await fetch(`${BASE}/api/instances/${NAME}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-OCB-Admin': '1' },
        body: JSON.stringify(body),
      })
      return { status: res.status, json: await res.json().catch(() => ({})) }
    }
    const cur = readCfg()

    // 留空 = 保持原值，且不触发重启提示
    let r = await put({ opencode: { password: '' } })
    ok(r.status === 200 && !r.json.notice, 'serve 密码留空保存不触发重启提示')
    ok(readCfg().opencode.password === cur.opencode.password, '留空时原密码保持不变')

    // 真改了才提示
    r = await put({ opencode: { password: 'new-secret-value' } })
    ok(r.status === 200 && readCfg().opencode.password === 'new-secret-value', '新密码写入配置')
    ok(
      /重启 serve/.test(r.json.notice || ''),
      '密码变更时提示需要重启 serve',
      r.json.notice,
    )

    // 掩码值（********）等于没改，同样不提示
    r = await put({ opencode: { password: '********' } })
    ok(r.status === 200 && !r.json.notice, '掩码密码不触发重启提示')
    ok(readCfg().opencode.password === 'new-secret-value', '掩码值时原密码不被冲掉')
  }

  // ---------- 会话查看与删除（pi 后端实例） ----------
  // 造一份干净的 pi 会话索引与 state.json（上一节把索引写坏过）
  {
    const piDir = join(INSTANCE_DIR, 'pi-sessions')
    mkdirSync(piDir, { recursive: true })
    writeFileSync(join(piDir, '2026-11-12T00-00-00_pi-del0001.jsonl'), '{"type":"session"}\n')
    writeFileSync(
      join(piDir, 'index.json'),
      JSON.stringify({
        'pi-del0001': { id: 'pi-del0001', title: '要删的', location: { directory: '/tmp/del' }, model: null, time: { created: 1, updated: 2 } },
        'pi-del0002': { id: 'pi-del0002', title: '要留的', location: { directory: '/tmp/keep' }, model: null, time: { created: 3, updated: 4 } },
      }),
    )
    const STATE_PATH = join(INSTANCE_DIR, 'state.json')
    const writeChats = (chats, inflight = {}) =>
      writeFileSync(STATE_PATH, JSON.stringify({ version: 1, chats, inflight }, null, 2))
    const readChats = () => JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    writeChats({
      'oc_keep': { key: 'oc_keep', chatId: 'oc_keep', sessionId: 'pi-del0002', directory: '/tmp/keep', updatedAt: 1 },
      'oc_gone': { key: 'oc_gone', chatId: 'oc_gone', sessionId: 'pi-del0001', directory: '/tmp/del', updatedAt: 2 },
      'root:om_thread': { key: 'root:om_thread', chatId: 'oc_group', replyTo: 'om_thread', sessionId: 'pi-del0002', updatedAt: 3 },
      'oc_nosession': { key: 'oc_nosession', chatId: 'oc_nosession', updatedAt: 4 },
    })

    const del = async (path) => {
      const res = await fetch(BASE + path, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-OCB-Admin': '1' },
      })
      return { status: res.status, json: await res.json().catch(() => ({})) }
    }
    const post = async (path, body) => {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OCB-Admin': '1' },
        body: JSON.stringify(body ?? {}),
      })
      return { status: res.status, json: await res.json().catch(() => ({})) }
    }

    // 解除绑定：先备份，再原子写；root: 这种带冒号的键要能编码穿过 URL
    let r = await del(`/api/instances/${NAME}/bindings/${encodeURIComponent('root:om_thread')}`)
    ok(r.status === 200 && r.json.ok === true, '解除绑定成功', JSON.stringify(r.json))
    ok(existsSync(STATE_PATH + '.bak'), '解除绑定前备份 state.json.bak')
    ok(!('root:om_thread' in readChats().chats), 'state.json 里该绑定已移除')
    ok('oc_keep' in readChats().chats && 'oc_gone' in readChats().chats, '其余绑定不受影响')
    ok(!existsSync(STATE_PATH + '.tmp'), '临时文件已重命名，没有残留')

    // 不存在的键返回 404，不动文件
    const chatsBefore = readFileSync(STATE_PATH, 'utf8')
    r = await del(`/api/instances/${NAME}/bindings/${encodeURIComponent('oc_nope')}`)
    ok(r.status === 404, '解除不存在的绑定返回 404')
    ok(readFileSync(STATE_PATH, 'utf8') === chatsBefore, '404 时 state.json 不动')

    // 缺写操作防护头：403 且不落盘
    const noHeader = await fetch(`${BASE}/api/instances/${NAME}/bindings/oc_keep`, { method: 'DELETE' })
    ok(noHeader.status === 403, '解除绑定缺 X-OCB-Admin 头返回 403')
    ok(readFileSync(STATE_PATH, 'utf8') === chatsBefore, '403 时 state.json 不动')

    // 会话正在执行中（inflight 里有）：拒解，提示先 /stop
    writeChats(readChats().chats, { 'pi-del0002': { sessionId: 'pi-del0002', cardId: 'c1', startedAt: 1 } })
    r = await del(`/api/instances/${NAME}/bindings/oc_keep`)
    ok(r.status === 400 && /\/stop/.test(r.json.error || ''), '绑定指向的会话在执行中时拒解', r.json.error)
    ok('oc_keep' in readChats().chats, '拒解后绑定还在')
    writeChats(readChats().chats)

    // 删除后端会话（pi）：删 jsonl 与索引条目，清掉指向它的绑定的 sessionId
    r = await del(`/api/instances/${NAME}/sessions/pi-del0001`)
    ok(r.status === 200 && r.json.ok === true && r.json.clearedBindings === 1, '删除 pi 会话并报告清掉的绑定数', JSON.stringify(r.json))
    ok(!existsSync(join(piDir, '2026-11-12T00-00-00_pi-del0001.jsonl')), '会话 jsonl 文件已删除')
    const idxAfter = JSON.parse(readFileSync(join(piDir, 'index.json'), 'utf8'))
    ok(!('pi-del0001' in idxAfter) && 'pi-del0002' in idxAfter, '索引条目删除，其余保留')
    const chatsAfter = readChats().chats
    ok(chatsAfter.oc_gone && !chatsAfter.oc_gone.sessionId, '绑定只清 sessionId，记录与目录保留')
    ok(chatsAfter.oc_gone.directory === '/tmp/del', '被清绑定的目录信息还在')
    ok('oc_keep' in chatsAfter && chatsAfter.oc_keep.sessionId === 'pi-del0002', '未指向被删会话的绑定不动')

    // 会话列表接口同步反映删除
    const sessionsAfter = await fetch(`${BASE}/api/instances/${NAME}/sessions`, { headers: { Accept: 'application/json' } }).then((x) => x.json())
    ok(sessionsAfter.sessions?.length === 1 && sessionsAfter.sessions[0].id === 'pi-del0002', '删除后会话列表只剩一条')

    // 删不存在的会话：404
    r = await del(`/api/instances/${NAME}/sessions/pi-nope`)
    ok(r.status === 404, '删除不存在的会话返回 404')

    // 原型链键（constructor 等）会从 Object.prototype 继承到值，存在性判定
    // 必须走 hasOwnProperty：不存在的会话不能被报成删除成功，索引也不能动
    const idxBeforeProto = readFileSync(join(piDir, 'index.json'), 'utf8')
    const stateBeforeProto = readFileSync(STATE_PATH, 'utf8')
    r = await del(`/api/instances/${NAME}/sessions/constructor`)
    ok(r.status === 404, '删除 sessions/constructor 返回 404（不走原型链）', JSON.stringify(r.json))
    ok(readFileSync(join(piDir, 'index.json'), 'utf8') === idxBeforeProto, '原型链键删除不动索引')
    r = await del(`/api/instances/${NAME}/bindings/constructor`)
    ok(r.status === 404, '解除 bindings/constructor 返回 404（不走原型链）', JSON.stringify(r.json))
    ok(readFileSync(STATE_PATH, 'utf8') === stateBeforeProto, '原型链键解除不重写 state.json')

    // 会话在执行中：拒删（删了后端数据，飞书卡片永远停在执行中）
    writeChats(readChats().chats, { 'pi-del0002': { sessionId: 'pi-del0002', cardId: 'c2', startedAt: 1 } })
    r = await del(`/api/instances/${NAME}/sessions/pi-del0002`)
    ok(r.status === 400 && /\/stop/.test(r.json.error || ''), '执行中的会话拒删', r.json.error)
    ok('pi-del0002' in JSON.parse(readFileSync(join(piDir, 'index.json'), 'utf8')), '拒删后会话还在')
    writeChats(readChats().chats)

    // reveal 的错误路径。成功路径会 spawn open 弹访达，不在测试里执行；
    // 路径解析的纯函数覆盖见 scripts/test-state-sync.mjs
    r = await post(`/api/instances/${NAME}/reveal`, { target: 'session', sid: 'pi-nope' })
    ok(r.status === 400 && /找不到会话/.test(r.json.error || ''), 'reveal 找不到会话文件时返回 400')
    r = await post(`/api/instances/${NAME}/reveal`, { target: 'binding', key: 'oc_nosession' })
    ok(r.status === 400 && /还没有会话/.test(r.json.error || ''), 'reveal 没有绑定会话时返回 400')
    r = await post(`/api/instances/${NAME}/reveal`, { target: 'session', sid: '' })
    ok(r.status === 400 && /缺少会话 id/.test(r.json.error || ''), 'reveal 缺会话 id 时返回 400')
  }

  // opencode 后端的删除走 serve 接口。这里起一个假 serve（stub fetch）：
  // 打真实的 19876 会删掉真机会话，这条用例不能用真连接
  {
    const OC_DIR = join(FAKE_HOME, '.config', 'opencode-feishu-bridge-ocdelete')
    mkdirSync(OC_DIR, { recursive: true })
    writeFileSync(
      join(OC_DIR, 'config.json'),
      JSON.stringify({ backend: { type: 'opencode' }, opencode: { url: 'http://127.0.0.1:19876', password: '' } }),
    )
    const OC_STATE = join(OC_DIR, 'state.json')
    writeFileSync(OC_STATE, JSON.stringify({
      version: 1,
      chats: {
        'oc_bound': { key: 'oc_bound', chatId: 'oc_bound', sessionId: 'ses_oc_1', directory: '/tmp/oc', updatedAt: 1 },
        'oc_other': { key: 'oc_other', chatId: 'oc_other', sessionId: 'ses_oc_2', updatedAt: 2 },
      },
    }))

    // 假 serve：只认 19876；打 admin 自己的请求走真 fetch
    const realFetch = globalThis.fetch
    const serveCalls = []
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url)
      if (!u.includes('127.0.0.1:19876')) return realFetch(url, opts)
      if (opts?.method === 'DELETE') {
        serveCalls.push(u)
        if (u.includes('ses_gone')) return new Response('{}', { status: 404 })
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // GET /api/session/:id（reveal 的存在性确认）
      if (u.includes('ses_gone')) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ data: { id: 'x' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const del = async (path) => {
        const res = await fetch(`${BASE}${path}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-OCB-Admin': '1' },
        })
        return { status: res.status, json: await res.json().catch(() => ({})) }
      }

      let r = await del('/api/instances/ocdelete/sessions/ses_oc_1')
      ok(r.status === 200 && r.json.ok === true && r.json.clearedBindings === 1, '删除 opencode 会话成功', JSON.stringify(r.json))
      ok(serveCalls.some((u) => u.endsWith('/api/session/ses_oc_1')), '删除请求打到 serve 的 /api/session/:id', serveCalls.join(','))
      const ocChats = JSON.parse(readFileSync(OC_STATE, 'utf8')).chats
      ok(ocChats.oc_bound && !ocChats.oc_bound.sessionId, '指向被删会话的绑定清掉 sessionId')
      ok(ocChats.oc_other?.sessionId === 'ses_oc_2', '其余绑定不动')

      // serve 404：会话已经没了，照样清绑定（幂等）
      r = await del('/api/instances/ocdelete/sessions/ses_gone')
      ok(r.status === 200, 'serve 返回 404 时按已删除处理', JSON.stringify(r.json))

      // 读-改-写窗口：ocDelete 最长等 5 秒，这期间桥接的 flush（入队、
      // sessionSeq）不能被 admin 基于旧快照的写盘打回磁盘版本。路由落盘前
      // 重读 state.json，在最新快照上清 sessionId
      writeFileSync(
        OC_STATE,
        JSON.stringify({
          version: 1,
          chats: {
            'oc_win': { key: 'oc_win', chatId: 'oc_win', sessionId: 'ses_oc_1', directory: '/tmp/oc', updatedAt: 1 },
            'oc_other': { key: 'oc_other', chatId: 'oc_other', sessionId: 'ses_oc_2', updatedAt: 2 },
          },
          sessionSeq: { day: '20261112', n: 3 },
        }),
      )
      globalThis.fetch = async (url, opts = {}) => {
        const u = String(url)
        if (!u.includes('127.0.0.1:19876')) return realFetch(url, opts)
        if (opts?.method === 'DELETE') {
          // serve 处理期间桥接落了一次盘：排队消息入队、占用一个新会话序号
          const cur = JSON.parse(readFileSync(OC_STATE, 'utf8'))
          cur.queue = { oc_win: [{ qid: 'q1', text: '排队中', at: 1 }] }
          cur.sessionSeq = { day: '20261112', n: 4 }
          writeFileSync(OC_STATE, JSON.stringify(cur, null, 2))
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ data: { id: 'x' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      r = await del('/api/instances/ocdelete/sessions/ses_oc_1')
      const winAfter = JSON.parse(readFileSync(OC_STATE, 'utf8'))
      ok(r.status === 200 && r.json.ok === true, '删除 opencode 会话成功（窗口期桥接有落盘）', JSON.stringify(r.json))
      ok(winAfter.queue?.['oc_win']?.length === 1, '桥接在窗口期写入的排队消息没被打回旧版')
      ok(winAfter.sessionSeq?.n === 4, '桥接刚占用的会话序号没被打回旧版')
      ok(winAfter.chats.oc_win && !winAfter.chats.oc_win.sessionId, '绑定在最新快照上清掉')
      ok(winAfter.chats.oc_other?.sessionId === 'ses_oc_2', '其余绑定在最新快照上不动')

      // opencode 分支的拒删：inflight 在发请求前就写好，路由开头那次检查
      // 命中——请求不该发到 serve、绑定不动。等 serve 前那次复查盖的是
      // 两次同步读之间的落盘，同步区间里用例触发不了（spec 已知限制第 7 条）
      writeFileSync(
        OC_STATE,
        JSON.stringify({
          version: 1,
          chats: { 'oc_other': { key: 'oc_other', chatId: 'oc_other', sessionId: 'ses_oc_2', updatedAt: 2 } },
          inflight: { 'ses_oc_2': { sessionId: 'ses_oc_2', cardId: 'c9', startedAt: 1 } },
        }),
      )
      const serveCallsBeforeInflight = serveCalls.length
      r = await del('/api/instances/ocdelete/sessions/ses_oc_2')
      ok(r.status === 400 && /\/stop/.test(r.json.error || ''), 'opencode 删除执行中的会话拒删', r.json.error)
      ok(serveCalls.length === serveCallsBeforeInflight, '拒删时请求没发到 serve')
      ok(JSON.parse(readFileSync(OC_STATE, 'utf8')).chats.oc_other?.sessionId === 'ses_oc_2', '拒删后绑定不动')
      // 还原成没有 inflight 的状态，供后面的 serve 报错用例使用
      writeFileSync(
        OC_STATE,
        JSON.stringify({
          version: 1,
          chats: { 'oc_other': { key: 'oc_other', chatId: 'oc_other', sessionId: 'ses_oc_2', updatedAt: 2 } },
        }),
      )

      // serve 有响应但报错（如 500）：文案说「返回 500」，不能含糊成「不可达」
      globalThis.fetch = async (url, opts = {}) => {
        const u = String(url)
        if (!u.includes('127.0.0.1:19876')) return realFetch(url, opts)
        return new Response('boom', { status: 500 })
      }
      r = await del('/api/instances/ocdelete/sessions/ses_oc_2')
      ok(r.status === 400 && /serve 返回 500/.test(r.json.error || '') && !/不可达/.test(r.json.error || ''), 'serve 报错时如实说状态码', r.json.error)
      ok(JSON.parse(readFileSync(OC_STATE, 'utf8')).chats.oc_other?.sessionId === 'ses_oc_2', 'serve 报错时绑定不被清')

      // serve 连不上：明确说删不了，此时只能解除绑定
      globalThis.fetch = async (url, opts = {}) => {
        const u = String(url)
        if (!u.includes('127.0.0.1:19876')) return realFetch(url, opts)
        throw new Error('connect ECONNREFUSED 127.0.0.1:19876')
      }
      r = await del('/api/instances/ocdelete/sessions/ses_oc_2')
      ok(r.status === 400 && /只能先解除绑定/.test(r.json.error || ''), 'serve 不可达时说明删不了', r.json.error)
      ok(JSON.parse(readFileSync(OC_STATE, 'utf8')).chats.oc_other?.sessionId === 'ses_oc_2', '删除失败时绑定不被清')
    } finally {
      globalThis.fetch = realFetch
    }
  }
} catch (err) {
  fail++
  console.log(`❌ 测试本身出错: ${err.stack || err.message}`)
} finally {
  server.closeAllConnections?.()
  server.close()
  rmSync(TMP_ROOT, { recursive: true, force: true })
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
