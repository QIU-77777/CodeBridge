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
