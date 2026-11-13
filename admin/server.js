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
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, chmodSync, unlinkSync, rmSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
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
import { CLI_SESSION_ROOT, cliSessionFilePath, scanCliSessions } from '../src/pi-cli-sessions.js'

const REPO = resolve(fileURLToPath(import.meta.url), '../..')
/** admin 自己监听的端口。新建实例自动分配 serve 端口时要避开它 */
let OWN_PORT = null
const INDEX_HTML = join(REPO, 'admin', 'public', 'index.html')
const FAVICON_SVG = join(REPO, 'admin', 'public', 'favicon.svg')
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

/**
 * 保存 state.json：先备份成 state.json.bak，再临时文件加重命名。
 * 备份沿用 config.json.bak 的做法——绑定层的删除可恢复，后端会话数据删了
 * 不可恢复，确认文案里写清。不加 chmod：桥接自己的 flush() 也不加，两边
 * 落盘权限保持一致（600 会把桥接随后的写入挡成 EACCES 的场景不存在，
 * 但不必要的权限差异会让排障多一层困惑）。
 */
function writeStateAtomic(statePath, next) {
  if (existsSync(statePath)) copyFileSync(statePath, statePath + '.bak')
  const tmp = statePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, statePath)
}

/** 读 state.json。文件不存在返回 null；解析失败抛错（坏文件不能当空状态删）。
 *  错误带 statusCode=400（与 readBody 同一做法）：外层 catch 按 statusCode 转状态码，
 *  不带就会落成 500，把解析器原文抛到页面上——同一条路由里 pi 索引损坏返的是
 *  400「会话索引读取失败」，两边状态码要一致 */
function readStateSafe(dir) {
  const path = join(dir, 'state.json')
  if (!existsSync(path)) return { data: null, path }
  try {
    return { data: JSON.parse(readFileSync(path, 'utf8')), path }
  } catch (err) {
    const bad = new Error(`state.json 解析失败: ${err.message}`)
    bad.statusCode = 400
    throw bad
  }
}

/** 某个会话是否正在执行（state.json 的 inflight 里有它） */
function sessionInFlight(state, sid) {
  return Boolean(state?.inflight && Object.prototype.hasOwnProperty.call(state.inflight, sid))
}

// ---------- 后端数据操作 ----------

/** 向 opencode serve 发 DELETE。404 视为已删除（幂等）；其余状态码带 err.status 抛出，
 *  网络层失败（连不上）抛出的错没有 status，路由据此区分两种说法 */
async function ocDelete(cfg, path) {
  const res = await fetch(ocBase(cfg) + path, {
    method: 'DELETE',
    headers: ocHeaders(cfg),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '')
    const err = new Error(`${path} -> ${res.status}${text ? ': ' + text.slice(0, 120) : ''}`)
    err.status = res.status
    throw err
  }
  return res.status
}

/**
 * pi 会话的 jsonl 文件名：`<时间戳>_<sid>.jsonl`，按后缀匹配。
 * 与 piModelOf() 找文件的规则一致；找不到返回 null。
 */
function piSessionFile(dir, sid) {
  let files = []
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  return files.find((f) => f.endsWith(`_${sid}.jsonl`)) || null
}

/** 桥接自建 pi 会话文件的绝对路径；找不到返回 null */
function piSessionFilePath(dir, sid) {
  const file = piSessionFile(dir, sid)
  return file ? join(dir, file) : null
}

/** 在访达里打开一个路径：文件用 open -R（选中该文件），目录用 open */
function revealInFinder(path, kind) {
  return new Promise((res, rej) => {
    execFile('open', kind === 'file' ? ['-R', path] : [path], (err) => (err ? rej(err) : res()))
  })
}

/** 解析出的路径必须落在允许根之内。路径由服务端从 sid/key 查出来后拼接，
 *  客户端传不了任意路径；这一层是兜底，防的是查表逻辑被非常规数据带偏 */
function pathWithinAny(path, roots) {
  const p = resolve(path)
  return roots.some((r) => p === r || p.startsWith(r + sep))
}

