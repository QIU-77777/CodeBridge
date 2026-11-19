/**
 * OAR 后端：一套接口驱动多个编码 agent 运行时。
 *
 * 配置（backend.oar）：
 *   runtime   必填，OAR 注册表 id
 *   model     可选，不填用运行时自己的默认
 *   env       可选，扁平 map，原样进 SessionOptions.env；值填 null 删掉继承的键
 *   idleMs    空闲多久回收会话，默认 10 分钟；0 关掉
 *
 * 与 opencode、pi 两个后端的分工：那两个后端各自吃一种运行时的私有接口，
 * 这一个后端吃 OAR 的统一契约。会话列表、改名、删除由桥接自己的索引管——
 * OAR 没有跨运行时的会话管理，这是宿主的事。
 *
 * pi 是例外：OAR_PI_AGENT_DIR 是进程级的，pi 的 SDK 模式 env overlay 只到
 * Bash 子进程、不到进程内的提供方。所以 pi 的第三方提供方在桥接进程环境里
 * 设，配置里不加字段。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRuntimes } from '@botiverse/oar'
import { CONFIG_DIR } from './config.js'
import { createEventTranslator } from './oar-events.js'
import { serveFeishuTools } from './oar-host-tools.js'

/** 第一版放开的运行时。cursor 与 pi-durable 要宿主传 SDK，不在表内 */
const OPEN_RUNTIMES = [
  'claude',
  'codex',
  'pi',
  'kimi',
  'qwen',
  'grok',
  'opencode',
  'antigravity',
  'codebuddy',
  'qoder',
  'devin',
  'factory',
  'dsh',
]

/** 解析前的保守取值：能力面板不渲染任何按钮，也不允许忙时注入 */
const PENDING_CAPS = {
  streaming: true,
  agents: false,
  permissions: false,
  steer: false,
  oneShot: false,
  label: '',
  images: false,
  refused: {},
}

export class OarBackend {
  /**
   * @param {object} opts
   * @param {object} opts.cfg 完整配置
   * @param {string} [opts.sessionDir] 桥接自建议话索引的目录；默认 <CONFIG_DIR>/oar-sessions
   * @param {Function} [opts.logger]
   * @param {object} [opts.registry] 运行时注册表；测试注入脚本运行时用
   */
  constructor({ cfg, sessionDir, logger = console, registry = defaultRuntimes } = {}) {
    this.cfg = cfg
    this.log = logger
    this.registry = registry
    this.oar = cfg.backend?.oar || {}
    this.runtimeId = String(this.oar.runtime || '').trim()
    if (!this.runtimeId) {
      throw new Error('backend.oar.runtime 未配置。可选值：' + OPEN_RUNTIMES.join(' / '))
    }
    if (!OPEN_RUNTIMES.includes(this.runtimeId)) {
      throw new Error(
        `不支持的 backend.oar.runtime: ${this.runtimeId}。第一版可选：${OPEN_RUNTIMES.join(' / ')}`,
      )
    }
    this.runtime = this.registry.get?.(this.runtimeId)
    if (!this.runtime) {
      throw new Error(`运行时注册表里没有 ${this.runtimeId}，升级 @botiverse/oar 或检查 runtime 拼写`)
    }
    this.env = this.oar.env && typeof this.oar.env === 'object' ? this.oar.env : undefined
    this.defaultModel = this.oar.model || ''
    const idle = Number(this.oar.idleMs)
    this.idleMs = Number.isFinite(idle) && idle >= 0 ? idle : 600_000

    this.sessionDir = sessionDir || join(CONFIG_DIR, 'oar-sessions')
    this.indexPath = join(this.sessionDir, 'index.json')
    // 桥接会话 id -> 运行中的 OAR 会话
    this.live = new Map()
    // 桥接会话 id -> 空闲回收定时器
    this.idleTimers = new Map()
    this.eventSink = null
    this.statusSink = null
    this.installation = null
    this.caps = { ...PENDING_CAPS, label: this.runtimeId }
    this._index = null

    // 能力异步解析一次并缓存，不阻塞启动。解析完成前 caps 全 false，
    // steer 按钮不渲染、忙时不注入，几百毫秒后自动恢复
    this._ready = this._resolve()
  }

  // ---------- 启动解析 ----------

