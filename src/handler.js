import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { RunState } from './render.js'
import {
  helpCard,
  permissionCard,
  runCard,
  sessionsCard,
  statusCard,
  textCard,
  fmtAgo,
} from './cards.js'
import { truncate } from './render.js'

const MAX_PROMPT_CHARS = 20000

export class Bridge {
  /**
   * @param {object} opts
   * @param {import('./oc.js').OpencodeClient} opts.oc
   * @param {import('./store.js').Store} opts.store
   * @param {object} opts.config
   * @param {object} opts.transport  sendCard/patchCard/sendText
   */
  constructor({ oc, store, config, transport, logger = console }) {
    this.oc = oc
    this.store = store
    this.cfg = config
    this.t = transport
    this.log = logger

    /** @type {Map<string, {state: RunState, cardId: string|null, chatId: string, timer: any, lastFlush: number, meta: object}>} */
    this.runs = new Map()
    /** @type {Map<string, {models: any[], expires: number}>} */
    this.modelCache = new Map()
    /** @type {Map<string, {sessions: any[], expires: number}>} */
    this.sessionCache = new Map()
    this.seenMessages = new Map()
    this.serverInfo = null
    this.lastEnv = null
  }

  // ---------- 生命周期 ----------

  async start() {
    this.serverInfo = await this.oc.health().catch((e) => ({ ok: false, error: e.message }))
    this.lastEnv = await this.oc.location().catch(() => null)
    this.stopEvents = this.oc.subscribe(
      (ev) => this.onEvent(ev),
      (s) => {
        if (s.connected) this.log.info('opencode 事件流已连接')
        else this.log.warn(`opencode 事件流断开: ${s.reason || ''}`)
      },
    )
    // 看门狗：事件流静默太久就判定卡死，否则卡片会永远停在「执行中」
    const idleMs = Number(this.cfg.behavior.idleTimeoutMs) || 0
    if (idleMs > 0) {
      this.watchdog = setInterval(() => this.checkIdle(idleMs), 60_000)
      this.watchdog.unref?.()
    }
  }

  /** 扫描所有运行中的 run，把长时间没有事件的标成失败并收尾卡片 */
  checkIdle(idleMs) {
    const now = Date.now()
    for (const [sid, run] of this.runs) {
      if (run.state.status !== 'running') continue
      const idle = now - (run.state.updatedAt || run.state.startedAt)
      if (idle < idleMs) continue
      const mins = Math.round(idleMs / 60000)
      run.state.status = 'failed'
      run.state.error = {
        message: `超过 ${mins} 分钟没有收到任何事件，判定为卡死。\n常见原因：模型长时间无响应、opencode serve 挂了、或事件流断开。\n发 /stop 中止后重试，或检查 serve 日志。`,
      }
      this.log.warn(`会话 ${sid} 空闲 ${Math.round(idle / 1000)}s，判定卡死并收尾`)
      this.flushRun(sid)
    }
  }

  stop() {
    this.stopEvents?.()
    if (this.watchdog) clearInterval(this.watchdog)
    for (const run of this.runs.values()) {
      if (run.timer) clearTimeout(run.timer)
    }
  }

  // ---------- 事件 ----------

  onEvent(ev) {
    const sid = ev?.data?.sessionID
    if (!sid) return

    // 权限请求：立即推卡片，不等事件聚合
    if (ev.type?.startsWith('session.permission.')) {
      this.onPermissionEvent(ev)
      return
    }

    const run = this.runs.get(sid)
    if (!run) return
    if (!run.state.apply(ev)) return

    const terminal = ['done', 'failed', 'aborted'].includes(run.state.status)
    if (terminal) {
      // 结束态立即刷新，并且关闭节流定时器
      if (run.timer) {
        clearTimeout(run.timer)
        run.timer = null
      }
      this.flushRun(sid)
      return
    }
    this.scheduleFlush(sid)
  }

