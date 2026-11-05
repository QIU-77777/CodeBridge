import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { STATE_PATH, ensureConfigDir } from './config.js'

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
    ensureConfigDir()
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      if (raw && raw.version === VERSION && raw.chats) this.data = raw
    } catch {
      // 文件损坏就从空状态开始，不阻塞启动
      this.data = { version: VERSION, chats: {} }
    }
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
   * open_id -> 显示名。
   *
   * 飞书没有「open_id 反查机器人名字」的接口（contact 接口对机器人 open_id
   * 直接返回 41050 no user authority），所以名字只能从消息的 mentions 里攒：
   * 谁被 @ 过，我们就把那条 mention 的 name 记下来。用得越久越全。
   */
  getName(openId) {
    if (!openId) return ''
    return this.data.names?.[openId] || ''
  }

  setName(openId, name) {
    if (!openId || !name) return
    const names = this.data.names || (this.data.names = {})
    if (names[openId] === name) return
    names[openId] = name
    this.scheduleSave()
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
    ensureConfigDir()
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.path)
    this.dirty = false
  }
}
