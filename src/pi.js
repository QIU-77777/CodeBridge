/**
 * pi 后端。
 *
 * 对外伪装成 OpencodeClient：Bridge 里所有 this.oc.* 调用都能原样跑。
 * 内部每个会话一个长驻 `pi --mode rpc` 子进程：stdin 收 JSONL 命令
 * （prompt / steer / follow_up / abort），stdout 出 response 回执与会话
 * 事件，事件形状与 --mode json 同构，直接喂回 subscribe() 注册的回调。
 *
 * 这么做是为了复用整条渲染管线（RunState → runCard → patchCard），以及
 * inflight 落盘 / 僵尸卡收尾 / 中止语义。给 pi 单写一套渲染路径，卡片版式
 * 和收尾逻辑迟早会跟 opencode 那边漂移。
 *
 * 长驻进程换来 steer：运行中可以把一条消息注入当前回合，下一步边界生效，
 * 不中止、不清除已有工作（老实现每条消息起一个一次性 `pi -p --mode json`
 * 子进程，进程随消息生灭，没有注入通道）。会话历史不丢：实测用同样的
 * --session-dir/--session-id 重启进程，历史还在，所以空闲回收是安全的。
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
  watch,
} from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'
import { githubEnv } from './github-identity.js'
import { CLI_SESSION_ROOT, scanCliSessions, textOf } from './pi-cli-sessions.js'

/** 单行 JSONL 可能包含整段 messages，限制一下，别让一条畸形输出吃光内存 */
const MAX_STDOUT_CHARS = 4 * 1024 * 1024
const MAX_STDERR_CHARS = 64 * 1024

/**
 * 扩展 UI 里需要客户端回应的方法（pi 的 docs/rpc-extension-ui.md）：
 * 这些对话方法发出来之后会阻塞到客户端回一条 extension_ui_response，
 * 不回应（且没带 timeout）agent 就一直等。其余方法（notify / setStatus /
 * setWidget 等）即发即忘，忽略即可。
 */
const DIALOG_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

/**
 * exit 之后等这么久再结算：直接子进程一死，已写进 stdio 管道的数据可能还没被
 * 读完，立刻结算会截断尾部输出。几百毫秒足够管道里缓存的数据全部到达。
 * 只服务于一次性短命令（_runOnce，health 检查走它）；prompt 走 RPC，正常完成
 * 信号是 agent_settled，进程退出属于崩溃路径，都不靠这段缓冲。
 */
const EXIT_DRAIN_MS = 300

/**
 * 终端 pi 的默认会话根目录（`pi -r` 列的就是它）与头部读取规则在
 * src/pi-cli-sessions.js：管理后台的会话列表与「查看」共用同一份实现。
 */
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

// textOf、readCliSessionHead 与扫描逻辑已移到 src/pi-cli-sessions.js（管理后台共用）

/** tool_execution_end.result → 纯文本，供卡片工具行展示 */
function toolOutputText(result) {
  if (!result) return ''
  if (typeof result === 'string') return result
  const c = result.content
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n')
  if (typeof c === 'string') return c
  return ''
}

/**
 * user 消息的文本。pi 的 user content 可能是纯字符串，也可能是分段数组
 * （助手消息一定是分段数组，见 textOf）——steer / 排队消息的交付核对两种
 * 都会遇到。
 */
