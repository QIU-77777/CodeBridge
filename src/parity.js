/**
 * 双实现对照：同一个 prompt 走两条路，比投影到卡片状态机的结果。
 *
 * 两条路：
 *   桥接现有 pi 后端（src/pi.js，长驻 RPC 进程 + JSONL 合成事件）
 *   OAR 的 pi 适配器（@botiverse/oar，事件经 src/oar-events.js 翻译）
 *
 * 判定不看事件原型是否相同，看投影到 RunState 之后是否一致。事件流天然不可
 * 逐条对齐（两侧的帧粒度、合并策略、序号都不同），能对齐的是「用户最终在
 * 卡片上看到什么」：正文、工具行、终态、用量。
 *
 * 四个对照项：
 *   文本   两侧正文拼接结果
 *   工具   名称、参数、结果状态（exitCode 只在运行时报告时有，不要求两边都有）
 *   终态   done / failed / aborted，失败时再比错误的归类
 *   用量   input / output 走容差带（带内只报观察项），cacheRead 只报不断定，
 *          cost 允许一边空（OAR 不给金额）
 *
 * 文本与工具输出做归一化再比：模型同样一句话，两次运行的空白、标点、工具
 * 输出里的时间戳与临时路径都可能不同。完全字字相同的要求不现实，会把对照
 * 变成运气。归一化去掉这些，剩下的差异才是真差异。
 */
import { truncate } from './render.js'
import { classifyError } from './errors.js'

/** 归一化：去首尾空白、压连续空白、去掉临时路径与时间戳 */
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/\/tmp\/[^\s)'"]+/g, '<tmp>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<time>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 工具行归一化：参数只比键集合与可读的摘要，不逐字节比 JSON */
function toolKey(t) {
  const input = t.input && typeof t.input === 'object' ? t.input : {}
  const keys = Object.keys(input).sort().join(',')
  const raw = typeof t.input === 'string' ? t.input : ''
  return `${t.name}|${keys}|${raw ? 'raw' : ''}`
}

/**
 * 用量容差：最大值的 5% 与 5 个 token 取大。
 *
 * 5% 抓住装配丢失（一侧整个不发用量是 100% 级偏差）与字段映射错误（cacheRead
 * 算进 input 也是数百 token 级）；5 的绝对下限让小输出（二十几个 token 的回
 * 合）的采样噪声不绊倒判定。
 *
 * 带宽依据（2026-11-19 双实现实测，同目录同 prompt，各一个全新会话）：两种
 * 模式的真实装配差只有 18 token（桥接 14523 对 OAR 14541）；连跑两遍的波动
 * 数百 token，全部来自提供商侧提示缓存——顺序执行时后跑的一侧吃前一侧刚热
 * 的缓存，OAR 第二遍 input 从 14541 涨到 14733、cacheRead 从 0 跳到 14080。
 * 精确相等只对同模式重复跑成立（桥接侧连跑两遍 14523 对 14523），那是对照
 * 脚本给自己的要求，不是跨模式判定能用的。
 */
function usageSlack(x, y) {
  return Math.max(5, Math.ceil(Math.max(x, y) * 0.05))
}

/**
 * 比两个运行态。
 *
 * @param {import('./render.js').RunState} a 桥接侧
 * @param {import('./render.js').RunState} b OAR 侧
 * @returns {{ok: boolean, diffs: Array<{aspect: string, detail: string}>}}
 */
