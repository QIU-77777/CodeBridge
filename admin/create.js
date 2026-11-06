/**
 * 新建实例：校验、生成配置、落盘。
 *
 * 为什么单独一个模块：这套逻辑要在 HTTP 接口和测试里共用，且不该在 import
 * server.js 时触发任何副作用。起停与装服务的副作用在 control.js，这里只做
 * 纯函数式的计划与文件写入。
 *
 * 一个实例 = 一份配置目录 + 一个进程 + 一个飞书应用。新建实例因此是三件事：
 * 按模板生成 config.json、装 launchd 常驻服务、启动。飞书应用本身要在开放
 * 平台先建好（权限与事件订阅见 README），admin 只收凭证。
 */
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { TEMPLATE_PATH } from '../src/config.js'

const CONFIG_PREFIX = 'opencode-feishu-bridge'
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/i
const APP_ID_RE = /^cli_[A-Za-z0-9]+$/
/** opencode serve 的默认起始端口。多实例各占一个，见 nextFreeUrl */
const SERVE_PORT_BASE = 19876

/** 实例名对应的默认配置目录：~/.config/opencode-feishu-bridge-<实例名> */
export function defaultDirForName(name) {
  return join(homedir(), '.config', `${CONFIG_PREFIX}-${name}`)
}

