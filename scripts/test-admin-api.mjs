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

const readCfg = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))

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
