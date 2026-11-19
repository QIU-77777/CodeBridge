#!/usr/bin/env node
/**
 * 双实现对照判定逻辑的离线测试：不发 prompt、不起后端。
 *   node scripts/test-parity.mjs
 *
 * 用合成 RunState 验证 compareProjections 的判定。判定分两类，依据是
 * 2026-11-19 的正式对照实测：
 *   进判定  终态、工具（名字序列与结果状态）
 *   只观察  文本、用量、工具参数
 * 用量只观察的理由是两侧读数口径不同（OAR 报累计多调用并把缓存加回 input，
 * 桥接报单次调用不含缓存且取哪次不确定），跨模式比大小永远得不到结论。
 */
import { RunState } from '../src/render.js'
import { compareProjections, formatComparison } from '../src/parity.js'

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name} ${extra}`)
  }
}

/** 造一个跑完的运行态：正文、工具、终态、用量 */
function makeRun({ text = '结论：跑通了。', tools = [], status = 'done', tokens = { input: 100, output: 20 }, error = null }) {
  const st = new RunState('ses_x')
  st.text = text
  st.tools = tools
  st.status = status
  st.tokens = tokens
  st.error = error
  return st
}

/** 给一个运行态补上 cacheRead，用来验「只报观察」 */
function withCacheRead(run, v) {
  run.tokens = { ...run.tokens, cacheRead: v }
  return run
}

const tool = (_name, input, status = 'ok') => ({ id: 't1', name: _name, input, status, output: '' })

// ---------- 1. 判定项一致判通过 ----------

{
  const a = makeRun({ tools: [tool('bash', { command: 'node --version' })] })
  const b = makeRun({ tools: [tool('bash', { command: 'node --version' })] })
  const r = compareProjections(a, b)
  ok(r.ok === true, '判定项全部相同判通过', JSON.stringify(r.diffs))
  ok(r.notes.length === 0, '没有差异时没有观察项', JSON.stringify(r.notes))
  ok(formatComparison('pi 对照', r).includes('判定项全部一致'), '一致的报告说清判定项')
}

// ---------- 2. 文本：只在一侧空时判失败 ----------

{
  const r = compareProjections(makeRun({ text: '' }), makeRun({ text: '有内容' }))
  ok(r.ok === false && r.diffs.some((d) => d.aspect === '文本'), '一侧空一侧非空判失败', JSON.stringify(r.diffs))
  ok(r.diffs[0].detail.includes('（空）'), '报告标出哪侧空', r.diffs[0].detail)

  // 两侧措辞不同：模型的采样不确定性，只报观察
  const r2 = compareProjections(makeRun({ text: '结论是 A' }), makeRun({ text: '结论是 B' }))
  ok(r2.ok === true, '两侧措辞不同不判失败', JSON.stringify(r2.diffs))
  ok(r2.notes.some((x) => x.startsWith('正文措辞不同')), '措辞差异报观察项', JSON.stringify(r2.notes))
  ok(r2.notes.some((x) => x.includes('结论是 A') && x.includes('结论是 B')), '观察项带两侧原文', JSON.stringify(r2.notes))

  // 两边都空且终态相同：空答复回合，记观察不判失败
  const r3 = compareProjections(makeRun({ text: '' }), makeRun({ text: '' }))
  ok(r3.ok === true, '两边都空且终态相同判通过（空答复回合）', JSON.stringify(r3.diffs))
  ok(r3.notes.some((x) => x.includes('都为空')), '空答复记观察项', JSON.stringify(r3.notes))

  // 归一化：临时路径、时间戳、空白差异不该产生观察项
  const r4 = compareProjections(
    makeRun({ text: '写入了 /tmp/build-1234/out.log，时间 2026-11-18T10:00:00Z' }),
    makeRun({ text: '写入了 /tmp/build-9999/out.log，时间 2026-11-18T11:22:33Z' }),
  )
  ok(r4.ok === true && !r4.notes.some((x) => x.startsWith('正文措辞')), '临时路径与时间戳归一化后不误报', JSON.stringify(r4.notes))
}

// ---------- 3. 工具：只判「有没有」，序列与参数只报观察 ----------

{
  // 一侧调了工具另一侧没调：结构性差异，判失败
  const r = compareProjections(makeRun({ tools: [] }), makeRun({ tools: [tool('bash', { command: 'ls' })] }))
  ok(r.ok === false && r.diffs.some((d) => d.aspect === '工具'), '一侧有工具一侧没有判失败', JSON.stringify(r.diffs))

  const r2 = compareProjections(makeRun({ tools: [] }), makeRun({ tools: [] }))
  ok(r2.ok === true, '两侧都没有工具判通过', JSON.stringify(r2.diffs))

  // 序列不同：模型自己决定分几次调用（实测同一句 prompt 两侧各自都跑出过 3 次和 4 次）
  const r3 = compareProjections(
    makeRun({ tools: [tool('bash', { command: 'x' }), tool('bash', { command: 'y' }), tool('read', { path: '/a' })] }),
    makeRun({ tools: [tool('bash', { command: 'x' }), tool('bash', { command: 'y' }), tool('bash', { command: 'z' }), tool('read', { path: '/a' })] }),
  )
  ok(r3.ok === true, '工具序列不同不判失败', JSON.stringify(r3.diffs))
  ok(r3.notes.some((x) => x.startsWith('工具序列不同')), '序列差异报观察项', JSON.stringify(r3.notes))

  // 两侧都调了工具但名字不同：也只报观察
  const r4 = compareProjections(
    makeRun({ tools: [tool('bash', { command: 'ls' })] }),
    makeRun({ tools: [tool('read', { filePath: '/tmp/x' })] }),
  )
  ok(r4.ok === true, '两侧都调了工具但名字不同不判失败', JSON.stringify(r4.diffs))

  // 参数键集合不同：模型选不选带可选参数，只报观察
  const r5 = compareProjections(
    makeRun({ tools: [tool('read', { path: '/a', limit: 10 })] }),
    makeRun({ tools: [tool('read', { path: '/a' })] }),
  )
  ok(r5.ok === true, '工具参数键集合不同不判失败', JSON.stringify(r5.diffs))
  ok(r5.notes.some((x) => x.startsWith('工具参数不同')), '参数差异报观察项', JSON.stringify(r5.notes))

  // 参数值不同但键集合相同：连观察项都没有
  const r6 = compareProjections(
    makeRun({ tools: [tool('bash', { command: 'ls', extra: 1 })] }),
    makeRun({ tools: [tool('bash', { command: 'ls', extra: 2 })] }),
  )
  ok(r6.ok === true && r6.notes.length === 0, '参数值不同但键集合相同，连观察项都没有', JSON.stringify(r6.notes))
}

// ---------- 4. 终态 ----------

{
  const r = compareProjections(makeRun({ status: 'done' }), makeRun({ status: 'failed', error: { message: '模型调用失败' } }))
  ok(r.ok === false && r.diffs.some((d) => d.aspect === '终态'), '终态不同判失败', JSON.stringify(r.diffs))

  // 都失败时比归类，不比原文
  const r2 = compareProjections(
    makeRun({ status: 'failed', error: { message: 'rate limit exceeded' } }),
    makeRun({ status: 'failed', error: { message: '429 too many requests' } }),
  )
  ok(r2.ok === true, '都失败且归类相同判通过（限流的两句原文不同但归类同）', JSON.stringify(r2.diffs))

  const r3 = compareProjections(
    makeRun({ status: 'failed', error: { message: '401 unauthorized' } }),
    makeRun({ status: 'failed', error: { message: 'rate limit exceeded' } }),
  )
  ok(r3.ok === false && r3.diffs.some((d) => d.aspect === '终态' && d.detail.includes('归类')), '失败归类不同判失败', JSON.stringify(r3.diffs))
}

// ---------- 5. 用量：只报观察，不判定 ----------

{
  // 读数口径不同，多大的差都不判失败
  const r = compareProjections(makeRun({ tokens: { input: 9190, output: 8 } }), makeRun({ tokens: { input: 29118, output: 33 } }))
  ok(r.ok === true, '用量差 30 倍也不判失败（两侧读数口径不同）', JSON.stringify(r.diffs))
  ok(r.notes.some((x) => x.startsWith('input')), 'input 差报观察项', JSON.stringify(r.notes))
  ok(r.notes.some((x) => x.startsWith('output')), 'output 差报观察项', JSON.stringify(r.notes))
  ok(r.notes.every((x) => x.includes('不计入判定')), '观察项都写明不计入判定', JSON.stringify(r.notes))

  // 一侧整个没有用量：同样是观察，不判失败
  const r2 = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), makeRun({ tokens: null }))
  ok(r2.ok === true, '一侧没有用量不判失败（只报观察）', JSON.stringify(r2.diffs))
  ok(r2.notes.some((x) => x.startsWith('input')), '缺失的用量报观察项', JSON.stringify(r2.notes))

  // cacheRead：只报观察
  const r3 = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), withCacheRead(makeRun({ tokens: { input: 100, output: 20 } }), 14080))
  ok(r3.ok === true, 'cacheRead 不同不判失败', JSON.stringify(r3.diffs))
  ok(r3.notes.some((x) => x.startsWith('cacheRead')), 'cacheRead 报观察项', JSON.stringify(r3.notes))

  // 用量完全相同：没有观察项
  const r4 = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), makeRun({ tokens: { input: 100, output: 20 } }))
  ok(r4.notes.length === 0, '用量相同时没有观察项', JSON.stringify(r4.notes))

  // cost 允许一边有一边没有：不产生观察项（OAR 不给金额，这不是读数口径问题）
  const r5 = compareProjections(makeRun({ tokens: { input: 100, output: 20, cost: 0.0123 } }), makeRun({ tokens: { input: 100, output: 20 } }))
  ok(r5.ok === true && r5.notes.length === 0, '一边有 cost 一边没有不报观察', JSON.stringify(r5.notes))
}

// ---------- 6. 组合：判定项失败时观察项照样出 ----------

{
  const r = compareProjections(
    makeRun({ text: 'A 侧答复', tools: [tool('bash', { command: 'x' })], status: 'done', tokens: { input: 9190, output: 8 } }),
    makeRun({ text: 'B 侧答复', tools: [tool('read', { path: '/a' })], status: 'aborted', tokens: { input: 29118, output: 33 } }),
  )
  ok(r.ok === false, '判定项失败判失败')
  ok(r.diffs.some((d) => d.aspect === '终态'), '终态报出来', JSON.stringify(r.diffs))
  ok(r.notes.some((x) => x.startsWith('工具序列不同')), '工具序列作为观察项报出来', JSON.stringify(r.notes))
  ok(r.notes.some((x) => x.startsWith('正文措辞')), '判定项失败时观察项照样出', JSON.stringify(r.notes))
  ok(r.notes.some((x) => x.startsWith('input')), '用量观察项照样出', JSON.stringify(r.notes))
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
