/**
 * pi 后端。
 *
 * 对外伪装成 OpencodeClient：Bridge 里所有 this.oc.* 调用都能原样跑。
 * 内部没有常驻服务，每次 prompt 起一个 `pi -p --mode json` 子进程，跑完后把
 * 结果翻译成与 opencode SSE 同形状的合成事件，喂回 subscribe() 注册的回调。
 *
 * 这么做是为了复用整条渲染管线（RunState → runCard → patchCard），以及
 * inflight 落盘 / 僵尸卡收尾 / 中止语义。给 pi 单写一套渲染路径，卡片版式
 * 和收尾逻辑迟早会跟 opencode 那边漂移。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  chmodSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { CONFIG_DIR } from './config.js'
import { githubEnv } from './github-identity.js'

/** 单行 JSONL 可能包含整段 messages，限制一下，别让一条畸形输出吃光内存 */
const MAX_STDOUT_CHARS = 4 * 1024 * 1024
const MAX_STDERR_CHARS = 64 * 1024

/**
 * 见过 agent_settled 之后的静默阈值：pi 已声明本次运行没有后续工作，这点
 * 时间只用来让管道里缓存的数据读完，之后进程还不退就按已完成收尾。
 */
const SETTLED_QUIET_MS = 5_000

/**
 * exit 之后等这么久再结算：直接子进程一死，已写进 stdio 管道的数据可能还没被
 * 读完，立刻结算会截断尾部输出。几百毫秒足够管道里缓存的数据全部到达。
 */
const EXIT_DRAIN_MS = 300

/**
 * 终端 pi 的默认会话根目录（`pi -r` 列的就是它）。它按工作目录建子目录存放
 * `<时间戳>_<uuid>.jsonl`；桥接自建的会话在实例配置目录下的 pi-sessions 里
 * 平铺存放，两处互不可见。扫终端目录时只读每个文件的头部，不整读——一个会话
 * 文件能到 16MB，而 id、cwd、标题、模型都在最前面几行。
 */
const CLI_SESSION_ROOT = join(homedir(), '.pi', 'agent', 'sessions')
/** 头部读取上限：够覆盖 system 行 + 第一条 user message（标题来源） */
const CLI_HEAD_BYTES = 512 * 1024
/** 扫描结果的进程内缓存时长：/sessions 之外，prompt 每次也要查一次 */
const CLI_SCAN_TTL_MS = 10_000

/**
 * kill 整个进程组。pi 的 bash 工具会留下长驻子进程，只杀直接子进程的话，孤儿
 * 进程继续持有继承来的 stdout/stderr，close 一直不来，收尾被拖住。spawn 时加
 * detached: true，子进程自成进程组，-pid 即打到全组。
 */
function killTree(child, signal) {
  if (!child) return
  try {
    if (process.platform === 'win32') {
      child.kill(signal)
      return
    }
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* 进程已经没了 */
    }
  }
}

/**
 * 从 pi 的 message_end / turn_end 里抠出最终文本
 */
function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}

/**
 * 读终端 pi 一个会话文件的头部，提炼出桥接需要的字段。
 *
 * 头部三行就有全部信息：第一行 `type:"session"` 带 id 与 cwd，随后的
 * model_change 带模型，第一条 role=user 的 message 的文本即标题（与 pi 的
 * resume 选择器同一来源）。只读前 CLI_HEAD_BYTES 字节——会话文件能到 16MB，
 * 整读会让每次 /sessions 都卡住。
 *
 * 返回 null 表示这个文件读不出有效会话头（损坏、空文件、非 pi 格式）。
 */
function readCliSessionHead(file) {
  let head
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.allocUnsafe(CLI_HEAD_BYTES)
      const n = readSync(fd, buf, 0, CLI_HEAD_BYTES, 0)
      head = buf.toString('utf8', 0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  let id = null
  let directory = ''
  let created = 0
  let model = null
  let title = ''
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!id && ev?.type === 'session' && ev.id) {
      id = ev.id
      directory = ev.cwd || ''
      created = ev.timestamp ? Date.parse(ev.timestamp) || 0 : 0
      continue
    }
    if (id && !model && ev?.type === 'model_change' && ev.modelId) {
      model = { providerID: ev.provider || '', id: ev.modelId }
      continue
    }
    if (id && !title && ev?.type === 'message' && ev.message?.role === 'user') {
      const t = textOf(ev.message).trim()
      if (t) title = t
      // 标题到手，后面的行都是正文，不再需要
      if (model || created) break
    }
  }
  if (!id) return null
  let updated = 0
  try {
    updated = statSync(file).mtimeMs
  } catch {
    /* 拿不到 mtime 就用创建时间 */
  }
  return {
    id,
    title: title || '(无标题)',
    location: { directory },
    model,
    time: { created: created || updated, updated: updated || created || Date.now() },
    cost: 0,
    tokens: null,
    // 桥接据此走 --session <file> 续聊，并禁止改名/删除（那是终端 pi 的地盘）
    file,
    cli: true,
  }
}

/** tool_execution_end.result → 纯文本，供卡片工具行展示 */
function toolOutputText(result) {
  if (!result) return ''
  if (typeof result === 'string') return result
  const c = result.content
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n')
  if (typeof c === 'string') return c
  return ''
}

