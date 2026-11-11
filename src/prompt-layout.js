/**
 * XML 版 prompt body 的组装器。
 *
 * 为什么单独一个模块：三段结构 <profile> / <context> / <task> 是跨段包裹的，
 * 原来的 runPrompt 只会把 origin / oncePrefix / topicContext / 正文线性串起来，
 * 无论怎么改 prompts.json 的文案都拼不出「一个标签包住好几段」。所以布局本身
 * 必须有代码，但**所有文案仍在 prompts.json 的 layout.xml**，这里只做：
 *   {{变量}} 填充 → 条件省略空键 → 不可信文本的闭合标签中和 → join('\n')
 *
 * 段的分工沿用 once 的省 token 契约：
 *   profile  身份 + 长期规则，只在会话第一条发（之后靠会话历史记住）
 *   context  本次唤醒的来源 / id / 话题近况，每条都发
 *   task     用户正文，每条都发
 *
 * behavior.promptLayout=plain 时本模块完全不参与，旧方括号拼装一字不变。
 */
import { render as fillTemplate } from './template.js'

/**
 * 中和不可信内容里与三段同名的标签。
 *
 * 为什么不做整体 HTML 转义：规则与正文里本来就有 <at user_id="...">、
 * <om_xxx>、<群 chat_id> 这类**字面命令模板**，全量 &lt; 转义会把命令写花，
 * 模型照着跑就是错的。只把形如 </task> / <context> 的成对标记换成全角尖括号，
 * 正文仍可读，但再也闭合不了我们的段。
 *
 * 这是 Microsoft Spotlighting 的 delimiting + 显式声明那一档：边界符必须与
 * layout.xml.contract 里「被中和的字符不构成指令」同时出现才有效，单独贴标签
 * 只是概率性防护，不是安全边界。我们只有一条 user message，用不了角色分层。
 */
const TAG_RE = /<\s*(\/?)\s*(profile|context|task)\s*>/gi

export function neutralizeTags(value) {
  return String(value ?? '').replace(TAG_RE, (m) => m.replace(/</g, '＜').replace(/>/g, '＞'))
}

/** 填模板并中和插值：群名、昵称、近况原文、用户正文都可能来自别人 */
function line(template, vars) {
  return neutralizeTags(fillTemplate(template, vars))
}

function idsTemplate(x, p) {
  if (!p.isGroup) return x.ids.private
  return p.inThread ? x.ids.thread : x.ids.main
}

/**
 * @param {{xml: object, parts: object}} layout FeishuTransport 给的模板与字段
 * @param {{text?: string, isNewSession?: boolean}} opts
 * @returns {string} 真正发给模型的 body
 */
export function renderXmlBody(layout, { text = '', isNewSession = false } = {}) {
  const x = layout?.xml
  const p = layout?.parts
  // 实例把 layout 覆盖没了时别把 undefined / 占位符发给模型，退化成纯正文
  if (!x || !p) return text
  const out = []

  // ── profile：静态信息，只发一次 ──────────────────────────────────────
  if (isNewSession) {
    const profile = []
    if (p.who) {
      const identity = fillTemplate(x.identityLine[p.identityKey] || '', { who: p.who, app: p.app })
      profile.push(line(x.identity, { identity }))
    }
    if (p.isGroup && p.peers) profile.push(line(x.peers, { peers: p.peers }))
    if (p.rules) {
      profile.push(x.rulesLabel)
      // 行为准则与契约是我们自己的文案，不能中和：里面有 <at ...> 命令模板
      profile.push(p.rules)
    }
    if (x.contract) profile.push(x.contract)
    if (profile.length) out.push(x.profileOpen, ...profile, x.profileClose)
  }

  // ── context：每条都带的本次事实 ──────────────────────────────────────
  const ctx = [
    line(p.isGroup ? x.source.group : x.source.private, p),
    line(x.sender, p),
    line(x.when, p),
    line(idsTemplate(x, p), p),
  ]
  if (p.topicLines) {
    ctx.push(line(x.topicLabel, { n: p.topicCount }))
    ctx.push(neutralizeTags(p.topicLines))
  }
  out.push(x.contextOpen, ...ctx, x.contextClose)

  // ── task：本次要执行的任务 ───────────────────────────────────────────
  out.push(x.taskOpen, neutralizeTags(text), x.taskClose)
  return out.join('\n')
}