  onPermissionEvent(ev) {
    const req = ev.data?.request || ev.data
    const sid = ev.data?.sessionID
    if (!sid) return
    const chat = this.store.chatsBySession(sid)[0]
    if (!chat) return
    const card = permissionCard({
      request: { ...req, id: req?.id || ev.data?.requestID, sessionID: sid },
      sessionTitle: this.shortSessionTitle(sid),
    })
    this.t
      .sendCard(chat.chatId, card)
      .catch((e) => this.log.error('推送权限卡片失败: ' + e.message))
  }

  scheduleFlush(sid) {
    const run = this.runs.get(sid)
    if (!run) return
    const interval = this.cfg.behavior.streamIntervalMs
    const now = Date.now()
    const elapsed = now - run.lastFlush
    if (elapsed >= interval) {
      this.flushRun(sid)
      return
    }
    if (run.timer) return
    run.timer = setTimeout(() => {
      run.timer = null
      this.flushRun(sid)
    }, interval - elapsed)
  }

  async flushRun(sid) {
    const run = this.runs.get(sid)
    if (!run || !run.cardId) return
    run.lastFlush = Date.now()
    const card = runCard(run.state, {
      ...run.meta,
      maxBodyChars: this.cfg.behavior.maxBodyChars,
      showReasoning: this.cfg.behavior.showReasoning,
      showTools: this.cfg.behavior.showTools,
    })
    try {
      await this.t.patchCard(run.cardId, card)
    } catch (err) {
      // 飞书 patch 有 QPS 和「内容未变化」限制，失败不致命
      this.log.warn?.(`卡片更新失败: ${err.message}`)
    }
    if (['done', 'failed', 'aborted'].includes(run.state.status)) {
      // 结束后再保留一小段时间便于清理
      setTimeout(() => this.runs.delete(sid), 60_000)
    }
  }

  // ---------- 消息入口 ----------

  isAllowed(userId) {
    const list = this.cfg.feishu.allowlist || []
    if (!list.length) return true
    return list.includes(userId)
  }

  dedupe(messageId) {
    if (!messageId) return false
    if (this.seenMessages.has(messageId)) return true
    this.seenMessages.set(messageId, Date.now())
    if (this.seenMessages.size > 2000) {
      const cutoff = Date.now() - 10 * 60_000
      for (const [k, v] of this.seenMessages) if (v < cutoff) this.seenMessages.delete(k)
    }
    return false
  }

  /**
   * @param {{chatId: string, userId: string, text: string, messageId?: string}} msg
   */
  async onMessage(msg) {
    const text = (msg.text || '').trim()
    if (!text) return
    if (this.dedupe(msg.messageId)) return
    if (!this.isAllowed(msg.userId)) {
      this.log.warn(`拒绝非白名单用户 ${msg.userId}`)
      return
    }

    if (text.startsWith('/')) return this.onCommand(msg)
    return this.runPrompt(msg)
  }

  async runPrompt(msg) {
    const chatId = msg.chatId
    let binding = this.store.get(chatId)
    const directory = binding?.directory || this.cfg.opencode.defaultDirectory

    // 没有绑定或不存在的会话 -> 自动建一个
    let session
    try {
      if (binding?.sessionId) {
        session = await this.oc.getSession(binding.sessionId)
      }
    } catch {
      this.log.warn(`绑定会话 ${binding?.sessionId} 已不存在，重建`)
      binding = null
    }
    if (!session) {
      session = await this.createAndBind(chatId, directory)
    }

    // 一个会话同时只跑一个任务。否则新 run 会覆盖旧的，旧卡片永远停在「执行中」
    const running = this.runs.get(session.id)
    if (running && running.state.status === 'running') {
      return this.t.sendText(chatId, '上一条还在执行中，等它结束，或者先发 /stop 中止。')
    }

    const raw = msg.text || ''
    const promptText = raw.length > MAX_PROMPT_CHARS ? raw.slice(0, MAX_PROMPT_CHARS) : raw

    const state = new RunState(session.id)
    const meta = {
      directory: session.location?.directory || directory,
      model: session.model ? `${session.model.providerID}/${session.model.id}` : '',
      title: session.title || 'opencode',
    }
    const run = { state, cardId: null, chatId, timer: null, lastFlush: 0, meta }
    this.runs.set(session.id, run)

    try {
      const cardId = await this.t.sendCard(chatId, runCard(state, meta))
      run.cardId = cardId
      run.lastFlush = Date.now()
    } catch (err) {
      this.log.error('发送执行卡片失败: ' + err.message)
    }

    try {
      await this.oc.prompt(session.id, promptText)
    } catch (err) {
      state.status = 'failed'
      state.error = { message: err.message }
      this.flushRun(session.id)
    }
  }

