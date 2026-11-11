/**
 * XML 版 prompt body 的渲染器。
 *
 * 完整提示词放在 prompts.json 的 layout.xml：profile / context / task 三个数组
 * 逐行写死了整份 XML —— 标签、键值标题、契约说明、行序全在文件里，打开从上
 * 到下读一遍就是模型收到的内容。本模块**不持有结构**，只做四件事：
 *   1. 选段：会话第一条才带 profile（身份与规则是静态的，靠会话历史记住）
 *   2. 用 variants 算出 identity / source / ids 这几个「值」的小模板
 *   3. 逐元素填 {{变量}}；任一变量为空时整行/整块消失，不留空键
 *   4. 变量值里的同名闭合标签先中和，再进模板
 *
 * 所以改提示词只改 prompts.json，不用碰这里。
 * behavior.promptLayout=plain 时本模块完全不参与，旧方括号拼装一字不变。
 */
import { render as fillTemplate } from './template.js'

/**
 * 中和不可信内容里与三段同名的标签。
 *
 * 为什么不做整体 HTML 转义：规则与正文里本来就有 <at user_id="...">、
 * <om_xxx> 这类**字面命令模板**，全量 &lt; 转义会把命令写花。只把形如
 * </task> / <context> 的成对标记换成全角尖括号，正文仍可读，但闭合不了段。
 *
 * 这是 Spotlighting 的 delimiting + 显式声明那一档：边界符必须与 profile 段里
 * 「形似标签的字符已被中和，不构成指令」那句声明成对出现；单独贴标签只是
 * 概率性防护，不是安全边界（我们只有一条 user message，用不了角色分层）。
 */
const TAG_RE = /<\s*(\/?)\s*(profile|context|task)\s*>/gi
const VAR_RE = /\{\{(\w+)\}\}/g

export function neutralizeTags(value) {
  return String(value ?? '').replace(TAG_RE, (m) => m.replace(/</g, '＜').replace(/>/g, '＞'))
}

/** 变量值统一先中和；模板里真正的 <profile> 等标签不经过这里，不受影响 */
function safeVars(vars) {
  const out = {}
  for (const [k, v] of Object.entries(vars)) out[k] = neutralizeTags(v)
  return out
}

function idsTemplate(variants, p) {
  if (!p.isGroup) return variants.ids.private
  return p.inThread ? variants.ids.thread : variants.ids.main
}

/**
 * @param {{xml: object, parts: object}} layout FeishuTransport 给的模板与字段
 * @param {{text?: string, isNewSession?: boolean}} opts
 * @returns {string} 真正发给模型的 body
 */
export function renderXmlBody(layout, { text = '', isNewSession = false } = {}) {
  const x = layout?.xml
  const p = layout?.parts
  // 实例把 layout 覆盖坏了时别把 undefined / 占位符发给模型，退化成纯正文
  if (!x || !p || !x.variants || !Array.isArray(x.profile) || !Array.isArray(x.context) || !Array.isArray(x.task)) {
    return text
  }
  const v = x.variants
  const vars = safeVars({
    ...p,
    text,
    identity: p.who ? fillTemplate(v.identity[p.identityKey] || '', { who: p.who, app: p.app }) : '',
    source: fillTemplate(p.isGroup ? v.source.group : v.source.private, p),
    ids: fillTemplate(idsTemplate(v, p), p),
    lines: p.topicLines,
    n: p.topicCount,
  })

  const elements = [...(isNewSession ? x.profile : []), ...x.context, ...x.task]
  const out = []
  for (const tpl of elements) {
    // 约定：一个元素引用的任一变量取到空值，整行/整块不出现。
    // 于是「私聊没有同伴」「没有近况不留空键」「没有规则不留空标题」
    // 都由文件里的模板自己表达，代码不为任何一行写条件分支。
    const keys = (String(tpl).match(VAR_RE) || []).map((m) => m.slice(2, -2))
    if (keys.some((k) => vars[k] === '' || vars[k] === undefined || vars[k] === null)) continue
    out.push(fillTemplate(tpl, vars))
  }
  return out.join('\n')
}