/**
 * 解析「查看」要打开的路径。纯函数（除 sessionExists 回调外不碰 I/O），
 * 失败抛 Error，路由原样转成 400。单拆出来是为了能离线测：
 * 路由本身会 spawn `open`，测试不该真的弹出访达窗口。
 *
 * @param {object} opts
 * @param {string} opts.dir          实例配置目录
 * @param {object} opts.cfg          实例配置（判后端类型）
 * @param {'session'|'binding'} opts.target
 * @param {string} opts.sidOrKey     会话 id 或绑定键
 * @param {object} opts.state        state.json 内容（target=binding 时用）
 * @param {Function} [opts.sessionExists] 确认 opencode 会话存在的回调，抛错即不存在
 * @returns {Promise<{path: string, kind: 'file'|'dir'}>}
 */
export async function resolveRevealTarget({ dir, cfg, target, sidOrKey, state, sessionExists }) {
  let sid = String(sidOrKey || '').trim()
  if (target === 'binding') {
    const key = String(sidOrKey || '').trim()
    sid = state?.chats?.[key]?.sessionId || ''
    if (!sid) throw new Error('这个绑定还没有会话')
  }
  if (!sid) throw new Error('缺少会话 id')
  if ((cfg.backend?.type || 'opencode') === 'pi') {
    const sessionDir = join(dir, 'pi-sessions')
    // 桥接自建的会话平铺在 pi-sessions；终端 pi 的会话在 cliSessionRoot 下
    // 按工作目录分的子目录里。/sessions 与 /switch 都认终端会话，「查看」
    // 只认一半的话，指向终端会话的绑定点了必然失败
    const cliRoot = cfg.backend?.pi?.cliSessionRoot || CLI_SESSION_ROOT
    const path = piSessionFilePath(sessionDir, sid) || cliSessionFilePath(cliRoot, sid)
    if (!path) throw new Error(`找不到会话 ${sid} 的文件`)
    if (!pathWithinAny(path, [resolve(sessionDir), resolve(cliRoot)])) throw new Error('路径不在允许范围内')
    return { path, kind: 'file' }
  }
  // opencode：会话是 serve 数据库里的行，没有单会话文件。先确认会话存在，
  // 不存在就没有打开目录的意义；确认不了（serve 无响应）也要说清楚
  if (sessionExists) {
    try {
      await sessionExists(sid)
    } catch (err) {
      if (err.status === 404) throw new Error(`会话 ${sid} 不存在`)
      if (err.status) throw new Error(`serve 返回 ${err.status}，无法确认会话（${err.message}）`)
      throw new Error(`serve 无响应，无法确认会话：${err.message}`)
    }
  }
  return { path: join(homedir(), '.local', 'share', 'opencode'), kind: 'dir' }
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
  if (feishu.listen !== undefined && !Array.isArray(feishu.listen)) {
    errs.push('feishu.listen 必须是数组')
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
  if (!res.ok) {
    const err = new Error(`${path} -> ${res.status}`)
    // 带状态码：调用方要区分「会话不存在（404）」与「serve 无响应」，
    // 两者给用户的下一步完全不同
    err.status = res.status
    throw err
  }
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

/** 写操作（POST/PUT/PATCH/DELETE）除 application/json 外还要带自定义头，挡掉跨站表单 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
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
    // 密码变了要重启 serve 才生效：serve 是长跑进程，启动时把密码读进自己的
    // 环境里，之后改配置不会跟着变。不提示的话，用户会以为改完就生效，
    // 而桥接拿着新密码去连旧 serve，全程 401——现象是「毫无反应」
    const pwChanged = next.opencode?.password && next.opencode.password !== current.opencode?.password
    return sendJson(res, 200, {
      ok: true,
      config: maskConfig(next),
      backup: 'config.json.bak',
      ...(pwChanged ? { notice: 'serve 密码已更改，需要重启 serve 才生效（它启动时把密码定格在进程环境里）' } : {}),
    })
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

  // 监听名单（feishu.listen）增删。语义与 allowlist 不同：这里是「它的 @ 能
  // 到达我」，由通讯录面板的开关维护，单向——A 的 listen 里有 B，B 的 @ 能
  // 唤醒 A；A 的 @ 能不能唤醒 B 看 B 自己的配置。写入的是 open_id，页面
  // 展示时用通讯录里的名字解释这个 id 是谁
  if (sub === 'listen' && req.method === 'POST') {
    const body = await readBody(req)
    const openId = String(body.openId || '').trim()
    const op = body.op
    if (!openId || !['add', 'remove'].includes(op)) {
      return sendError(res, 400, '需要 op（add 或 remove）与 openId')
    }
    const idErr = checkOpenId(openId)
    if (idErr) return sendError(res, 400, idErr)
    const current = readJsonSafe(found.dir)
    const list = Array.isArray(current.feishu?.listen) ? current.feishu.listen : []
    const next = op === 'add' ? applyAllowlistAdd(list, openId) : applyAllowlistRemove(list, openId)
    current.feishu = { ...current.feishu, listen: next }
    writeConfigAtomic(join(found.dir, 'config.json'), current)
    return sendJson(res, 200, { ok: true, listen: next })
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
      const merged = new Map()
      for (const s of Object.values(index || {})) if (s?.id) merged.set(s.id, s)
      // 终端 pi 的会话（cliSessionRoot 下按工作目录分目录存放）：桥接的
      // /sessions 一直合并展示，admin 不合并的话，指向终端会话的绑定会被页面
      // 误判成「会话已删除」而置灰，会话表也少一半会话。桥接自建的优先
      // （id 命名空间不同，实际不会撞）
      const cliRoot = cfg.backend?.pi?.cliSessionRoot || CLI_SESSION_ROOT
      for (const [id, s] of scanCliSessions(cliRoot)) if (!merged.has(id)) merged.set(id, s)
      const sessions = [...merged.values()]
        .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
        .map((s) => ({
          id: s.id || '',
          title: s.title || '',
          directory: s.location?.directory || '',
          model: piModelOf(found.dir, s),
          updatedAt: s.time?.updated || null,
          // 终端会话不在桥接索引里：页面把「删除」置灰（那是终端 pi 的地盘），
          // 「查看」可用——reveal 会去 cliSessionRoot 找文件
          cli: Boolean(s.cli),
        }))
      return sendJson(res, 200, { applicable: true, sessions })
    }
    if ((cfg.backend?.type || 'opencode') !== 'opencode') {
      return sendJson(res, 200, { applicable: false })
    }
    try {
      // limit 放到 500：会话页「飞书绑定」表的模型列要把每个绑定键的 sessionId
      // 解析成模型，100 条覆盖不全（实测一个实例 193 条会话、24 个绑定，只有
      // 16 个落在前 100 条里）。页面展示仍按 100 条截断，见 index.html
      const json = await ocGet(cfg, '/api/session?limit=500&order=desc')
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

  // 会话查看：在访达里打开。pi 的会话本来就是文件，选中那个 jsonl；
  // opencode 的会话是 serve 数据库里的行，没有单会话文件，打开数据库所在目录
  if (sub === 'reveal' && req.method === 'POST') {
    const body = await readBody(req)
    const cfg = readJsonSafe(found.dir)
    // 只有按绑定键查找时才需要 state.json：会话查看不该被一个损坏的
    // 状态文件挡在门外
    const state = body.target === 'binding' ? readStateSafe(found.dir).data : null
    let target
    try {
      target = await resolveRevealTarget({
        dir: found.dir,
        cfg,
        target: body.target,
        sidOrKey: body.target === 'binding' ? body.key : body.sid,
        state,
        sessionExists: (sid) => ocGet(cfg, `/api/session/${encodeURIComponent(sid)}`),
      })
    } catch (err) {
      return sendError(res, 400, err.message)
    }
    try {
      await revealInFinder(target.path, target.kind)
    } catch (err) {
      return sendError(res, 500, `打开访达失败: ${err.message}`)
    }
    return sendJson(res, 200, { ok: true, path: target.path, kind: target.kind })
  }

  // 解除飞书绑定：从 state.json 删掉这个 key。桥接进程运行时会通过它自己的
  // 监听把删除同步进内存（src/store.js 的 syncExternalDeletes），不会被
  // 300ms 防抖的全量落盘写回
  if (sub === 'bindings' && req.method === 'DELETE') {
    const key = decodeURIComponent(parts[4] || '')
    if (!key) return sendError(res, 400, '缺少绑定键')
    const { data: state, path: statePath } = readStateSafe(found.dir)
    // 原型链键（constructor、toString……）会从 Object.prototype 继承到值，
    // 下标直取会把不存在的绑定判成存在；与 sessionInFlight 同一写法
    const chats = state?.chats
    const binding =
      chats && typeof chats === 'object' && Object.prototype.hasOwnProperty.call(chats, key) ? chats[key] : undefined
    if (!state || !binding) return sendError(res, 404, `没有键为 ${key} 的绑定`)
    // 正在执行的会话拒解：绑定删掉后这个群再 @ 就是新会话，而飞书上那张
    // 「执行中」的卡片还挂在旧会话上，事件回来时绑定已经不见了
    if (binding.sessionId && sessionInFlight(state, binding.sessionId)) {
      return sendError(res, 400, '这个绑定指向的会话正在执行中，先在飞书里发 /stop 中止再解除')
    }
    const next = { ...state, chats: { ...state.chats } }
    delete next.chats[key]
    writeStateAtomic(statePath, next)
    const inst = await collectInstance(found)
    return sendJson(res, 200, { ok: true, bridgeRunning: inst.process.running })
  }

  // 删除后端会话。pi 删文件与索引条目；opencode 没有本地会话文件，调 serve
  // 的删除接口（删的是本地数据库里的行）。两种情况都要清掉指向它的绑定：
  // 不清的话绑定悬空，下一次 @ 会打到不存在的会话上
  if (sub === 'sessions' && req.method === 'DELETE') {
    const sid = decodeURIComponent(parts[4] || '')
    if (!sid) return sendError(res, 400, '缺少会话 id')
    const { data: state } = readStateSafe(found.dir)
    // 进行中的会话拒删：删了后端数据，事件流没有归宿，飞书卡片永远停在
    // 「执行中」；pi 的子进程还会继续往已删除的 jsonl 写。opencode 分支
    // 在下面等 serve 之前还会用最新快照再查一次：两次同步读之间桥接的
    // 落盘，那次重读看得到；ocDelete 的 await 里落盘的那次，重读看不到，
    // 原因见 spec 已知限制第 7 条
    if (sessionInFlight(state, sid)) {
      return sendError(res, 400, '这个会话正在执行中，先在飞书里发 /stop 中止再删除')
    }
    const cfg = readJsonSafe(found.dir)
    const isPi = (cfg.backend?.type || 'opencode') === 'pi'
    if (isPi) {
      const dir = join(found.dir, 'pi-sessions')
      const indexPath = join(dir, 'index.json')
      let index = null
      try {
        index = JSON.parse(readFileSync(indexPath, 'utf8'))
      } catch (err) {
        // 从没建过会话时文件不存在；解析失败要说出来，不能当空索引删
        if (err.code !== 'ENOENT') {
          return sendError(res, 400, `会话索引读取失败: ${err.message}`)
        }
      }
      // 原型链键（constructor……）会通过 `in` 的存在性检查，把不存在的
      // 会话判成存在；与 sessionInFlight 同一写法，只认索引自己的键
      if (!index || !Object.prototype.hasOwnProperty.call(index, sid)) {
        // 终端 pi 的会话不在桥接索引里：删不了，说清去哪儿删。与桥接的
        // /del 对终端会话的拒绝同一口径（src/pi.js deleteSession）
        if (cliSessionFilePath(cfg.backend?.pi?.cliSessionRoot || CLI_SESSION_ROOT, sid)) {
          return sendError(res, 400, `会话 ${sid} 是终端 pi 的会话，不在桥接目录里，要删请在终端 pi 的会话选择器里操作`)
        }
        return sendError(res, 404, `会话 ${sid} 不存在`)
      }
      delete index[sid]
      const tmp = indexPath + '.tmp'
      writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8')
      renameSync(tmp, indexPath)
      // jsonl 文件删掉；文件本来就没有（索引残留）时忽略
      const file = piSessionFile(dir, sid)
      if (file) {
        try {
          unlinkSync(join(dir, file))
        } catch {
          /* 文件读不了就算了，索引条目已经删掉 */
        }
      }
    } else {
      // 等 serve 之前用最新快照再查一次 inflight：路由开头那次检查之后
      // 桥接可能刚起了这个会话的执行，用旧快照查不到。这次重读只盖到
      // 它读的那一刻——之后到 serve 返回之间仍是窗口，fetch 往返本身
      // 盖不住，那时删除已经生效，拒无可拒（spec 已知限制第 3 条）
      const { data: preDelete } = readStateSafe(found.dir)
      if (sessionInFlight(preDelete, sid)) {
        return sendError(res, 400, '这个会话正在执行中，先在飞书里发 /stop 中止再删除')
      }
      try {
        await ocDelete(cfg, `/api/session/${encodeURIComponent(sid)}`)
      } catch (err) {
        // serve 连不上（没有状态码）与会话被 serve 拒绝（有状态码）是两回事，
        // 文案不能把后者说成「不可达」——那时数据明明还在
        const why = err.status ? `serve 返回 ${err.status}` : 'serve 无响应'
        return sendError(res, 400, `删除失败：${why}（${err.message}）` + (err.status ? '' : '。此时会话还在 serve 的数据库里，删不掉，只能先解除绑定'))
      }
    }
    // 清掉指向该会话的绑定：保留记录与目录，只把 sessionId 清空，
    // 下一次 @ 在同一目录新建会话（与 /del 的行为一致）。
    // 落盘前重读一次 state.json：opencode 分支上面的 ocDelete 最长要等
    // 5 秒（超时），这期间桥接任何一次 flush（入队、setInflight、
    // sessionSeq）都会被开头那份旧快照的写盘打回磁盘版本。排队消息与
    // sessionSeq 的磁盘记录丢了有实际损失：进程在窗口内被杀时它们就没
    // 了，sessionSeq 回退还会让重启后重发已用过的号（nextSessionSeq
    // 要避免的会话重名）。在最新快照上改，写盘就只清 sessionId 一件事
    let cleared = 0
    const { data: latest, path: latestPath } = readStateSafe(found.dir)
    if (latest?.chats) {
      const next = { ...latest, chats: { ...latest.chats } }
      for (const [k, c] of Object.entries(latest.chats)) {
        if (c?.sessionId === sid) {
          next.chats[k] = { ...c, sessionId: undefined }
          cleared++
        }
      }
      if (cleared > 0) writeStateAtomic(latestPath, next)
    }
    return sendJson(res, 200, { ok: true, clearedBindings: cleared })
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