  // ---------- 命令 ----------

  async onCommand(msg) {
    const raw = msg.text.trim()
    const [, nameRaw, ...restParts] = raw.match(/^\/(\S+)\s*([\s\S]*)$/) || []
    const name = (nameRaw || '').toLowerCase()
    const arg = restParts.join(' ').trim()
    const chatId = msg.chatId

    switch (name) {
      case 'help':
      case '?':
        return this.t.sendCard(chatId, helpCard())

      case 'new':
        return this.cmdNew(chatId, arg)

      case 'sessions':
      case 'ls':
        return this.cmdSessions(chatId, 0)

      case 'switch':
      case 'use':
        return this.cmdSwitch(chatId, arg)

      case 'cd':
        return this.cmdCd(chatId, arg)

      case 'status':
        return this.cmdStatus(chatId)

      case 'stop':
      case 'abort':
        return this.cmdStop(chatId)

      case 'rename':
        return this.cmdRename(chatId, arg)

      case 'del':
      case 'delete':
        return this.cmdDelete(chatId, arg)

      case 'model':
        return this.cmdModel(chatId, arg)

      case 'agent':
        return this.cmdAgent(chatId, arg)

      default:
        return this.t.sendText(chatId, `未知命令 /${name}，发送 /help 查看可用命令`)
    }
  }

  async cmdNew(chatId, arg) {
    const binding = this.store.get(chatId)
    let dir = binding?.directory || this.cfg.opencode.defaultDirectory
    if (arg) {
      const resolved = this.resolveDir(arg)
      if (!resolved) return this.t.sendText(chatId, `目录不存在: ${arg}`)
      dir = resolved
    }
    const session = await this.createAndBind(chatId, dir)
    return this.t.sendCard(
      chatId,
      textCard(
        '🆕 新会话已绑定',
        [
          `**会话** \`${session.id}\``,
          `**目录** \`${shortDir(dir)}\``,
          session.model ? `**模型** \`${session.model.providerID}/${session.model.id}\`` : '',
          '',
          '直接发消息即可开始。',
        ]
          .filter(Boolean)
          .join('\n'),
        'green',
        [buttonListNew(chatId)],
      ),
    )
  }

  async cmdSessions(chatId, page) {
    const binding = this.store.get(chatId)
    const dir = binding?.directory || this.cfg.opencode.defaultDirectory
    let sessions = this.sessionCache.get(chatId)
    if (!sessions || sessions.expires < Date.now()) {
      const all = await this.oc.listSessions({ limit: '100' })
      const filtered = all.filter((s) => (s.location?.directory || '') === dir)
      sessions = { sessions: filtered, expires: Date.now() + 15_000 }
      this.sessionCache.set(chatId, sessions)
    }
    const card = sessionsCard({
      sessions: sessions.sessions,
      currentId: binding?.sessionId,
      directory: dir,
      page,
    })
    return this.t.sendCard(chatId, card)
  }