/** usage 在 pi 里出现过很多次，取最后一个 input/output 非零的 */
function pickUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  return {
    input: Number(usage.input) || 0,
    output: Number(usage.output) || 0,
    cacheRead: Number(usage.cacheRead) || 0,
    totalTokens: Number(usage.totalTokens) || 0,
    cost: Number(usage.cost?.total) || 0,
  }
}

/**
 * 把 pi 的 JSONL 输出解析成一次执行的结果。
 * 单独导出，方便离线测试，不必真的起 pi。
 */
export function parsePiJsonl(text) {
  const out = { text: '', delta: '', usage: null, model: null, aborted: false, toolNames: [] }
  let lastAssistant = null
  for (const line of String(text).split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let ev
    try {
      ev = JSON.parse(s)
    } catch {
      continue
    }
    if (ev.type === 'message_update') {
      const a = ev.assistantMessageEvent
      if (a?.type === 'text_delta' && typeof a.delta === 'string') out.delta += a.delta
      if (a?.type === 'text_end' && typeof a.content === 'string') out.delta = a.content
      const u = pickUsage(ev.usage)
      if (u && (u.input || u.output)) out.usage = u
      if (a?.type?.startsWith('toolcall') && a.name) out.toolNames.push(a.name)
    } else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      lastAssistant = ev.message
      const u = pickUsage(ev.message.usage)
      if (u && (u.input || u.output)) out.usage = u
    } else if (ev.type === 'turn_end' && ev.message) {
      if (!lastAssistant) lastAssistant = ev.message
      const u = pickUsage(ev.message.usage)
      if (u && (u.input || u.output)) out.usage = u
    } else if (ev.type === 'agent_settled') {
      out.aborted = Boolean(ev.aborted)
    }
  }
  out.text = textOf(lastAssistant) || out.delta.trim()
  const provider = lastAssistant?.provider || ''
  const model = lastAssistant?.model || ''
  if (model) out.model = provider ? `${provider}/${model}` : model
  return out
}

/**
 * 从 pi 的一行输出里抠出 provider 报错；没有返回 null。
 *
 * 模型调用被拒（429 限流、provider 未配置）时，pi 会打一条 role=assistant、
 * stopReason=error、errorMessage 带原文的消息，然后**不退出**——进程挂住，
 * 以前只能等 backend.pi.timeoutMs 硬超时兜底，用户白等满一个超时周期。
 * 这里认出这条消息就够当场终态了。
 */
export function providerErrorOf(ev) {
  const msg = ev?.message
  if (msg?.role !== 'assistant' || msg.stopReason !== 'error') return null
  const text = msg.errorMessage || msg.error?.message
  return text ? String(text) : null
}

export class PiBackend {
  /**
   * @param {object} opts
   * @param {object} opts.cfg            完整配置
   * @param {string} [opts.sessionDir]  桥接自建会话的目录；默认 <CONFIG_DIR>/pi-sessions
   * @param {string} [opts.configDir]   实例配置目录（飞书凭证所在处）；默认 CONFIG_DIR。测试传临时目录，避免碰真实配置
   * @param {Function} [opts.spawnImpl] 注入子进程工厂，测试用
   * @param {object} [opts.logger]
   */
  constructor({ cfg, sessionDir, configDir, spawnImpl = spawn, logger = console } = {}) {
    this.cfg = cfg
    this.log = logger
    this.pi = cfg.backend?.pi || {}
    this.bin = process.env.OCB_PI_BIN || this.pi.bin || 'pi'
    this.timeoutMs = Number(this.pi.timeoutMs) || 10 * 60_000
    // 最终消息之后静默多久按已完成收尾；0 或负数 = 关闭（恢复只等进程退出）
    const quiet = Number(this.pi.settleQuietMs)
    this.settleQuietMs = Number.isFinite(quiet) && quiet >= 0 ? quiet : 60_000
    this.extraArgs = Array.isArray(this.pi.extraArgs) ? this.pi.extraArgs : []
    this.sessionDir = sessionDir || join(CONFIG_DIR, 'pi-sessions')
    // 终端 pi 的会话根目录：人类 `pi -r` 列的是这里，桥接默认看不到。指过来
    // 之后 /sessions 能列出、/switch 能切、发消息能在同一个 jsonl 上续聊。
    // 默认 ~/.pi/agent/sessions，可用 backend.pi.cliSessionRoot 覆盖
    this.cliRoot = this.pi.cliSessionRoot || CLI_SESSION_ROOT
    this.configDir = configDir || CONFIG_DIR
    this.indexPath = join(this.sessionDir, 'index.json')
    this.spawnImpl = spawnImpl
    this.procs = new Map()
    this.eventSink = null
    this.statusSink = null
    this._version = null
    this._index = null
    this._cliCache = null
  }

  // ---------- 子进程环境：把本实例的飞书身份、GitHub 身份钉进去 ----------