function userTextOf(message) {
  const c = message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('')
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
    // 工具在飞时的静默预算。bash 跑构建、测试、大搜索可以数分钟不吐一行，
    // 和模型挂住不是一回事，单独一档（见 src/config.js 同名字段的注释）
    this.toolTimeoutMs = Number(this.pi.toolTimeoutMs) || 30 * 60_000
    // 最终消息之后静默多久按已完成收尾；0 或负数 = 关闭（恢复只等进程退出）
    const quiet = Number(this.pi.settleQuietMs)
    this.settleQuietMs = Number.isFinite(quiet) && quiet >= 0 ? quiet : 60_000
    // 空闲回收阈值（毫秒）：一轮结束后进程不退出，留着给下一条消息复用
    // （起一次 pi 要读配置、连 provider，复用省掉这段）。超过这个时间没有
    // 新消息就杀掉，下次 prompt 用同样的 session 参数重启——实测重启后
    // 会话历史还在，回收不丢历史。0 或非法值按默认值算
    const idle = Number(this.pi.idleMs)
    this.idleMs = Number.isFinite(idle) && idle > 0 ? idle : 600_000
    this.extraArgs = Array.isArray(this.pi.extraArgs) ? this.pi.extraArgs : []
    this.sessionDir = sessionDir || join(CONFIG_DIR, 'pi-sessions')
    // 终端 pi 的会话根目录：人类 `pi -r` 列的是这里，桥接默认看不到。指过来
    // 之后 /sessions 能列出、/switch 能切、发消息能在同一个 jsonl 上续聊。
    // 默认 ~/.pi/agent/sessions，可用 backend.pi.cliSessionRoot 覆盖
    this.cliRoot = this.pi.cliSessionRoot || CLI_SESSION_ROOT
    this.configDir = configDir || CONFIG_DIR
    this.indexPath = join(this.sessionDir, 'index.json')
    this.spawnImpl = spawnImpl
    // 长驻 RPC 进程注册表：sessionId -> proc。proc.run 是当前在飞的一轮，
    // 没有 run 的进程是空闲待复用状态（见 _ensureIdleReaper）
    this.procs = new Map()
    this.eventSink = null
    this.statusSink = null
    this._version = null
    this._index = null
    this._cliCache = null
    this._watchStarted = false
    this._idleTimer = null
    this._ensureWatch()
    this._ensureIdleReaper()
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

  /**
   * 监听会话目录，外部改动（管理后台删会话文件、改索引）时清掉索引缓存。
   *
   * `_index` 是 index.json 的纯内存缓存，进程启动后只读一次。管理后台按文件
   * 删掉一条会话后，不失效缓存的话桥接的 `/sessions` 还列着它、绑定还指向它，
   * 用户看到「删了但还在」。这里把缓存视作可随时作废的投影：目录下任何变动
   * 都置空，下一次 `_load()` 从磁盘读新内容。
   *
   * 桥接自己 `_save()` 或建会话触发的事件同样只表现为一次重读，内容一致，
   * 无需区分事件来源。目录不存在时先建（与 `_save()` 同一做法）：没有目录
   * 就没有会话可删，建出来也无害。
   */
  _ensureWatch() {
    if (this._watchStarted) return
    this._watchStarted = true
    try {
      mkdirSync(this.sessionDir, { recursive: true })
      this._watcher = watch(this.sessionDir, () => {
        this._index = null
      })
      // 不 ref：测试进程不能因为一个监听器退不出去
      this._watcher.unref?.()
    } catch {
      // 监听失败不阻塞启动：缓存失效退回「桥接重启后才生效」
      this._watchStarted = false
    }
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
   * 扫描实现在 src/pi-cli-sessions.js（管理后台共用）；这里只包一层 10 秒
   * 缓存：prompt 每次也要查一次这个 Map 来判断会话在哪，不缓存的话每条消息
   * 都全盘扫一遍。force=true 跳过缓存（/sessions 用）。
   */
  _scanCliSessions({ force = false } = {}) {
    const now = Date.now()
    if (!force && this._cliCache && now - this._cliCache.at < CLI_SCAN_TTL_MS) {
      return this._cliCache.map
    }
    const map = scanCliSessions(this.cliRoot)
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
    // 会话没了，长驻进程也要退：pi 的会话内容写在 jsonl 文件里，进程还活着
    // 的话，下一轮会把刚删掉的文件重新写出来，用户在 /sessions 里又看到它
    const proc = this.procs.get(id)
    if (proc) {
      this.procs.delete(id)
      this._killProc(proc, 'SIGTERM')
    }
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
    // 进程长驻：一轮结束后它也活着，那时没有正在执行的东西，abort 发过去
    // 只是个空操作，别告诉用户「已发送中止请求」
    if (!p.busy || !p.run || p.run.settled) return false
    p.aborted = true
    try {
      // abort 的响应要等会话空闲才回来（实测约 300ms）。stdin 写失败说明
      // 进程已经死了（EPIPE），killTree 兜底，让退出路径收尸
      await this._sendCmd(p, { type: 'abort' })
    } catch {
      this._killProc(p, 'SIGTERM')
      return true
    }
    // abort 回来时会话已空闲，agent_settled(aborted) 正常情况下紧随其后。
    // 一直不来的话（pi 挂死在半路）按中止收尾，别让卡片停在「执行中」干等
    // 看门狗
    const run = p.run
    if (run && !run.settled) {
      const timer = setTimeout(() => this._finishRun(p, run, { kind: 'aborted' }), 2000)
      timer.unref?.()
    }
    return true
  }

  // ---------- 执行 ----------

  /**
   * 发一条用户消息，等这一轮（含排队的后续消息）全部跑完。
   *
   * 每个会话一个长驻进程：消息走 stdin 的 prompt 命令，进程不退出，完成
   * 信号是 agent_settled（它覆盖整条 drain：排队的 follow_up 全部跑完才来）。
   *
   * opts.delivery === 'steer' 时转交 steer()：Bridge 的忙等分支与排队卡片的
   * 「引导」按钮都走这条（src/handler.js），运行中注入、不中止。
   */
  async prompt(sessionId, body, opts = {}) {
    if (opts?.delivery === 'steer') return this.steer(sessionId, body)

    // 桥接自建的会话（index.json 有条目）走 --session-id；终端 pi 的会话
    // 走 --session <file>，见 _ensureProc
    const s = this._load()[sessionId] || this._cliSession(sessionId)
    if (!s) throw new Error(`会话 ${sessionId} 不存在，先 /new`)

    let proc
    try {
      proc = await this._ensureProc(sessionId, s)
    } catch (err) {
      this._emit(sessionId, 'session.execution.failed', { error: { message: err.message } })
      return { ok: false, error: err.message }
    }

    // 已经有一轮在飞：这条消息排进当前 drain。不新起 run，也不发
    // execution.started——在飞的那张卡还在跑，重新置位会把累积的文本清掉
    if (proc.run && !proc.run.settled) {
      const run = proc.run
      await this._queueFollowUp(proc, run, body)
      // 等整条 drain 收尾：settle 覆盖排队消息，交付信号只说明它被接走了
      return run.donePromise
    }

    this._emit(sessionId, 'session.execution.started')
    const run = this._startRun(proc, s)

    let resp
    try {
      resp = await this._sendCmd(proc, { type: 'prompt', message: body })
    } catch (err) {
      // 命令没发出去：进程已经没了（EPIPE）或起不来。退出事件可能在这个
      // Promise 之前就跑完（那时还没有 run 可收），所以这里自己按失败收尾，
      // 别等一个不会来的事件
      this._finishRun(proc, run, { kind: 'exit', err })
      return run.donePromise
    }
    if (!resp?.success) {
      // 陷阱二的竞态收口：pi 说「已经在处理」，而桥接侧的 run 刚建起来
      // （handler 的 busy 检查与这里之间有窗口）。按 followUp 变体重试一次，
      // 然后按排队的路等下去
      await this._queueFollowUp(proc, run, body)
      return run.donePromise
    }
    if (resp.data?.disposition === 'handled') {
      // 扩展命令把这条消息吃掉了：不会有 run，也不会有 agent_settled，
      // 等下去只会等到看门狗超时。按已完成收尾
      this._finishRun(proc, run, { kind: 'settled' })
    }
    return run.donePromise
  }

  /**
   * 把一条消息 steer 进正在跑的回合。
   *
   * 只在确有 run 在飞时发：空闲时 pi 也回一个 disposition=queued，然后这条
   * 消息静静躺在队列里永不交付，直到未来某次 run 把它当排队消息注入，造成
   * 串话。busy 为假时抛错，调用方（src/handler.js）会退回排队，消息不丢。
   *
   * 只等命令回执，不等交付：反馈要快，卡片按钮不能卡住。
   */
  async steer(sessionId, text) {
    const s = this._load()[sessionId] || this._cliSession(sessionId)
    if (!s) throw new Error(`会话 ${sessionId} 不存在，先 /new`)
    // 先查注册表，再决定起不起进程：没有长驻进程就等于没有在跑的回合——
    // 进程一轮结束不退出，但空闲回收会杀，杀了就没有 run 可注入。若先
    // _ensureProc 再抛错，会白起一个进程躺在注册表里等下一次回收
    const proc = this.procs.get(sessionId)
    if (!proc || proc.exited || !proc.busy || !proc.run || proc.run.settled) {
      throw new Error('当前没有正在执行的任务，引导（steer）只在运行中有效')
    }
    const resp = await this._sendCmd(proc, { type: 'steer', message: text })
    if (!resp?.success) throw new Error(resp?.error || 'pi 拒绝了这条引导消息')
    proc.pendingSteers.set(text, Date.now())
    return { ok: true, disposition: resp.data?.disposition }
  }

  // ---------- 长驻 RPC 进程 ----------

  /**
   * 取（或起）一个会话的长驻 RPC 进程。
   *
   * 注册表里有没退出的进程就复用：一轮结束后进程不退出，下一条消息直接往
   * stdin 写命令，省掉一次启动。已退出的残留条目删掉重建。
   */
  async _ensureProc(sessionId, s) {
    const have = this.procs.get(sessionId)
    if (have && !have.exited) {
      have.lastUsedAt = Date.now()
      return have
    }
    if (have) this.procs.delete(sessionId)

    // 子进程环境要先取好再起进程：Promise 的执行函数不是 async，不能在里面
    // await（childEnv 要给 app 模式换 token，是异步的）。取不到环境就抛，
    // prompt 按失败收尾，卡片上能看到原因，不会留一张永远「执行中」的卡
    let env
    try {
      env = await this.childEnv()
    } catch (err) {
      throw new Error(`取 pi 子进程环境失败：${err.message}`)
    }

    const args = s.file
      ? ['--mode', 'rpc', '--session', s.file]
      : ['--mode', 'rpc', '--session-dir', this.sessionDir, '--session-id', sessionId]
    const modelStr = s.model?.id ? [s.model.providerID, s.model.id].filter(Boolean).join('/') : ''
    if (modelStr) args.push('--model', modelStr)
    args.push(...this.extraArgs)
    // --approve：飞书里没法点授权按钮，跑在已绑定的项目目录里就信任它
    if (!this.extraArgs.some((a) => a === '--approve' || a === '--no-approve' || a === '-na')) {
      args.push('--approve')
    }

    mkdirSync(this.sessionDir, { recursive: true })

    const child = this.spawnImpl(this.bin, args, {
      cwd: s.location?.directory || undefined,
      // 注入本实例的飞书凭证、GitHub 身份与 lark-cli 配置：代理用 CLI
      // 发言时用本实例身份，不会误用机器级配置里别的机器人应用
      env,
      // stdin 必须可写：RPC 命令从这儿进。stdout/stderr 照旧读
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    const proc = {
      child,
      sessionId,
      busy: false,
      aborted: false,
      exited: false,
      // 空闲回收已发过 SIGTERM、进程还没退：下一次扫描跳过它，摘注册表等
      // 退出回调（见 _ensureIdleReaper）
      reaping: false,
      // steer 的交付核对：text -> 入队时间。回执只说「排进队列了」，不保证
      // 真的交付；对不上的一直留到收尾，由 finish 记 warn（竞态残留）
      pendingSteers: new Map(),
      // 命令回执等待者：id -> { resolve, reject }
      pendingCmds: new Map(),
      cmdSeq: 0,
      lastUsedAt: Date.now(),
      run: null,
      killTimer: null,
      lineBuf: '',
    }
    this.procs.set(sessionId, proc)
    this._wireProc(proc)
    this._ensureIdleReaper()
    return proc
  }

  /** 挂上 stdout 记录路由、stderr 收集与进程善后 */
  _wireProc(proc) {
    const { child } = proc
    child.stdout?.on('data', (d) => this._onProcData(proc, d))
    child.stderr?.on('data', (d) => {
      const run = proc.run
      if (!run) return
      if (run.stderr.length < MAX_STDERR_CHARS) run.stderr += d.toString()
    })
    child.on('error', (err) => this._onProcGone(proc, { err }))
    // 收尾听 exit 而不是 close：close 要等 stdio 管道全部关闭，pi 的 bash
    // 工具子进程会成为孤儿进程，继续持有继承来的 stdout/stderr，收尾被拖住。
    // exit 只等直接子进程结束，与 stdio 无关
    child.on('exit', (code, signal) => this._onProcGone(proc, { code, signal }))
  }

  /**
   * 进程退出 / 起不来。
   *
   * 有 run 在飞 → 按失败收尾（退出码与 stderr 原文上卡片）；没有 → 只清
   * 注册表，下次 prompt 重启（同 session 参数重启后历史还在）。
   */
  _onProcGone(proc, { err = null, code = null, signal = null } = {}) {
    if (proc.exited) return
    proc.exited = true
    // 命令回执不会再来：全部拒掉，别让等回执的调用方挂住
    for (const [, p] of proc.pendingCmds) {
      p.reject(new Error(`pi 进程已退出（${err ? err.message : `code=${code} signal=${signal || '-'}`}）`))
    }
    proc.pendingCmds.clear()
    if (proc.killTimer) {
      clearTimeout(proc.killTimer)
      proc.killTimer = null
    }
    const run = proc.run
    if (run && !run.settled) {
      this._finishRun(proc, run, { kind: 'exit', code: err ? -1 : code, signal, err })
    }
    // 注册表里还是这个进程才清理：被空闲回收杀掉又重起过一个的话，旧进程的
    // 迟到退出不能把新进程的条目删掉
    if (this.procs.get(proc.sessionId) === proc) this.procs.delete(proc.sessionId)
  }

  /**
   * stdout 记录路由。一行一条 JSON，只按 \n 断行（文档明确警告不要用会按
   * U+2028/2029 断行的读法）。
   *
   * 三类记录：response 回执按 id 对应到 pendingCmds；extension_ui_request
   * 按方法分流（对话类回取消，即发即忘类忽略，见下）；其余是会话事件，送进
   * 当前 run 的处理管线。没有 run 的事件是进程空闲时来的杂事件，没有接收方，
   * 丢掉。
   */
  _onProcData(proc, chunk) {
    // 进程被回收过（空闲杀掉）又有余数据到达：注册表里已经不是它了，余料
    // 丢掉，别路由进新进程的 run
    if (this.procs.get(proc.sessionId) !== proc) return
    proc.lineBuf += chunk.toString()
    let idx
    while ((idx = proc.lineBuf.indexOf('\n')) >= 0) {
      const line = proc.lineBuf.slice(0, idx).trim()
      proc.lineBuf = proc.lineBuf.slice(idx + 1)
      if (!line.startsWith('{')) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      this._routeRecord(proc, rec, line)
    }
    // 扫不完的尾巴设上限：一行始终不换行时不至于无限堆积（与 stdout 同口径）
    if (proc.lineBuf.length > MAX_STDOUT_CHARS) proc.lineBuf = ''

    // agent_settled 是一轮的权威完成信号。本 chunk 里剩下的行先路由完
    // （同一批里的最终 message_end 不能漏），再收尾
    const run = proc.run
    if (run?.settleSeen && !run.settled) this._finishRun(proc, run, { kind: 'settled' })
  }

  /** 路由一条 stdout 记录 */
  _routeRecord(proc, rec, line) {
    // 回执按 id 对应，异步乱序。命令可能在一轮的空隙里发出（abort 就是一
    // 例），那时没有 run 在飞，回执不能跟着事件一起被丢掉。回执也不进事件
    // 管线：parsePiJsonl 虽能容忍，但 stdout 里混进它们不干净
    if (rec.type === 'response') {
      const p = proc.pendingCmds.get(rec.id)
      if (p) {
        proc.pendingCmds.delete(rec.id)
        p.resolve(rec)
      }
      return
    }
    if (rec.type === 'extension_ui_request') {
      // 两类（pi 的 docs/rpc-extension-ui.md）：notify / setStatus / setWidget
      // 这一类即发即忘，忽略即可；select / confirm / input / editor 这一类
      // 对话方法会阻塞到客户端回一条 extension_ui_response（带 timeout 的到点
      // 自动解决，不带的会一直等）。桥接在飞书里弹不出这些对话框，统一按
      // 「取消」回应，别让 agent 干等一个不会有的人机交互
      if (DIALOG_UI_METHODS.has(rec.method)) {
        try {
          // 回执要回显请求的 id，不走 _sendCmd——那个会另发一个命令 id
          proc.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: rec.id, cancelled: true }) + '\n')
        } catch {
          /* 进程将死：退出路径会收尾，这条回应丢就丢了 */
        }
      }
      return
    }

    const run = proc.run
    if (!run || run.settled) return
    run.lineCount++
    if (run.stdout.length < MAX_STDOUT_CHARS) run.stdout += line + '\n'
    run.lastEventAt = Date.now()
    // 已经认出 provider 报错：进程正在被杀，余下的记录只留现场，不再翻译
    if (run.providerError) return
    if (rec.type === 'agent_settled') run.settleSeen = true
    // 静默判定的现场：最后事件时间、是否见过收尾事件、有没有在进行中的
    // 消息 / 工具调用。pi 偶发「最终回答产出了却不退出」，进程挂住但再也不
    // 吐事件——有这些状态就能把「干完活在装死」和「还在跑」区分开
    this._trackEvent(run, rec)
    // 每吐一行就按当前阶段重置计时器。trackEvent 必须先跑：
    // tool_execution_start 落地的这一刻计时器就要切到工具档，否则工具
    // 开跑后的第一段静默仍按模型档算，长命令会在切档前就被杀
    this._bump(proc, run)
    // 逐条翻译成合成事件：文本增量、工具调用、步数、模型名边收边发，
    // 运行中的卡片按节流刷新，不再是一张静态图
    this._streamEvent(proc.sessionId, rec, run.st)
    // steer / 排队的 follow_up 有没有被当 user 消息交付
    if (rec.type === 'message_start' && rec.message?.role === 'user') {
      this._noteDelivery(proc, run, userTextOf(rec.message))
    }
    // provider 报错（限流、未配置等）：pi 遇到这种错误不退出，只打一条
    // stopReason=error 的助手消息然后挂住。边收边认，认出来就杀进程、立即
    // 失败终态，错误原文上卡片——不再让用户等满一个超时周期
    const err = providerErrorOf(rec)
    if (err) {
      run.providerError = err
      // SIGTERM 先礼，2 秒后 SIGKILL 兜底；退出后 finish 走 providerError
      // 分支，错误原文上卡片
      this._killProc(proc, 'SIGTERM')
    }
  }

  /** 建一个 run 态：一条消息的现场。proc.run 指向当前在飞的一轮 */
  _startRun(proc, s) {
    const run = {
      session: s,
      stdout: '',
      stderr: '',
      lastEventAt: Date.now(),
      sawTurnEnd: false,
      finalTurnHasText: false,
      inFlight: false,
      sawAgentSettled: false,
      settleSeen: false,
      providerError: null,
      lineCount: 0,
      idleTimer: null,
      quietTimer: null,
      quietSettled: false,
      settled: false,
      timedOut: false,
      result: null,
      // 等这条文本被当 user 消息交付的等待者（followUp 排队路用）
      deliveryWaiters: [],
      // 等 agent_settled 的等待者
      settleWaiters: [],
      // 流式翻译的现场：模型名发过没有、步数序号。streamedText 记录有没有
      // 流式发过文本，供排障时区分「卡片一直不刷新」和「刷新了但内容重复」
      st: { modelSent: false, streamedText: false, turnSeq: 0, stepOpen: false },
    }
    run.donePromise = new Promise((resolve) => {
      run.resolveDone = resolve
    })
    proc.run = run
    proc.busy = true
    // 上一轮的中止标记不能带到这一轮：abort 之后进程复用，旧标记会让这一轮
    // 的正常收尾被误判成主动中止
    proc.aborted = false
    proc.lastUsedAt = Date.now()

    // 超时按活跃度算：pi 每吐一行就把计时器重置，只有长时间没有任何输出才杀。
    // 原来从进程启动算总时长，会把一直在干活的运行误杀——真实事故：一个运行
    // 10 分钟里产出 16290 行、12 步，超时前一刻还在查东西，按总时长被杀。
    // 真挂住的运行不再吐任何行，计时器到点照杀。
    //
    // 预算分两档（2026-11-12 补充）：无在飞工具时用 timeoutMs，管模型静默；
    // 工具在飞时用 toolTimeoutMs，管 bash 跑构建、测试、大搜索——这类命令
    // 可以数分钟不吐一行，不是卡死。真实事故：小P 连续两轮被 10 分钟看门狗
    // 杀掉，第二轮的命令实测只要 1.5 分钟（工具结果不回流），第一轮的全家
    // grep -rl 实测要跑 6 分钟以上。inFlight 由 trackEvent 维护
    //
    // 这是 pi 侧唯一的卡死兜底，触发时真杀进程并在卡片上给终态。桥接那层
    // behavior.idleTimeoutMs 看门狗只服务 opencode（pi 的事件从 stdout 逐行
    // 解析，长命令执行期间事件静默而进程健康，按事件判定就是误杀），见
    // src/handler.js 的 watchdogIdleMs。答案出来之后的静默收尾是另一层：
    // settleQuietMs，看的是最终文本出来了没有
    this._bump(proc, run)

    // 静默看护：2 秒扫一次，条件够就 quietSettle。unref，不拖住桥接进程
    if (this.settleQuietMs > 0) {
      run.quietTimer = setInterval(() => {
        if (run.settled || run.quietSettled || run.sawAgentSettled) return
        if (!run.sawTurnEnd || !run.finalTurnHasText || run.inFlight) return
        if (Date.now() - run.lastEventAt < this.settleQuietMs) return
        this._quietSettle(proc, run)
      }, 2000)
      run.quietTimer.unref?.()
    }
    return run
  }

  /** 重置空闲看门狗。档位由 inFlight 决定：工具在飞用 toolTimeoutMs */
  _bump(proc, run) {
    if (run.settled || run.quietSettled) return
    if (run.idleTimer) clearTimeout(run.idleTimer)
    run.idleTimer = setTimeout(() => {
      run.timedOut = run.inFlight ? 'tool' : 'idle'
      this._killProc(proc, 'SIGTERM')
    }, run.inFlight ? this.toolTimeoutMs : this.timeoutMs)
    run.idleTimer.unref?.()
  }

  /** 用一条 stdout 事件更新静默判定的现场状态 */
  _trackEvent(run, ev) {
    const t = ev?.type
    if (t === 'turn_end' || t === 'agent_settled' || t === 'agent_end') {
      if (t === 'turn_end') {
        run.sawTurnEnd = true
        run.finalTurnHasText = textOf(ev.message) !== ''
      }
      if (t === 'agent_settled') run.sawAgentSettled = true
      run.inFlight = false
    } else if (t === 'message_start' || t === 'tool_execution_start') {
      if (t === 'tool_execution_start' || ev?.message?.role === 'assistant') run.inFlight = true
    } else if (t === 'message_end' || t === 'tool_execution_end') {
      if (t === 'tool_execution_end' || ev?.message?.role === 'assistant') run.inFlight = false
    }
  }

  /**
   * 一条 user 消息被交付给 agent：核对 steer / 排队 followUp 的交付情况。
   *
   * steer 的命令回执只说「排进队列了」，不保证真的交付；队列里的文本会在
   * 未来某次 run 的回合边界上当 user 消息出现。这里按文本比对清除记录。
   */
  _noteDelivery(proc, run, text) {
    if (!text) return
    for (const [t] of proc.pendingSteers) {
      if (text.includes(t)) proc.pendingSteers.delete(t)
    }
    const left = []
    for (const w of run.deliveryWaiters) {
      if (text.includes(w.text)) w.resolve()
      else left.push(w)
    }
    run.deliveryWaiters = left
  }

  /**
   * 等一条排队的消息进入当前 drain：先等它被当 user 消息交付，再等
   * agent_settled（settle 覆盖整条 drain，排队的 follow_up 全部跑完才来）。
   * 任一等到了就放行——另一个等待者在收尾时也会被放行，不会挂住。
   */
  _waitDrain(proc, run, text) {
    return new Promise((resolve) => {
      if (!run || run.settled) return resolve()
      let done = false
      const fin = () => {
        if (done) return
        done = true
        resolve()
      }
      run.deliveryWaiters.push({ text, resolve: fin })
      run.settleWaiters.push({ resolve: fin })
    })
  }

  /**
   * 按 followUp 排进当前 drain。
   *
   * 两条来路：发普通 prompt 时 pi 说「已经在处理了」（竞态），和发命令时
   * 注册表里已经有一轮在飞（handler 的 busy 检查与这里有窗口）。两种都带
   * streamingBehavior 才能排进去——RPC 协议下运行中发普通 prompt 会被直接
   * 拒绝。
   */
  async _queueFollowUp(proc, run, body) {
    let resp
    try {
      resp = await this._sendCmd(proc, { type: 'prompt', message: body, streamingBehavior: 'followUp' })
    } catch {
      // 进程死了：退出路径按失败收尾
      return
    }
    if (!resp?.success) {
      this.log.warn?.(
        `会话 ${proc.sessionId} 的 followUp 排队被拒（${resp?.error || '未知原因'}），这条消息没有进入会话`,
      )
      return
    }
    await this._waitDrain(proc, run, body)
  }

  /**
   * 往 stdin 写一条命令，等它对应的 response 回执。
   *
   * 回执按 id 对应、异步乱序（见 _routeRecord）。进程死了回执永远不会来：
   * _onProcGone 会把所有等待中的命令拒掉，所以这里不另设超时——进程级的
   * 看门狗会杀掉再也不回应的进程。
   */
  _sendCmd(proc, cmd) {
    if (proc.exited) return Promise.reject(new Error('pi 进程已退出'))
    const id = `c${++proc.cmdSeq}`
    return new Promise((resolve, reject) => {
      proc.pendingCmds.set(id, { resolve, reject })
      try {
        proc.child.stdin.write(JSON.stringify({ ...cmd, id }) + '\n')
      } catch (err) {
        proc.pendingCmds.delete(id)
        reject(err)
      }
    })
  }

  /**
   * 收尾一轮。取代老实现里「等进程退出再结算」的 finish：RPC 下进程长驻，
   * 正常完成信号是 agent_settled（_onProcData 里调到这里），异常路径是进程
   * 退出、provider 报错、看门狗超时与静默兜底。
   */
  _finishRun(proc, run, outcome = {}) {
    if (run.settled) return run.result
    run.settled = true
    if (run.idleTimer) clearTimeout(run.idleTimer)
    if (run.quietTimer) clearInterval(run.quietTimer)
    if (proc.killTimer) {
      clearTimeout(proc.killTimer)
      proc.killTimer = null
    }
    proc.busy = false
    // run 态交还：进程留着复用，但没有在飞的一轮了。之后再来的事件没有
    // 接收方（进程空闲时的杂事件），由 _routeRecord 丢掉
    proc.run = null
    const sessionId = proc.sessionId
    const s = run.session
    const parsed = parsePiJsonl(run.stdout)
    s.time.updated = Date.now()

    // 把进程杀掉才收得了尾的几种（超时、provider 报错、静默兜底、进程退出）：
    // 进程死了或快死了，不能留在注册表里给下一条消息复用——往一个将死进程的
    // stdin 写命令只会拿到 EPIPE。abort 之后的进程是好的，留着复用
    if (outcome.kind !== 'settled' && outcome.kind !== 'aborted') {
      if (this.procs.get(sessionId) === proc) this.procs.delete(sessionId)
    }

    // 等回执 / 等交付的等待者一律放行：调用方据此返回，不再挂住
    const waiters = [...run.deliveryWaiters, ...run.settleWaiters]
    run.deliveryWaiters.length = 0
    run.settleWaiters.length = 0

    // steer 竞态残留：命令回执说 queued，但这一轮跑完都没把它当 user 消息
    // 交付。记一笔文本，排障时能看出来
    for (const [text, at] of proc.pendingSteers) {
      this.log.warn?.(`会话 ${sessionId} 的 steer 未被交付（排队 ${Date.now() - at}ms）：${text.slice(0, 120)}`)
    }
    proc.pendingSteers.clear()

    const done = (result) => {
      run.result = result
      for (const w of waiters) w.resolve()
      run.resolveDone(result)
      return result
    }

    // 主动中止：只发 interrupted，不抛错，否则 runPrompt 的 catch 会把 aborted 覆盖成 failed
    if (proc.aborted || outcome.kind === 'aborted') {
      this._emit(sessionId, 'session.execution.interrupted')
      return done({ ok: false, aborted: true })
    }

    // provider 报错：turn 已经被这个错误中断（进程就是我们杀掉的），立即
    // 失败终态，原文上卡片。排在超时之前——错误先发生，该报它的原因
    if (run.providerError) {
      const msg = `pi 的模型调用失败，本次运行已中断：\n${run.providerError}`
      this._emit(sessionId, 'session.execution.failed', { error: { message: msg } })
      return done({ ok: false, error: msg })
    }

    if (run.timedOut) {
      // 超时不丢产出：流式期间的文本增量已经上过卡，这里照常解析全量
      // stdout，把已产出的部分以 text.ended 权威覆盖发出，用户看得到
      // agent 做到了哪一步。失败终态保留——partial 的答案不等于完成
      if (parsed.text) {
        const note = run.timedOut === 'tool'
          ? `\n\n—— 工具执行超过 ${Math.round(this.toolTimeoutMs / 60000)} 分钟没有输出，已强制终止，以上是部分产出。`
          : `\n\n—— 超过 ${Math.round(this.timeoutMs / 60000)} 分钟没有任何输出，已强制终止，以上是部分产出。`
        this._emit(sessionId, 'session.text.ended', { text: parsed.text + note })
      }
      const msg = run.timedOut === 'tool'
        ? `pi 工具执行 ${Math.round(this.toolTimeoutMs / 60000)} 分钟没有任何输出，已强制终止。\n长时间不吐输出的命令（构建、测试、大搜索）会触发这条。\n可以调大 backend.pi.toolTimeoutMs，或用 /stop 主动中止。`
        : `pi ${Math.round(this.timeoutMs / 60000)} 分钟没有任何输出，已强制终止。\n长时间不吐输出的命令（构建、测试、长模型调用）也会触发这条。\n可以调大 backend.pi.timeoutMs，或用 /stop 主动中止。`
      this._emit(sessionId, 'session.execution.failed', { error: { message: msg } })
      return done({ ok: false, error: msg })
    }

    if (outcome.kind === 'exit') {
      // 进程自己在一轮还没收尾时退了：崩溃、被外部杀掉、或 stdin 被关。
      // 退出码与 stderr 原文上卡片
      const tail = run.stderr.trim().slice(-800)
      const how = outcome.err
        ? outcome.err.message
        : outcome.code === null || outcome.code === undefined
          ? `被信号 ${outcome.signal || '-'} 终止`
          : `退出码 ${outcome.code}`
      const msg = `pi 进程退出（${how}），本次运行中断${tail ? `：${tail}` : '（没有错误输出）'}`
      this._emit(sessionId, 'session.execution.failed', { error: { message: msg } })
      return done({ ok: false, error: msg })
    }

    if (parsed.aborted) {
      // pi 自己把这一轮中止了（不是桥接发的中止指令）
      const msg = 'pi 的这一轮被中止（agent_settled.aborted=true），没有完整结果'
      this._emit(sessionId, 'session.execution.failed', { error: { message: msg } })
      return done({ ok: false, error: msg })
    }

    // 静默兜底的收尾要在卡片上注明：用户能看出「完成了」但不是正常跑完的
    const quietSec =
      outcome.kind === 'quiet' ? Math.max(1, Math.round((Date.now() - run.lastEventAt) / 1000)) : 0
    const finalText =
      (parsed.text || '（这次 pi 没有返回文本内容）') +
      (quietSec
        ? `\n\n—— pi 产出最终回答后没有响应（静默 ${quietSec} 秒），桥接按已完成收尾并终止了进程。`
        : '')
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
    if (quietSec) {
      this.log.info?.(
        `会话 ${sessionId} 最终消息后静默 ${quietSec} 秒，按已完成收尾并终止进程` +
          `（stdout ${run.lineCount} 行，见过 agent_settled=${run.sawAgentSettled}）`,
      )
      // pi 自己不退，留着他只会占着会话绑定
      this._killProc(proc, 'SIGTERM')
    }
    return done(quietSec ? { ok: true, text: finalText, quietSettled: true } : { ok: true, text: finalText })
  }

  /**
   * 静默兜底：最终消息之后 pi 再也不吐事件，按已完成收尾。
   *
   * RPC 下 agent_settled 正常会来（一到就收尾，见 _onProcData），走到这里只
   * 说明 agent 挂死：最终回答有了、没有在飞的工作，却再也没有下文。
   */
  _quietSettle(proc, run) {
    if (run.settled || run.quietSettled) return
    run.quietSettled = true
    this._finishRun(proc, run, { kind: 'quiet' })
  }

  /** 杀掉整个进程组，2 秒后 SIGKILL 兜底 */
  _killProc(proc, signal) {
    if (!proc?.child) return
    if (proc.killTimer) {
      clearTimeout(proc.killTimer)
      proc.killTimer = null
    }
    killTree(proc.child, signal)
    if (signal === 'SIGTERM') {
      proc.killTimer = setTimeout(() => killTree(proc.child, 'SIGKILL'), 2000)
    }
  }

  /**
   * 空闲回收：一个统一定时器扫全部会话的进程。
   *
   * 一轮结束后进程不退出（留着复用），但也不能永远留着：超过 idleMs 没有新
   * 消息就杀掉整个进程组。实测用同样的 session 参数重启后历史还在，回收不丢
   * 会话。用每进程一个定时器的话，并发会话一多就是一片定时器；扫一遍 Map
   * 的成本可以忽略。
   */
  _ensureIdleReaper() {
    if (this._idleTimer) return
    this._idleTimer = setInterval(() => {
      const now = Date.now()
      for (const [sid, proc] of this.procs) {
        if (proc.busy || proc.reaping) continue
        if (now - proc.lastUsedAt <= this.idleMs) continue
        this.log.info?.(`会话 ${sid} 的 pi 进程空闲超过 ${Math.round(this.idleMs / 1000)} 秒，回收`)
        // 只杀不摘注册表：先摘的话，SIGTERM 到进程退出（至多两秒，之后还有
        // SIGKILL 兜底）这段时间里，同会话再来一条消息会另起一个进程，两个
        // 进程写同一个 jsonl。摘注册表交给退出回调（_onProcGone）——进程
        // 真的没了才让位；reaping 标记防止下一次扫描重复杀、重复记日志
        proc.reaping = true
        this._killProc(proc, 'SIGTERM')
      }
    }, 1000)
    // 不 ref：测试进程不能因为一个定时器退不出去
    this._idleTimer.unref?.()
  }
}

