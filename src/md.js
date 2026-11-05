/**
 * Markdown → 飞书卡片 2.0 元素。
 *
 * 背景：飞书卡片的 lark_md 只是 Markdown 的**子集**——
 * 支持加粗/斜体/删除线/行内代码/链接/换行，但**不支持表格、标题、代码块、列表**。
 * 直接塞 `| a | b |` 会被渲染成一坨乱码（就是用户看到的那个问题）。
 *
 * 所以这里做分段解析：
 *   ```code```  → {"tag":"markdown"} 组件（带语法高亮）
 *   | a | b |   → {"tag":"table"}    组件（原生表格）
 *   其它        → {"tag":"div"} + lark_md
 */

const TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/
/** 单表最多渲染多少行，超出截断（防止撑爆 30KB 限制 / 飞书分页太碎） */
const MAX_TABLE_ROWS = 50
/** 单表最多保留多少列 */
const MAX_TABLE_COLS = 8

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** 表头/单元格里去掉 markdown 标记，用于 plain text 场景 */
function stripMd(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .trim()
}

/**
 * lark_md 也不支持 # 标题和 - 列表，这里降级成它能认的写法：
 *   ## 标题      → **标题**
 *   - 项目       → • 项目
 *   1. 项目      → 1. 项目（有序列表 lark_md 原样可读，保留）
 * 引用块 > 去掉前缀留文字。
 */
function degradeInline(line) {
  const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/)
  if (h) return `**${h[1].trim()}**`
  // 流式中途的半截表格（还没等到分隔行）也不能露原始竖线
  if (/^\s*\|.*\|\s*$/.test(line)) return splitRow(line).join(' ｜ ')
  const ul = line.match(/^(\s*)[-*+]\s+(.*)$/)
  if (ul && !/^\s*\|/.test(line)) return `${ul[1]}• ${ul[2]}`
  const quote = line.match(/^\s*>\s?(.*)$/)
  if (quote) return quote[1]
  return line
}

function buildTable(header, rows) {
  const cols = header.map((h, i) => ({
    name: `c${i}`,
    display_name: stripMd(h) || `列${i + 1}`,
    data_type: 'lark_md',
    horizontal_align: 'left',
    vertical_align: 'top',
    width: 'auto',
  }))

  const dataRows = rows.map((cells) => {
    const obj = {}
    header.forEach((_, i) => {
      obj[`c${i}`] = cells[i] ?? ''
    })
    return obj
  })

  return {
    tag: 'table',
    page_size: Math.min(Math.max(dataRows.length, 1), 10),
    row_height: 'low',
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'default',
      bold: true,
      lines: 1,
    },
    columns: cols,
    rows: dataRows,
  }
}

/**
 * @param {string} md
 * @param {{maxChars?: number}} opts
 * @returns {Array} 飞书卡片 body.elements 数组
 */
export function mdToElements(md, { maxChars = 6000 } = {}) {
  if (!md) return []
  let text = String(md)
  if (text.length > maxChars) {
    text = `_（前 ${text.length - maxChars} 字已省略）_\n…` + text.slice(-maxChars)
  }

  const lines = text.split('\n')
  const out = []
  let buf = []

  const flushText = () => {
    const joined = buf.map(degradeInline).join('\n').trim()
    if (joined) out.push({ tag: 'div', text: { tag: 'lark_md', content: joined } })
    buf = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    if (/^\s*```/.test(line)) {
      flushText()
      const lang = line.trim().slice(3).trim()
      const code = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i])
        i++
      }
      i++ // 跳过收尾 ```
      const body = code.join('\n')
      if (body.trim()) {
        out.push({ tag: 'markdown', content: '```' + (lang || '') + '\n' + body + '\n```' })
      }
      continue
    }

    // 表格：当前行是 |...|，下一行是分隔行 |---|---|
    const next = lines[i + 1]
    if (/^\s*\|.*\|\s*$/.test(line) && next && TABLE_SEP.test(next) && next.includes('-')) {
      flushText()
      const header = splitRow(line)
      const rows = []
      i += 2
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      if (rows.length) {
        const cols = Math.min(header.length, MAX_TABLE_COLS)
        const shownRows = rows.slice(0, MAX_TABLE_ROWS).map((r) => r.slice(0, cols))
        out.push(buildTable(header.slice(0, cols), shownRows))
        const notes = []
        if (rows.length > MAX_TABLE_ROWS) notes.push(`表格还有 ${rows.length - MAX_TABLE_ROWS} 行未显示`)
        if (header.length > MAX_TABLE_COLS) notes.push(`还有 ${header.length - MAX_TABLE_COLS} 列未显示`)
        if (notes.length) out.push({ tag: 'markdown', content: '_' + notes.join('；') + '_', text_size: 'notation' })
      } else {
        buf.push(...header.map((h) => `- ${h}`))
      }
      continue
    }

    buf.push(line)
    i++
  }
  flushText()

  return out
}

/** 纯文本（无元素）时的兜底 */
export function mdToText(md, maxChars = 6000) {
  const els = mdToElements(md, { maxChars })
  return els
    .map((e) => (e.tag === 'div' ? e.text.content : e.tag === 'markdown' ? e.content : ''))
    .join('\n')
}
