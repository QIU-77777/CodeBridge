/**
 * 终端 pi 会话的共享读取。
 *
 * 桥接（src/pi.js）与管理后台（admin/server.js）都要读终端 pi 的会话：
 * 桥接的 /sessions 合并展示、/switch 切换、prompt 续聊；管理后台的会话
 * 列表合并展示、「查看」在访达里打开会话文件。两边各写一遍扫描逻辑，格式
 * 细节（子目录结构、头部三行、文件名规则）迟早会漂移，所以提取到这个模块，
 * 两边共用同一份实现。
 *
 * 存放方式：cliSessionRoot（默认 ~/.pi/agent/sessions）下每个子目录是一个
 * 工作目录（目录名是路径编码，不用解析——jsonl 头部自带 cwd），里面平铺
 * `<时间戳>_<uuid>.jsonl`。桥接自建的会话在实例配置目录的 pi-sessions 里
 * 平铺存放，两处互不可见。
 */
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 终端 pi 的默认会话根目录（`pi -r` 列的就是它）。可用 backend.pi.cliSessionRoot 覆盖 */
export const CLI_SESSION_ROOT = join(homedir(), '.pi', 'agent', 'sessions')

/** 头部读取上限：够覆盖 system 行 + 第一条 user message（标题来源） */
const CLI_HEAD_BYTES = 512 * 1024

/**
 * 从 pi 的 message 里抠出纯文本（content 是分段数组）
 */
export function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}

/**
 * 读终端 pi 一个会话文件的头部，提炼出桥接与管理后台都需要的字段。
 *
 * 头部三行就有全部信息：第一行 `type:"session"` 带 id 与 cwd，随后的
 * model_change 带模型，第一条 role=user 的 message 的文本即标题（与 pi 的
 * resume 选择器同一来源）。只读前 CLI_HEAD_BYTES 字节——会话文件能到 16MB，
 * 整读会让每次列表都卡住。
 *
 * 返回 null 表示这个文件读不出有效会话头（损坏、空文件、非 pi 格式）。
 */
export function readCliSessionHead(file) {
  let head
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.allocUnsafe(CLI_HEAD_BYTES)
      const n = readSync(fd, buf, 0, CLI_HEAD_BYTES, 0)
      head = buf.toString('utf8', 0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  let id = null
  let directory = ''
  let created = 0
  let model = null
  let title = ''
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!id && ev?.type === 'session' && ev.id) {
      id = ev.id
      directory = ev.cwd || ''
      created = ev.timestamp ? Date.parse(ev.timestamp) || 0 : 0
      continue
    }
    if (id && !model && ev?.type === 'model_change' && ev.modelId) {
      model = { providerID: ev.provider || '', id: ev.modelId }
      continue
    }
    if (id && !title && ev?.type === 'message' && ev.message?.role === 'user') {
      const t = textOf(ev.message).trim()
      if (t) title = t
      // 标题到手，后面的行都是正文，不再需要
      if (model || created) break
    }
  }
  if (!id) return null
  let updated = 0
  try {
    updated = statSync(file).mtimeMs
  } catch {
    /* 拿不到 mtime 就用创建时间 */
  }
  return {
    id,
    title: title || '(无标题)',
    location: { directory },
    model,
    time: { created: created || updated, updated: updated || created || Date.now() },
    cost: 0,
    tokens: null,
    // 桥接据此走 --session <file> 续聊，并禁止改名/删除（那是终端 pi 的地盘）；
    // 管理后台据此把「删除」置灰，只留「查看」
    file,
    cli: true,
  }
}

/**
 * 扫终端根目录，返回 id -> 会话 的 Map。
 *
 * 根目录不存在或读不了时返回空 Map：没装过终端 pi、或目录被挪走，都当作没有
 * 外部会话，桥接自建的照常用。不在这里做缓存——调用方的节奏不同（桥接每数
 * 秒一次要缓存，管理后台一次页面加载一次不必）。
 */
export function scanCliSessions(root) {
  const map = new Map()
  let subs = []
  try {
    subs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return map
  }
  for (const sub of subs) {
    const dir = join(root, sub.name)
    let files = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const meta = readCliSessionHead(join(dir, f))
      if (meta) map.set(meta.id, meta)
    }
  }
  return map
}

/**
 * 按会话 id 在终端根目录里找会话文件，返回绝对路径或 null。
 * 文件在按工作目录分的子目录里，名字是 `<时间戳>_<id>.jsonl`——只按后缀找，
 * 不读文件内容（id 在文件名里就有）。
 */
export function cliSessionFilePath(root, sid) {
  if (!root || !sid) return null
  let subs = []
  try {
    subs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return null
  }
  for (const sub of subs) {
    const dir = join(root, sub.name)
    let files = []
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    const hit = files.find((f) => f.endsWith(`_${sid}.jsonl`))
    if (hit) return join(dir, hit)
  }
  return null
}