  async cmdSwitch(chatId, arg) {
    if (!arg) return this.t.sendText(chatId, '用法: /switch <序号|sessionId>，先用 /sessions 查看')
    const binding = this.store.get(chatId)
    const dir = binding?.directory || this.cfg.opencode.defaultDirectory

    let targetId = arg
    if (/^\d+$/.test(arg)) {
      const cached = this.sessionCache.get(chatId)
      const list = cached?.sessions || (await this.oc.listSessions({ limit: '100' })).filter((s) => (s.location?.directory || '') === dir)
      const idx = Number(arg) - 1
      if (idx < 0 || idx >= list.length) return this.t.sendText(chatId, `序号超出范围（共 ${list.length} 个）`)
      targetId = list[idx].id
    }

    let session
    try {
      session = await this.oc.getSession(targetId)
    } catch {
      return this.t.sendText(chatId, `会话不存在: ${targetId}`)
    }
    this.store.set(chatId, {
      sessionId: session.id,
      directory: session.location?.directory || dir,
    })
    return this.t.sendCard(
      chatId,
      textCard(
        '✅ 已切换会话',
        [`**会话** \`${session.id}\``, `**标题** ${session.title || '(无标题)'}`, `**目录** \`${shortDir(session.location?.directory)}\``].join('\n'),
        'green',
      ),
    )
  }

  async cmdCd(chatId, arg) {
    if (!arg) {
      const b = this.store.get(chatId)
      return this.t.sendText(chatId, `当前工作目录: ${b?.directory || this.cfg.opencode.defaultDirectory}\n用法: /cd <绝对路径>`)
    }
    const resolved = this.resolveDir(arg)
    if (!resolved) return this.t.sendText(chatId, `目录不存在: ${arg}`)
    this.store.set(chatId, { directory: resolved, sessionId: undefined })
    return this.t.sendText(chatId, `工作目录已切到 ${resolved}，会话绑定已重置，发送 /new 新建会话（或直接发消息自动创建）`)
  }

  async cmdStatus(chatId) {
    const binding = this.store.get(chatId)
    let session = null
    if (binding?.sessionId) {
      session = await this.oc.getSession(binding.sessionId).catch(() => null)
    }
    const health = await this.oc.health().catch((e) => ({ ok: false, error: e.message }))
    return this.t.sendCard(
      chatId,
      statusCard({
        session,
        binding,
        directory: this.lastEnv?.directory,
        server: health,
      }),
    )
  }

  async cmdStop(chatId) {
    const binding = this.store.get(chatId)
    if (!binding?.sessionId) return this.t.sendText(chatId, '当前没有绑定会话')
    const ok = await this.oc.interrupt(binding.sessionId)
    return this.t.sendText(chatId, ok ? '已发送中止请求' : '中止失败（可能当前没有在执行）')
  }

  async cmdRename(chatId, arg) {
    const binding = this.store.get(chatId)
    if (!binding?.sessionId) return this.t.sendText(chatId, '当前没有绑定会话')
    if (!arg) return this.t.sendText(chatId, '用法: /rename <新标题>')
    const s = await this.oc.renameSession(binding.sessionId, arg)
    this.sessionCache.delete(chatId)
    return this.t.sendText(chatId, `已重命名为「${s?.title || arg}」`)
  }

  async cmdDelete(chatId, arg) {
    const binding = this.store.get(chatId)
    const dir = binding?.directory || this.cfg.opencode.defaultDirectory
    if (!arg) return this.t.sendText(chatId, '用法: /del <序号>，先用 /sessions 查看')
    const cached = this.sessionCache.get(chatId)
    const list = cached?.sessions || (await this.oc.listSessions({ limit: '100' })).filter((s) => (s.location?.directory || '') === dir)
    let targetId = arg
    if (/^\d+$/.test(arg)) {
      const idx = Number(arg) - 1
      if (idx < 0 || idx >= list.length) return this.t.sendText(chatId, `序号超出范围（共 ${list.length} 个）`)
      targetId = list[idx].id
    }
    await this.oc.deleteSession(targetId)
    this.sessionCache.delete(chatId)
    if (binding?.sessionId === targetId) this.store.clearSession(chatId)
    return this.t.sendText(chatId, `已删除会话 ${targetId}`)
  }

