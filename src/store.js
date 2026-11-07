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
    this.migrateNames()
  }

  /**
   * 旧版的 names 是平铺的 { open_id: 名字 }，只为「标注里显示名字」服务。
   * 通讯录需要类型和时间戳，升级时平译过去：kind 留空（下次它说话就补上），
   * 时间戳用当前时间。丢一次也不心疼——那本来就是个缓存，重新 @ 一遍就全回来了。
   */
  migrateNames() {
    const flat = this.data.names
    if (!flat || typeof flat !== 'object') return
    const c = this.data.contacts || (this.data.contacts = {})
    const now = Date.now()
    for (const [openId, name] of Object.entries(flat)) {
      if (typeof name !== 'string' || !name) continue
      if (c[openId]) continue
      c[openId] = { name, kind: '', source: 'mention', firstSeen: now }
    }
    delete this.data.names
    // 更早的实验结构可能带 lastSeen，统一清掉，不留半套字段
    for (const v of Object.values(c)) delete v.lastSeen
    this.scheduleSave()
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

  all() {
    return Object.values(this.data.chats)
  }

  /**
   * 通讯录：open_id -> { name, kind, source, firstSeen, lastSeen }。
   *
   * 这是「认识」层——知道对方是谁、在**本应用视角**里怎么地址它。入册只认
   * 「被 @」：飞书把群里每条消息推给每一个机器人，mentions 数组里带的是接收
   * 方视角的 open_id 和名字，所以任何人 @ 过一次某机器人，所有机器人都认识了
   * 它。`kind`（user/app）由「它说过话」的事件补充，只 enrichment 不建册。
   *
   * 注意这和「许可」是两层：认识 ≠ 能唤醒我。放行名单在 config 的
   * feishu.listen / feishu.allowlist，见 handler.isAllowed。
   *
   * 飞书没有「open_id 反查名字」的接口（contact 对机器人 open_id 直接返回
   * 41050），mentions 里的 name 是唯一免费来源。
   */
  getName(openId) {
    if (!openId) return ''
    return this.data.contacts?.[openId]?.name || ''
  }

  /**
   * 被 @ 到 → 入册（或刷新名字）。没有名字的 mention 不入册。
   *
   * 只记 firstSeen：admin 通讯录要看的是「什么时候认识的」，最近见到时间
   * 对「认识 ≠ 放行」这个模型没有决策价值，反而让表格多一列噪声
   */
  learnContact(openId, name) {
    if (!openId || !name) return
    const c = this.data.contacts || (this.data.contacts = {})
    const prev = c[openId]
    if (prev && prev.name === name && !prev.lastSeen) return
    c[openId] = {
      name,
      kind: prev?.kind || '',
      source: 'mention',
      firstSeen: prev?.firstSeen || Date.now(),
    }
    this.scheduleSave()
  }

  /**
   * 补充「它是人还是机器人」。只更新已入册的条目，不建册——入册只认被 @。
   * 机器人被 @ 之后通常就会在群里说话，所以说过一次话它的 kind 就准了。
   */
  markContactKind(openId, kind) {
    if (!openId || !kind) return
    const c = this.data.contacts || {}
    const prev = c[openId]
    if (!prev || prev.kind === kind) return
    prev.kind = kind
    this.scheduleSave()
  }

  /**
   * 把自己的 open_id 从通讯录删掉。
   *
   * 机器人被 @ 时自己也在 mentions 里，早期版本没排除，存量数据里留着「自己」
   * 这一条——admin 通讯录会把它列成一个需要放行的同伴，没有意义。收集端已修
   * （feishu.js 排除自己），这里负责清存量。
   *
   * 机器人被 @ 时自己也在 mentions 里，早期版本没排除，存量数据里留着「自己」
   * 这一条——admin 通讯录会把它列成一个需要放行的同伴，没有意义。收集端已修
   * （feishu.js 排除自己），这里负责清存量：桥接每次解析出自身身份时调一次。
   */
  dropContact(openId) {
    if (!openId || !this.data.contacts?.[openId]) return
    delete this.data.contacts[openId]
    this.scheduleSave()
  }

  /** 通讯录全量，admin 通讯录面板用 */
  contactList() {
    return Object.entries(this.data.contacts || {}).map(([openId, v]) => ({
      openId,
      name: v.name || '',
      kind: v.kind || '',
      source: v.source || '',
      firstSeen: v.firstSeen || null,
    }))
  }

  setName(openId, name) {
    this.learnContact(openId, name)
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
  // 上一条任务还在跑时新消息不会被丢弃：先存进 pending（每个 key 一条，
  // 后来的覆盖先来的），同时回一张三选一的卡片——加入队列、中止当前改发
  // 这条、取消。选「加入队列」或「插队」时消息进 queue（FIFO），当前任务
  // 收尾后逐条自动发出。两块都落盘，桥接重启不丢。

  setPending(key, msg) {
    if (!key || !msg?.text) return null
    // 已有一条没处理的：按到达顺序排进队列，不丢。旧卡片按钮带的是旧消息的
    // qid，点击时会对不上而被拒并提示，不会出现「卡片预览是一条、发出去是
    // 另一条」。qid 优先用飞书消息 id，天然唯一
    const prev = this.data.pending?.[key]
    if (prev) this.enqueue(key, prev)
    const m = this.data.pending || (this.data.pending = {})
    m[key] = {
      ...msg,
      qid: msg.qid || msg.messageId || `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),
    }
    this.scheduleSave()
    return m[key]
  }

  getPending(key) {
    return this.data.pending?.[key] || null
  }

  clearPending(key) {
    if (!this.data.pending?.[key]) return
    delete this.data.pending[key]
    this.scheduleSave()
  }

  /** front=true 时插到队首（「中止当前改发这条」用） */
  enqueue(key, msg, front = false) {
    if (!key || !msg?.text) return 0
    const q = this.data.queue || (this.data.queue = {})
    const list = Array.isArray(q[key]) ? q[key] : (q[key] = [])
    const item = { ...msg, at: Date.now() }
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

  queueLength(key) {
    return this.data.queue?.[key]?.length || 0
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