/** pi 会话文件头部读取字节数。model_change 在第二行，64KB 足够覆盖 */
const PI_HEAD_BYTES = 64 * 1024

/**
 * pi 会话的模型名（provider/id）。
 *
 * 索引里没有就回读会话文件的头部：第二行 model_change 写着 provider 与
 * modelId。建会话时配置没写默认模型，索引里 model 是 null，老会话因此也能
 * 显示模型，不必等它再跑一次；新会话由桥接在运行中补写进索引（src/pi.js
 * 的 _patchIndexModel）。读不到就返回空字符串，由页面显示成 —
 */
function piModelOf(configDir, entry) {
  const fromIndex = entry?.model?.id
    ? [entry.model.providerID, entry.model.id].filter(Boolean).join('/')
    : ''
  if (fromIndex || !entry?.id) return fromIndex
  const dir = join(configDir, 'pi-sessions')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(`_${entry.id}.jsonl`))
  } catch {
    return ''
  }
  for (const f of files) {
    let fd
    try {
      fd = openSync(join(dir, f), 'r')
      const buf = Buffer.allocUnsafe(PI_HEAD_BYTES)
      const n = readSync(fd, buf, 0, PI_HEAD_BYTES, 0)
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        if (!line.startsWith('{')) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev?.type === 'model_change' && ev.modelId) {
          return [ev.provider, ev.modelId].filter(Boolean).join('/')
        }
      }
    } catch {
      /* 这个文件读不了就试下一个 */
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* noop */
        }
      }
    }
  }
  return ''
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
      if (url.pathname === '/favicon.svg') {
        // 站点图标。路径写死不从请求里取，没有目录穿越的面；文件缺失时退化成
        // 204，和 .ico 的行为一致——浏览器拿不到图标不该让整个页面打不开
        if (!existsSync(FAVICON_SVG)) {
          res.writeHead(204)
          return res.end()
        }
        const svg = readFileSync(FAVICON_SVG)
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
        return res.end(svg)
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
