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
  queuedCard,
  queuedSentCard,
  queuedDroppedCard,
} from './cards.js'
import { truncate } from './render.js'

const MAX_PROMPT_CHARS = 20000

/** 本地时区的 YYYYMMDD，用于会话默认名 */
export function dayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

export class Bridge {
  /**
   * @param {object} opts
   * @param {import('./oc.js').OpencodeClient} opts.oc
   * @param {import('./store.js').Store} opts.store
   * @param {object} opts.config
   * @param {object} opts.transport  sendCard/patchCard/sendText
   */
  constructor({ oc, store, config, transport, capabilities = {}, logger = console }) {
    // oc 只是历史变量名：现在是 createBackend() 给的后端，可能是 opencode，
    // 也可能是一次性子进程（pi）。两者实现同一组方法 + 同形状的 SSE 事件。
    this.oc = oc
    this.store = store
    this.cfg = config
    this.t = transport
    this.caps = capabilities
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
        const label = this.caps.label || 'opencode'
        if (s.connected) this.log.info(`${label} 后端已就绪`)
        else this.log.warn(`${label} 事件通道断开: ${s.reason || ''}`)
      },
    )
    // 看门狗：事件流静默太久就判定卡死，否则卡片会永远停在「执行中」。——
    // 只对 opencode 有意义。它的事件来自 SSE 流，流断了就不会再有事件，而运行
    // 可能还挂着；实测一次模型流 7 秒后断掉，卡片在「执行中」挂了 16 分钟。
    //
    // pi 后端不适用：pi 的事件从子进程 stdout 逐行解析，跑 npm install 这类
    // 「一直刷进度但产不出 JSON 事件」的命令时，stdout 在流动、事件却长时间
    // 没有——按事件静默判定卡死会误杀健康的运行。pi 的卡死由
    // backend.pi.timeoutMs 按 stdout 静默判定（见 src/pi.js 的 bump），而且
    // 它触发时会真的杀进程；看门狗只翻新卡片不碰进程，会留下「卡片显示失败、
    // 进程还在跑」的误导状态。两层对 pi 是重复且有害的，所以这里直接跳过。
    //
    // 扫描间隔跟着阈值缩：固定 60 秒的话，120 秒阈值的最坏检测延迟是 180 秒
    // （错过一次扫描就得多等一个周期）。取阈值的 1/4，最短 15 秒。
    // 扫描本身对两个后端都要常开——即使 idleMs 为 0（关了静默判定），checkIdle
    // 里的「终态卡片 patch 卡死」安全网仍然要跑，否则 pi 会丢掉那层保护
    const idleMs = this.watchdogIdleMs()
    const tick = idleMs > 0 ? Math.min(60_000, Math.max(15_000, Math.floor(idleMs / 4))) : 60_000
    this.watchdog = setInterval(() => this.checkIdle(idleMs), tick)
    this.watchdog.unref?.()

    // 上一个进程可能死在半路，飞书上留着没收尾的卡片，先统一标注掉
    await this.reconcileInflight()
  }

  /**
   * 把上次进程遗留的「执行中」卡片标成已中断。
   *
   * run 状态只活在内存里，进程一换就没了，但飞书上那张卡片还在，会永远停在
   * 「正在等待模型响应… 耗时 8s」。启动时拿 state.json 里的 inflight 记录补一刀。
   * 失败不影响启动 —— 卡片大不了继续僵尸，不能因为一条旧卡片起不来服务。
   */
  async reconcileInflight() {
    const list = this.store.inflightList?.() || []
    for (const it of list) {
      if (it.cardId) {
        const st = new RunState(it.sessionId)
        st.status = 'aborted'
        st.startedAt = it.startedAt || Date.now()
        st.updatedAt = Date.now()
        st.text =
          '这次执行被中断了：桥接进程在它跑完之前退出过（改代码重启 `npm run up` 也会）。\n\n' +
          '需要的话把刚才那句重发一次。'
        try {
          await this.t.patchCard(
            it.cardId,
            runCard(st, {
              directory: it.directory,
              model: it.model,
              title: it.title,
              key: it.key,
              rootId: it.replyTo,
              isGroup: it.isGroup,
            }),
          )
          this.log.info(`已把上次遗留的执行卡片标为中断: ${it.cardId}`)
        } catch (err) {
          this.log.warn?.(`收尾遗留卡片失败 ${it.cardId}: ${err.message}`)
        }
      }
      this.store.clearInflight?.(it.sessionId)
    }
    // 重启后没有任何「运行中」的任务，收尾事件不会再来：队列里躺的消息
    // 在这里补一次排空，与卡片上「当前任务结束后自动发送」的承诺一致
    for (const qk of Object.keys(this.store.data?.queue || {})) {
      if (this.store.queueLength(qk) > 0) this.scheduleDrainIfIdle(qk)
    }
  }

  /**
   * 看门狗的「事件静默」阈值（毫秒）。pi 后端返回 0 = 不按事件静默判定。
   *
   * 抽成方法是为了能直接断言这个分流：pi 的事件从子进程 stdout 逐行解析，
   * 「stdout 在刷但产不出 JSON 事件」的命令（npm install、长 bash）会让事件
   * 长时间没有而进程完全健康，按事件静默判定就是误杀。详见 start() 里的注释。
   */
  watchdogIdleMs() {
    return this.caps.type === 'opencode' ? Number(this.cfg.behavior.idleTimeoutMs) || 0 : 0
  }

  /**
   * 看门狗的扫描体，两个独立职责：
   *   1. 事件静默判定卡死——只对 opencode 生效（idleMs > 0 时）。pi 跳过，
   *      理由见 start() 里那段注释：它会把「stdout 在刷但没事件」的健康运行
   *      误判成卡死
   *   2. 终态卡片 patch 卡死的安全网——两个后端都要
   */
  checkIdle(idleMs) {
    const now = Date.now()
    if (idleMs > 0) {
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
    // 安全网：终态已到但终态 patch 始终没完成（飞书 SDK 请求挂死过），
    // runs 表项和 inflight 记录会永远堆着。超过 2 分钟直接收殓状态——
    // 卡片可能停在旧样子，但桥接的状态是干净的，重启也能 reconcile
    const WEDGE_MS = 2 * 60_000
    for (const [sid, run] of this.runs) {
      if (run.flushed) continue
      if (!['done', 'failed', 'aborted'].includes(run.state.status)) continue
      const since = run.terminalAt || run.state.updatedAt || run.state.startedAt
      if (now - since < WEDGE_MS) continue
      this.log.warn(`会话 ${sid} 终态卡片更新疑似卡死（${Math.round((now - since) / 1000)}s 未完成），强制收殓状态`)
      run.flushed = true
      this.store.clearInflight?.(sid)
      this.runs.delete(sid)
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

    // 一次性后端只有跑完才知道真实模型（pi 写在 message_end 里），
    // 用它补上卡片前缀；opencode 后端不发这个事件，无副作用。
    if (ev.type === 'backend.meta' && ev.data?.model) {
      const run = this.runs.get(sid)
      if (run) run.meta.model = ev.data.model
      return
    }

    // 权限请求：立即推卡片，不等事件聚合
    if (ev.type?.startsWith('session.permission.')) {
      this.onPermissionEvent(ev)
      return
    }

    const run = this.runs.get(sid)
    if (!run) return

    // 兜底：任何带 error/failed 又不是工具级的事件，都把运行态翻成失败，
    // 并原地把「执行中」卡片转成报错卡片（不新发消息）。opencode 各版本
    // 对模型提供商报错抛出的事件名和载荷形状不一致——实测遇到过卡片停在
    // 「执行中」、直到 15 分钟看门狗超时才收尾，用户根本不知道任务已经
    // 断了。这里不依赖具体事件名：类型里带 error/failed，或载荷里带
    // error 字段，都算。工具级错误只标记那个工具，不终结整个 run
    const type = String(ev.type || '')
    const isToolEvent = /tool/i.test(type)
    const payloadError = isToolEvent ? null : ev.data?.error
    if (run.state.status === 'running' && (payloadError || (!isToolEvent && /error|failed/i.test(type)))) {
      const message =
        payloadError?.message || ev.data?.message || `执行失败（${type || '未知事件'}）`
      // 提供商拒输入多数是上下文过长，卡片上直接给续命办法
      const hint = /invalid|input/i.test(message + type)
        ? '（上下文可能过长：发 /new 开新会话续上）'
        : ''
      run.state.status = 'failed'
      run.state.error = { message: message + hint }
      run.state.updatedAt = Date.now()
      this.log.warn?.(`会话 ${sid} 事件 ${type} 判定失败: ${message}`)
      this.flushRun(sid)
      return
    }

    if (!run.state.apply(ev)) return

    const terminal = ['done', 'failed', 'aborted'].includes(run.state.status)
    if (terminal) {
      // 结束态立即刷新，并且关闭节流定时器
      if (run.timer) {
        clearTimeout(run.timer)
        run.timer = null
      }
      if (!run.terminalAt) run.terminalAt = Date.now()
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

  /**
   * 刷新卡片。同一张卡的多次更新串行发出。
   *
   * 为什么必须串行：终态事件和最后一条文本事件常常在同一时刻到达——pi 后端的
   * finish() 就连发 text.delta / usage / backend.meta / succeeded 四个事件，每个都
   * 触发一次立即刷新。旧实现每次都直接发起一次 patch，两个请求同时在途，飞书侧
   * 的生效顺序没有保证。真实事故：任务早已完成，「已完成」快照先到、「执行中」
   * 快照后到，卡片永远停在「⏳ 执行中」，正文却是完整答案，用户完全看不出任务
   * 已经结束。串行之后终态一定最后生效。
   *
   * 在途期间到达的刷新只标记 patchDue，由在途那次收尾时带上最新快照再发一次：
   * 同一时刻积压的多次刷新合并成一次 patch，飞书侧 QPS 压力也小一个量级。
   */
  flushRun(sid) {
    const run = this.runs.get(sid)
    if (!run?.cardId) return
    run.patchDue = true
    // 有一次 patch 在途：交给它收尾时一起发，这里只记状态
    if (run.patching) return
    run.patching = true
    this._drainPatch(sid)
  }

  /** 把在途 patch 之后积压的状态全部发完。快照在发送时构建，永远是最新的 */
  async _drainPatch(sid) {
    try {
      let run = this.runs.get(sid)
      while (run?.cardId && run.patchDue) {
        run.patchDue = false
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
        if (['done', 'failed', 'aborted'].includes(run.state.status)) this._finalizeRun(sid, run)
        // 终态收尾会把 run 排进 60 秒后删除，这里按 id 重新取，删了就不再发
        run = this.runs.get(sid)
      }
    } finally {
      const cur = this.runs.get(sid)
      if (!cur) return
      cur.patching = false
      // 等待在途 patch 的过程中又来了新状态：接着发
      if (cur.patchDue) this.flushRun(sid)
    }
  }

  /** 终态卡片已经发过：抹掉 inflight、排进清理、把忙等队列排空 */
  _finalizeRun(sid, run) {
    if (run.flushed) return
    run.flushed = true
    // 卡片已经收尾，把「还有人在跑」的记录抹掉，重启时就不会误标成已中断
    this.store.clearInflight?.(sid)
    // 结束后再保留一小段时间便于清理。**只删还是同一个 run 对象的情况**：
    // 同一个会话 60 秒内完全可能又起一个新 run（用户连着发两句，前一句跑得
    // 快），新 run 的 this.runs.set 会覆盖旧条目，而这个定时器只认 sid——
    // 无条件删会把新 run 的对象删掉，它的终态事件随后被 onEvent 的
    // 「找不到 run 就丢弃」全部吃掉，卡片永远停在「执行中」。真实事故：
    // 22:12:19 排的定时器在 22:13:19 删掉了 22:13:10 才开始的 run，那张卡
    // 至今停在「执行中 · 耗时 7s · 正在等待模型响应…」，而答案早就产出了
    setTimeout(() => {
      if (this.runs.get(sid) === run) this.runs.delete(sid)
    }, 60_000)
    // 忙等时排队或插队的消息，到这里接着发。等 1.5 秒让卡片落定、
    // 迟到的 abort 事件过去，避免两条消息挤在同一张卡片上
    const qk = run.meta?.key
    if (qk && (this.store.queueLength?.(qk) || 0) > 0) {
      setTimeout(() => this.drainQueue(qk), 1500)
    }
  }

  /**
   * 把排队/插队的下一条发出去。当前任务收尾后由 flushRun 触发，
   * 「中止当前改发这条」的 interrupt 收尾时也会走到这里。
   */
  async drainQueue(key) {
    const cap = Number(this.cfg.behavior?.maxParallel) || 0
    if (cap > 0 && this.runningCount() >= cap) {
      // 撞并发上限：消息还压在队首（没出队），稍后重试。已经出队再被拒
      // 会把内容丢掉。定时器 unref，不拖住事件循环
      const head = this.store.data?.queue?.[key]?.[0]
      if (head) {
        const t = setTimeout(() => this.drainQueue(key), 10_000)
        t.unref?.()
      }
      return
    }
    const msg = this.store.dequeue(key)
    if (!msg) return
    // 翻新排队卡片：它还挂着「已加入队列」和两个按钮，而消息已经发出去了
    this.refreshQueuedCard(msg, queuedSentCard)
    const ctx = { key, chatId: msg.chatId, replyTo: msg.replyTo || null }
    try {
      await this.runPrompt(msg, ctx)
    } catch (err) {
      this.log.error?.(`排队消息发送失败: ${err.message}`)
      this.t
        .sendText(ctx.chatId, `排队的内容发送失败: ${err.message}`, { replyTo: ctx.replyTo })
        ?.catch?.(() => { })
    }
  }

  /**
   * 该 key 没有运行中的任务时，补一次排空。
   * 用户可能盯着卡片看半分钟才点「加入队列」——那时任务早已收尾，收尾
   * 事件不会再来，不补这一下消息就要躺到下一次任务结束。重启后的
   * reconcile 也走这里。
   */
  scheduleDrainIfIdle(key, delay = 1500) {
    const binding = this.store.get(key)
    const running = binding?.sessionId
      ? this.runs.get(binding.sessionId)?.state?.status === 'running'
      : false
    if (running) return
    const t = setTimeout(() => this.drainQueue(key), delay)
    t.unref?.()
  }

  /**
   * 翻新一张排队卡片。卡片旧着不影响消息本身发出去，所以失败只记日志。
   *
   * 没有 cardId 的条目（改动之前入的队、重启前留下的）跳过——那些卡只能
   * 靠人工忽略，或者下次任务结束时由 reconcile 兜底
   */
  refreshQueuedCard(item, build) {
    if (!item?.cardId) return
    const card = build({
      preview: item.text,
      from: this.nameOf(item.userId) || item.userId,
    })
    this.t
      .patchCard(item.cardId, card)
      .catch((e) => this.log.warn?.(`排队卡片翻新失败: ${e.message}`))
  }

  // ---------- 消息入口 ----------

  /**
   * 放行闸门。两个名单的并集，都来自配置（启动时读一次，人在 admin 里维护）：
   *
   *   feishu.allowlist —— 手写的例外清单，人类也走这里；
   *   feishu.listen    —— 单向放行名单。语义是「它的 @ 能到达我」：A 的
   *                       listen 里有 B，则 B 的 @ 能唤醒 A；A 的 @ 能不能
   *                       唤醒 B，看 B 自己的配置。
   *
   * 两个名单都是人手动维护的。open_id 按应用隔离，抄错了不会报错、只会静默
   * 失效（日志里记「拒绝非白名单用户 xxx」），所以加完之后要在日志里确认
   * 一次。@ 判定（requireMention）在更前面，所以放行的是「它的 @ 消息」，
   * 不是它的任何消息。
   */
  isAllowed(userId) {
    const allow = this.cfg.feishu.allowlist || []
    const listen = this.cfg.feishu.listen || []
    if (!allow.length && !listen.length) return true
    return allow.includes(userId) || listen.includes(userId)
  }

  /**
   * open_id -> 显示名。唯一来源是配置里的 feishu.names（人工声明）。
   *
   * 之所以只有这一条路，是因为飞书没有「open_id 反查名字」的接口 ——
   * contact 接口对机器人 open_id 直接返回 41050 no user authority。以前还
   * 从「被 @ 攒下的通讯录」里找，那份缓存已下线：攒得越多越像一份查不到
   * 重点的档案，而放行名单本来就要人手工维护，顺手把名字一起声明了。
   */
  nameOf(openId) {
    if (!openId) return ''
    return this.cfg.feishu?.names?.[openId] || ''
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
    // 命令分流用 cmdText（feishu.js 剥掉开头 @ 的版本），不用 text：
    // @ 占位符全部还原之后，群里「@Lil_P /help」的 text 不再以 / 开头，
    // 拿 text 判定会把命令当普通消息发给模型。老调用方没有 cmdText 时
    // 退回 text，行为与改动前一致
    const cmd = (msg.cmdText ?? msg.text ?? '').trim()
    if (cmd.startsWith('/')) return this.onCommand({ ...msg, text: cmd }, ctx)
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
      // 加塞的消息默认按 follow-up 处理：直接排进队列，不用用户点任何按钮。
      // 回一张卡片告诉用户排在第几位，附两个改主意的按钮——中止当前改发这条
      // （提到队首并中止）、取消（从队列摘掉）。队列在任务收尾后自动排空
      const item = {
        text: msg.text,
        userId: msg.userId,
        messageId: msg.messageId,
        origin: msg.origin,
        oncePrefix: msg.oncePrefix,
        isGroup: msg.isGroup,
        chatId: ctx.chatId,
        replyTo: ctx.replyTo,
      }
      // qid 是这条排队消息的身份证：卡片上的两个按钮只对得上同一条
      const qid = this.store.qidOf(item)
      const position = this.store.enqueue(ctx.key, { ...item, qid })
      const cardId = await this.t.sendCard(
        ctx.chatId,
        queuedCard({
          preview: msg.text,
          from: this.nameOf(msg.userId) || msg.userId,
          qid,
          position,
          k: ctx.key,
          rt: ctx.replyTo,
        }),
        { replyTo: ctx.replyTo },
      )
      // 记住这张卡的 ID：消息出队或取消时要翻新它，不然它会一直挂着
      // 「已加入队列」和两个点不动的按钮，而消息早就处理完了
      this.store.setQueuedCard(ctx.key, qid, cardId)
      return cardId
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
    let isNewSession = false
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
      isNewSession = true
    }

    const raw = msg.text || ''
    const promptText = raw.length > MAX_PROMPT_CHARS ? raw.slice(0, MAX_PROMPT_CHARS) : raw
    // 前缀分两路，只拼给模型，不参与 /命令 解析，也不计入 MAX_PROMPT_CHARS：
    //   origin      每条消息都带（来源标注 + 身份声明 + 配置里 always 的前缀）
    //   oncePrefix  只在该会话的第一条消息带（配置里 once 的前缀，默认是协作
    //               规则）。规则是静态的，第一条带过之后就在会话历史里，后续
    //               消息靠上下文记住——每轮重复只是白烧 token
    const preamble = [msg.origin, isNewSession ? msg.oncePrefix : ''].filter(Boolean).join('\n')
    const body = preamble ? `${preamble}\n\n${promptText}` : promptText

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
      // 卡片一发出去就落盘：进程要是这时候被杀，下次启动才知道该收尾哪张卡
      this.store.setInflight?.(session.id, {
        cardId,
        chatId: ctx.chatId,
        replyTo: ctx.replyTo,
        key: ctx.key,
        directory: meta.directory,
        model: meta.model,
        title: meta.title,
        isGroup: meta.isGroup,
        startedAt: state.startedAt,
      })
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
        return this.t.sendCard(ctx.chatId, helpCard(this.caps), { replyTo: ctx.replyTo })

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
      // force：人类刚在终端 pi 里建的会话也要马上看到，不吃扫描缓存
      const all = await this.oc.listSessions({ limit: '100', force: true })
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
        backendLabel: this.caps.label || 'opencode',
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
    // 终端 pi 的会话改不了名（标题写在 jsonl 里，由 pi 维护），抛错时回一句
    // 清楚的说明，别让异常冒泡到事件循环里没了下文
    let s
    try {
      s = await this.oc.renameSession(binding.sessionId, arg)
    } catch (err) {
      return this.t.sendText(ctx.chatId, `重命名失败: ${err.message}`, { replyTo: ctx.replyTo })
    }
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
    // 终端 pi 的会话不在桥接目录里，删它等于删人类自己的一份数据，明确拒绝
    try {
      await this.oc.deleteSession(targetId)
    } catch (err) {
      return this.t.sendText(ctx.chatId, `删除失败: ${err.message}`, { replyTo: ctx.replyTo })
    }
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
    // 终端 pi 的会话切不了模型（model_change 行由 pi 维护），switchModel 会抛错，
    // 这里接住回成一句人能看懂的话，别让异常冒泡到事件循环里没了下文
    try {
      await this.oc.switchModel(binding.sessionId, { id: target.id, providerID: target.providerID })
    } catch (err) {
      return this.t.sendText(ctx.chatId, `切换失败: ${err.message}`, { replyTo: ctx.replyTo })
    }
    return this.t.sendText(ctx.chatId, `已切换到 ${target.providerID}/${target.id}`, { replyTo: ctx.replyTo })
  }

  async cmdAgent(ctx, arg) {
    if (this.caps.agents === false) {
      return this.t.sendText(
        ctx.chatId,
        `${this.caps.label} 后端没有 opencode 的 agent 概念。要换模型用 /model，要改行为改 backend 配置。`,
        { replyTo: ctx.replyTo },
      )
    }
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
          // force：翻页也重扫终端目录，人类新建的会话不用等缓存过期
          const all = await this.oc.listSessions({ limit: '100', force: true })
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
          const stopped = await this.oc.interrupt(a.s)
          /**
           * 不能只发中断就完事。
           *
           * 以前这里只 `await interrupt` + 一个 toast，卡片靠 opencode 回吐的
           * abort 事件来更新。但会话已经结束、或桥接重启过之后，那个事件永远
           * 不会来了 —— 用户点了「中止」，toast 说成功，卡片上却还写着「正在
           * 等待模型响应…」，完全没法判断到底停没停。所以这里自己动手改卡片。
           */
          const run = this.runs.get(a.s)
          if (run) {
            run.state.status = 'aborted'
            run.state.updatedAt = Date.now()
            this.flushRun(a.s)
            return { toast: { type: 'success', content: '已中止' } }
          }
          if (messageId) {
            // 内存里已经没有这个 run 了，说明是上个进程留下的僵尸卡片
            const st = new RunState(a.s || 'ses_unknown')
            st.status = 'aborted'
            st.startedAt = Date.now()
            st.updatedAt = Date.now()
            st.text =
              '这条执行已经中断了（桥接进程重启过，或它早就结束了），没有正在跑的任务。\n\n' +
              '重新发一句就能开新的。'
            const binding = this.store.get(key)
            await this.t
              .patchCard(
                messageId,
                runCard(st, {
                  directory: binding?.directory,
                  title: '飞书',
                  key,
                  rootId: replyTo,
                  isGroup: Boolean(replyTo),
                }),
              )
              .catch((e) => this.log.warn?.(`中止后更新卡片失败: ${e.message}`))
            return { toast: { type: 'info', content: stopped ? '已中止' : '这条早就不在跑了' } }
          }
          return { toast: { type: 'success', content: '已中止' } }
        }
        case 'perm': {
          if (this.caps.permissions === false) {
            return { toast: { type: 'info', content: `${this.caps.label} 后端没有交互式授权` } }
          }
          await this.oc.replyPermission(a.s, a.r, a.d)
          const label = a.d === 'reject' ? '已拒绝' : a.d === 'always' ? '已允许（永久）' : '已允许一次'
          return replyNew({ type: 'success', content: label }, textCard('🔐 授权已处理', label, a.d === 'reject' ? 'red' : 'green'))
        }
        case 'steer': {
          // 加塞的消息默认已排队，这里是改主意：把它提到队首并中止当前任务。
          // 按 qid 找，找不到说明它已经发出去（或被取消了），按钮点不动
          const p = this.store.promoteQueued(key, a.q)
          if (!p) return { toast: { type: 'error', content: '这条消息不在队列里（可能已经发出或被取消）' } }
          // 插到队首并中止当前任务：abort 事件收尾时 drainQueue 会把它发出去
          const binding = this.store.get(key)
          const stopped = binding?.sessionId ? await this.oc.interrupt(binding.sessionId) : false
          // 当前任务已经不在了（刚点过 /stop、或已结束）：没有 abort 事件会来，
          // 补一次排空
          this.scheduleDrainIfIdle(key)
          return replyNew(
            { type: 'success', content: stopped ? '已中止当前任务' : '当前任务已结束' },
            textCard(
              '🛑 中止当前任务',
              [
                `**改发** ${truncate(p.text, 120)}`,
                '',
                '当前任务已中止，这条消息接着发送。',
              ].join('\n'),
              'red',
            ),
          )
        }
        case 'drop': {
          // 取消 = 把这条已排队的消息从队列里摘掉。摘不到说明它已经发出去了
          const p = this.store.removeQueued(key, a.q)
          if (!p) return { toast: { type: 'error', content: '这条消息不在队列里（可能已经发出）' } }
          // 翻新那张「已加入队列」：消息已经取消，按钮也该撤掉
          this.refreshQueuedCard(p, queuedDroppedCard)
          return { toast: { type: 'info', content: '已取消，消息没有发送' } }
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
    const model = this.cfg.opencode.defaultModel || this.cfg.backend?.pi?.model || ''
    let modelRef
    if (model) {
      const [providerID, ...idParts] = model.split('/')
      if (providerID && idParts.length) modelRef = { providerID, id: idParts.join('/') }
    }
    // 会话默认名：飞书·YYYYMMDD·新建会话n。n 按天从 1 开始，只增不减——
    // 删会话、改会话名都不回收序号（按现存同名会话数推会把发过的号再发
    // 出去，与历史重名），计数器在 store 里落盘，见 Store.nextSessionSeq。
    // 先同步占号再发起创建：两个话题同时新建不会撞号；后端创建失败会跳过
    // 一个号，跳号无害
    const day = dayStamp()
    const title = `飞书·${day}·新建会话${this.store.nextSessionSeq(day)}`
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