  /**
   * 给 pi 子进程的环境：在桥接自身环境之上注入本实例的飞书凭证与 GitHub 身份，
   * 并准备一份只含本实例应用的 lark-cli 配置。
   *
   * 为什么必须做（飞书）：代理要用飞书 CLI 发消息时，读的是机器级配置
   * （~/.feishu-cli/config.yaml、~/.lark-cli/config.json）。多机器人同机部署时，
   * 那个默认应用经常是另一个实例的——代理就以别人的身份发言。真实事故：
   * 用户让 Lil_P 跟 LilO 打招呼，Lil_P 的代理调 feishu-cli 发出，消息却以
   * Lil_O 的应用到达群里，看起来像 Lil_O 自己跟自己打招呼。
   *
   * feishu-cli 的凭证优先级是 --bot-app-id > 环境变量 > 配置文件，所以注入
   * FEISHU_APP_ID / FEISHU_APP_SECRET 就能盖过机器级配置；lark-cli 认
   * LARKSUITE_CLI_CONFIG_DIR，给它一份只含本实例应用的配置同理。
   *
   * GitHub 身份同理：agent 要用自己的 `xxx[bot]` 推送和开 PR，而不是人手里
   * 那个 gh 登录。注入块由 src/github-identity.js 生成，四路分工见那里的注释。
   */
  async childEnv() {
    const env = { ...process.env }
    const f = this.cfg.feishu || {}
    if (f.appId) env.FEISHU_APP_ID = f.appId
    if (f.appSecret) env.FEISHU_APP_SECRET = f.appSecret
    if (f.domain) env.FEISHU_DOMAIN = f.domain
    const larkDir = this.ensureLarkCliConfig()
    if (larkDir) env.LARKSUITE_CLI_CONFIG_DIR = larkDir
    // GitHub 身份：取 token 失败不能拖垮整个 prompt，日志记一笔继续跑
    try {
      const gh = await githubEnv(this.cfg, this.configDir)
      if (gh) Object.assign(env, gh)
    } catch (err) {
      this.log.warn?.(`GitHub 身份注入失败，本次运行沿用默认身份: ${err.message}`)
    }
    return env
  }

