/**
 * OAR 登录流程驱动。
 *
 * OAR 的 runtime.login() 用一个交互对象把登录过程交给宿主：事件面是
 * auth_url、device_code、info，回答面是 text、secret、manual_code、select。
 * 这个驱动把那两样翻成一份状态，桥接按状态渲染卡片、把用户的回答送回去。
 *
 * 三条边界：
 *   1. 桥接不碰密钥。OAR 只把地址与设备码交给宿主，用户粘贴的码写回运行时的
 *      标准输入，不落日志、不进卡片历史。
 *   2. 登录改变本机凭据，只有人明确发起（/login）才会走到这里。
 *   3. 取消随时可以：中止信号交给 OAR，它停掉登录进程及其子进程。
 */

/** 卡片渲染用的状态。phase 决定卡片长什么样 */
const INITIAL = {
  phase: 'starting',
  url: '',
  userCode: '',
  expiresInSeconds: 0,
  info: [],
  prompt: null,
  result: null,
}

export class LoginFlow {
  /**
   * @param {object} opts
   * @param {object} opts.runtime OAR 的 Runtime
   * @param {object} opts.installation available 的安装
   * @param {object} [opts.env] 环境变量叠加
   * @param {number} [opts.timeoutMs] 整个流程的墙钟上限
   * @param {(state: object) => void} [opts.onState] 状态变化时回调
   * @param {Function} [opts.logger]
   */
  constructor({ runtime, installation, env, timeoutMs, onState, logger = console } = {}) {
    this.runtime = runtime
    this.installation = installation
    this.env = env
    this.timeoutMs = timeoutMs
    this.onState = onState
    this.log = logger
    this.state = { ...INITIAL }
    this.controller = new AbortController()
    // 等待中的提问：OAR 的 interaction.prompt 返回的 promise 由用户的回答兑现
    this._pending = null
  }

  /**
   * 要不要把下一条用户消息当成答案。
   *
   * 只有文本类提问要：select 走卡片按钮，设备码阶段的地址与码是给人看的，
   * 那期间发消息仍然是普通任务，不当成登录答案。
   */
  get awaitingText() {
    const p = this.state.prompt
    return this.state.phase === 'prompt' && Boolean(p) && p.kind !== 'select'
  }

  /** 开始登录。 resolves 成 OAR 的 LoginResult */
  async start() {
    if (typeof this.runtime.login !== 'function') {
      this._set({ phase: 'done', result: { kind: 'unsupported', reason: 'no_login', detail: '这个运行时不提供登录接口' } })
      return this.state.result
    }
    const interaction = {
      signal: this.controller.signal,
      onEvent: (ev) => this._onEvent(ev),
      prompt: (p) => this._prompt(p),
    }
    let result
    try {
      result = await this.runtime.login(this.installation, interaction, {
        env: this.env,
        timeoutMs: this.timeoutMs,
      })
    } catch (err) {
      result = { kind: 'failed', reason: 'error', detail: err?.message || String(err) }
    }
    this._set({ phase: 'done', prompt: null, result })
    return result
  }

  /** 用户发来的一段文本，送给等待中的提问 */
  answer(text) {
    const p = this._pending
    if (!p) return false
    this._pending = null
    this._set({ phase: 'prompting', prompt: null })
    p.resolve(String(text))
    return true
  }

  /** 取消：中止信号交给 OAR，它停掉登录进程及其子进程 */
  cancel() {
    this.controller.abort()
    const p = this._pending
    if (p) {
      this._pending = null
      p.resolve('')
    }
  }

  // ---------- 内部 ----------

  _onEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    if (ev.kind === 'auth_url') {
      this._set({ phase: 'url', url: ev.url, info: pushInfo(this.state.info, ev.instructions) })
      return
    }
    if (ev.kind === 'device_code') {
      this._set({
        phase: 'device_code',
        url: ev.verificationUri || this.state.url,
        userCode: ev.userCode || '',
        expiresInSeconds: ev.expiresInSeconds || 0,
        info: pushInfo(this.state.info, ev.intervalSeconds ? `每 ${ev.intervalSeconds} 秒轮询一次` : ''),
      })
      return
    }
    if (ev.kind === 'info') {
      this._set({ info: pushInfo(this.state.info, ev.message) })
    }
  }

  _prompt(p) {
    this._set({ phase: 'prompt', prompt: normalizePrompt(p) })
    return new Promise((resolve) => {
      this._pending = { resolve }
    })
  }

  _set(patch) {
    this.state = { ...this.state, ...patch }
    try {
      this.onState?.(this.state)
    } catch (err) {
      this.log.warn?.('登录状态回调失败: ' + (err?.message || err))
    }
  }
}

/** 提问归一：select 给按钮用，其余给输入框用 */
function normalizePrompt(p) {
  if (!p || typeof p !== 'object') return null
  if (p.kind === 'select') {
    return {
      kind: 'select',
      message: p.message || '选一个',
      options: (p.options || []).map((o) => ({ id: o.id, label: o.label || o.id, description: o.description || '' })),
    }
  }
  return {
    kind: p.kind === 'secret' ? 'secret' : p.kind === 'manual_code' ? 'manual_code' : 'text',
    message: p.message || '请输入',
    placeholder: p.placeholder || '',
  }
}

function pushInfo(list, line) {
  const t = String(line || '').trim()
  if (!t) return list
  return [...list, t].slice(-6)
}

export { INITIAL as LOGIN_INITIAL_STATE }
