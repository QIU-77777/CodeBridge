/**
 * opencode v2 HttpApi 客户端。
 *
 * 注意：v2（>= 2.0.x）的接口与 v1 完全不同，路径统一在 /api/* 下，
 * 且 / 与 /doc 返回的是 Web UI，不是 API。规格见 http://<host>/openapi.json
 */

export class OpencodeClient {
  constructor({ url, password = '', logger = console }) {
    this.base = url.replace(/\/+$/, '')
    this.auth = password ? 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') : ''
    this.log = logger
    this.abort = null
  }

  async request(path, { method = 'GET', body, signal, raw = false } = {}) {
    const headers = { Accept: 'application/json' }
    if (this.auth) headers.Authorization = this.auth
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })

    const text = await res.text()
    if (raw) return { res, text }

    let json
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      throw new Error(`${method} ${path} 返回非 JSON (${res.status}): ${text.slice(0, 200)}`)
    }
    if (!res.ok) {
      const msg = json?.message || json?.error?.message || text.slice(0, 300)
      // 401 单独说清楚：这一种的成因几乎是「serve 带着旧密码在跑，配置里的
      // 密码变了或被清空」。serve 是长跑进程，密码启动时定格在它的环境里，
      // 之后改配置不会跟着变——两边一不一致，桥接就全程 401，而现象是
      // 「毫无反应」而不是报错
      if (res.status === 401) {
        throw new Error(
          `opencode 认证失败（401）：配置里的 opencode.password 与 serve 实际使用的不一致。` +
            `serve 启动时把密码定格在进程环境里，之后改配置不会生效——重启 serve 让两边一致：` +
            `launchctl kickstart -k gui/$(id -u)/$(launchctl list | grep -o 'ai.qiguang.ocbridge.serve' | head -1)`,
        )
      }
      const err = new Error(`${method} ${path} -> ${res.status}: ${msg}`)
      err.status = res.status
      err.body = json
      throw err
    }
    return json
  }

  // ---- 基础 ----
  async info() {
    return this.request('/api/info')
  }

  async location() {
    return this.request('/api/location')
  }

  async health() {
    const info = await this.info()
    return { ok: true, version: info.version, pid: info.pid }
  }

  // ---- 会话 ----
  async listSessions({ limit = '100', order = 'desc', search } = {}) {
    const qs = new URLSearchParams()
    qs.set('limit', limit)
    qs.set('order', order)
    if (search) qs.set('search', search)
    const r = await this.request(`/api/session?${qs}`)
    return r.data || []
  }

  async createSession({ title, directory, model, agent } = {}) {
    const body = {}
    if (title) body.title = title
    if (directory) body.location = { directory }
    if (model) body.model = model
    if (agent) body.agent = agent
    const r = await this.request('/api/session', { method: 'POST', body })
    return r.data
  }

  async getSession(id) {
    const r = await this.request(`/api/session/${encodeURIComponent(id)}`)
    return r.data
  }

  async deleteSession(id) {
    await this.request(`/api/session/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return true
  }

  async renameSession(id, title) {
    // 实测：这个 PATCH 成功时返回 204 No Content，没有响应体，
    // 所以 request() 会返回 null —— 不能再解 r.data，否则改名成功但桥接抛错。
    const r = await this.request(`/api/session/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { title },
    })
    return r?.data ?? null
  }

  async switchModel(id, model) {
    await this.request(`/api/session/${encodeURIComponent(id)}/model`, {
      method: 'POST',
      body: { model },
    })
    return true
  }

  async switchAgent(id, agent) {
    await this.request(`/api/session/${encodeURIComponent(id)}/agent`, {
      method: 'POST',
      body: { agent },
    })
    return true
  }

  // ---- 消息 ----
  async prompt(id, text, { files, delivery } = {}) {
    const body = { text }
    if (files?.length) body.files = files
    // delivery=steer：会话正在跑时，这条消息在下一个步骤边界注入当前回合，
    // 不中止、不清除已有工作（serve 的 Session.Inbox.Delivery 枚举）。
    // 缺省时不带这个字段，行为与以前一致
    if (delivery) body.delivery = delivery
    const r = await this.request(`/api/session/${encodeURIComponent(id)}/prompt`, {
      method: 'POST',
      body,
    })
    return r.data
  }

  async listMessages(id, { limit = '40', order = 'desc' } = {}) {
    const r = await this.request(`/api/session/${encodeURIComponent(id)}/message?limit=${limit}&order=${order}`)
    return r.data || []
  }

  async interrupt(id) {
    try {
      await this.request(`/api/session/${encodeURIComponent(id)}/interrupt`, { method: 'POST' })
      return true
    } catch (err) {
      // 没在跑的时候可能返回 4xx，不算错误
      this.log.warn?.(`interrupt 失败（可能未在执行）: ${err.message}`)
      return false
    }
  }

  // ---- 权限 ----
  async listPermissions(id) {
    try {
      const r = await this.request(`/api/session/${encodeURIComponent(id)}/permission`)
      return r.data || []
    } catch {
      return []
    }
  }

  async replyPermission(id, requestId, decision, message) {
    await this.request(
      `/api/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: 'POST', body: { decision, ...(message ? { message } : {}) } },
    )
    return true
  }

  // ---- 元数据 ----
  async listModels() {
    const r = await this.request('/api/model')
    return r.data || []
  }

  async listAgents() {
    const r = await this.request('/api/agent')
    return r.data || []
  }

  async defaultModel() {
    try {
      const r = await this.request('/api/model/default')
      return r.data
    } catch {
      return null
    }
  }

  /**
   * 订阅全局事件流。
   * v2 的 /api/event 是 SSE，data 为 JSON；事件里带 location.directory，
   * 跨项目的会话事件都会从这条流推过来，调用方需按 sessionID 过滤。
   */
  subscribe(onEvent, onStatus) {
    const self = this
    let stopped = false
    let retry = 0

    const connect = async () => {
      if (stopped) return
      const ctrl = new AbortController()
      self.abort = ctrl
      try {
        const headers = { Accept: 'text/event-stream' }
        if (self.auth) headers.Authorization = self.auth
        const res = await fetch(self.base + '/api/event', { headers, signal: ctrl.signal })
        if (!res.ok) throw new Error(`SSE ${res.status}`)
        retry = 0
        onStatus?.({ connected: true })
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            let dataLine = ''
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data:')) dataLine += line.slice(5).trim()
            }
            if (!dataLine) continue
            let payload
            try {
              payload = JSON.parse(dataLine)
            } catch {
              continue
            }
            if (typeof payload === 'string') {
              try {
                payload = JSON.parse(payload)
              } catch {
                /* keep as string */
              }
            }
            if (payload && typeof payload === 'object') onEvent(payload)
          }
        }
        onStatus?.({ connected: false, reason: 'stream ended' })
      } catch (err) {
        if (stopped) return
        onStatus?.({ connected: false, reason: err.message })
      }
      if (stopped) return
      retry = Math.min(retry + 1, 6)
      const delay = Math.min(1000 * 2 ** (retry - 1), 15000)
      setTimeout(connect, delay)
    }

    connect()
    return () => {
      stopped = true
      try {
        self.abort?.abort()
      } catch {
        /* noop */
      }
    }
  }
}
