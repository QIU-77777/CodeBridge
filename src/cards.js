/**
 * 飞书卡片模板（card 2.0 结构）
 *
 * 为什么是 2.0：1.0 的 lark_md 不支持表格/代码块，markdown 表格会被渲染成一坨原始竖线。
 * 2.0 才有原生 table 组件和带语法高亮的 markdown 组件。
 *
 * 2.0 与 1.0 的坑（已实测）：
 *   - 必须带 schema:'2.0'，元素放在 body.elements，不是根级 elements
 *   - **没有 action 容器**，button 直接放进 elements / column.elements（用 action 包会 400）
 *   - **没有 note 组件**，小字用 {tag:'markdown', text_size:'notation'}
 *   - 2.0 和 1.0 卡片不能互相 patch，会报 200830
 *
 * 交互约定：按钮 value 里带 { a: <action>, ... }，由 card.action.trigger 统一分发。
 */

import { truncate } from './render.js'
import { mdToElements } from './md.js'

function card(title, template, elements) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template, title: { tag: 'plain_text', content: truncate(title, 80) } },
    body: { elements },
  }
}

function div(content) {
  return { tag: 'div', text: { tag: 'lark_md', content } }
}

/** 小字备注（2.0 没有 note 组件，用 notation 尺寸的 markdown 代替） */
function note(content) {
  return { tag: 'markdown', content, text_size: 'notation' }
}

function hr() {
  return { tag: 'hr' }
}

function button(text, value, type = 'default', extra = {}) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    value,
    ...extra,
  }
}

/** 一行横排按钮。2.0 没有 action 容器，用 column_set 拼横向布局 */
function buttonRow(buttons) {
  if (buttons.length === 1) return buttons[0]
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
  }
}

function columns(left, right, weight = 5) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      { tag: 'column', width: 'weighted', weight, elements: left },
      { tag: 'column', width: 'auto', elements: right },
    ],
  }
}

export function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m${rs ? rs + 's' : ''}`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

export function fmtAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

function shortDir(dir) {
  if (!dir) return '—'
  const home = process.env.HOME || ''
  return home && dir.startsWith(home) ? '~' + dir.slice(home.length) : dir
}

/**
 * 运行中的会话卡片。同一个 message 反复 patch 更新。
 * @param {object} state RunState
 * @param {{directory?:string, model?:string, title?:string, maxBodyChars?:number,
 *          showReasoning?:boolean, showTools?:boolean}} meta
 */
export function runCard(state, meta = {}) {
  const statusMap = {
    running: { template: 'blue', label: '执行中', icon: '⏳' },
    done: { template: 'green', label: '已完成', icon: '✅' },
    failed: { template: 'red', label: '失败', icon: '❌' },
    aborted: { template: 'grey', label: '已中止', icon: '⏹' },
  }
  const st = statusMap[state.status] || statusMap.running

  const elements = []

  if (meta.directory) {
    elements.push(
      div(
        `**目录** ${shortDir(meta.directory)}` +
          (meta.model ? `　**模型** ${meta.model}` : '') +
          `　**耗时** ${fmtDuration(state.elapsed)}` +
          (state.steps > 1 ? `　**步数** ${state.steps}` : ''),
      ),
    )
  }

  // 正文：走分段解析，表格 → table 组件、代码块 → markdown 组件
  const body = state.text || ''
  const bodyEls = mdToElements(body, { maxChars: meta.maxBodyChars ?? 6000 })
  if (bodyEls.length) {
    elements.push(...bodyEls)
  } else if (state.status === 'running') {
    elements.push(div('_正在等待模型响应…_'))
  }

  if (meta.showReasoning && state.reasoning) {
    elements.push(hr(), div(`**思考过程**\n${truncate(state.reasoning, 1500)}`))
  }

  // 用户要求：默认不在飞书上看工具调用链路，看轨迹去电脑上
  if (meta.showTools) {
    const toolText = state.toolSummary?.()
    if (toolText) elements.push(hr(), div(`**工具调用**\n${toolText}`))
  }

  if (state.status === 'failed' && state.error) {
    const msg = state.error.message || JSON.stringify(state.error)
    elements.push(hr(), div(`**错误**\n\`${truncate(msg, 500)}\``))
  }

  const footer = []
  if (state.status === 'running') footer.push(button('中止', { a: 'abort', s: state.sessionId }, 'danger'))
  footer.push(button('新会话', { a: 'new' }, 'default'))
  footer.push(button('会话列表', { a: 'sessions' }, 'default'))
  elements.push(buttonRow(footer))

  const usage = []
  if (state.tokens?.input) usage.push(`in ${state.tokens.input}`)
  if (state.tokens?.output) usage.push(`out ${state.tokens.output}`)
  if (state.cost) usage.push(`$${state.cost.toFixed(4)}`)
  if (usage.length) elements.push(note(usage.join(' · ')))

  return card(`${st.icon} ${meta.title || 'opencode'}`, st.template, elements)
}

export function textCard(title, body, template = 'blue', buttons = []) {
  const elements = mdToElements(body, { maxChars: 6000 })
  if (buttons.length) elements.push(buttonRow(buttons))
  return card(title, template, elements)
}