  async cmdModel(chatId, arg) {
    const binding = this.store.get(chatId)
    if (!binding?.sessionId) return this.t.sendText(chatId, '当前没有绑定会话，先 /new')
    let cache = this.modelCache.get(chatId)
    if (!cache || cache.expires < Date.now()) {
      const models = await this.oc.listModels()
      cache = { models, expires: Date.now() + 5 * 60_000 }
      this.modelCache.set(chatId, cache)
    }
    if (!arg) {
      // 只列中国大陆区能用的那批更实用：全部列出但截断为 60 条
      const lines = cache.models.slice(0, 60).map((m, i) => `${i + 1}. \`${m.providerID}/${m.id}\` ${m.name || ''}`)
      return this.t.sendCard(
        chatId,
        textCard('🧠 模型列表', lines.join('\n') + '\n\n用 `/model <序号>` 切换', 'purple'),
      )
    }
    const idx = Number(arg)
    const target = Number.isFinite(idx) && idx > 0 ? cache.models[idx - 1] : cache.models.find((m) => m.id === arg)
    if (!target) return this.t.sendText(chatId, `找不到模型: ${arg}`)
    await this.oc.switchModel(binding.sessionId, { id: target.id, providerID: target.providerID })
    return this.t.sendText(chatId, `已切换到 ${target.providerID}/${target.id}`)
  }

  async cmdAgent(chatId, arg) {
    const binding = this.store.get(chatId)
    if (!binding?.sessionId) return this.t.sendText(chatId, '当前没有绑定会话，先 /new')
    const agents = await this.oc.listAgents()
    if (!arg) {
      const lines = agents.map((a, i) => `${i + 1}. \`${a.id}\` ${a.description || ''}`)
      return this.t.sendCard(chatId, textCard('🧩 Agent 列表', lines.join('\n') + '\n\n用 `/agent <名字>` 切换', 'violet'))
    }
    const idx = Number(arg)
    const target = Number.isFinite(idx) && idx > 0 ? agents[idx - 1] : agents.find((a) => a.id === arg)
    if (!target) return this.t.sendText(chatId, `找不到 agent: ${arg}`)
    await this.oc.switchAgent(binding.sessionId, target.id)
    this.store.set(chatId, { agent: target.id })
    return this.t.sendText(chatId, `已切换到 agent ${target.id}`)
  }

  // ---------- 卡片回调 ----------