export function compareProjections(a, b) {
  const diffs = []
  // notes 是只报不断定的观察项：真实存在但不构成实现差异
  const notes = []

  // 1. 文本
  const ta = norm(a.text)
  const tb = norm(b.text)
  if (ta !== tb) {
    diffs.push({
      aspect: '文本',
      detail: `两侧正文不同\n  桥接：${truncate(ta, 400)}\n  OAR ：${truncate(tb, 400)}`,
    })
  }

  // 2. 工具
  const ka = a.tools.map(toolKey)
  const kb = b.tools.map(toolKey)
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
    diffs.push({
      aspect: '工具',
      detail: `工具序列不同\n  桥接：${JSON.stringify(ka)}\n  OAR ：${JSON.stringify(kb)}`,
    })
  } else {
    // 序列一致时再比每个工具的结果状态
    const bad = a.tools.map((t, i) => ({ t, o: b.tools[i] })).filter(({ t, o }) => t.status !== o.status)
    if (bad.length) {
      diffs.push({
        aspect: '工具',
        detail: `工具结果状态不同：${bad.map(({ t, o }) => `${t.name} ${t.status}≠${o.status}`).join('；')}`,
      })
    }
  }

  // 3. 终态
  if (a.status !== b.status) {
    diffs.push({ aspect: '终态', detail: `桥接 ${a.status}，OAR ${b.status}` })
  }
  if (a.status === 'failed' && b.status === 'failed') {
    // 失败时比归类（src/errors.js 的 classifyError），不比原文
    const ca = classify(a.error?.message)
    const cb = classify(b.error?.message)
    if (ca !== cb) diffs.push({ aspect: '终态', detail: `失败归类不同：${ca} ≠ ${cb}` })
  }

  // 4. 用量。三项都按「只在异常时判不一致」处理：
  //
  // input / output 走容差带，带内只报观察项。跨模式对照不要求精确相等：两种
  // 模式的真实装配差只有 18 token，连跑的数百 token 波动全是提供商侧提示缓存
  // 按执行顺序造成的（依据见 usageSlack 的注释）。精确相等留给同模式重复跑。
  //
  // cacheRead 只报不断定：它反映执行顺序，不反映实现差异。
  //
  // cost 允许一边没有：OAR 的用量接口不给金额，要显示得宿主自己按单价表算。
  const ua = a.tokens || {}
  const ub = b.tokens || {}
  for (const k of ['input', 'output']) {
    const x = Number(ua[k] || 0)
    const y = Number(ub[k] || 0)
    const delta = Math.abs(x - y)
    const slack = usageSlack(x, y)
    if (delta > slack) {
      diffs.push({
        aspect: '用量',
        detail: `${k} 偏差超容差带：桥接 ${ua[k] ?? '空'}，OAR ${ub[k] ?? '空'}（差 ${delta}，容差 ${slack}）`,
      })
    } else if (delta > 0) {
      notes.push(`${k}：桥接 ${ua[k] ?? '空'}，OAR ${ub[k] ?? '空'}（差 ${delta}，容差 ${slack} 内，装配与缓存噪声，不计入判定）`)
    }
  }
  // cacheRead 只报不断言。两条路是顺序跑的，后跑的那一侧吃前一侧刚热的提示
  // 缓存，cacheRead 因此反映的是执行顺序，不是实现差异。实测：先跑桥接再跑
  // OAR，OAR 第二遍 cacheRead 从 0 跳到 14080、input 从 14541 涨到 14733。
  // 要对照缓存行为得两条路各跑两遍比第二次，那不在本对照的范围里
  if (Number(ua.cacheRead || 0) !== Number(ub.cacheRead || 0)) {
    notes.push(`cacheRead：桥接 ${ua.cacheRead ?? '空'}，OAR ${ub.cacheRead ?? '空'}（顺序执行的缓存差，不计入判定）`)
  }

  return { ok: diffs.length === 0, diffs, notes }
}

/** 错误归类：复用卡片那一套，对照的是「给人看的那句话」 */
function classify(message) {
  return classifyError(String(message || ''))?.label || 'unknown'
}

/** 人看的对照报告 */
export function formatComparison(label, result) {
  const head = result.ok ? `✅ ${label}：四项全部一致` : `❌ ${label}：${result.diffs.length} 处不一致`
  const body = result.diffs.map((d) => `  [${d.aspect}] ${d.detail}`).join('\n')
  const notes = (result.notes || []).map((x) => `  [观察] ${x}`).join('\n')
  return [head, body, notes].filter(Boolean).join('\n')
}