export function sessionsCard({ sessions, currentId, directory, page = 0, pageSize = 8 }) {
  const total = sessions.length
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const p = Math.min(Math.max(0, page), pages - 1)
  const slice = sessions.slice(p * pageSize, p * pageSize + pageSize)

  if (!total) {
    return textCard(
      '📂 会话列表',
      `当前目录 \`${shortDir(directory)}\` 下没有会话。\n发送 \`/new\` 新建一个。`,
      'grey',
      [button('新建会话', { a: 'new' }, 'primary')],
    )
  }

  const elements = []
  elements.push(
    div(
      `**当前** \`${currentId ? currentId.slice(0, 16) + '…' : '未绑定'}\`　**目录** \`${shortDir(directory)}\`　**共 ${total} 个**`,
    ),
  )

  for (const s of slice) {
    const isCurrent = s.id === currentId
    const mark = isCurrent ? '▶ ' : ''
    const title = s.title || '(无标题)'
    const metaLine = [fmtAgo(s.time?.updated || s.time?.created), s.model?.id || '', s.cost ? `$${s.cost.toFixed(3)}` : '']
      .filter(Boolean)
      .join(' · ')

    elements.push(
      columns(
        [div(`${mark}**${truncate(title, 34)}**\n\`${s.id.slice(0, 16)}…\` ${metaLine}`)],
        [
          isCurrent
            ? button('当前', { a: 'noop' }, 'default', { disabled: true })
            : button('切换', { a: 'switch', s: s.id }, 'primary'),
        ],
      ),
    )
  }

  const nav = []
  if (pages > 1) {
    nav.push(button('上一页', { a: 'sessions', p: p - 1 }, 'default', { disabled: p <= 0 }))
    nav.push(button(`${p + 1}/${pages}`, { a: 'noop' }, 'default', { disabled: true }))
    nav.push(button('下一页', { a: 'sessions', p: p + 1 }, 'default', { disabled: p >= pages - 1 }))
  }
  elements.push(hr(), buttonRow([...nav, button('新建会话', { a: 'new' }, 'primary')]))

  return card('📂 会话列表', 'turquoise', elements)
}

export function permissionCard({ request, sessionTitle }) {
  const resources = (request.resources || []).map((r) => `\`${truncate(r, 120)}\``).join('\n')
  const body = [
    `**会话** ${sessionTitle || request.sessionID}`,
    `**动作** \`${request.action || '?'}\``,
    resources ? `**资源**\n${resources}` : '',
    request.message ? `\n${truncate(request.message, 300)}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return card('🔐 需要授权', 'orange', [
    div(body),
    buttonRow([
      button('允许一次', { a: 'perm', s: request.sessionID, r: request.id, d: 'once' }, 'primary'),
      button('总是允许', { a: 'perm', s: request.sessionID, r: request.id, d: 'always' }, 'default'),
      button('拒绝', { a: 'perm', s: request.sessionID, r: request.id, d: 'reject' }, 'danger'),
    ]),
  ])
}

export function statusCard({ session, binding, directory, server }) {
  const lines = [
    `**opencode** ${server?.version ? `v${server.version}` : '未知'} ${server?.ok ? '🟢' : '🔴'}`,
    `**绑定会话** ${binding?.sessionId ? `\`${binding.sessionId}\`` : '未绑定（发送 /new 新建）'}`,
    `**工作目录** \`${shortDir(binding?.directory || directory)}\``,
  ]
  if (session) {
    lines.push(`**标题** ${session.title || '(无标题)'}`)
    lines.push(
      `**模型** ${session.model?.id ? '`' + session.model.providerID + '/' + session.model.id + '`' : '_未定（发首条消息时确定）_'}`,
    )
    lines.push(`**Agent** ${session.agent ? '`' + session.agent + '`' : '_默认_'}`)
    if (session.tokens) {
      lines.push(`**累计 tokens** in ${session.tokens.input} / out ${session.tokens.output}`)
    }
    if (session.cost) lines.push(`**累计成本** $${session.cost.toFixed(4)}`)
  }
  return textCard('📊 状态', lines.join('\n'), 'indigo', [
    button('会话列表', { a: 'sessions' }, 'default'),
    button('新会话', { a: 'new' }, 'primary'),
  ])
}

export function helpCard() {
  const body = [
    '**对话**',
    '直接发消息 = 发给当前绑定会话。',
    '',
    '**会话**',
    '`/new [目录]` 新建会话并绑定（目录省略则用默认目录）',
    '`/sessions` 列出会话，点按钮切换',
    '`/switch <序号|sessionId>` 文本方式切换',
    '`/rename <标题>` 重命名当前会话',
    '`/del <序号>` 删除会话',
    '`/cd <目录>` 改工作目录并重置绑定（之后 /new 或直接发消息都会新建会话）',
    '',
    '**控制**',
    '`/stop` 中止当前执行',
    '`/status` 查看绑定与服务器状态',
    '`/model` 列出模型，`/model <序号>` 切换',
    '`/agent` 列出 agent，`/agent <名字>` 切换',
    '`/help` 本帮助',
  ].join('\n')
  return textCard('🤖 opencode 桥接', body, 'wathet')
}
