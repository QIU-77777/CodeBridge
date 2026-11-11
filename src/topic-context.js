/**
 * 话题近况：替模型带上它本来收不到的那部分聊天记录。
 *
 * 背景：群里只有 @ 我的消息会进模型会话，人类和别的 agent 在话题里说话我
 * 收不到（design-notes 十二节，@ 闸门是刻意的——「谁会被唤醒必须显式」）。
 * 以前模型的补救办法是收到任务后自己去 feishu-cli 拉话题历史，白烧好几步。
 * 桥接反正收到了全部群消息事件（飞书推给在群的每个机器人），以前只是在
 * 闸门处丢掉；现在把最近 N 条**原文**留在缓冲里，被 @ 唤醒时随 prompt 带上。
 *
 * 为什么是原文不是摘要：桥接里没有 LLM，做摘要意味着为一件辅助的事起一次
 * 完整的后端 run——总 input 变成「原文 + 摘要」两份，还引入延迟和新的失败
 * 链路。原文做两级截断（单条 perMsgChars、总量 maxChars 保尾）就够，而且
 * 协作场景里对方轮次的原话（命令、参数、结论）正是模型要用的东西，摘要会
 * 磨掉这些细节。
 *
 * 键的语义与会话绑定键对齐：
 *   - 话题内 / 引用回复链：root:<root_id>（和绑定键 root:<根消息> 同一套）
 *   - 主聊天流：chat:<chat_id>。主聊天流里 @ 我的每条消息都是新会话（键是
 *     它自己的 message_id），话题近况恰好是它唯一的上下文来源，所以主聊天流
 *     单独按群缓冲
 *   - 私聊不采集：私聊每条消息都进会话，没有盲区，带了反而重复
 *
 * 缓冲只在内存里，重启即失。可接受：覆盖的是「最近几条」，更早的历史模型
 * 仍可用 feishu-cli 拉（协作规则里教过）。
 */

/** 单条消息正文截断。再长的粘贴（日志、代码）在话题闲聊里也不该整段带 */
const PER_MSG_CHARS = 400
/** @ 过我的轮次只给指针行截断：正文已经在会话历史里，这里只需要时间线占位 */
const POINTER_CHARS = 40

/** 非文本消息在近况里给一行占位：模型至少知道「谁在什么时刻发了什么类型」 */
const TYPE_LABEL = {
  image: '图片',
  file: '文件',
  audio: '语音',
  media: '视频',
  sticker: '表情',
  interactive: '卡片',
  share_chat: '分享的群',
  share_user: '分享的名片',
  post: null, // post 拉平成文本，不算占位
  text: null,
}

/**
 * 近况缓冲键。m 是飞书事件里的 message 对象（root_id / chat_id 原始字段）。
 * 与 handler.ctxOf 的绑定键同语义但不完全相同：主聊天流这里用 chat:<群>，
 * 因为要聚的是整个主聊天流的近况，而不是「这一条消息自己」（绑定键是
 * root:<自身 message_id>，那是给会话隔离用的，拿来当缓冲键每条消息一个桶，
 * 桶里永远只有它自己）。
 */
export function contextKeyOf(m) {
  return m.root_id ? `root:${m.root_id}` : `chat:${m.chat_id}`
}

/**
 * 把一条消息的内容拉平成纯文本。
 *
 * text：@ 占位符（@_user_1）还原成 @姓名——和 handleImMessage 的主路径同一
 * 套逻辑，模型需要知道那句话在冲谁说。
 * post：富文本按段拉平。text 段取文字，a 段取链接文字，at 段按 user_id 去
 * mentions 里找名字（post 的 at 元素不带 placeholder key，找不回就 @某人）。
 * 其他类型：返回占位标签，text 为空串。
 *
 * @returns {{kind: string, text: string}|null} kind='text'|'post' 或占位标签；
 *   内容为空 / 解析不出任何文字时返回 null
 */
export function flattenContent(messageType, rawContent, mentions = []) {
  let parsed = null
  try {
    parsed = JSON.parse(rawContent || '{}')
  } catch {
    parsed = null
  }

  if (messageType === 'text') {
    let text = parsed?.text || ''
    for (const mt of mentions) {
      if (!mt?.key) continue
      text = text.split(mt.key).join(`@${mt.name || '某人'}`)
    }
    return text.trim() ? { kind: 'text', text: text.trim() } : null
  }

  if (messageType === 'post') {
    const out = []
    const nameOfId = new Map(mentions.map((mt) => [mt?.id?.user_id || mt?.user_id, mt?.name || '']))
    for (const para of parsed?.content || []) {
      if (!Array.isArray(para)) continue
      const line = []
      for (const el of para) {
        if (!el?.tag) continue
        if (el.tag === 'text') line.push(el.text || '')
        else if (el.tag === 'a') line.push(el.text || el.href || '')
        else if (el.tag === 'at') line.push('@' + (nameOfId.get(el.user_id) || '某人'))
        else if (el.tag === 'img') line.push('[图片]')
      }
      if (line.length) out.push(line.join(''))
    }
    const text = out.join('\n').trim()
    return text ? { kind: 'post', text } : null
  }

  // 非文本：占位。interactive（卡片）不展开——别的 agent 的卡片可能很大，
  // 展开是另一个量级的成本，需要细节让模型自己去拉
  const label = TYPE_LABEL[messageType] || '消息'
  return { kind: label, text: '' }
}