  /**
   * 卡片回调。
   *
   * 两条铁律：
   * 1. 响应体里**只返回 toast**，不带 card。飞书对 card 字段格式要求极严
   *    （必须 {type:'raw',data:{...}}），稍偏就 200672「响应体格式错误」。
   * 2. **不动历史消息**。点按钮产生的结果一律新发一条卡片，
   *    绝不 patch 原来那条回复——否则用户的历史答案会被顶掉。
   *    唯一例外：会话列表内部的翻页，patch 的是列表卡片自己。
   */
  async onCardAction({ chatId, userId, action, messageId }) {
    if (!this.isAllowed(userId)) return { toast: { type: 'error', content: '无权限' } }
    const a = action || {}

    // 新发一条消息承载结果，历史保持不变
    const replyNew = (toast, card) => {
      if (card) {
        setTimeout(() => {
          this.t.sendCard(chatId, card).catch((e) => this.log.warn?.(`回调后发卡片失败: ${e.message}`))
        }, 250)
      }
      return { toast }
    }

    // 仅用于列表自身翻页：原地替换自己，避免翻页刷屏
    const replySelf = (toast, card) => {
      if (card && messageId) {
        setTimeout(() => {
          this.t.patchCard(messageId, card).catch((e) => this.log.warn?.(`翻页更新失败: ${e.message}`))
        }, 250)
      }
      return { toast }
    }

    try {
      switch (a.a) {
        case 'new': {
          const b = this.store.get(chatId)
          const dir = b?.directory || this.cfg.opencode.defaultDirectory
          const s = await this.createAndBind(chatId, dir)
          return replyNew(
            { type: 'success', content: '已新建会话' },
            textCard('🆕 新会话已绑定', `**会话** \`${s.id}\`\n**目录** \`${shortDir(dir)}\`\n\n直接发消息开始。`, 'green'),
          )
        }
        case 'sessions': {
          const b = this.store.get(chatId)
          const dir = b?.directory || this.cfg.opencode.defaultDirectory
          const all = await this.oc.listSessions({ limit: '100' })
          const filtered = all.filter((s) => (s.location?.directory || '') === dir)
          this.sessionCache.set(chatId, { sessions: filtered, expires: Date.now() + 15_000 })
          const card = sessionsCard({ sessions: filtered, currentId: b?.sessionId, directory: dir, page: a.p || 0 })
          const toast = { type: 'success', content: `共 ${filtered.length} 个会话` }
          // 翻页（带 p）就地更新列表自己；首次点击新发一条
          return 'p' in a ? replySelf(toast, card) : replyNew(toast, card)
        }
        case 'switch': {
          if (!a.s) return { toast: { type: 'error', content: '缺少会话 ID，请重新打开 /sessions' } }
          const session = await this.oc.getSession(a.s)
          this.store.set(chatId, { sessionId: session.id, directory: session.location?.directory })
          return replyNew(
            { type: 'success', content: `已切换到 ${truncate(session.title || session.id, 20)}` },
            textCard('✅ 已切换会话', `**${session.title || '(无标题)'}**\n\`${session.id}\`\n\n后续消息将进入这个会话。`, 'green'),
          )
        }
        case 'abort': {
          await this.oc.interrupt(a.s)
          return { toast: { type: 'success', content: '已发送中止请求' } }
        }
        case 'perm': {
          await this.oc.replyPermission(a.s, a.r, a.d)
          const label = a.d === 'reject' ? '已拒绝' : a.d === 'always' ? '已允许（永久）' : '已允许一次'
          return replyNew({ type: 'success', content: label }, textCard('🔐 授权已处理', label, a.d === 'reject' ? 'red' : 'green'))
        }
        case 'noop':
          return { toast: { type: 'info', content: '无需操作' } }
        default:
          return { toast: { type: 'error', content: `未知操作 ${a.a}` } }
      }
    } catch (err) {
      this.log.error?.(`卡片回调处理失败: ${err.message}`)
      return { toast: { type: 'error', content: `处理失败: ${truncate(err.message, 60)}` } }
    }
  }

  // ---------- 工具 ----------

  async createAndBind(chatId, directory) {
    const model = this.cfg.opencode.defaultModel
    let modelRef
    if (model) {
      const [providerID, ...idParts] = model.split('/')
      if (providerID && idParts.length) modelRef = { providerID, id: idParts.join('/') }
    }
    const title = `飞书 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`
    const session = await this.oc.createSession({ title, directory, model: modelRef })
    this.store.set(chatId, { sessionId: session.id, directory })
    this.sessionCache.delete(chatId)
    return session
  }

  resolveDir(input) {
    let p = input.trim()
    if (p.startsWith('~')) p = homedir() + p.slice(1)
    const abs = resolve(p)
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) return abs
    } catch {
      /* noop */
    }
    return null
  }

  shortSessionTitle(sid) {
    const binding = this.store.chatsBySession(sid)[0]
    return binding ? `飞书会话 ${binding.chatId.slice(-6)}` : sid
  }
}

function shortDir(dir) {
  if (!dir) return '—'
  const home = process.env.HOME || ''
  return home && dir.startsWith(home) ? '~' + dir.slice(home.length) : dir
}

function buttonListNew() {
  return { tag: 'button', text: { tag: 'plain_text', content: '查看会话' }, type: 'default', value: { a: 'sessions' } }
}
