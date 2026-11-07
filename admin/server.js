/**
 * 本地管理后台：零依赖的 HTTP 服务 + JSON API，配一个单页界面。
 *
 * 为什么不用框架：仓库现在只有一个依赖（@larksuiteoapi/node-sdk），全部代码
 * 是 ESM 加 Node 标准库。管理后台的面（一张实例表、几个表单、日志跟随）用
 * node:http 加一个 HTML 文件就能承载，引入 Web 框架只会多一棵依赖树要维护。
 *
 * 安全边界：默认只绑 127.0.0.1。appSecret 与 opencode password 在任何响应里
 * 都不以明文出现——读接口掩码，写接口留空表示保持原值；本服务也不打请求体日志。
 *
 * 用法：
 *   npm run admin                # 127.0.0.1:19877
 *   npm run admin -- --port 8080 # 换端口
 */
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, chmodSync, unlinkSync, rmSync } from 'node:fs'
import { collectAll, collectInstance, discoverInstances } from './instances.js'
import { scanBackends } from './backends.js'
import { startInstance, stopInstance, restartInstance, doctor, readLog, installInstance, rollbackService } from './control.js'
import { planNewInstance, writeNewInstance, nextFreeUrl } from './create.js'
import {
  applyAllowlistAdd,
  applyAllowlistRemove,
  applyNameRemove,
  applyNameSet,
  checkName,
  checkOpenId,
} from './entries.js'

const REPO = resolve(fileURLToPath(import.meta.url), '../..')
/** admin 自己监听的端口。新建实例自动分配 serve 端口时要避开它 */
let OWN_PORT = null
const INDEX_HTML = join(REPO, 'admin', 'public', 'index.html')
const DEFAULT_PORT = 19877

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: Number(process.env.PORT) || DEFAULT_PORT }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i])
    else if (argv[i] === '--host') out.host = argv[++i]
  }
  return out
}

// ---------- 小工具 ----------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendError(res, code, message) {
  sendJson(res, code, { error: message })
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((res, rej) => {
    let size = 0
    const chunks = []
    req.on('data', (d) => {
      size += d.length
      if (size > limit) {
        const err = new Error('请求体超过 1MB')
        err.statusCode = 400
        rej(err)
        req.destroy()
        return
      }
      chunks.push(d)
    })
    req.on('end', () => {
      try {
        res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        const err = new Error('请求体不是合法 JSON')
        err.statusCode = 400
        rej(err)
      }
    })
    req.on('error', rej)
  })
}