/**
 * 群消息的内存环形缓冲。按上下文键分桶；单桶封顶防长刷屏话题无限膨胀，
 * 桶数封顶防进一堆群后内存失控（最旧未活跃的桶先被挤掉）。
 */
export class TopicLog {
  constructor({ maxKeys = 128, maxPerKey = 60 } = {}) {
    this.maxKeys = maxKeys
    this.maxPerKey = maxPerKey
    /** @type {Map<string, Array<{messageId:string, ts:number, senderId:string, senderType:string, kind:string, text:string, atMe:boolean}>>} */
    this.map = new Map()
  }

  push(key, item) {
    if (!key || !item) return
    let arr = this.map.get(key)
    if (!arr) {
      arr = []
      this.map.set(key, arr)
      // 桶数超限时逐掉最旧的桶（Map 保持插入序，最早进的先被逐）
      while (this.map.size > this.maxKeys) {
        const oldest = this.map.keys().next().value
        this.map.delete(oldest)
      }
    }
    arr.push(item)
    if (arr.length > this.maxPerKey) arr.splice(0, arr.length - this.maxPerKey)
  }

  /**
   * 取某键最近 limit 条（时间正序），排除指定消息（@ 我的那条自己是 prompt，
   * 不该在近况里重复出现）。重推去重按 messageId。
   */
  snapshot(key, { excludeId = '', limit = 20 } = {}) {
    const arr = this.map.get(key)
    if (!arr?.length) return []
    const seen = new Set()
    const out = []
    for (const it of arr) {
      if (excludeId && it.messageId === excludeId) continue
      if (it.messageId && seen.has(it.messageId)) continue
      if (it.messageId) seen.add(it.messageId)
      out.push(it)
    }
    return out.slice(-limit)
  }
}

function hhmm(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function truncate(str, n) {
  const s = String(str || '')
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/**
 * 把近况条目渲染成模型可读的文本。
 *
 * 行格式：`[19:52] 邱琪光: 内容`；机器人发送者带（机器人）标注——语气和防
 * 循环的判据，与主前缀的 senderType 同一用途。名字取不到给完整 open_id：
 * @ 回去要完整 id，截断了就 @ 不回去（同「可@的 id」行的原则）。
 *
 * @ 过我的轮次渲染成指针行：`→ [19:55] 名字: <前40字>…（已 @ 我）`。那些
 * 正文已经作为 prompt 进了会话历史，整段重给是双倍 input；指针行保住的
 * 是时间线交错——模型能看出「这句讨论发生在我被唤醒处理那次之后」。
 *
 * 总量超限时保尾（最近优先），被裁掉的条数在开头注明。
 *
 * @returns {{text: string, count: number}} count = 实际带上的条数（供模板 {{n}}）
 */
export function renderTopicContext(items, nameOf, { maxChars = 2500 } = {}) {
  if (!items?.length) return { text: '', count: 0 }
  const name = (it) => {
    const n = nameOf?.(it.senderId)
    return (n ? n : it.senderId || '未知') + (it.senderType === 'app' ? '（机器人）' : '')
  }
  const lineOf = (it) => {
    const head = `[${hhmm(it.ts)}] ${name(it)}: `
    if (it.atMe) return `→ ${head}${truncate(it.text, POINTER_CHARS)}${it.text.length > POINTER_CHARS ? '…' : ''}（已 @ 我）`
    if (!it.text) return `${head}[${it.kind}]`
    return `${head}${truncate(it.text, PER_MSG_CHARS)}`
  }

  const lines = items.map(lineOf)
  // 保尾：从最新的往回收集，直到超过总量。至少留一条——一条都带不上
  // 近况就没有意义了
  const kept = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i].length + 1
    if (used + len > maxChars && kept.length) break
    used += len
    kept.unshift(lines[i])
  }
  const dropped = lines.length - kept.length
  const prefix = dropped > 0 ? `（更早的 ${dropped} 条已省略）\n` : ''
  return { text: prefix + kept.join('\n'), count: kept.length }
}
