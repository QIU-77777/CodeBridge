/**
 * 把 opencode 的 SSE 事件聚合成可渲染的运行态。
 * 事件来源：GET /api/event（v2 全局事件流）
 */

const TOOL_LABEL = {
  shell: '执行命令',
  bash: '执行命令',
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  patch: '修改文件',
  glob: '查找文件',
  grep: '搜索内容',
  list: '列目录',
  webfetch: '抓取网页',
  websearch: '联网搜索',
  task: '子任务',
}

export class RunState {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.assistantMessageID = null
    this.startedAt = Date.now()
    this.updatedAt = Date.now()
    this.reasoning = ''
    this.text = ''
    this.tools = []
    this.status = 'running'
    this.error = null
    this.cost = 0
    this.tokens = null
    this.steps = 0
    this.finish = null
  }

  get elapsed() {
    return Date.now() - this.startedAt
  }

  /** 只处理属于本 session 的事件，返回是否命中 */
  apply(event) {
    const d = event.data || {}
    if (d.sessionID !== this.sessionId) return false
    this.updatedAt = Date.now()

    switch (event.type) {
      case 'session.execution.started':
        this.status = 'running'
        this.startedAt = this.startedAt || Date.now()
        break

      case 'session.step.started':
        this.steps += 1
        this.assistantMessageID = d.assistantMessageID || this.assistantMessageID
        break

      case 'session.reasoning.delta':
        this.reasoning += d.delta || ''
        break

      case 'session.text.delta':
        this.text += d.delta || ''
        break

      case 'session.text.ended':
        if (typeof d.text === 'string' && d.text.length >= this.text.length) this.text = d.text
        break

      // 工具名在 input.started 里给，参数在 called 里给，要分两步拼
      case 'session.tool.input.started': {
        if (d.id && !this.tools.some((t) => t.id === d.id)) {
          this.tools.push({ id: d.id, name: d.name || 'tool', input: null, status: 'running', output: '' })
        }
        break
      }

      case 'session.tool.input.ended': {
        const t = this.tools.find((x) => x.id === d.id)
        if (t && !t.input && typeof d.text === 'string') {
          try {
            t.input = JSON.parse(d.text)
          } catch {
            t.input = { raw: d.text }
          }
        }
        break
      }

      case 'session.tool.called': {
        const id = d.id
        const existing = this.tools.find((t) => t.id === id)
        if (existing) {
          if (d.input) existing.input = d.input
          if (d.name && existing.name === 'tool') existing.name = d.name
        } else if (id) {
          this.tools.push({
            id,
            name: d.name || 'tool',
            input: d.input || null,
            status: 'running',
            output: '',
          })
        }
        break
      }

      case 'session.tool.success':
      case 'session.tool.failed':
      case 'session.tool.error': {
        const t = this.tools.find((x) => x.id === d.id)
        if (t) {
          t.status = event.type === 'session.tool.success' ? 'ok' : 'error'
          t.output = extractToolOutput(d)
        }
        break
      }

      case 'session.step.ended':
        this.finish = d.finish || null
        if (d.cost !== undefined) this.cost = d.cost
        if (d.tokens) this.tokens = d.tokens
        break

      case 'session.usage.updated':
        if (d.cost !== undefined) this.cost = d.cost
        if (d.tokens) this.tokens = d.tokens
        break

      case 'session.execution.succeeded':
        this.status = 'done'
        break

      case 'session.execution.failed':
        this.status = 'failed'
        this.error = d.error || { message: '未知错误' }
        break

      case 'session.execution.interrupted':
      case 'session.execution.aborted':
        this.status = 'aborted'
        break

      default:
        break
    }
    return true
  }

  toolSummary(limit = 6) {
    if (!this.tools.length) return ''
    const shown = this.tools.slice(-limit)
    const lines = shown.map((t) => {
      const label = TOOL_LABEL[t.name] || t.name
      const detail = describeToolInput(t.name, t.input)
      const mark = t.status === 'ok' ? '✓' : t.status === 'error' ? '✗' : '…'
      return `${mark} **${label}** ${detail ? '`' + truncate(detail, 60) + '`' : ''}`
    })
    const more = this.tools.length > limit ? `\n_…另有 ${this.tools.length - limit} 个工具调用_` : ''
    return lines.join('\n') + more
  }
}

function extractToolOutput(d) {
  if (Array.isArray(d.content)) {
    return d.content
      .map((c) => (typeof c === 'string' ? c : c?.text || ''))
      .join('\n')
  }
  if (typeof d.content === 'string') return d.content
  if (d.error) return typeof d.error === 'string' ? d.error : d.error.message || ''
  return ''
}

export function describeToolInput(name, input) {
  if (!input) return ''
  if (typeof input === 'string') return input
  if (input.command) return input.command
  if (input.filePath) return input.filePath
  if (input.path) return input.path
  if (input.pattern) return input.pattern
  if (input.query) return input.query
  if (input.url) return input.url
  const first = Object.values(input).find((v) => typeof v === 'string')
  return first || ''
}

export function truncate(str, n) {
  if (!str) return ''
  const s = String(str)
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/** 超长文本保留尾部（流式输出最重要的内容在后面） */
export function clampBody(text, max) {
  if (!text) return ''
  if (text.length <= max) return text
  return `_（前 ${text.length - max} 字已省略）_\n…` + text.slice(-max)
}
