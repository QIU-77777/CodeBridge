/**
 * 实例发现与状态采集。
 *
 * 「实例」的定义和仓库现状一一对应：一个桥接实例 = 一份配置目录 + 一个进程 +
 * 一个飞书应用。配置目录的解析规则必须和 src/config.js 的 resolveConfigDir()
 * 逐字一致（$OCB_CONFIG_DIR 优先，否则 ~/.config/opencode-feishu-bridge），
 * 这里不新造第二套。
 *
 * 实例发现以 launchd plist 为准：install-agent.sh 的 --config-dir 与
 * --instance 相互独立，从目录后缀猜实例名会猜错，而 plist 里同时写着
 * label（推实例名）和 OCB_CONFIG_DIR（推配置目录），是唯一同时可靠的来源。
 * 目录扫描降级为没装 plist 的实例的展示来源（nohup 起的实例没有 plist）。
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO = resolve(fileURLToPath(import.meta.url), '../..')
const CONFIG_PREFIX = 'opencode-feishu-bridge'
const CONFIG_BASE = join(homedir(), '.config')
const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents')
/** launchd label 前缀。规则与 scripts/lib/config-dir.sh 的 ocb_label() 一致 */
const LABEL_PREFIX = 'ai.qiguang.ocbridge'

/** 默认实例的配置目录。规则与 src/config.js 的 resolveConfigDir() 一致 */
export function defaultConfigDir() {
  const explicit = process.env.OCB_CONFIG_DIR
  if (explicit) return resolve(explicit)
  return join(homedir(), '.config', CONFIG_PREFIX)
}

/**
 * 不带环境变量覆盖的缺省配置目录。
 *
 * plist 里没写 OCB_CONFIG_DIR 时，launchd 拉起的那个桥接进程读的就是这个
 * 目录；admin 自己的 OCB_CONFIG_DIR 只回答「admin 是哪个实例」，不能顺带
 * 把别的实例的目录改成自己。曾经这里兜底用 defaultConfigDir()，admin 从
 * 带 OCB_CONFIG_DIR 的会话（pi 子进程）里启动时，缺省实例的 plist 会被指到
 * 那个实例的目录，两条记录在去重时撞车：名字全变成 default、缺省实例的
 * launchd label 与托管标记丢失，页面上的起停按钮变成「安装常驻服务」提示。
 */
function baseConfigDir() {
  return join(homedir(), '.config', CONFIG_PREFIX)
}

/**
 * 配置目录 -> 实例名。只用于没有 plist 的实例（展示用），
 * 缺省实例叫 default，其余取目录名的前缀后缀。
 */
export function instanceNameOf(dir) {
  const base = basename(dir)
  if (base === CONFIG_PREFIX) return 'default'
  if (base.startsWith(CONFIG_PREFIX + '-')) return base.slice(CONFIG_PREFIX.length + 1)
  return base
}

/**
 * launchd label -> 实例名。ai.qiguang.ocbridge.app 是缺省实例，
 * ai.qiguang.ocbridge.<instance>.app 的中间段是实例名。与 ocb_label() 互逆。
 */
export function instanceNameFromLabel(label) {
  const m = new RegExp(`^${LABEL_PREFIX.replace(/\./g, '\\.')}(?:\\.(.+?))?\\.app$`).exec(label)
  if (!m) return null
  return m[1] || 'default'
}

/** 实例对应的启动环境变量。default 的 OCB_INSTANCE 留空，服务名才不带后缀 */
export function instanceEnv(name, dir) {
  return { OCB_CONFIG_DIR: dir, OCB_INSTANCE: name === 'default' ? '' : name }
}

