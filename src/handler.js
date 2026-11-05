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
      k: chat.key || chat.chatId,
      rt: chat.replyTo || '',
    })
    this.t
      .sendCard(chat.chatId, card, { replyTo: chat.replyTo || null })
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
   * 一条消息的寻址上下文。
   *   key      —— 会话绑定的键。私聊就是 chat_id；群里一个话题一个键（root:<话题根消息>）
   *   chatId   —— 发消息的目标会话
   *   replyTo  —— 有值就往这个消息下面回（群里进话题），私聊为空
   */
  ctxOf(msg) {
    if (msg.chatType !== 'group') {
      return { key: msg.chatId, chatId: msg.chatId, replyTo: null }
    }
    const rootId = msg.rootId || msg.messageId
    return { key: msg.key || `root:${rootId}`, chatId: msg.chatId, replyTo: rootId }
  }

  async onMessage(msg) {
    const text = (msg.text || '').trim()
    if (!text) return
    if (this.dedupe(msg.messageId)) return
    if (!this.isAllowed(msg.userId)) {
      this.log.warn(`拒绝非白名单用户 ${msg.userId}`)
      return
    }

    const ctx = this.ctxOf(msg)
    if (text.startsWith('/')) return this.onCommand(msg, ctx)
    return this.runPrompt(msg, ctx)
  }

  /** 同时在跑的任务数 / 上限（0 = 不限） */
  runningCount() {
    let n = 0
    for (const r of this.runs.values()) if (r.state.status === 'running') n++
    return n
  }

  async runPrompt(msg, ctx) {
    let binding = this.store.get(ctx.key)
    const directory = binding?.directory || this.cfg.opencode.defaultDirectory

    // 两个闸门都必须在「建会话」之前判断：createAndBind 是会真去 opencode 里建一个会话的，
    // 先建再拒，后台就会留一串没有任何消息的空会话。
    //
    // 一个会话同时只跑一个任务。否则新 run 会覆盖旧的，旧卡片永远停在「执行中」
    const busy = binding?.sessionId ? this.runs.get(binding.sessionId) : null
    if (busy?.state?.status === 'running') {
      return this.t.sendText(ctx.chatId, '这条话题的上一条还在执行中，等它结束，或者先发 /stop 中止。', {
        replyTo: ctx.replyTo,
      })
    }

    // 话题之间可以并行，但不能无限并行：每个会话都在真跑 bash / node，开太多会打满本机
    const cap = Number(this.cfg.behavior?.maxParallel) || 0
    if (cap > 0 && this.runningCount() >= cap) {
      return this.t.sendText(
        ctx.chatId,
        `现在已经有 ${cap} 个任务在跑（上限 behavior.maxParallel=${cap}），等一个结束再发。`,
        { replyTo: ctx.replyTo },
      )
    }

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
      session = await this.createAndBind(ctx, directory)
    }

    const raw = msg.text || ''
    const promptText = raw.length > MAX_PROMPT_CHARS ? raw.slice(0, MAX_PROMPT_CHARS) : raw
    // 来源标注只拼给模型，不参与 /命令 解析，也不计入 MAX_PROMPT_CHARS
    const body = msg.origin ? `${msg.origin}\n\n${promptText}` : promptText

    const state = new RunState(session.id)
    const meta = {
      directory: session.location?.directory || directory,
      model: session.model ? `${session.model.providerID}/${session.model.id}` : '',
      title: session.title || 'opencode',
      key: ctx.key,
      rootId: ctx.replyTo,
      isGroup: Boolean(msg.isGroup),
    }
    const run = { state, cardId: null, chatId: ctx.chatId, replyTo: ctx.replyTo, timer: null, lastFlush: 0, meta }
    this.runs.set(session.id, run)

    try {
      const cardId = await this.t.sendCard(ctx.chatId, runCard(state, meta), { replyTo: ctx.replyTo })
      run.cardId = cardId
      run.lastFlush = Date.now()
    } catch (err) {
      this.log.error('发送执行卡片失败: ' + err.message)
    }

    try {
      await this.oc.prompt(session.id, body)
    } catch (err) {
      state.status = 'failed'
      state.error = { message: err.message }
      this.flushRun(session.id)
    }
  }

  // ---------- 命令 ----------

  async onCommand(msg, ctx = this.ctxOf(msg)) {
    const raw = msg.text.trim()
    const [, nameRaw, ...restParts] = raw.match(/^\/(\S+)\s*([\s\S]*)$/) || []
    const name = (nameRaw || '').toLowerCase()
    const arg = restParts.join(' ').trim()
    const to = (text) => this.t.sendText(ctx.chatId, text, { replyTo: ctx.replyTo })

    switch (name) {
      case 'help':
      case '?':
        return this.t.sendCard(ctx.chatId, helpCard(), { replyTo: ctx.replyTo })

      case 'new':
        return this.cmdNew(ctx, arg)

      case 'sessions':
      case 'ls':
        return this.cmdSessions(ctx, 0)

      case 'switch':
      case 'use':
        return this.cmdSwitch(ctx, arg)

      case 'cd':
        return this.cmdCd(ctx, arg)

      case 'status':
        return this.cmdStatus(ctx)

      case 'stop':
      case 'abort':
        return this.cmdStop(ctx)

      case 'rename':
        return this.cmdRename(ctx, arg)

      case 'del':
      case 'delete':
        return this.cmdDelete(ctx, arg)

      case 'model':
        return this.cmdModel(ctx, arg)

      case 'agent':
        return this.cmdAgent(ctx, arg)

      default:
        return to(`未知命令 /${name}，发送 /help 查看可用命令`)
    }
  }

  async cmdNew(ctx, arg) {
    const binding = this.store.get(ctx.key)
    let dir = binding?.directory || this.cfg.opencode.defaultDirectory
    if (arg) {
      const resolved = this.resolveDir(arg)
      if (!resolved) return this.t.sendText(ctx.chatId, `目录不存在: ${arg}`, { replyTo: ctx.replyTo })
      dir = resolved
    }
    const session = await this.createAndBind(ctx, dir)
    return this.t.sendCard(
      ctx.chatId,
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
        [buttonListNew(ctx)],
      ),
      { replyTo: ctx.replyTo },
    )
  }

  async cmdSessions(ctx, page) {
    const binding = this.store.get(ctx.key)
    const dir = binding?.directory || this.cfg.opencode.defaultDirectory
    let cached = this.sessionCache.get(ctx.key)
    if (!cached || cached.expires < Date.now()) {
      const all = await this.oc.listSessions({ limit: '100' })
      const filtered = all.filter((s) => (s.location?.directory || '') === dir)
      cached = { sessions: filtered, expires: Date.now() + 15_000 }
      this.sessionCache.set(ctx.key, cached)
    }
    const card = sessionsCard({
      sessions: cached.sessions,
      currentId: binding?.sessionId,
      directory: dir,
      page,
      k: ctx.key,
      rt: ctx.replyTo,
    })
    return this.t.sendCard(ctx.chatId, card, { replyTo: ctx.replyTo })
  }

  async cmdSwitch(ctx, arg) {
    if (!arg) {
      return this.t.sendText(ctx.chatId, '用法: /switch <序号|sessionId>，先用 /sessions 查看', {
        replyTo: ctx.replyTo,
      })
    }
    const binding = this.store.get(ctx.key)
    const dir = binding?.directory || this.cfg.opencode.defaultDirectory

    let targetId = arg
    if (/^\d+$/.test(arg)) {
      const cached = this.sessionCache.get(ctx.key)
      const list =
        cached?.sessions ||
        (await this.oc.listSessions({ limit: '100' })).filter((s) => (s.location?.directory || '') === dir)
      const idx = Number(arg) - 1
      if (idx < 0 || idx >= list.length) {
        return this.t.sendText(ctx.chatId, `序号超出范围（共 ${list.length} 个）`, { replyTo: ctx.replyTo })
      }
      targetId = list[idx].id
    }

    let session
    try {
      session = await this.oc.getSession(targetId)
    } catch {
      return this.t.sendText(ctx.chatId, `会话不存在: ${targetId}`, { replyTo: ctx.replyTo })
    }
    this.store.set(ctx.key, {
      sessionId: session.id,
      directory: session.location?.directory || dir,
      chatId: ctx.chatId,
      replyTo: ctx.replyTo,
    })
    return this.t.sendCard(
      ctx.chatId,
      textCard(
        '✅ 已切换会话',
        [
          `**会话** \`${session.id}\``,
          `**标题** ${session.title || '(无标题)'}`,
          `**目录** \`${shortDir(session.location?.directory)}\``,
        ].join('\n'),
        'green',
      ),
      { replyTo: ctx.replyTo },
    )
  }

  async cmdCd(ctx, arg) {
    if (!arg) {
      const b = this.store.get(ctx.key)
      return this.t.sendText(
        ctx.chatId,
        `当前工作目录: ${b?.directory || this.cfg.opencode.defaultDirectory}\n用法: /cd <绝对路径>`,
        { replyTo: ctx.replyTo },
      )
    }
    const resolved = this.resolveDir(arg)
    if (!resolved) return this.t.sendText(ctx.chatId, `目录不存在: ${arg}`, { replyTo: ctx.replyTo })
    this.store.set(ctx.key, { directory: resolved, sessionId: undefined, chatId: ctx.chatId, replyTo: ctx.replyTo })
    return this.t.sendText(
      ctx.chatId,
      `工作目录已切到 ${resolved}，会话绑定已重置，发送 /new 新建会话（或直接发消息自动创建）`,
      { replyTo: ctx.replyTo },
    )
  }

  async cmdStatus(ctx) {
    const binding = this.store.get(ctx.key)
    let session = null
    if (binding?.sessionId) {
      session = await this.oc.getSession(binding.sessionId).catch(() => null)
    }
    const health = await this.oc.health().catch((e) => ({ ok: false, error: e.message }))
    return this.t.sendCard(
      ctx.chatId,
      statusCard({
        session,
        binding,
        directory: this.lastEnv?.directory,
        server: health,
        k: ctx.key,
        rt: ctx.replyTo,
      }),
      { replyTo: ctx.replyTo },
    )
  }

  async cmdStop(ctx) {
    const binding = this.store.get(ctx.key)
    if (!binding?.sessionId) {
      return this.t.sendText(ctx.chatId, '这条话题还没有绑定会话', { replyTo: ctx.replyTo })
    }
    const ok = await this.oc.interrupt(binding.sessionId)
    return this.t.sendText(ctx.chatId, ok ? '已发送中止请求' : '中止失败（可能当前没有在执行）', {
      replyTo: ctx.replyTo,
    })
  }

  async cmdRename(ctx, arg) {
    const binding = this.store.get(ctx.key)
    if (!binding?.sessionId) {
      return this.t.sendText(ctx.chatId, '当前没有绑定会话', { replyTo: ctx.replyTo })
    }
    if (!arg) return this.t.sendText(ctx.chatId, '用法: /rename <新标题>', { replyTo: ctx.replyTo })
    const s = await this.oc.renameSession(binding.sessionId, arg)
    this.sessionCache.delete(ctx.key)
    return this.t.sendText(ctx.chatId, `已重命名为「${s?.title || arg}」`, { replyTo: ctx.replyTo })
  }

  async cmdDelete(ctx, arg) {
    const binding = this.store.get(ctx.key)
    const dir = binding?.directory || this.cfg.opencode.defaultDirectory
    if (!arg) return this.t.sendText(ctx.chatId, '用法: /del <序号>，先用 /sessions 查看', { replyTo: ctx.replyTo })
    const cached = this.sessionCache.get(ctx.key)
    const list =
      cached?.sessions ||
      (await this.oc.listSessions({ limit: '100' })).filter((s) => (s.location?.directory || '') === dir)
    let targetId = arg
    if (/^\d+$/.test(arg)) {
      const idx = Number(arg) - 1
      if (idx < 0 || idx >= list.length) {
        return this.t.sendText(ctx.chatId, `序号超出范围（共 ${list.length} 个）`, { replyTo: ctx.replyTo })
      }
      targetId = list[idx].id
    }
    await this.oc.deleteSession(targetId)
    this.sessionCache.delete(ctx.key)
    if (binding?.sessionId === targetId) this.store.clearSession(ctx.key)
    return this.t.sendText(ctx.chatId, `已删除会话 ${targetId}`, { replyTo: ctx.replyTo })
  }

  async cmdModel(ctx, arg) {
    const binding = this.store.get(ctx.key)
    if (!binding?.sessionId) {
      return this.t.sendText(ctx.chatId, '当前没有绑定会话，先 /new', { replyTo: ctx.replyTo })
    }
    let cache = this.modelCache.get(ctx.key)
    if (!cache || cache.expires < Date.now()) {
      const models = await this.oc.listModels()
      cache = { models, expires: Date.now() + 5 * 60_000 }
      this.modelCache.set(ctx.key, cache)
    }
    if (!arg) {
      // 只列中国大陆区能用的那批更实用：全部列出但截断为 60 条
      const lines = cache.models.slice(0, 60).map((m, i) => `${i + 1}. \`${m.providerID}/${m.id}\` ${m.name || ''}`)
      return this.t.sendCard(
        ctx.chatId,
        textCard('🧠 模型列表', lines.join('\n') + '\n\n用 `/model <序号>` 切换', 'purple'),
        { replyTo: ctx.replyTo },
      )
    }
    const idx = Number(arg)
    const target =
      Number.isFinite(idx) && idx > 0 ? cache.models[idx - 1] : cache.models.find((m) => m.id === arg)
    if (!target) return this.t.sendText(ctx.chatId, `找不到模型: ${arg}`, { replyTo: ctx.replyTo })
    await this.oc.switchModel(binding.sessionId, { id: target.id, providerID: target.providerID })
    return this.t.sendText(ctx.chatId, `已切换到 ${target.providerID}/${target.id}`, { replyTo: ctx.replyTo })
  }

  async cmdAgent(ctx, arg) {
    const binding = this.store.get(ctx.key)
    if (!binding?.sessionId) {
      return this.t.sendText(ctx.chatId, '当前没有绑定会话，先 /new', { replyTo: ctx.replyTo })
    }
    const agents = await this.oc.listAgents()
    if (!arg) {
      const lines = agents.map((a, i) => `${i + 1}. \`${a.id}\` ${a.description || ''}`)
      return this.t.sendCard(
        ctx.chatId,
        textCard('🧩 Agent 列表', lines.join('\n') + '\n\n用 `/agent <名字>` 切换', 'violet'),
        { replyTo: ctx.replyTo },
      )
    }
    const idx = Number(arg)
    const target = Number.isFinite(idx) && idx > 0 ? agents[idx - 1] : agents.find((a) => a.id === arg)
    if (!target) return this.t.sendText(ctx.chatId, `找不到 agent: ${arg}`, { replyTo: ctx.replyTo })
    await this.oc.switchAgent(binding.sessionId, target.id)
    this.store.set(ctx.key, { agent: target.id, chatId: ctx.chatId, replyTo: ctx.replyTo })
    return this.t.sendText(ctx.chatId, `已切换到 agent ${target.id}`, { replyTo: ctx.replyTo })
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

    // 绑定键从按钮 value 里带过来（cards.js 的 nav）；
    // 老卡片没带 k 的，按卡片 message_id 反查属于哪个 run，再不行退回 chatId（私聊老行为）
    const key = a.k || this.keyForCard(messageId) || chatId
    const replyTo = a.rt || null
    const ctx = { key, chatId, replyTo }

    // 新发一条消息承载结果，历史保持不变
    const replyNew = (toast, card) => {
      if (card) {
        setTimeout(() => {
          this.t
            .sendCard(chatId, card, { replyTo })
            .catch((e) => this.log.warn?.(`回调后发卡片失败: ${e.message}`))
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
          const b = this.store.get(key)
          const dir = b?.directory || this.cfg.opencode.defaultDirectory
          const s = await this.createAndBind(ctx, dir)
          return replyNew(
            { type: 'success', content: '已新建会话' },
            textCard('🆕 新会话已绑定', `**会话** \`${s.id}\`\n**目录** \`${shortDir(dir)}\`\n\n直接发消息开始。`, 'green'),
          )
        }
        case 'sessions': {
          const b = this.store.get(key)
          const dir = b?.directory || this.cfg.opencode.defaultDirectory
          const all = await this.oc.listSessions({ limit: '100' })
          const filtered = all.filter((s) => (s.location?.directory || '') === dir)
          this.sessionCache.set(key, { sessions: filtered, expires: Date.now() + 15_000 })
          const card = sessionsCard({
            sessions: filtered,
            currentId: b?.sessionId,
            directory: dir,
            page: a.p || 0,
            k: key,
            rt: replyTo || '',
          })
          const toast = { type: 'success', content: `共 ${filtered.length} 个会话` }
          // 翻页（带 p）就地更新列表自己；首次点击新发一条
          return 'p' in a ? replySelf(toast, card) : replyNew(toast, card)
        }
        case 'switch': {
          if (!a.s) return { toast: { type: 'error', content: '缺少会话 ID，请重新打开 /sessions' } }
          const session = await this.oc.getSession(a.s)
          this.store.set(key, {
            sessionId: session.id,
            directory: session.location?.directory,
            chatId,
            replyTo,
          })
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

  async createAndBind(ctx, directory) {
    const model = this.cfg.opencode.defaultModel
    let modelRef
    if (model) {
      const [providerID, ...idParts] = model.split('/')
      if (providerID && idParts.length) modelRef = { providerID, id: idParts.join('/') }
    }
    const title = `飞书 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`
    const session = await this.oc.createSession({ title, directory, model: modelRef })
    this.store.set(ctx.key, {
      sessionId: session.id,
      directory,
      chatId: ctx.chatId,
      replyTo: ctx.replyTo,
    })
    this.sessionCache.delete(ctx.key)
    return session
  }

  /** 老卡片没带绑定键时，按卡片 message_id 找回它是哪个 run 的 */
  keyForCard(messageId) {
    if (!messageId) return null
    for (const run of this.runs.values()) {
      if (run.cardId === messageId && run.meta?.key) return run.meta.key
    }
    return null
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

function buttonListNew(ctx) {
  const value = { a: 'sessions' }
  if (ctx?.key) value.k = ctx.key
  if (ctx?.replyTo) value.rt = ctx.replyTo
  return { tag: 'button', text: { tag: 'plain_text', content: '查看会话' }, type: 'default', value }
}