function deepMerge(base, override) {
  const out = { ...base }
  for (const [k, v] of Object.entries(override || {})) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 密钥掩码。响应里只回「是否已填写」，明文一个字都不出这个进程。
 * 两个密钥字段名写死在这里，新增密钥字段时同步加进来。
 */
const SECRET_FIELDS = [
  ['feishu', 'appSecret'],
  ['opencode', 'password'],
]

function maskConfig(cfg) {
  if (!cfg) return null
  const out = JSON.parse(JSON.stringify(cfg))
  for (const [section, key] of SECRET_FIELDS) {
    if (out[section] && typeof out[section][key] === 'string') {
      out[section][key] = out[section][key] ? '********' : ''
    }
  }
  return out
}

/** 保存配置：先备份，再临时文件加重命名，和 store.js 的落盘方式一致 */
function writeConfigAtomic(configPath, next) {
  if (existsSync(configPath)) copyFileSync(configPath, configPath + '.bak')
  const tmp = configPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  chmodSync(tmp, 0o600)
  renameSync(tmp, configPath)
}

// ---------- 配置校验 ----------

function validateConfig(body, current) {
  const errs = []
  const feishu = body.feishu || {}
  if (feishu.appId !== undefined) {
    if (!/^cli_[A-Za-z0-9]+$/.test(feishu.appId || '')) errs.push('feishu.appId 应为 cli_ 开头的应用 ID')
  } else if (!current?.feishu?.appId) {
    errs.push('feishu.appId 不能为空')
  }
  if (feishu.domain !== undefined && !['feishu', 'lark'].includes(feishu.domain)) {
    errs.push('feishu.domain 只能是 feishu 或 lark')
  }
  if (feishu.allowlist !== undefined && !Array.isArray(feishu.allowlist)) {
    errs.push('feishu.allowlist 必须是数组')
  }
  if (feishu.names !== undefined && (typeof feishu.names !== 'object' || feishu.names === null || Array.isArray(feishu.names))) {
    errs.push('feishu.names 必须是 open_id 到名字的对象')
  }
  if (body.backend?.type !== undefined && !['opencode', 'pi'].includes(body.backend.type)) {
    errs.push('backend.type 只能是 opencode 或 pi')
  }
  const oc = body.opencode || {}
  if (oc.url !== undefined && !/^https?:\/\//.test(oc.url || '')) errs.push('opencode.url 应为 http(s) 地址')
  const b = body.behavior || {}
  if (b.streamIntervalMs !== undefined && !(Number(b.streamIntervalMs) >= 1200)) {
    // 飞书 message.patch 有频率限制，低于 1200 会被限流，README 有相同说明
    errs.push('behavior.streamIntervalMs 不能低于 1200（飞书 patch 限流）')
  }
  for (const key of ['idleTimeoutMs', 'maxParallel', 'maxBodyChars']) {
    if (b[key] !== undefined && !(Number(b[key]) >= 0)) errs.push(`behavior.${key} 应为非负数字`)
  }
  if (body.backend?.pi?.timeoutMs !== undefined && !(Number(body.backend.pi.timeoutMs) > 0)) {
    errs.push('backend.pi.timeoutMs 应为正数')
  }
  return errs
}

// ---------- 飞书凭证校验 ----------

/**
 * 校验 appId 与 appSecret：打一次 bot/v3/info。写法与 scripts/init.mjs 一致，
 * SDK 用仓库已有的那个；缺依赖时降级成「跳过」，不阻塞其他功能。
 */
async function verifyFeishu(cfg) {
  let Lark = null
  try {
    Lark = await import('@larksuiteoapi/node-sdk')
  } catch {
    return { ok: false, skipped: true, error: '未安装 @larksuiteoapi/node-sdk，跳过校验' }
  }
  try {
    const client = new Lark.Client({
      appId: cfg.feishu.appId,
      appSecret: cfg.feishu.appSecret,
      domain: cfg.feishu.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.fatal,
    })
    const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
    const bot = res?.bot || res?.data?.bot || {}
    if (!bot.open_id) return { ok: false, error: '接口返回里没有 open_id' }
    return { ok: true, botName: bot.app_name || '', openId: bot.open_id }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ---------- opencode 后端数据 ----------

function ocBase(cfg) {
  return (cfg?.opencode?.url || 'http://127.0.0.1:19876').replace(/\/+$/, '')
}

function ocHeaders(cfg) {
  const headers = { Accept: 'application/json' }
  if (cfg?.opencode?.password) {
    headers.Authorization = 'Basic ' + Buffer.from(`opencode:${cfg.opencode.password}`).toString('base64')
  }
  return headers
}

async function ocGet(cfg, path) {
  const res = await fetch(ocBase(cfg) + path, { headers: ocHeaders(cfg), signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

// ---------- 体检输出解析 ----------

/** doctor.mjs 的文本输出解析成逐条检查项，页面按节分组，失败标红 */
function parseDoctor(output) {
  const sections = []
  let current = null
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const header = /^\[(.+)\]$/.exec(line.trim())
    if (header) {
      current = { name: header[1], checks: [] }
      sections.push(current)
      continue
    }
    const mark = line.trim().slice(0, 2).trim()
    if (!current || !['✅', '❌', '⚠️'].includes(mark)) continue
    current.checks.push({
      level: mark === '✅' ? 'ok' : mark === '❌' ? 'bad' : 'warn',
      text: line.trim().slice(2).trim(),
    })
  }
  return { sections, raw: output }
}

// ---------- 本地防护 ----------

/**
 * Host 头只接受 localhost 与 127.0.0.1。浏览器直接访问本机时 Host 必是这两个
 * 之一；别的值说明请求经过了他人的代理或域名指向，拒绝。
 */
function hostAllowed(req) {
  const host = String(req.headers.host || '')
  const name = host.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase()
  return name === 'localhost' || name === '127.0.0.1'
}

/** 写操作（POST/PUT/PATCH）除 application/json 外还要带自定义头，挡掉跨站表单 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH'])
const ADMIN_HEADER = 'x-ocb-admin'

function requestGuards(req) {
  if (!hostAllowed(req)) return 'Host 不被接受：本服务只响应 localhost 与 127.0.0.1'
  if (WRITE_METHODS.has(req.method)) {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (ct !== 'application/json') return '写操作只接受 application/json'
    if (String(req.headers[ADMIN_HEADER] || '') !== '1') return `写操作需要头 ${ADMIN_HEADER}: 1`
  }
  return null
}

// ---------- 路由 ----------

/**
 * 探测计划的 serve 地址上有没有别人的 serve。
 * 端口被占时新实例的 serve 绑不上，桥接还会连到那个需要密码的 serve 报 401，
 * 装了也是白装——装之前就拒绝，别给用户一个「已创建但起不来」的实例。
 * 连不上（端口空着）返回 null 放行；探测超时也放行，不拿偶发慢当占用。
 */
async function probeServeBusy(url) {
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/api/info', { signal: AbortSignal.timeout(2000) })
    if (res.status === 401) {
      return `${url} 上已有一个需要密码的 serve，新建实例连不上（会报 401 退出）。换一个端口，或留空由 admin 自动分配`
    }
    return `${url} 上已有 serve 在响应，新建实例的 serve 会绑不上这个端口。换一个端口，或留空由 admin 自动分配`
  } catch {
    return null
  }
}

/**
 * 新建实例：校验 -> 探测端口 -> 写配置 -> 装常驻服务并启动。
 * 飞书应用要用户事先在开放平台建好（权限与事件订阅见 README），admin 只收凭证。
 * 装服务失败时回滚刚写的配置，不留一个起不来的半成品实例。
 */
async function createInstanceApi(req, res) {
  const body = await readBody(req)
  const existing = await collectAll()

  // serve 地址分两种。用户显式指定：尊重输入，探到被占就拒绝，不擅自改。
  // 留空：自动顺延——配置里占用的、admin 自己的、探下来有东西在跑的，都跳过，
  // 直到探到一个空端口，保证「留空即可成功」
  let requestBody = body
  const explicitUrl = String(body.opencode?.url || '').trim()
  if ((body.backend?.type || 'opencode') === 'opencode' && !explicitUrl) {
    const tried = []
    let picked = null
    for (let i = 0; i < 20; i++) {
      const candidate = nextFreeUrl(existing, OWN_PORT, tried)
      if (!(await probeServeBusy(candidate))) {
        picked = candidate
        break
      }
      tried.push(Number(/:(\d+)/.exec(candidate)[1]))
    }
    if (!picked) {
      return sendError(res, 409, '19876 往后的 20 个端口都被占用了，请在表单里显式指定 serve 地址')
    }
    requestBody = { ...body, opencode: { ...body.opencode, url: picked } }
  }

  const { errors, plan } = planNewInstance(requestBody, existing, OWN_PORT)
  if (errors.length) return sendError(res, 400, errors.join('；'))

  // 端口被别人的 serve 占着时，新实例的 serve 绑不上、桥接还会 401，
  // 装了也是白装——装之前就拒绝，别给用户一个「已创建但起不来」的实例
  if (plan.backend === 'opencode' && explicitUrl) {
    const busy = await probeServeBusy(plan.config.opencode.url)
    if (busy) return sendError(res, 409, busy)
  }

  const dirExisted = existsSync(plan.dir)
  let configPath
  try {
    configPath = writeNewInstance(plan.dir, plan.config)
  } catch (err) {
    return sendError(res, 500, `写配置失败: ${err.message}`)
  }

  const result = await installInstance(plan.name, plan.dir)
  if (result.code !== 0) {
    // 装服务失败：回滚刚写的配置与 plist，别留一个起不来的半成品实例。
    // 回滚只摘本实例的 label 与 plist，不碰其他在跑实例
    rollbackService(plan.name)
    try {
      unlinkSync(configPath)
      if (!dirExisted) rmSync(plan.dir, { recursive: true, force: true })
    } catch {
      /* 回滚尽力而为，失败不掩盖原始错误 */
    }
    return sendJson(res, 200, {
      ok: false,
      name: plan.name,
      dir: plan.dir,
      output: result.output,
      error: '安装常驻服务失败，已回滚刚生成的配置',
    })
  }

  // 装好后重新发现一次：plist 已在位，label 与 managed 状态以发现结果为准
  const found = discoverInstances().find((i) => resolve(i.dir) === resolve(plan.dir))
  const inst = found ? await collectInstance(found) : null
  return sendJson(res, 200, {
    ok: true,
    name: plan.name,
    dir: plan.dir,
    configPath,
    output: result.output,
    instance: inst && {
      name: inst.name,
      dir: inst.dir,
      managed: inst.managed,
      backend: inst.backend,
      process: inst.process,
      serve: inst.serve,
    },
  })
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean) // ['api','instances',name,...]
  if (parts[0] !== 'api') return sendError(res, 404, '未知接口')

  // 本地 coding agent 扫描：配置页与新建弹窗的后端选项来源。
  // 不绑定实例，任何页面打开时都能问一次
  if (parts[1] === 'backends') {
    if (req.method !== 'GET') return sendError(res, 405, '只支持 GET')
    return sendJson(res, 200, { backends: await scanBackends() })
  }

  if (parts[1] !== 'instances') return sendError(res, 404, '未知接口')

  // 集合接口：列表（GET）与新建（POST）
  if (!parts[2]) {
    if (req.method === 'POST') return await createInstanceApi(req, res)
    if (req.method !== 'GET') return sendError(res, 405, '只支持 GET 与 POST')
    const list = await collectAll()
    return sendJson(res, 200, {
      instances: list.map((i) => ({
        name: i.name,
        dir: i.dir,
        label: i.label,
        managed: i.managed,
        backend: i.backend,
        appId: i.config.data?.feishu?.appId || '',
        botOpenId: i.config.data?.feishu?.botOpenId || '',
        process: i.process,
        serve: i.serve,
        pi: i.pi,
        summary: i.summary,
        configError: i.config.error,
        stateError: i.state.error,
      })),
    })
  }

  const name = decodeURIComponent(parts[2])
  const found = discoverInstances().find((i) => i.name === name)
  if (!found) return sendError(res, 404, `没有名为 ${name} 的实例`)

  const sub = parts[3] || ''

  // 实例详情
  if (!sub) {
    if (req.method !== 'GET') return sendError(res, 405, '只支持 GET')
    const inst = await collectInstance(found)
    return sendJson(res, 200, {
      name: inst.name,
      dir: inst.dir,
      label: inst.label,
      managed: inst.managed,
      configPath: inst.configPath,
      backend: inst.backend,
      config: maskConfig(inst.config.data),
      configError: inst.config.error,
      state: inst.state.data,
      stateError: inst.state.error,
      process: inst.process,
      serve: inst.serve,
      pi: inst.pi,
      summary: inst.summary,
    })
  }

  // 保存配置
  if (sub === 'config' && req.method === 'PUT') {
    const body = await readBody(req)
    const current = readJsonSafe(found.dir)
    const errs = validateConfig(body, current)
    if (errs.length) return sendError(res, 400, errs.join('；'))
    // 密钥留空 = 保持原值，不让一次表单保存把 appSecret 冲掉
    const next = deepMerge(current, body)
    for (const [section, key] of SECRET_FIELDS) {
      const v = body?.[section]?.[key]
      if (v === undefined || v === '' || v === '********') {
        if (next[section]) next[section][key] = current?.[section]?.[key] ?? next[section][key]
      }
    }
    writeConfigAtomic(join(found.dir, 'config.json'), next)
    return sendJson(res, 200, { ok: true, config: maskConfig(next), backup: 'config.json.bak' })
  }

  // 白名单快捷增删。加的时候可以顺手填名字：写进 feishu.names，
  // 消息来源标注里直接显示，不用再翻到别处编辑 JSON
  if (sub === 'allowlist' && req.method === 'POST') {
    const body = await readBody(req)
    const openId = String(body.openId || '').trim()
    const op = body.op
    if (!openId || !['add', 'remove'].includes(op)) {
      return sendError(res, 400, '需要 op（add 或 remove）与 openId')
    }
    const current = readJsonSafe(found.dir)
    const list = Array.isArray(current.feishu?.allowlist) ? current.feishu.allowlist : []
    const names = current.feishu?.names
    if (op === 'add') {
      const idErr = checkOpenId(openId)
      if (idErr) return sendError(res, 400, idErr)
      // 名字选填：填了要过长度校验，留空只加白名单不动 names
      const name = String(body.name ?? '').trim()
      if (name) {
        const nameErr = checkName(name)
        if (nameErr) return sendError(res, 400, nameErr)
      }
      const nextList = applyAllowlistAdd(list, openId)
      const nextNames = name ? applyNameSet(names, openId, name) : names
      current.feishu = { ...current.feishu, allowlist: nextList, names: nextNames }
    } else {
      // 移除只动白名单，不碰名字：这个名字可能还给非白名单用户的标注用着，
      // 要清理去名字对照接口删
      current.feishu = { ...current.feishu, allowlist: applyAllowlistRemove(list, openId) }
    }
    writeConfigAtomic(join(found.dir, 'config.json'), current)
    return sendJson(res, 200, { ok: true, allowlist: current.feishu.allowlist, names: current.feishu.names })
  }

  // 名字对照增改删。飞书没有 open_id 反查名字的接口，feishu.names 是唯一
  // 准确的名字来源，页面上逐条维护；清空保存等于删除声明
  if (sub === 'names' && req.method === 'POST') {
    const body = await readBody(req)
    const openId = String(body.openId || '').trim()
    const op = body.op
    if (!openId || !['set', 'remove'].includes(op)) {
      return sendError(res, 400, '需要 op（set 或 remove）与 openId')
    }
    const idErr = checkOpenId(openId)
    if (idErr) return sendError(res, 400, idErr)
    const current = readJsonSafe(found.dir)
    const names = current.feishu?.names
    if (op === 'set') {
      const nameErr = checkName(body.name)
      if (nameErr) return sendError(res, 400, nameErr)
      current.feishu = { ...current.feishu, names: applyNameSet(names, openId, body.name) }
    } else {
      current.feishu = { ...current.feishu, names: applyNameRemove(names, openId) }
    }
    writeConfigAtomic(join(found.dir, 'config.json'), current)
    return sendJson(res, 200, { ok: true, names: current.feishu.names })
  }

  // 起停。只对装了 launchd 常驻服务的实例开放：没装 plist 的实例走 down.sh
  // 会触发末尾的 pkill，误杀本机所有桥接进程，这条路不能开。
  if (sub === 'action' && req.method === 'POST') {
    if (!found.managed) {
      return sendError(res, 409, '该实例没有安装 launchd 常驻服务，不能在此起停。请先在仓库目录运行 ./scripts/install-agent.sh --instance <实例名> --config-dir <配置目录>')
    }
    const body = await readBody(req)
    const action = body.action
    if (!['start', 'stop', 'restart'].includes(action)) {
      return sendError(res, 400, 'action 只能是 start、stop 或 restart')
    }
    const result =
      action === 'start'
        ? await startInstance(name, found.dir)
        : action === 'stop'
          ? await stopInstance(name, found.dir)
          : await restartInstance(name, found.dir)
    const output = result.output || [result.down?.output, result.up?.output].filter(Boolean).join('\n')
    const inst = await collectInstance(found)
    return sendJson(res, 200, {
      ok: (result.code ?? 0) === 0,
      action,
      output,
      process: inst.process,
    })
  }

  // 日志增量
  if (sub === 'logs' && req.method === 'GET') {
    const file = url.searchParams.get('file') || 'bridge'
    const since = Number(url.searchParams.get('since') || 0)
    return sendJson(res, 200, readLog(file, since))
  }

  // 体检
  if (sub === 'doctor' && req.method === 'GET') {
    const result = await doctor(name, found.dir)
    return sendJson(res, 200, { code: result.code, ...parseDoctor(result.output) })
  }

  // 飞书凭证校验
  if (sub === 'feishu-verify' && req.method === 'GET') {
    const cfg = readJsonSafe(found.dir)
    if (!cfg.feishu?.appId || !cfg.feishu?.appSecret) {
      return sendJson(res, 200, { ok: false, error: 'appId 或 appSecret 未填写' })
    }
    return sendJson(res, 200, await verifyFeishu(cfg))
  }

  // 会话列表。两个后端都有会话，存放方式不同：opencode 问常驻 serve；
  // pi 没有 serve，会话索引由桥接写在配置目录的 pi-sessions/index.json，
  // 详细记录是同目录下的 JSONL 文件（pi 自己写的）。admin 只读索引，
  // 不与桥接进程争抢写入
  if (sub === 'sessions' && req.method === 'GET') {
    const cfg = readJsonSafe(found.dir)
    if ((cfg.backend?.type || 'opencode') === 'pi') {
      const indexPath = join(found.dir, 'pi-sessions', 'index.json')
      let index = null
      try {
        index = JSON.parse(readFileSync(indexPath, 'utf8'))
      } catch (err) {
        // 从没建过会话时文件不存在，是正常状态，返回空列表；解析失败才报错
        if (err.code !== 'ENOENT') {
          return sendJson(res, 200, { applicable: true, error: `会话索引读取失败: ${err.message}`, sessions: [] })
        }
      }
      const sessions = Object.values(index || {})
        .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
        .map((s) => ({
          id: s.id || '',
          title: s.title || '',
          directory: s.location?.directory || '',
          model: s.model?.id ? [s.model.providerID, s.model.id].filter(Boolean).join('/') : '',
          updatedAt: s.time?.updated || null,
        }))
      return sendJson(res, 200, { applicable: true, sessions })
    }
    if ((cfg.backend?.type || 'opencode') !== 'opencode') {
      return sendJson(res, 200, { applicable: false })
    }
    try {
      const json = await ocGet(cfg, '/api/session?limit=100&order=desc')
      const sessions = (json.data || []).map((s) => ({
        id: s.id,
        title: s.title || '',
        directory: s.location?.directory || '',
        model: s.model ? `${s.model.providerID}/${s.model.id}` : '',
        updatedAt: s.time?.updated || null,
      }))
      return sendJson(res, 200, { applicable: true, sessions })
    } catch (err) {
      return sendJson(res, 200, { applicable: true, error: err.message, sessions: [] })
    }
  }

  // opencode 模型列表
  if (sub === 'models' && req.method === 'GET') {
    const cfg = readJsonSafe(found.dir)
    if ((cfg.backend?.type || 'opencode') !== 'opencode') {
      return sendJson(res, 200, { applicable: false })
    }
    try {
      const json = await ocGet(cfg, '/api/model')
      const models = (json.data || []).map((m) => `${m.providerID}/${m.id}`)
      return sendJson(res, 200, { applicable: true, models })
    } catch (err) {
      return sendJson(res, 200, { applicable: true, error: err.message, models: [] })
    }
  }

  return sendError(res, 404, '未知接口')
}

function readJsonSafe(dir) {
  const path = join(dir, 'config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`配置解析失败: ${err.message}`)
  }
}

// ---------- 启动 ----------

/** 允许绑定的地址。只认本机回环，不给「暴露到局域网」的入口 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost'])

export function startAdmin({ host, port } = parseArgs(process.argv.slice(2))) {
  if (!ALLOWED_HOSTS.has(host)) {
    console.error(`启动失败: --host 只接受 127.0.0.1 或 localhost（收到 ${host}）。本服务不绑定其他网卡。`)
    process.exit(1)
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    try {
      const denied = requestGuards(req)
      if (denied) return sendError(res, 403, denied)
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = readFileSync(INDEX_HTML)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(html)
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204)
        return res.end()
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url)
      }
      return sendError(res, 404, 'not found')
    } catch (err) {
      return sendError(res, err.statusCode || 500, err.message)
    }
  })
  server.listen(port, host, () => {
    OWN_PORT = server.address().port
    console.log(`CodeBridge 管理后台: http://${host}:${port}`)
    console.log('实例发现：~/Library/LaunchAgents/ai.qiguang.ocbridge*.plist 加 ~/.config/opencode-feishu-bridge* 目录扫描')
    console.log('只监听本机回环；Ctrl-C 退出。')
  })
  server.on('error', (err) => {
    console.error(`启动失败: ${err.message}`)
    process.exit(1)
  })
  return server
}

// 直接 node admin/server.js 时启动；被别处 import 时只导出
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startAdmin()
}
