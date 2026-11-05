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

  set(chatId, patch) {
    const prev = this.data.chats[chatId] || { chatId }
    this.data.chats[chatId] = { ...prev, ...patch, chatId, updatedAt: Date.now() }
    this.scheduleSave()
    return this.data.chats[chatId]
  }

  clearSession(chatId) {
    const cur = this.data.chats[chatId]
    if (!cur) return
    this.data.chats[chatId] = { chatId, directory: cur.directory, updatedAt: Date.now() }
    this.scheduleSave()
  }

  all() {
    return Object.values(this.data.chats)
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
