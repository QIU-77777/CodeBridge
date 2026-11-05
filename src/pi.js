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
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'

/** 单行 JSONL 可能包含整段 messages，限制一下，别让一条畸形输出吃光内存 */
const MAX_STDOUT_CHARS = 4 * 1024 * 1024
const MAX_STDERR_CHARS = 64 * 1024

/**
 * exit 之后等这么久再结算：直接子进程一死，已写进 stdio 管道的数据可能还没被
 * 读完，立刻结算会截断尾部输出。几百毫秒足够管道里缓存的数据全部到达。
 */
const EXIT_DRAIN_MS = 300

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

/** 从 pi 的 message_end / turn_end 里抠出最终文本 */
function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
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

export class PiBackend {
  /**
   * @param {object} opts
   * @param {object} opts.cfg            完整配置
   * @param {string} [opts.sessionDir]  会话目录；默认 <CONFIG_DIR>/pi-sessions
   * @param {Function} [opts.spawnImpl] 注入子进程工厂，测试用
   * @param {object} [opts.logger]
   */
  constructor({ cfg, sessionDir, spawnImpl = spawn, logger = console } = {}) {
    this.cfg = cfg
    this.log = logger
    this.pi = cfg.backend?.pi || {}
    this.bin = process.env.OCB_PI_BIN || this.pi.bin || 'pi'
    this.timeoutMs = Number(this.pi.timeoutMs) || 10 * 60_000
    this.extraArgs = Array.isArray(this.pi.extraArgs) ? this.pi.extraArgs : []
    this.sessionDir = sessionDir || join(CONFIG_DIR, 'pi-sessions')
    this.indexPath = join(this.sessionDir, 'index.json')
    this.spawnImpl = spawnImpl
    this.procs = new Map()
    this.eventSink = null
    this.statusSink = null
    this._version = null
    this._index = null
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
    if (!s) throw new Error(`会话 ${id} 不存在`)
    return s
  }

  async renameSession(id, title) {
    const s = this._load()[id]
    if (!s) throw new Error(`会话 ${id} 不存在`)
    s.title = title
    s.time.updated = Date.now()
    this._save()
    return s
  }

  async deleteSession(id) {
    const idx = this._load()
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

  async listSessions({ limit = '100', order = 'desc', search } = {}) {
    let all = Object.values(this._load())
    if (search) all = all.filter((s) => (s.title || '').includes(search))
    all.sort((a, b) => (order === 'desc' ? b.time.updated - a.time.updated : a.time.updated - b.time.updated))
    return all.slice(0, Number(limit) || 100)
  }

  async switchModel(id, model) {
    const s = this._load()[id]
    if (!s) throw new Error(`会话 ${id} 不存在`)
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
    const s = this._load()[sessionId]
    if (!s) throw new Error(`会话 ${sessionId} 不存在，先 /new`)

    const args = ['-p', '--mode', 'json', '--session-dir', this.sessionDir, '--session-id', sessionId]
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

    return new Promise((resolve) => {
      let child
      try {
        child = this.spawnImpl(this.bin, args, {
          cwd: s.location?.directory || undefined,
          env: process.env,
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

      const timer = setTimeout(() => {
        rec.timedOut = true
        killTree(child, 'SIGTERM')
        rec.killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2000)
      }, this.timeoutMs)
      timer.unref?.()

      const finish = (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
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

        if (rec.timedOut) {
          const msg = `pi 超过 ${Math.round(this.timeoutMs / 60000)} 分钟没有结束，已强制终止。\n可以用 /stop 主动中止，或调大 backend.pi.timeoutMs。`
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
        this._emit(sessionId, 'session.text.delta', { delta: finalText })
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

      child.stdout?.on('data', (d) => {
        if (stdout.length < MAX_STDOUT_CHARS) stdout += d.toString()
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
      child.on('exit', (code) => {
        drainTimer = setTimeout(() => finish(code), EXIT_DRAIN_MS)
      })
    })
  }
}

/**
 * 后端能力表。help / status / 卡片回调据此决定哪些功能可用。
 * opencode 是全功能，pi 是一次性执行，没有交互式权限与 agent 概念。
 */
export function capabilitiesFor(cfg) {
  const type = cfg.backend?.type || 'opencode'
  if (type === 'opencode') {
    return { type, label: 'opencode', streaming: true, agents: true, permissions: true, oneShot: false }
  }
  if (type === 'pi') {
    return { type, label: 'pi', streaming: false, agents: false, permissions: false, oneShot: true }
  }
  return { type, label: type, streaming: false, agents: false, permissions: false, oneShot: true }
}