/**
 * 后端能力表。help / status / 卡片回调据此决定哪些功能可用。
 *
 * steer = 能不能把一条用户消息注入「正在跑的那一轮」：服务端在下一个步骤
 * 边界把它交给 agent，在飞工作不中止、已处理的痕迹不清除。opencode serve
 * 的 session.prompt 带 delivery=steer 原生支持（schema Session.Inbox.Delivery，
 * 枚举 steer/queue）；pi 的 RPC 长驻进程有 steer / follow_up 两个命令，同样
 * 做得到。两种后端的默认行为都是 follow-up 排队，steer 只是多给一个选项。
 *
 * opencode 是全功能；pi 是长驻子进程，流式与 steer 都有，没有 opencode 的
 * agent 概念与交互式授权（权限由启动参数 --approve 一类决定）。
 *
 * 坑（发命令前必须知道）：pi 空闲时发 steer / follow_up 不会跑——回一个
 * disposition=queued 就静静躺在队列里，直到未来某次 run 把它当排队消息注入，
 * 造成串话。所以 steer 只在确有 run 在飞时发（见 PiBackend.steer）。
 */
export function capabilitiesFor(cfg) {
  const type = cfg.backend?.type || 'opencode'
  if (type === 'opencode') {
    return { type, label: 'opencode', streaming: true, agents: true, permissions: true, oneShot: false, steer: true }
  }
  if (type === 'pi') {
    return { type, label: 'pi', streaming: false, agents: false, permissions: false, oneShot: false, steer: true }
  }
  return { type, label: type, streaming: false, agents: false, permissions: false, oneShot: true, steer: false }
}
