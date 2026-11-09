import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { STATE_PATH } from './config.js'

const VERSION = 1

/**
 * chat_id -> { sessionId, directory, model, agent, updatedAt }
 * 这是桥接唯一的真相来源：飞书侧会话绑定完全由这里决定，
 * 不依赖 opencode 的 TUI 状态（v2 的 /api/session/active 只反映界面选中项）。
 */
export class Store {
  constructor(path = STATE_PATH) {
    this.path = path
    this.data = { version: VERSION, chats: {} }
    this.timer = null
    this.dirty = false
    this.load()
  }

  load() {
    // 建 this.path 自己的目录，不是全局 CONFIG_DIR：测试和多实例都会传自定义路径，
    // 用全局目录会在 path 落在别处时写不进去（ENOENT）。
    mkdirSync(dirname(this.path), { recursive: true })
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      if (raw && raw.version === VERSION && raw.chats) this.data = raw
    } catch {
      // 文件损坏就从空状态开始，不阻塞启动
      this.data = { version: VERSION, chats: {} }
    }
    this.migrateLegacy()
  }

  /**
   * 清掉两批已废弃的字段：
   *
   *   names    —— 旧版平铺的 { open_id: 名字 }，只在 state.json 里缓存名字；
   *   contacts —— 一度自动攒的「认识层」通讯录。
   *
   * 通讯录已下线：自动攒出来的 open_id 用不上（放行名单是人手写的），
   * 攒得越多越像一份查不到重点的档案。名字现在只有一个来源——配置里的
   * feishu.names，人手声明。这里负责把存量数据清掉，不留半套字段。
   */
  migrateLegacy() {
    let changed = false
    if (this.data.names && typeof this.data.names === 'object') {
      delete this.data.names
      changed = true
    }
    if (this.data.contacts && typeof this.data.contacts === 'object') {
      delete this.data.contacts
      changed = true
    }
    if (changed) this.scheduleSave()
  }

  get(chatId) {
    return this.data.chats[chatId] || null
  }

  set(key, patch) {
    const prev = this.data.chats[key] || { key }
    // chatId 是「发消息的目标会话」，key 是「哪个话题/哪个私聊」的绑定键。
    // 私聊两者相同；群里 key 是 root:<话题根消息>，chatId 仍是群 id。
    const chatId = patch.chatId || prev.chatId || key
    this.data.chats[key] = { ...prev, ...patch, key, chatId, updatedAt: Date.now() }
    this.scheduleSave()
    return this.data.chats[key]
  }

  clearSession(key) {
    const cur = this.data.chats[key]
    if (!cur) return
    this.data.chats[key] = { ...cur, sessionId: undefined, updatedAt: Date.now() }
    this.scheduleSave()
  }

  /**
   * 新建会话的按天序号，只增不减。
   *
   * 为什么需要计数器：会话默认名是「飞书·YYYYMMDD·新建会话n」，n 若按现存
   * 同名会话数推，删掉一个会话、或把一个会话改名为别的，下一个就会发回已
   * 用过的号，新名字与历史重名。计数器与后端会话无联动，删会话、改会话名
   * 都碰不到它；落盘后重启不丢。
   *
   * 同步占号：调用方拿到号才去建会话，两个话题同时新建不会撞同一个 n。
   * 后端创建失败会跳过一个号——跳号无害，重号有害。
   *
   * 占号后立即 flush 而不走防抖：号发出去了会话却还没建成，这中间进程被杀
   * 的话，重启会把同一个号再发一次，撞上已建成的同名会话。
   */
  nextSessionSeq(day) {
    const cur = this.data.sessionSeq
    const n = cur && cur.day === day ? cur.n + 1 : 1
    this.data.sessionSeq = { day, n }
    this.dirty = true
    this.flush()
    return n
  }

  all() {
    return Object.values(this.data.chats)
  }

  /**
   * 正在跑的卡片。只存「还没收尾」的那几条。
   *
   * 为什么不存整个 run：run 里的状态每 1.8 秒变一次，落盘没意义；真正会丢的
   * 是「飞书上还有一张卡片没人管」这件事。进程重启后拿它把卡片标成已中断，
   * 否则卡片会永远停在「正在等待模型响应… 耗时 8s」。
   */
  setInflight(sessionId, info) {
    if (!sessionId || !info?.cardId) return
    const m = this.data.inflight || (this.data.inflight = {})
    m[sessionId] = { ...info, startedAt: info.startedAt || Date.now() }
    this.scheduleSave()
  }

  clearInflight(sessionId) {
    const m = this.data.inflight
    if (!m || !m[sessionId]) return
    delete m[sessionId]
    this.scheduleSave()
  }

  inflightList() {
    return Object.entries(this.data.inflight || {}).map(([sessionId, v]) => ({ sessionId, ...v }))
  }

  /** 找出所有绑定了某个 session 的 chat，用于事件回推 */
  chatsBySession(sessionId) {
    return this.all().filter((c) => c.sessionId === sessionId)
  }

  // ---------- 忙等挡下的消息 ----------
  //
  // 上一条任务还在跑时新消息不会被丢弃：直接排进 queue（follow-up 是默认
  // 动作，不用用户点），同时回一张卡片告诉用户排在第几位，带两个按钮——
  // 「引导」把它提到队首并中止当前任务，「取消」把它从队列
  // 摘掉。队列落盘，桥接重启不丢。

  /** 一条排队消息的身份：优先用飞书消息 id，天然唯一 */
  qidOf(msg) {
    return (
      msg?.qid ||
      msg?.messageId ||
      `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    )
  }

  /** front=true 时插到队首（「中止当前改发这条」用） */
  enqueue(key, msg, front = false) {
    if (!key || !msg?.text) return 0
    const q = this.data.queue || (this.data.queue = {})
    const list = Array.isArray(q[key]) ? q[key] : (q[key] = [])
    const item = { ...msg, qid: this.qidOf(msg), at: Date.now() }
    if (front) list.unshift(item)
    else list.push(item)
    this.scheduleSave()
    return list.length
  }

  dequeue(key) {
    const list = this.data.queue?.[key]
    if (!Array.isArray(list) || !list.length) return null
    const msg = list.shift()
    if (!list.length) delete this.data.queue[key]
    this.scheduleSave()
    return msg
  }

  /**
   * 给排队条目记上它那张「已加入队列」卡片的 ID。
   *
   * 消息出队或取消时要把那张卡翻新，否则它会一直挂着过时的状态和两个点不动
   * 的按钮——用户看到的是一条早已处理完的消息，仍显示「在排队」。
   */
  setQueuedCard(key, qid, cardId) {
    const list = this.data.queue?.[key]
    if (!Array.isArray(list) || !qid || !cardId) return
    const item = list.find((x) => x.qid === qid)
    if (!item || item.cardId === cardId) return
    item.cardId = cardId
    this.scheduleSave()
  }

  queueLength(key) {
    return this.data.queue?.[key]?.length || 0
  }

  /** 按 qid 从队列里摘掉一条（「取消」用）。返回摘到的那条，没摘到返回 null */
  removeQueued(key, qid) {
    const list = this.data.queue?.[key]
    if (!Array.isArray(list) || !list.length || !qid) return null
    const idx = list.findIndex((m) => m.qid === qid)
    if (idx === -1) return null
    const [item] = list.splice(idx, 1)
    if (!list.length) delete this.data.queue[key]
    this.scheduleSave()
    return item
  }

  /** 按 qid 把队列里的一条提到队首（「引导」用） */
  promoteQueued(key, qid) {
    const list = this.data.queue?.[key]
    if (!Array.isArray(list) || !list.length || !qid) return null
    const idx = list.findIndex((m) => m.qid === qid)
    if (idx === -1) return null
    const [item] = list.splice(idx, 1)
    list.unshift(item)
    this.scheduleSave()
    return item
  }

  scheduleSave() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 300)
  }

  flush() {
    if (!this.dirty) return
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.path)
    this.dirty = false
  }
}