/** 展开 ~ 开头为用户主目录 */
function expandHome(p) {
  if (typeof p !== 'string') return ''
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/**
 * 给 opencode 后端挑一个没被现有实例占用的 serve 地址。
 * 两个 opencode 实例共用同一个端口时，后起的 serve 绑不上，launchd 会一直
 * 重试并把日志刷满；桥接去连别人那个需要密码的 serve 还会报 401。所以这里
 * 按现有实例的端口往后顺延。
 *
 * 注意 existing 是 collectAll() 的结果，配置在 config.data 里（config 本身
 * 是 { data, error } 的读取结果）——读错形状会让避让静默失效。
 */
export function nextFreeUrl(instances = [], ownPort = null, tried = []) {
  const used = new Set()
  for (const i of instances) {
    const m = /:(\d+)/.exec(i?.config?.data?.opencode?.url || '')
    if (m) used.add(Number(m[1]))
  }
  // admin 自己的端口也要避开：新实例的 serve 绑不上 admin 占着的端口
  if (ownPort) used.add(Number(ownPort))
  // 探测后确认有东西在跑的端口（ tried ）同样避开
  for (const p of tried) used.add(Number(p))
  let port = SERVE_PORT_BASE
  while (used.has(port)) port++
  return `http://127.0.0.1:${port}`
}

/** 从现有实例里找占用了某个端口的实例，没有返回 null */
function instanceOnPort(instances, port) {
  return instances.find((i) => /:(\d+)/.exec(i?.config?.data?.opencode?.url || '')?.[1] === String(port)) || null
}

function readTemplate() {
  if (!existsSync(TEMPLATE_PATH)) throw new Error(`找不到配置模板 ${TEMPLATE_PATH}，请确认仓库完整`)
  return JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'))
}

/**
 * 校验并生成新实例的计划。不碰文件系统（除了读模板），返回错误列表或完整计划，
 * 测试直接调用它。
 *
 * @param body 请求体：{ name, dir?, backend?, feishu, opencode?, pi? }
 * @param existing 现有实例列表（collectAll 的结果），用于重名与端口避让
 */
export function planNewInstance(body, existing = [], ownPort = null) {
  const errors = []
  const name = String(body.name || '').trim()
  if (!NAME_RE.test(name)) {
    errors.push('实例名只能包含小写字母、数字和连字符，1 到 31 字符，字母或数字开头')
  } else if (name.toLowerCase() === 'default') {
    // default 是缺省实例的专名（配置目录就是 ~/.config/opencode-feishu-bridge），
    // 再建一个 default 会和现有主实例抢同一份配置；大小写都挡掉
    errors.push('实例名不能是 default，那是缺省实例的专名')
  } else if (existing.some((i) => i.name === name)) {
    errors.push(`实例 ${name} 已存在`)
  }

  let dir = expandHome(String(body.dir || '').trim()) || defaultDirForName(name)
  if (!isAbsolute(dir)) {
    errors.push('配置目录必须是绝对路径（可用 ~ 开头）')
  } else {
    // 两条各自独立报错：目录里有配置、目录已被别的实例占用，可能同时成立
    if (existsSync(join(dir, 'config.json'))) {
      errors.push(`配置目录已有 config.json，拒绝覆盖: ${dir}`)
    }
    const claimed = existing.find((i) => resolve(i.dir) === resolve(dir))
    if (claimed) errors.push(`配置目录已被实例 ${claimed.name} 占用`)
  }

  const type = body.backend?.type === 'pi' ? 'pi' : 'opencode'
  const feishu = body.feishu || {}
  const appId = String(feishu.appId || '').trim()
  if (!APP_ID_RE.test(appId)) errors.push('feishu.appId 应为 cli_ 开头的应用 ID')
  const appSecret = String(feishu.appSecret || '').trim()
  if (!appSecret) errors.push('feishu.appSecret 不能为空')
  if (feishu.domain && !['feishu', 'lark'].includes(feishu.domain)) {
    errors.push('feishu.domain 只能是 feishu 或 lark')
  }
  const botOpenId = String(feishu.botOpenId || '').trim()

  const oc = body.opencode || {}
  const ocPassword = String(oc.password || '').trim()
  let ocUrl = String(oc.url || '').trim()
  if (type === 'opencode') {
    if (ocUrl && !/^https?:\/\//.test(ocUrl)) errors.push('opencode.url 应为 http(s) 地址')
    // 新实例的 serve 用这个密码起，桥接也用它连。静默留空时，一旦连到
    // 别人需要密码的 serve 就报 401 退出，launchd 反复重启，实例永远起不来
    if (!ocPassword) {
      errors.push('opencode 后端的 serve 密码必填（新建实例的 serve 用它启动，桥接也用它连）')
    }
    if (ocUrl) {
      const port = /:(\d+)/.exec(ocUrl)?.[1]
      const clash = port ? instanceOnPort(existing, port) : null
      if (clash) {
        // 每个 opencode 实例各起一个 serve，两个实例共用一个端口必然有一个绑不上
        errors.push(`serve 端口 ${port} 已被实例 ${clash.name} 占用，两个实例不能共用一个端口。留空由 admin 自动分配，或换一个端口`)
      }
    } else {
      ocUrl = nextFreeUrl(existing, ownPort)
    }
  }
  // pi 后端不连 serve，url 保持模板里的占位值即可

  if (errors.length) return { errors, plan: null }

  // 配置以仓库模板为底，用户填的值覆盖上去：默认值只有一份，不在这里抄第二遍
  const config = readTemplate()
  config.backend = { ...config.backend, type }
  config.feishu = {
    ...config.feishu,
    appId,
    appSecret,
    domain: feishu.domain || 'feishu',
    botOpenId,
    requireMention: feishu.requireMention !== false,
  }
  config.opencode = {
    ...config.opencode,
    password: ocPassword,
    defaultDirectory: expandHome(String(oc.defaultDirectory || '').trim()) || homedir(),
    defaultModel: String(oc.defaultModel || '').trim(),
  }
  // opencode 后端用算出或指定的地址；pi 后端不连 serve，保留模板占位值
  if (ocUrl) config.opencode.url = ocUrl
  if (type === 'pi') {
    config.backend.pi = {
      ...config.backend.pi,
      bin: String(body.pi?.bin || '').trim() || 'pi',
      model: String(body.pi?.model || '').trim(),
      timeoutMs: Number(body.pi?.timeoutMs) || config.backend.pi.timeoutMs,
    }
  }
  return { errors: [], plan: { name, dir, backend: type, config } }
}

/** 落盘：建目录、写 config.json、权限收紧到 600（里面有 appSecret） */
export function writeNewInstance(dir, config) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8')
  chmodSync(path, 0o600)
  return path
}
