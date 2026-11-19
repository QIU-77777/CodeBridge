/**
 * 双实现对照：同一个 prompt 走两条路，比投影到卡片状态机的结果。
 *
 * 两条路：
 *   桥接现有 pi 后端（src/pi.js，长驻 RPC 进程 + JSONL 合成事件）
 *   OAR 的 pi 适配器（@botiverse/oar，事件经 src/oar-events.js 翻译）
 *
 * 判定不看事件原型是否相同，看投影到 RunState 之后是否一致。事件流天然不可
 * 逐条对齐（两侧的帧粒度、合并策略、序号都不同），能对齐的是「用户最终在
 * 卡片上看到什么」。
 *
 * 四项里只有两项进判定，另外两项只报观察。分成两类的依据是 2026-11-19 的
 * 正式对照实测（同目录同 prompt，每侧连跑两遍）：
 *
 *   进判定  终态      精确相等。这是翻译层最直接的产出，两侧必须一致
 *            工具      只比工具名的序列与结果状态，精确相等
 *   只观察  文本      模型的采样不确定性让两次运行的措辞必然不同，逐字判定
 *                      是把对照变成运气
 *            用量      两侧读数口径不同（见下），跨模式比用量永远得不到结论
 *            工具参数   模型自己选不选带可选参数（read 带不带 limit），不是
 *                      实现差异
 *
 * 用量为什么只观察，不判定：两侧的口径不同，而且差异是结构性的，等不来。
 *   OAR 侧：usage 事件是 adaptTokens 往上叠的累计值，报的是整个回合所有模型
 *     调用（工具调用加最终答复）的合计，并且把缓存读取加回 input
 *     （@botiverse/oar dist/runtimes/pi/projection.js 的 accumulate）
 *   桥接侧：读 pi 原始 usage 的单次调用值，input 不含缓存读取，而且取哪一次
 *     调用不确定（pickUsage 取「最后一个 input/output 非零的事件」，取决于用量
 *     事件与终态事件谁先到）
 * 实测对得上：OAR 侧 29118 = (9160+5376) + (14582+0)，29310 = (648+14080) +
 * (502+14080)；桥接侧 9190 是调用 1 的未缓存输入，486 是调用 2 的。两侧送进
 * 模型的上下文大小是同一个量级（约 14.5k），差的是读数单位，不是装配。
 *
 * 真正能判定用量的地方是同模式重复跑（parity-pi-oar.mjs 的自检），那才是抓
 * 「装配不确定」类回归的信号。
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

/** 工具名序列：只比名字，参数另算 */
function toolNames(tools) {
  return tools.map((t) => t.name || '?')
}

/** 参数键集合：模型选不选带可选参数，报出来给人看，不判定 */
function toolParams(tools) {
  return tools.map((t) => {
    const input = t.input && typeof t.input === 'object' ? t.input : {}
    const keys = Object.keys(input).sort().join(',')
    return keys ? `${t.name}(${keys})` : t.name
  })
}

/**
 * 比两个运行态。
 *
 * @param {import('./render.js').RunState} a 桥接侧
 * @param {import('./render.js').RunState} b OAR 侧
 * @returns {{ok: boolean, diffs: Array<{aspect: string, detail: string}>, notes: string[]}}
 */
export function compareProjections(a, b) {
  const diffs = []
  // notes 是只报不断定的观察项：真实存在但不构成实现差异
  const notes = []

  // 1. 文本：一方空一方非空判失败；都非空只报观察（措辞不可复现）
  const ta = norm(a.text)
  const tb = norm(b.text)
  if (!ta && !tb) {
    // 两边都空：终态相同的情况下是空答复回合，记观察；终态不同第 3 条已经抓
    if (a.status === b.status) notes.push('两侧正文都为空（空答复回合）')
  } else if (!ta || !tb) {
    diffs.push({
      aspect: '文本',
      detail: `一侧没有正文\n  桥接：${truncate(ta, 400) || '（空）'}\n  OAR ：${truncate(tb, 400) || '（空）'}`,
    })
  } else if (ta !== tb) {
    notes.push(`正文措辞不同（模型采样不确定性，不计入判定）\n  桥接：${truncate(ta, 300)}\n  OAR ：${truncate(tb, 300)}`)
  }

  // 2. 工具：名字序列与结果状态精确相等；参数键集合只报观察
  const na = toolNames(a.tools)
  const nb = toolNames(b.tools)
  if (na.length !== nb.length || na.some((n, i) => n !== nb[i])) {
    diffs.push({
      aspect: '工具',
      detail: `工具序列不同\n  桥接：${JSON.stringify(na)}\n  OAR ：${JSON.stringify(nb)}`,
    })
  } else {
    const bad = a.tools.map((t, i) => ({ t, o: b.tools[i] })).filter(({ t, o }) => t.status !== o.status)
    if (bad.length) {
      diffs.push({
        aspect: '工具',
        detail: `工具结果状态不同：${bad.map(({ t, o }) => `${t.name} ${t.status}≠${o.status}`).join('；')}`,
      })
    }
    const pa = toolParams(a.tools).join(' | ')
    const pb = toolParams(b.tools).join(' | ')
    if (pa !== pb) {
      notes.push(`工具参数不同（模型选不选带可选参数，不计入判定）\n  桥接：${pa}\n  OAR ：${pb}`)
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

  // 4. 用量：只报观察，不判定。两侧读数口径不同（见文件头），跨模式比大小得不到
  // 结论。原始数字全部打出来，人眼看着判断
  const ua = a.tokens || {}
  const ub = b.tokens || {}
  for (const k of ['input', 'output', 'cacheRead']) {
    const x = ua[k]
    const y = ub[k]
    if (Number(x || 0) === Number(y || 0)) continue
    notes.push(`${k}：桥接 ${x ?? '空'}，OAR ${y ?? '空'}（两侧读数口径不同，不计入判定）`)
  }

  return { ok: diffs.length === 0, diffs, notes }
}

/** 错误归类：复用卡片那一套，对照的是「给人看的那句话」 */
function classify(message) {
  return classifyError(String(message || ''))?.label || 'unknown'
}

/** 人看的对照报告 */
export function formatComparison(label, result) {
  const head = result.ok ? `✅ ${label}：判定项全部一致` : `❌ ${label}：${result.diffs.length} 处不一致`
  const body = result.diffs.map((d) => `  [${d.aspect}] ${d.detail}`).join('\n')
  const notes = (result.notes || []).map((x) => `  [观察] ${x}`).join('\n')
  return [head, body, notes].filter(Boolean).join('\n')
}