  async _resolve() {
    try {
      const inst = (await this.runtime.installation?.()) || null
      this.installation = inst && inst.kind === 'available' ? inst : null
      if (!this.installation) {
        this.log.warn?.(
          `OAR 后端：运行时 ${this.runtimeId} 未安装或不可用（${inst?.kind || '无探测接口'}）`,
        )
        this._status({ connected: false, reason: inst?.kind || 'not_installed' })
        return
      }
      const declared = this.runtime.sessionCapabilities?.(this.installation) || {}
      this.caps = {
        streaming: true,
        agents: false,
        permissions: false,
        oneShot: false,
        steer: declared.steer === true,
        images: declared.images === true,
        refused: this.runtime.refusedSessionOptions || {},
        label: this.runtime.brand?.name || this.runtimeId,
      }
      this._status({ connected: true, caps: this.caps })
      this.log.info?.(
        `OAR 后端就绪：${this.caps.label}（steer=${this.caps.steer} images=${this.caps.images}）`,
      )
    } catch (err) {
      this.log.error?.('OAR 后端启动解析失败: ' + (err?.message || err))
      this._status({ connected: false, reason: err?.message || 'resolve_failed' })
    }
  }

  _status(s) {
    try {
      this.statusSink?.(s)
    } catch {
      /* noop */
    }
  }

  // ---------- 索引 ----------