  /**
   * 在实例配置目录下生成一份只含本实例应用的 lark-cli 配置，返回其目录。
   * 没有配置飞书凭证时返回 null（子进程沿用机器级配置，与老行为一致）。
   * appSecret 与桥接自己的 config.json 同样只落在家目录、权限 600。
   */
  ensureLarkCliConfig() {
    const f = this.cfg.feishu || {}
    if (!f.appId || !f.appSecret) return null
    const dir = join(this.configDir, 'lark-cli')
    const file = join(dir, 'config.json')
    try {
      const want = JSON.stringify({ strictMode: 'bot', apps: [{ appId: f.appId, appSecret: f.appSecret }] })
      if (!existsSync(file) || readFileSync(file, 'utf8') !== want) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, want, { mode: 0o600 })
        chmodSync(file, 0o600)
      }
      return dir
    } catch (err) {
      this.log.warn?.(`生成 lark-cli 实例配置失败，子进程将沿用机器级配置: ${err.message}`)
      return null
    }
  }

  // ---------- 会话索引 ----------

  _load() {
    if (this._index) return this._index
    if (existsSync(this.indexPath)) {
      try {
        this._index = JSON.parse(readFileSync(this.indexPath, 'utf8'))
      } catch {
        this._index = {}
      }
    } else {
      this._index = {}
    }
    return this._index
  }

  _save() {
    mkdirSync(this.sessionDir, { recursive: true })
    const tmp = this.indexPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(this._load(), null, 2), 'utf8')
    renameSync(tmp, this.indexPath)
  }

  _findSessionFile(id) {
    try {
      return readdirSync(this.sessionDir).find((f) => f.endsWith(`_${id}.jsonl`)) || null
    } catch {
      return null
    }
  }

  // ---------- 终端 pi 的会话 ----------

  /**
   * 扫终端 pi 的会话根目录，返回 id -> 会话 的 Map。
   *
   * 根目录下每个子目录是一个工作目录（目录名是路径编码，不用解析——jsonl
   * 头部自带 cwd）。缓存 10 秒：prompt 每次也要查一次这个 Map 来判断会话在
   * 哪，不缓存的话每条消息都全盘扫一遍。force=true 跳过缓存（/sessions 用）。
   */
  _scanCliSessions({ force = false } = {}) {
    const now = Date.now()
    if (!force && this._cliCache && now - this._cliCache.at < CLI_SCAN_TTL_MS) {
      return this._cliCache.map
    }
    const map = new Map()
    let subs = []
    try {
      subs = readdirSync(this.cliRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      // 没装过终端 pi、或目录被挪走：当作没有外部会话，桥接自建的照常用
      this._cliCache = { at: now, map }
      return map
    }
    for (const sub of subs) {
      const dir = join(this.cliRoot, sub.name)
      let files = []
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const f of files) {
        const meta = readCliSessionHead(join(dir, f))
        if (meta) map.set(meta.id, meta)
      }
    }
    this._cliCache = { at: now, map }
    return map
  }

  /** 按 id 找终端会话；桥接自建的优先（id 命名空间不同，实际不会撞） */
  _cliSession(id) {
    if (!id) return null
    return this._scanCliSessions().get(id) || null
  }

  // ---------- 事件 ----------

  /**
   * pi 没有常驻事件流，这里只把回调存下来。
   * 立刻回 connected:true，让 Bridge.start() 的日志不误报「事件流断开」。
   */
  subscribe(onEvent, onStatus) {
    this.eventSink = onEvent
    this.statusSink = onStatus
    queueMicrotask(() => this.statusSink?.({ connected: true }))
    return () => {
      this.eventSink = null
      this.statusSink = null
    }
  }

  _emit(sid, type, data = {}) {
    this.eventSink?.({ type, data: { sessionID: sid, ...data } })
  }

  /**
   * 模型名一从流里看到就补上卡片前缀，不用等跑完。
   *
   * 会话创建时模型是空的（配置没写 backend.pi.model 时 index.json 里
   * model: null），真实模型只写在 pi 的助手消息里。旧实现只在进程结束时
   * 发一次 backend.meta，中途卡片前缀一直没有模型，opencode 后端的卡片
   * 却从头带着模型——两个机器人的卡片不一样。
   */
  _emitModel(sessionId, message, st) {
    if (st.modelSent) return
    const model = message?.model
    if (!model) return
    st.modelSent = true
    const provider = message.provider || ''
    this._emit(sessionId, 'backend.meta', { model: provider ? `${provider}/${model}` : model })
    this._patchIndexModel(sessionId, { providerID: provider, id: model })
  }

  /**
   * 把运行中拿到的真实模型补进会话索引。
   *
   * 建会话时配置没写默认模型，index.json 里 model 是 null，而真实模型只写在
   * pi 的助手消息里：/sessions 卡片的模型位和管理后台的模型列因此一直是空的。
   * 索引是桥接自己的文件，这里补写；admin 仍然只读索引，不与桥接争抢写入
   */
  _patchIndexModel(sessionId, model) {
    if (!model?.id) return
    try {
      const s = this._load()[sessionId]
      if (!s) return
      s.model = { providerID: model.providerID || '', id: model.id }
      this._save()
    } catch (err) {
      this.log.warn?.(`补写会话模型失败: ${err.message}`)
    }
  }

  /**
   * 把 pi 的一条 JSON 事件翻译成桥接的合成事件，边收边发。
   *
   * pi 的 --mode json 流里就有全部进度：message_update 带文本增量，
   * toolcall_* / tool_execution_* 带工具调用，message_end 带权威文本、
   * usage 和模型名，turn_start / turn_end 划出步骤。旧实现只把这些行攒进
   * 缓冲区，进程结束才一次性解析，运行中的卡片因此一次都不刷新——用户盯着
   * 「执行中」看好几分钟，一个字都看不到，而模型其实一直在干活。逐条翻译之后，
   * 卡片和 opencode 后端一样按 streamIntervalMs 节流刷新，步数、模型、工具
   * 调用也都有了。事件形状见 pi 文档 docs/json.md。
   */
  _streamEvent(sessionId, ev, st) {
    switch (ev?.type) {
      case 'turn_start':
        st.turnSeq += 1
        st.stepOpen = true
        this._emit(sessionId, 'session.step.started', { assistantMessageID: `turn-${st.turnSeq}` })
        break
      case 'turn_end': {
        if (!st.stepOpen) break
        st.stepOpen = false
        const u = pickUsage(ev.message?.usage)
        this._emit(sessionId, 'session.step.ended', {
          finish: ev.message?.stopReason || null,
          tokens: u ? { input: u.input, output: u.output } : undefined,
        })
        break
      }
      case 'message_start':
        if (ev.message?.role === 'assistant') this._emitModel(sessionId, ev.message, st)
        break
      case 'message_update': {
        const a = ev.assistantMessageEvent
        if (a?.type === 'text_delta' && typeof a.delta === 'string') {
          st.streamedText = true
          this._emit(sessionId, 'session.text.delta', { delta: a.delta })
        } else if (a?.type === 'text_end' && typeof a.content === 'string') {
          st.streamedText = true
          this._emit(sessionId, 'session.text.ended', { text: a.content })
        } else if (a?.type === 'thinking_delta' && typeof a.delta === 'string') {
          this._emit(sessionId, 'session.reasoning.delta', { delta: a.delta })
        } else if (a?.type === 'toolcall_start') {
          this._emit(sessionId, 'session.tool.input.started', { id: a.id, name: a.toolName })
        } else if (a?.type === 'toolcall_end') {
          const tc = a.toolCall || {}
          this._emit(sessionId, 'session.tool.called', { id: tc.id || a.id, name: tc.name, input: tc.args ?? tc.arguments })
        }
        // toolcall_delta 是参数增量，完整参数在 toolcall_end / tool_execution_start，忽略
        break
      }
      case 'message_end': {
        if (ev.message?.role !== 'assistant') break
        this._emitModel(sessionId, ev.message, st)
        const text = textOf(ev.message)
        if (text) {
          st.streamedText = true
          this._emit(sessionId, 'session.text.ended', { text })
        }
        const u = pickUsage(ev.message.usage)
        if (u) this._emit(sessionId, 'session.usage.updated', { tokens: { input: u.input, output: u.output }, cost: u.cost })
        break
      }
      case 'tool_execution_start':
        this._emit(sessionId, 'session.tool.input.started', { id: ev.toolCallId, name: ev.toolName })
        this._emit(sessionId, 'session.tool.called', { id: ev.toolCallId, name: ev.toolName, input: ev.args })
        break
      case 'tool_execution_end': {
        const out = toolOutputText(ev.result)
        if (ev.isError) this._emit(sessionId, 'session.tool.failed', { id: ev.toolCallId, content: out, error: out })
        else this._emit(sessionId, 'session.tool.success', { id: ev.toolCallId, content: out })
        break
      }
      default:
        break
    }
  }

  // ---------- 与 OpencodeClient 同形的基础接口 ----------

  async health() {
    const version = await this._piVersion()
    return { ok: true, version, pid: process.pid }
  }

  async _piVersion() {
    if (this._version) return this._version
    try {
      const r = await this._runOnce(['--version'], 5000)
      this._version = r.stdout.trim().split('\n')[0] || 'pi'
    } catch {
      this._version = 'pi'
    }
    return this._version
  }

  /** 跑一个不做推理的短命令（--version / --list-models） */
  _runOnce(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      let drainTimer = null
      const t = setTimeout(() => killTree(child, 'SIGKILL'), timeoutMs)
      child.stdout?.on('data', (d) => (stdout += d.toString()))
      child.stderr?.on('data', (d) => (stderr += d.toString()))
      const settle = (code) => {
        if (settled) return
        settled = true
        clearTimeout(t)
        if (drainTimer) clearTimeout(drainTimer)
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(`${this.bin} ${args.join(' ')} -> ${code}: ${stderr.slice(0, 200)}`))
      }
      child.on('error', (err) => {
        clearTimeout(t)
        settled = true
        reject(err)
      })
      // 收尾听 exit 而不是 close：close 要等 stdio 管道全部关闭，短命令被
      // SIGKILL 后若有孤儿进程持有管道，health 检查的超时就形同虚设。
      child.on('exit', (code) => {
        drainTimer = setTimeout(() => settle(code), EXIT_DRAIN_MS)
      })
    })
  }

  async location() {
    return { directory: this.cfg.opencode.defaultDirectory }
  }

  // ---------- 会话 ----------

  async createSession({ title, directory, model } = {}) {
    const id = `pi-${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const s = {
      id,
      title: title || id,
      location: { directory: directory || this.cfg.opencode.defaultDirectory },
      model: model ? { providerID: model.providerID || '', id: model.id || '' } : this._defaultModelRef(),
      time: { created: now, updated: now },
      cost: 0,
      tokens: null,
    }
    this._load()[id] = s
    this._save()
    return s
  }

  _defaultModelRef() {
    // pi 的模型写在 backend.pi.model；opencode.defaultModel 若显式给了也认
    const raw = this.cfg.opencode.defaultModel || this.pi.model || ''
    if (!raw) return null
    const [providerID, ...rest] = raw.split('/')
    return rest.length ? { providerID, id: rest.join('/') } : null
  }

  async getSession(id) {
    const s = this._load()[id]
    if (s) return s
    const cli = this._cliSession(id)
    if (cli) return cli
    throw new Error(`会话 ${id} 不存在`)
  }

  async renameSession(id, title) {
    const s = this._load()[id]
    if (!s) {
      // 终端会话的标题写在 jsonl 里，由 pi 的 resume 选择器管理；桥接改不了，
      // 明确拒绝，别静默失败让人以为改成功了
      if (this._cliSession(id)) throw new Error('终端 pi 的会话标题由 pi 管理，要在桥接里改名请先 /new 建一个桥接会话')
      throw new Error(`会话 ${id} 不存在`)
    }
    s.title = title
    s.time.updated = Date.now()
    this._save()
    return s
  }

  async deleteSession(id) {
    const idx = this._load()
    if (!idx[id]) {
      if (this._cliSession(id)) {
        throw new Error('终端 pi 的会话不在桥接目录里，要删请在终端 pi 的会话选择器里操作')
      }
      throw new Error(`会话 ${id} 不存在`)
    }
    delete idx[id]
    this._save()
    const f = this._findSessionFile(id)
    if (f) {
      try {
        unlinkSync(join(this.sessionDir, f))
      } catch {
        /* noop */
      }
    }
    return true
  }

  async listSessions({ limit = '100', order = 'desc', search, force = false } = {}) {
    const merged = new Map()
    for (const s of Object.values(this._load())) if (s?.id) merged.set(s.id, s)
    for (const [id, s] of this._scanCliSessions({ force })) {
      if (!merged.has(id)) merged.set(id, s)
    }
    let all = [...merged.values()]
    if (search) all = all.filter((s) => (s.title || '').includes(search))
    all.sort((a, b) => (order === 'desc' ? b.time.updated - a.time.updated : a.time.updated - b.time.updated))
    return all.slice(0, Number(limit) || 100)
  }

  async switchModel(id, model) {
    const s = this._load()[id]
    if (!s) {
      // 终端会话的模型写在 jsonl 的 model_change 行里，由 pi 维护；桥接的
      // index.json 管不到它。拒掉并说清，避免「显示切换成功、下次跑又变回去」
      if (this._cliSession(id)) throw new Error('终端 pi 的会话模型由 pi 管理，桥接里切不了；要指定模型请 /new 建一个桥接会话')
      throw new Error(`会话 ${id} 不存在`)
    }
    s.model = { providerID: model.providerID || '', id: model.id || String(model) }
    s.time.updated = Date.now()
    this._save()
    return true
  }

  async listModels() {
    // pi 的模型 catalog 是模糊匹配的字符串，不是 opencode 的 {providerID,id} 结构。
    // 这里给出「配置里指定的 + 历史会话里用过的」，够 /model 选了。
    const seen = new Map()
    for (const s of Object.values(this._load())) {
      const id = s.model?.id
      if (id) seen.set(`${s.model.providerID}/${id}`, { providerID: s.model.providerID, id, name: '' })
    }
    const raw = this.pi.model || this.cfg.opencode.defaultModel || ''
    if (raw) {
      const [providerID, ...rest] = raw.split('/')
      const id = rest.join('/') || raw
      seen.set(raw, { providerID: rest.length ? providerID : '', id, name: '配置默认' })
    }
    return [...seen.values()]
  }

  async listAgents() {
    return []
  }

  async switchAgent() {
    throw new Error('pi 后端没有 opencode 的 agent 概念；要换模型用 /model')
  }

  async replyPermission() {
    // pi 用 --approve / --no-tools 一类的启动参数决定权限，不产生交互式授权卡片
    return false
  }

  async interrupt(id) {
    const p = this.procs.get(id)
    if (!p) return false
    p.aborted = true
    killTree(p.child, 'SIGTERM')
    p.killTimer = setTimeout(() => killTree(p.child, 'SIGKILL'), 2000)
    return true
  }

  // ---------- 执行 ----------

  /**
   * 起一个 pi 子进程，等它跑完，把结果合成成 opencode 形状的事件。
   * 返回 Promise 会等到结束；Bridge.runPrompt 本来就 await 它，结果的呈现靠事件。
   */
  async prompt(sessionId, body) {
    // 桥接自建的会话（index.json 有条目）走 --session-id；终端 pi 的会话
    // （index.json 没有、扫描目录里有）走 --session <file>——它按工作目录存在
    // 子目录里，--session-id 在桥接的平铺目录里找不到那个文件
    const s = this._load()[sessionId] || this._cliSession(sessionId)
    if (!s) throw new Error(`会话 ${sessionId} 不存在，先 /new`)

    const args = s.file
      ? ['-p', '--mode', 'json', '--session', s.file]
      : ['-p', '--mode', 'json', '--session-dir', this.sessionDir, '--session-id', sessionId]
    const modelStr = s.model?.id ? [s.model.providerID, s.model.id].filter(Boolean).join('/') : ''
    if (modelStr) args.push('--model', modelStr)
    args.push(...this.extraArgs)
    args.push('--', body)
    // --approve：飞书里没法点授权按钮，跑在已绑定的项目目录里就信任它
    if (!this.extraArgs.some((a) => a === '--approve' || a === '--no-approve' || a === '-na')) {
      args.splice(args.indexOf('--'), 0, '--approve')
    }

    mkdirSync(this.sessionDir, { recursive: true })

    this._emit(sessionId, 'session.execution.started')

    // 子进程环境要先取好再进 Promise：Promise 的执行函数不是 async，不能在里面
    // await（childEnv 要给 app 模式换 token，是异步的）。取不到环境按失败收尾，
    // 卡片上能看到原因，不会留一张永远「执行中」的卡
    let env
    try {
      env = await this.childEnv()
    } catch (err) {
      this._emit(sessionId, 'session.execution.failed', { error: { message: err.message } })
      return { ok: false, error: err.message }
    }

    return new Promise((resolve) => {
      let child
      try {
        child = this.spawnImpl(this.bin, args, {
          cwd: s.location?.directory || undefined,
          // 注入本实例的飞书凭证、GitHub 身份与 lark-cli 配置：代理用 CLI
          // 发言时用本实例身份，不会误用机器级配置里别的机器人应用
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        })
      } catch (err) {
        this._emit(sessionId, 'session.execution.failed', { error: { message: err.message } })
        return resolve({ ok: false, error: err.message })
      }

      const rec = { child, aborted: false, timedOut: false, killTimer: null }
      this.procs.set(sessionId, rec)

      let stdout = ''
      let stderr = ''
      let settled = false
      let drainTimer = null
      // provider 报错（限流、未配置等）的行缓冲与原文。pi 遇到这种错误不退出，
      // 只打一条 stopReason=error 的助手消息然后挂住；边收边认，认出来就杀进程、
      // 立即失败终态，错误原文上卡片——不再让用户等满一个超时周期
      let lineBuf = ''
      let providerError = null
      // 静默判定的现场：最后事件时间、是否见过收尾事件、有没有在进行中的
      // 消息 / 工具调用。pi 偶发「最终回答产出了却不退出」，进程挂住但再也不
      // 吐事件——实测一次卡片在「执行中」停了 6 分 58 秒。有这些状态就能把
      // 「干完活在装死」和「还在跑」区分开，不用干等进程退出
      let lastEventAt = Date.now()
      let sawTurnEnd = false
      let sawAgentSettled = false
      let finalTurnHasText = false
      let inFlight = false
      let lineCount = 0
      let quietSettled = false
      let quietTimer = null
      // 流式翻译的现场：模型名发过没有、步数序号。streamedText 记录有没有
      // 流式发过文本，供排障时区分「卡片一直不刷新」和「刷新了但内容重复」
      const st = { modelSent: false, streamedText: false, turnSeq: 0, stepOpen: false }

      // 超时按活跃度算：pi 每吐一行就把计时器重置，只有长时间没有任何输出才杀。
      // 原来从进程启动算总时长，会把一直在干活的运行误杀——真实事故：一个运行
      // 10 分钟里产出 16290 行、12 步，超时前一刻还在查东西，按总时长被杀。
      // 真挂住的运行不再吐任何行，计时器到点照杀。
      //
      // 这是 pi 侧唯一的卡死兜底，触发时真杀进程并在卡片上给终态。桥接那层
      // behavior.idleTimeoutMs 看门狗只服务 opencode（pi 的事件从 stdout 逐行
      // 解析，长命令执行期间事件静默而进程健康，按事件判定就是误杀），见
      // src/handler.js 的 watchdogIdleMs。答案出来之后的静默收尾是另一层：
      // settleQuietMs，看的是最终文本出来了没有
      let idleTimer = null
      const bump = () => {
        if (settled || quietSettled) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          rec.timedOut = true
          killTree(child, 'SIGTERM')
          rec.killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2000)
        }, this.timeoutMs)
        idleTimer.unref?.()
      }
      bump()

      const finish = (code) => {
        if (settled) return
        settled = true
        if (idleTimer) clearTimeout(idleTimer)
        if (rec.killTimer) clearTimeout(rec.killTimer)
        if (drainTimer) clearTimeout(drainTimer)
        this.procs.delete(sessionId)

        const parsed = parsePiJsonl(stdout)
        s.time.updated = Date.now()

        // 主动中止：只发 interrupted，不抛错，否则 runPrompt 的 catch 会把 aborted 覆盖成 failed
        if (rec.aborted) {
          this._emit(sessionId, 'session.execution.interrupted')
          return resolve({ ok: false, aborted: true })
        }

        // provider 报错：turn 已经被这个错误中断（进程就是我们杀掉的），
        // 立即失败终态，原文上卡片。排在超时之前——错误先发生，该报它的原因
        if (providerError) {
          const msg = `pi 的模型调用失败，本次运行已中断：\n${providerError}`
          this._emit(sessionId, 'session.execution.failed', { error: { message: msg } })
          return resolve({ ok: false, error: msg })
        }

        if (rec.timedOut) {
          const mins = Math.round(this.timeoutMs / 60000)
          const msg =
            `pi ${mins} 分钟没有任何输出，已强制终止。\n` +
            '长时间不吐输出的命令（构建、测试、长模型调用）也会触发这条。\n' +
            '可以调大 backend.pi.timeoutMs，或用 /stop 主动中止。'
          this._emit(sessionId, 'session.execution.failed', { error: { message: msg } })
          return resolve({ ok: false, error: msg })
        }

        if (code !== 0 || parsed.aborted) {
          const tail = stderr.trim().slice(-800)
          const msg = `pi 退出码 ${code}${tail ? `：${tail}` : '（没有错误输出）'}`
          this._emit(sessionId, 'session.execution.failed', { error: { message: msg } })
          return resolve({ ok: false, error: msg })
        }

        const finalText = parsed.text || '（这次 pi 没有返回文本内容）'
        // 一律用 text.ended 权威覆盖：流式期间已经发过文本增量，再发一次
        // text.delta 会把同一段答案在卡片正文里重复两遍
        this._emit(sessionId, 'session.text.ended', { text: finalText })
        if (parsed.usage) {
          const tokens = { input: parsed.usage.input, output: parsed.usage.output }
          s.tokens = { ...tokens, cache: { read: parsed.usage.cacheRead, write: 0 } }
          s.cost = (s.cost || 0) + parsed.usage.cost
          this._emit(sessionId, 'session.usage.updated', { tokens, cost: s.cost })
        }
        if (parsed.model) this._emit(sessionId, 'backend.meta', { model: parsed.model })
        this._save()
        this._emit(sessionId, 'session.execution.succeeded')
        return resolve({ ok: true, text: finalText })
      }

      /**
       * 最终消息之后静默超时：按已完成收尾，不等进程退出。
       *
       * 触发条件四条同时满足：见过带正文的 turn_end（有最终消息）、没有在进行
       * 中的助手消息或工具调用、距最后事件超过 settleQuietMs。任一不满足都说明
       * pi 还在干活（模型流式输出中、工具在跑、最终轮次还没有正文），不能动它。
       *
       * 收尾后杀掉整个进程组：pi 自己不退，留着他只会占着会话绑定。
       */
      const quietSettle = () => {
        if (settled || quietSettled) return
        quietSettled = true
        settled = true
        if (quietTimer) clearInterval(quietTimer)
        if (idleTimer) clearTimeout(idleTimer)
        if (rec.killTimer) clearTimeout(rec.killTimer)
        this.procs.delete(sessionId)

        const parsed = parsePiJsonl(stdout)
        const quietSec = Math.max(1, Math.round((Date.now() - lastEventAt) / 1000))
        const finalText = parsed.text || '（这次 pi 没有返回文本内容）'
        // 卡片上注明这是提前收尾的，用户能看出「完成了」但不是 pi 自己退的
        const note =
          `\n\n—— pi 产出最终回答后没有自行退出（静默 ${quietSec} 秒），` +
          '桥接按已完成收尾并终止了进程。'
        s.time.updated = Date.now()
        this._emit(sessionId, 'session.text.ended', { text: finalText + note })
        if (parsed.usage) {
          const tokens = { input: parsed.usage.input, output: parsed.usage.output }
          s.tokens = { ...tokens, cache: { read: parsed.usage.cacheRead, write: 0 } }
          s.cost = (s.cost || 0) + parsed.usage.cost
          this._emit(sessionId, 'session.usage.updated', { tokens, cost: s.cost })
        }
        if (parsed.model) this._emit(sessionId, 'backend.meta', { model: parsed.model })
        this._save()
        this._emit(sessionId, 'session.execution.succeeded')
        this.log.info?.(
          `会话 ${sessionId} 最终消息后静默 ${quietSec} 秒，按已完成收尾并终止进程` +
            `（stdout ${lineCount} 行，见过 agent_settled=${sawAgentSettled}）`,
        )
        killTree(child, 'SIGTERM')
        rec.killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2000)
        resolve({ ok: true, text: finalText, quietSettled: true })
      }

      // 静默看护：2 秒扫一次，条件够就 quietSettle。unref，不拖住桥接进程
      if (this.settleQuietMs > 0) {
        quietTimer = setInterval(() => {
          if (settled || quietSettled) return
          if (!sawTurnEnd || !finalTurnHasText || inFlight) return
          // 阈值分两档。见过 agent_settled 时 pi 已明确没有后续工作，短静默
          // 即可收尾（留时间是让管道里缓存的数据读完）；没见到时可能是模型在
          // 两轮之间思考——实测同一轮任务里轮间间隔到过 62 秒和 107 秒，用
          // 短阈值会把还在跑的运行误判成完成：杀掉进程、把中途答案标成
          // 「已完成」，用户拿到的是半截结果
          const quietMs = sawAgentSettled ? Math.min(this.settleQuietMs, SETTLED_QUIET_MS) : this.settleQuietMs
          if (Date.now() - lastEventAt < quietMs) return
          quietSettle()
        }, 2000)
        quietTimer.unref?.()
      }

      /** 用一条 stdout 事件更新静默判定的现场状态 */
      const trackEvent = (ev) => {
        const t = ev?.type
        if (t === 'turn_end' || t === 'agent_settled' || t === 'agent_end') {
          if (t === 'turn_end') {
            sawTurnEnd = true
            finalTurnHasText = textOf(ev.message) !== ''
          }
          if (t === 'agent_settled') sawAgentSettled = true
          inFlight = false
        } else if (t === 'message_start' || t === 'tool_execution_start') {
          if (t === 'tool_execution_start' || ev?.message?.role === 'assistant') inFlight = true
        } else if (t === 'message_end' || t === 'tool_execution_end') {
          if (t === 'tool_execution_end' || ev?.message?.role === 'assistant') inFlight = false
        }
      }

      child.stdout?.on('data', (d) => {
        if (stdout.length < MAX_STDOUT_CHARS) stdout += d.toString()
        lastEventAt = Date.now()
        if (providerError) return
        // 逐行扫 provider 报错：一行可能被拆进两个 chunk，先用行缓冲拼齐
        lineBuf += d.toString()
        let idx
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx).trim()
          lineBuf = lineBuf.slice(idx + 1)
          if (!line.startsWith('{')) continue
          lineCount++
          // 每吐一行就重置超时计时器：超时按活跃度算，不按总时长
          bump()
          let ev
          try {
            ev = JSON.parse(line)
          } catch {
            continue
          }
          trackEvent(ev)
          const err = providerErrorOf(ev)
          if (err) {
            providerError = err
            break
          }
          // 逐条翻译成合成事件：文本增量、工具调用、步数、模型名边收边发，
          // 运行中的卡片按节流刷新，不再是一张静态图
          this._streamEvent(sessionId, ev, st)
        }
        // 扫不完的尾巴设上限：一行始终不换行时不至于无限堆积（与 stdout 同口径）
        if (lineBuf.length > MAX_STDOUT_CHARS) lineBuf = ''
        if (providerError) {
          // 认出来就杀：SIGTERM 先礼，2 秒后 SIGKILL 兜底；
          // 退出后 finish 走 providerError 分支，错误原文上卡片
          killTree(child, 'SIGTERM')
          rec.killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2000)
        }
      })
      child.stderr?.on('data', (d) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += d.toString()
      })
      child.on('error', (err) => {
        stderr += `\n${err.message}`
        finish(-1)
      })
      // 收尾听 exit 而不是 close：close 要等 stdio 管道全部关闭，pi 的 bash
      // 工具子进程会成为孤儿进程，继续持有继承来的 stdout/stderr，中止和超时
      // 的收尾被拖住（实测中断后 29 秒才发 interrupted）。exit 只等直接子进程
      // 结束，与 stdio 无关；已写入管道的数据给一个兜底定时器再结算。
      child.on('exit', (code, signal) => {
        // 退出时留一行现场：下次再遇到卡片停在「执行中」，这行能直接分辨是
        // 「pi 没 settle 就退出了」还是「桥接没收到退出事件」
        this.log.info?.(
          `pi 会话 ${sessionId} 进程退出: code=${code} signal=${signal || '-'} ` +
            `quietSettled=${quietSettled} stdout ${lineCount} 行 ` +
            `turn_end=${sawTurnEnd} agent_settled=${sawAgentSettled} ` +
            `最后事件距今 ${Date.now() - lastEventAt}ms`,
        )
        drainTimer = setTimeout(() => finish(code), EXIT_DRAIN_MS)
      })
    })
  }
}

/**
 * 后端能力表。help / status / 卡片回调据此决定哪些功能可用。
 *
 * steer = 能不能把一条用户消息注入「正在跑的那一轮」：服务端在下一个步骤
 * 边界把它交给 agent，在飞工作不中止、已处理的痕迹不清除。opencode serve
 * 的 session.prompt 带 delivery=steer 原生支持（schema Session.Inbox.Delivery，
 * 枚举 steer/queue）；pi 每条消息起一次性子进程，没有注入通道，只有排队和
 * 中止两种。两种后端的默认行为都是 follow-up 排队，steer 只是多给一个选项。
 *
 * opencode 是全功能，pi 是一次性执行，没有交互式权限与 agent 概念。
 */
export function capabilitiesFor(cfg) {
  const type = cfg.backend?.type || 'opencode'
  if (type === 'opencode') {
    return { type, label: 'opencode', streaming: true, agents: true, permissions: true, oneShot: false, steer: true }
  }
  if (type === 'pi') {
    return { type, label: 'pi', streaming: false, agents: false, permissions: false, oneShot: true, steer: false }
  }
  return { type, label: type, streaming: false, agents: false, permissions: false, oneShot: true, steer: false }
}