/** 用 macOS 自带 plutil 取 plist 里的环境变量，取不到返回空串 */
function plistEnv(plistPath, key) {
  try {
    const out = execFileSync('plutil', ['-extract', `EnvironmentVariables.${key}`, 'raw', plistPath], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return out.trim()
  } catch {
    return ''
  }
}

/**
 * 扫描 launchd plist。一个 app 服务就是一个实例；配套的 .serve 服务不重复计。
 * 实例名从 label 推，配置目录取 plist 里 install-agent.sh 写进去的
 * OCB_CONFIG_DIR（缺失时退回不带环境覆盖的缺省目录）。
 */
function scanPlists() {
  let files = []
  try {
    files = readdirSync(PLIST_DIR)
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    if (!f.startsWith(LABEL_PREFIX) || !f.endsWith('.app.plist')) continue
    const label = f.slice(0, -'.plist'.length)
    const name = instanceNameFromLabel(label)
    if (!name) continue
    const plistPath = join(PLIST_DIR, f)
    const dir = plistEnv(plistPath, 'OCB_CONFIG_DIR') || baseConfigDir()
    out.push({ name, dir, label, plistPath, managed: true })
  }
  return out
}

/**
 * 目录扫描：发现没装 plist 的实例（nohup 起的）。只作展示来源，
 * 不起停——down.sh 末尾的 pkill 会误杀本机所有桥接进程，不能走那条路。
 */
function scanConfigDirs() {
  const dirs = []
  try {
    for (const name of readdirSync(CONFIG_BASE)) {
      if (name !== CONFIG_PREFIX && !name.startsWith(CONFIG_PREFIX + '-')) continue
      const full = join(CONFIG_BASE, name)
      if (existsSync(join(full, 'config.json')) || existsSync(join(full, 'state.json'))) {
        dirs.push(full)
      }
    }
  } catch {
    // 家目录读不到就只剩 plist 里的实例，不阻塞启动
  }
  return dirs
}

/**
 * 枚举本机实例：plist 优先，目录扫描补上没有 plist 的，按配置目录去重
 * （同一目录被 plist 和扫描同时命中时保留 plist 条目，它有实例名和 label）。
 */
export function discoverInstances() {
  const seen = new Map()
  for (const inst of scanPlists()) seen.set(inst.dir, inst)
  for (const dir of scanConfigDirs()) {
    if (seen.has(dir)) continue
    seen.set(dir, { name: instanceNameOf(dir), dir, label: null, plistPath: null, managed: false })
  }
  // admin 进程自身的 OCB_CONFIG_DIR 也纳入（自定义路径且没建 plist 时看得见）
  const own = defaultConfigDir()
  if (!seen.has(own)) {
    seen.set(own, { name: instanceNameOf(own), dir: own, label: null, plistPath: null, managed: false })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ---------- 进程状态 ----------

function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

/** pid 的命令行。用来防止 pid 复用把无关进程当成桥接 */
function pidCmdline(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function pidUptime(pid) {
  try {
    return execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function lockPid(dir) {
  try {
    const raw = readFileSync(join(dir, 'bridge.lock'), 'utf8').trim()
    const pid = Number(raw)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** launchd 服务名。规则与 scripts/lib/config-dir.sh 的 ocb_label() 一致 */
export function appLabel(name) {
  return name === 'default' ? 'ai.qiguang.ocbridge.app' : `ai.qiguang.ocbridge.${name}.app`
}

/**
 * launchd 侧状态。只认当前用户 gui 域下的服务；plist 没装过、没加载都算未托管。
 */
function launchdState(label) {
  const plist = join(PLIST_DIR, `${label}.plist`)
  if (!existsSync(plist)) return { installed: false }
  try {
    const out = execFileSync('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${label}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const state = /\bstate = (\w+)/.exec(out)?.[1] || ''
    const pid = Number(/\bpid = (\d+)/.exec(out)?.[1] || 0) || null
    return { installed: true, loaded: true, state, pid }
  } catch {
    // bootout 过的服务 print 会失败：装过但没加载
    return { installed: true, loaded: false }
  }
}

/**
 * 进程状态。判定顺序和 scripts/status.sh 对齐，但 pid 取得更准：
 * status.sh 用 pgrep 取第一个 node 进程，多实例时会张冠李戴；这里以
 * bridge.lock 里的 pid 为准（锁里写的就是这个配置目录对应的桥接进程）。
 */
function processStatus(inst) {
  const label = inst.label || appLabel(inst.name)
  const pid = lockPid(inst.dir)
  if (pid && pidAlive(pid) && pidCmdline(pid).includes('src/index.js')) {
    return { running: true, pid, uptime: pidUptime(pid), via: 'lock' }
  }
  const ld = launchdState(label)
  if (ld.installed) {
    if (ld.loaded && ld.state === 'running' && ld.pid) {
      return { running: true, pid: ld.pid, uptime: pidUptime(ld.pid), via: 'launchd' }
    }
    return { running: false, pid: null, uptime: '', via: 'launchd', launchd: ld }
  }
  // 没装 launchd 时，本仓库的 .bridge.pid 是最后一条线索（脚本 down.sh 会删它）
  const pidFile = join(REPO, '.bridge.pid')
  if (inst.name === 'default' && existsSync(pidFile)) {
    try {
      const p = Number(readFileSync(pidFile, 'utf8').trim())
      if (pidAlive(p) && pidCmdline(p).includes('src/index.js')) {
        return { running: true, pid: p, uptime: pidUptime(p), via: 'pidfile' }
      }
    } catch {
      /* noop */
    }
  }
  return { running: false, pid: null, uptime: '', via: 'none' }
}

// ---------- 文件读取 ----------

function readJson(path) {
  try {
    return { data: JSON.parse(readFileSync(path, 'utf8')), error: null }
  } catch (err) {
    if (!existsSync(path)) return { data: null, error: '文件不存在' }
    return { data: null, error: err.message }
  }
}

/** opencode 后端的 serve 健康检查。pi 后端不适用 */
export async function serveHealth(cfg) {
  if ((cfg?.backend?.type || 'opencode') !== 'opencode') {
    return { applicable: false }
  }
  const url = (cfg?.opencode?.url || 'http://127.0.0.1:19876').replace(/\/+$/, '')
  const password = cfg?.opencode?.password || ''
  const headers = {}
  if (password) headers.Authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
  try {
    const res = await fetch(url + '/api/info', { headers, signal: AbortSignal.timeout(3000) })
    const json = await res.json()
    return { applicable: true, ok: true, version: json.version, pid: json.pid }
  } catch (err) {
    return { applicable: true, ok: false, error: err.message }
  }
}

/**
 * 常见用户 bin 目录。admin 进程的 PATH 未必包含它们——admin 常由 npm 启动，
 * PATH 里只有 node_modules/.bin 和系统目录；而用户装的 CLI（pi 这类）多在
 * npm 全局 bin 里。PATH 直接找不到时去这些目录找，别误报「CLI 异常」。
 * 导出给 backends.js 的扫描用：找不到 pi 时的原因说明要列出这些目录。
 */
export const USER_BIN_DIRS = [
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
]

/**
 * 找可执行文件：显式路径直接用；裸命令名先信 PATH（spawn 自己会找），
 * PATH 找不到时再逐个试常见目录。返回绝对路径或 null。
 */
export function resolveBin(bin) {
  if (!bin) return null
  if (bin.includes('/')) return existsSync(bin) ? bin : null
  for (const dir of USER_BIN_DIRS) {
    const p = join(dir, bin)
    if (existsSync(p)) return p
  }
  return null
}

/** pi 后端：CLI 能否跑起来。和 index.js 启动时的健康检查同口径 */
export async function piCliHealth(cfg) {
  if ((cfg?.backend?.type || 'opencode') !== 'pi') return { applicable: false }
  const bin = cfg?.backend?.pi?.bin || 'pi'
  const { spawn } = await import('node:child_process')
  const resolved = resolveBin(bin)
  return new Promise((res) => {
    const p = spawn(resolved || bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      p.kill()
      res({ applicable: true, ok: false, error: `${bin} --version 超过 5 秒无响应` })
    }, 5000)
    p.stdout?.on('data', (d) => (out += d))
    p.on('error', (err) => {
      clearTimeout(timer)
      const tried = USER_BIN_DIRS.join('、')
      res({
        applicable: true,
        ok: false,
        error: err.code === 'ENOENT'
          ? `找不到可执行文件 ${bin}（PATH 与这些目录都没有：${tried}）。装在别处就把绝对路径填进 backend.pi.bin`
          : err.message,
      })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      res({
        applicable: true,
        ok: code === 0,
        version: out.trim(),
        resolved: resolved || undefined,
        error: code === 0 ? null : `退出码 ${code}`,
      })
    })
  })
}

/**
 * 采集一个实例的全部展示数据。config 与 state 解析失败不抛出，
 * 把 error 带回页面显示，坏一个文件不拖垮整页。
 *
 * managed 表示这个实例装了 launchd 常驻服务：只有它能在页面里起停。
 * 没装 plist 的实例（nohup 起的）不给出起停入口——down.sh 末尾的 pkill
 * 会误杀本机所有桥接进程，这条路过不去。
 */
export async function collectInstance(inst) {
  const { name, dir } = inst
  const config = readJson(join(dir, 'config.json'))
  const state = readJson(join(dir, 'state.json'))
  const cfg = config.data
  const [serve, pi] = await Promise.all([serveHealth(cfg), piCliHealth(cfg)])
  return {
    name,
    dir,
    label: inst.label || null,
    managed: Boolean(inst.managed),
    configPath: join(dir, 'config.json'),
    statePath: join(dir, 'state.json'),
    backend: cfg?.backend?.type || 'opencode',
    config,
    state,
    process: processStatus(inst),
    serve,
    pi,
    summary: {
      chats: state.data?.chats ? Object.keys(state.data.chats).length : 0,
      inflight: state.data?.inflight ? Object.keys(state.data.inflight).length : 0,
      names: state.data?.names ? Object.keys(state.data.names).length : 0,
    },
  }
}

export function collectAll() {
  return Promise.all(discoverInstances().map(collectInstance))
}

/** 文件修改时间，页面显示「配置最后更新时间」用 */
export function mtimeOf(path) {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return null
  }
}