  _load() {
    if (this._index) return this._index
    try {
      this._index = JSON.parse(readFileSync(this.indexPath, 'utf8'))
    } catch {
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

  // ---------- 会话选项 ----------

  /**
   * 拼开会话选项，先把运行时拒绝的选项剥掉。
   *
   * 剥选项是为了不让 UnsupportedOptionError 把整次任务打掉——用户发一句话，
   * 不该因为后端不支持改名就整个失败。创建与恢复共用这一个函数：OAR 不持久化
   * 宿主选项，resume 漏传会静默丢失。
   */
  buildSessionOptions({ directory, model, name } = {}) {
    const refused = this.runtime.refusedSessionOptions || {}
    const opts = {}
    if (directory) opts.cwd = directory
    const m = model || this.defaultModel
    if (m) opts.model = m
    if (name && !refused.name) opts.name = name
    if (this.env) opts.env = this.env
    // 飞书能力挂上来：运行时拒绝 mcpServers 或带头部的条目时不挂
    if (this.hostServer && !refused.mcpServers && !refused.mcpServerCredentials) {
      opts.mcpServers = [this.hostServer]
    }
    for (const key of Object.keys(refused)) delete opts[key]
    return opts
  }

  /**
   * 收飞书传输层与状态存储，用来起飞书宿主工具。
   *
   * 构造时它们还不存在（桥接先建后端，飞书连上之后才有传输层），所以后给。
   * 会话在第一条消息时才打开，那时一定已经给过了。
   */
  setHost({ transport, store, askHuman } = {}) {
    this.host = { transport, store, askHuman }
  }

  /** 第一次开会话前把飞书工具服务起来。运行时不收 MCP 就不起，白起一个端口 */
  async _ensureHostTools() {
    if (this.hostServer !== undefined) return this.hostServer
    const refused = this.runtime.refusedSessionOptions || {}
    if (refused.mcpServers || refused.mcpServerCredentials || !this.host?.transport) {
      this.hostServer = null
      return null
    }
    try {
      const served = await serveFeishuTools(this.host)
      this.hostServer = served ? served.server : null
      this.hostClose = served ? served.close : null
    } catch (err) {
      this.log.warn?.('飞书宿主工具启动失败: ' + (err?.message || err))
      this.hostServer = null
    }
    return this.hostServer
  }

  // ---------- Backend 接口 ----------

  async health() {
    if (!this.installation) {
      return { ok: false, version: '', runtime: this.runtimeId, reason: '未安装或未登录' }
    }
    return {
      ok: true,
      version: this.installation.version || '',
      runtime: this.runtimeId,
      label: this.caps.label,
    }
  }

  async location() {
    return { directory: this.cfg.opencode?.defaultDirectory || process.cwd() }
  }

  subscribe(onEvent, onStatus) {
    this.eventSink = onEvent
    this.statusSink = onStatus
    // 构造时就发出的状态可能已经过去了（_resolve 在构造里启动，subscribe 由
    // 桥接的 start 调用）：补发一次当前状态，能力跟着一起送上去
    queueMicrotask(() => this.statusSink?.({ connected: Boolean(this.installation), caps: this.caps }))
    return () => {
      this.eventSink = null
      this.statusSink = null
    }
  }

  _emit(sessionId, type, data = {}) {
    // 桥接的会话 id 盖过翻译层带上的 OAR 会话 id：RunState 与 runs 表都认前者
    this.eventSink?.({ type, data: { ...data, sessionID: sessionId } })
  }

  async createSession({ title, directory, model } = {}) {
    const id = `oar-${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const s = {
      id,
      title: title || id,
      location: { directory: directory || this.cfg.opencode?.defaultDirectory || process.cwd() },
      model: this._modelRef(model),
      time: { created: now, updated: now },
      // OAR 的会话 id，第一次发消息开会话时才有
      oarId: null,
    }
    this._load()[id] = s
    this._save()
    return s
  }

  _modelRef(model) {
    const raw = model || this.defaultModel
    if (!raw) return null
    if (typeof raw === 'object') return { providerID: raw.providerID || '', id: raw.id || '' }
    const [providerID, ...rest] = String(raw).split('/')
    return rest.length ? { providerID, id: rest.join('/') } : { providerID: '', id: raw }
  }

  async getSession(id) {
    const s = this._load()[id]
    if (s) return s
    throw new Error(`会话 ${id} 不存在`)
  }

  async listSessions({ limit = '100', order = 'desc', search } = {}) {
    let all = Object.values(this._load()).filter((s) => s?.id)
    if (search) all = all.filter((s) => (s.title || '').includes(search))
    all.sort((a, b) => (order === 'desc' ? b.time.updated - a.time.updated : a.time.updated - b.time.updated))
    return all.slice(0, Number(limit) || 100)
  }

  async renameSession(id) {
    // OAR 的 name 只在建会话时给，恢复不会替换运行时就有的名字；跨运行时的
    // 改名接口不存在。明确拒绝，别让人以为改成功了
    const s = this._load()[id]
    if (!s) throw new Error(`会话 ${id} 不存在`)
    throw new Error(
      `${this.caps.label || this.runtimeId} 不支持改会话名：运行时只在建会话时接受名字，桥接改不了`,
    )
  }

  async deleteSession(id) {
    const idx = this._load()
    if (!idx[id]) throw new Error(`会话 ${id} 不存在`)
    delete idx[id]
    this._save()
    this._dropLive(id, '删除会话')
    return true
  }

  async switchModel(id, model) {
    const s = this._load()[id]
    if (!s) throw new Error(`会话 ${id} 不存在`)
    s.model = this._modelRef(model)
    s.time.updated = Date.now()
    this._save()
    // 运行中的会话改模型：OAR 没有运行中改模型的接口，关掉它，下一条消息用
    // 新模型恢复。这样卡片显示与实际执行一致
    this._dropLive(id, '切换模型')
    return true
  }

  async listModels() {
    if (!this.installation) return []
    try {
      const models = await this.runtime.listModels?.(this.installation)
      return (models || []).map((m) => ({
        providerID: m.providerID || m.provider || '',
        id: m.id || m.model || '',
        name: m.name || '',
      }))
    } catch (err) {
      this.log.warn?.('OAR 后端列模型失败: ' + (err?.message || err))
      return []
    }
  }

  async listAgents() {
    return []
  }

  async switchAgent() {
    throw new Error(
      `${this.caps.label || this.runtimeId} 没有 opencode 的 agent 概念；要换模型用 /model`,
    )
  }

  async replyPermission() {
    // 权限卡片逐个运行时验证后再开；OAR 的运行时请求回答接口也还没定
    return false
  }

  // ---------- 登录 ----------

  /** 登录状态。拿不到就说拿不到，不当成未登录 */
  async authStatus() {
    await this._ready.catch(() => {})
    if (!this.installation || typeof this.runtime.authStatus !== 'function') return { kind: 'unsupported', reason: 'no_reader' }
    try {
      return await this.runtime.authStatus(this.installation, { env: this.env })
    } catch (err) {
      return { kind: 'unknown', detail: err?.message || String(err) }
    }
  }

  /**
   * 跑一次登录。
   *
   * 登录改变本机凭据，只有人明确发起（/login）才会走到这里。交互对象由调用方
   * 给，桥接把它翻成卡片与消息。
   */
  async login(interaction, { timeoutMs } = {}) {
    await this._ready.catch(() => {})
    if (!this.installation) {
      return { kind: 'unsupported', reason: 'not_installed', detail: `运行时 ${this.runtimeId} 未安装` }
    }
    return this.runtime.login(this.installation, interaction, { env: this.env, timeoutMs })
  }

  /** 登出。同样只由人发起 */
  async logout({ timeoutMs } = {}) {
    await this._ready.catch(() => {})
    if (!this.installation || typeof this.runtime.logout !== 'function') {
      return { kind: 'unsupported', reason: 'no_logout', detail: '这个运行时不提供登出接口' }
    }
    try {
      return await this.runtime.logout(this.installation, { env: this.env, timeoutMs })
    } catch (err) {
      return { kind: 'failed', reason: 'error', detail: err?.message || String(err) }
    }
  }

  async interrupt(id) {
    const live = this.live.get(id)
    if (!live) return false
    try {
      const r = await live.session.abort()
      return r.kind !== 'rejected'
    } catch {
      return false
    }
  }

  // ---------- 发消息 ----------

  /** 取这个桥接会话的 OAR 会话：活着就复用，否则按索引恢复或新建 */
  async _sessionFor(id) {
    const live = this.live.get(id)
    if (live) return live
    // 等启动解析落地：解析失败也继续走，下面会给一句明确的话
    await this._ready.catch(() => {})
    await this._ensureHostTools()
    const entry = this._load()[id]
    if (!entry) throw new Error(`会话 ${id} 不存在`)
    if (!this.installation) {
      throw new Error(
        `运行时 ${this.caps.label || this.runtimeId} 未安装或未登录，先在本机安装并登录再发消息`,
      )
    }
    const options = this.buildSessionOptions({
      directory: entry.location?.directory,
      model: entry.model?.id ? `${entry.model.providerID ? entry.model.providerID + '/' : ''}${entry.model.id}` : '',
    })
    let session
    try {
      session = entry.oarId
        ? await this.runtime.session(this.installation, { ...options, resume: entry.oarId })
        : await this.runtime.session(this.installation, options)
    } catch (err) {
      throw new Error(this._resumeError(err, entry))
    }
    entry.oarId = session.id
    entry.time.updated = Date.now()
    this._save()

    const live1 = { session, translate: createEventTranslator(session.id) }
    this.live.set(id, live1)
    session.events((ev) => {
      for (const b of live1.translate(ev)) this._emit(id, b.type, b.data)
    })
    return live1
  }

  /** 恢复失败说清是哪一种，别静默新建——用户要知道原来的会话没了 */
  _resumeError(err, entry) {
    const name = err?.name || ''
    if (name === 'SessionNotFoundError') {
      return `原会话已不存在（${entry.oarId}），可能被运行时删了。用 /new 开新会话`
    }
    if (name === 'SessionUnavailableError') {
      const reason = err?.reason === 'archived' ? '已被归档' : '正被其他进程占用'
      return `原会话取不回来：${reason}。等占用它的程序退出后再试，或用 /new 开新会话`
    }
    return err?.message || String(err)
  }

  async prompt(sessionId, body, opts = {}) {
    const { session } = await this._sessionFor(sessionId)
    // 忙时注入统一走 deliver：空闲新开一回合，忙时能引导就引导、不能就排队，
    // OAR 自己判断，不读 caps
    if (opts.delivery === 'steer') {
      const r = await session.deliver(body)
      if (r.landed === 'rejected') throw new Error(r.reason || '注入被拒绝')
      return r.landed
    }
    const r = await session.prompt(body)
    if (r.kind === 'rejected') throw new Error(r.reason || '发送被拒绝')
    return 'prompted'
  }

  // ---------- 生命周期 ----------

  /** 关掉运行中的会话，索引里的 oarId 留着，下次发消息用 resume 恢复 */
  _dropLive(id, why) {
    const live = this.live.get(id)
    if (live) {
      this.live.delete(id)
      live.session.dispose().catch((e) => this.log.warn?.(`OAR 会话回收失败（${why}）: ${e?.message || e}`))
    }
    const timer = this.idleTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.idleTimers.delete(id)
    }
  }

  /**
   * 一轮结束后启动空闲回收。会话不自己养热进程：OAR 的恢复能把历史带回来，
   * 养着只是白占一个进程。回收超时后 dispose，索引里的 oarId 留给 resume。
   */
  noteRunEnded(sessionId) {
    if (!this.idleMs) return
    const timer = this.idleTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.idleTimers.set(
      sessionId,
      setTimeout(() => this._dropLive(sessionId, '空闲回收'), this.idleMs),
    )
  }

  async close() {
    for (const id of [...this.live.keys()]) this._dropLive(id, '进程退出')
    if (this.hostClose) await this.hostClose().catch(() => {})
  }
}

export { OPEN_RUNTIMES }
