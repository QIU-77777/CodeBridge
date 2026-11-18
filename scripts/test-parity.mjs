#!/usr/bin/env node
/**
 * 双实现对照逻辑的离线测试：不发 prompt、不起后端。
 *   node scripts/test-parity.mjs
 *
 * 用合成 RunState 验证 compareProjections 的判定：一致时判一致，差在哪一项
 * 说清哪一项，该容忍的差异（空白、临时路径、时间戳、用量在容差带内、cost 一边
 * 没有）不误报。
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

/** 给一个运行态补上 cacheRead，用来验「0 与缺失等价」 */
function withCacheRead(run, v) {
  run.tokens = { ...run.tokens, cacheRead: v }
  return run
}

const tool = (_name, input, status = 'ok') => ({ id: 't1', name: _name, input, status, output: '' })

// ---------- 1. 一致判一致 ----------

{
  const a = makeRun({ tools: [tool('bash', { command: 'node --version' })] })
  const b = makeRun({ tools: [tool('bash', { command: 'node --version' })] })
  const r = compareProjections(a, b)
  ok(r.ok === true, '两侧完全相同判一致', JSON.stringify(r.diffs))
  ok(formatComparison('pi 对照', r).includes('四项全部一致'), '一致的报告说清四项')
}

// ---------- 2. 文本差异 ----------

{
  const r = compareProjections(makeRun({ text: '结论是 A' }), makeRun({ text: '结论是 B' }))
  ok(r.ok === false, '正文不同判不一致')
  ok(r.diffs.length === 1 && r.diffs[0].aspect === '文本', '只报文本一项', JSON.stringify(r.diffs))
  ok(r.diffs[0].detail.includes('结论是 A') && r.diffs[0].detail.includes('结论是 B'), '报告带两侧原文', r.diffs[0].detail)
}

// ---------- 3. 工具差异 ----------

{
  const r = compareProjections(
    makeRun({ tools: [tool('bash', { command: 'ls' })] }),
    makeRun({ tools: [tool('read', { filePath: '/tmp/x' })] }),
  )
  ok(r.ok === false && r.diffs[0].aspect === '工具', '工具名不同判不一致', JSON.stringify(r.diffs))

  const r2 = compareProjections(makeRun({ tools: [tool('bash', { command: 'ls' })] }), makeRun({ tools: [] }))
  ok(r2.ok === false && r2.diffs[0].aspect === '工具', '工具个数不同判不一致')

  const r3 = compareProjections(
    makeRun({ tools: [tool('bash', { command: 'ls' }, 'ok')] }),
    makeRun({ tools: [tool('bash', { command: 'ls' }, 'error')] }),
  )
  ok(r3.ok === false && r3.diffs[0].aspect === '工具' && r3.diffs[0].detail.includes('结果状态'), '工具结果状态不同判不一致', JSON.stringify(r3.diffs))
}

// ---------- 4. 终态差异 ----------

{
  const r = compareProjections(makeRun({ status: 'done' }), makeRun({ status: 'failed', error: { message: '模型调用失败' } }))
  ok(r.ok === false && r.diffs.some((d) => d.aspect === '终态'), '终态不同判不一致', JSON.stringify(r.diffs))

  // 都失败时比归类，不比原文
  const r2 = compareProjections(
    makeRun({ status: 'failed', error: { message: 'rate limit exceeded' } }),
    makeRun({ status: 'failed', error: { message: '429 too many requests' } }),
  )
  ok(r2.ok === true, '都失败且归类相同判一致（限流的两句原文不同但归类同）', JSON.stringify(r2.diffs))

  const r3 = compareProjections(
    makeRun({ status: 'failed', error: { message: '401 unauthorized' } }),
    makeRun({ status: 'failed', error: { message: 'rate limit exceeded' } }),
  )
  ok(r3.ok === false && r3.diffs.some((d) => d.aspect === '终态' && d.detail.includes('归类')), '失败归类不同判不一致', JSON.stringify(r3.diffs))
}

// ---------- 5. 用量差异 ----------

{
  const r = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), makeRun({ tokens: { input: 120, output: 20 } }))
  ok(r.ok === false && r.diffs.some((d) => d.aspect === '用量' && d.detail.includes('input')), '输入 token 差超容差带判不一致', JSON.stringify(r.diffs))

  // 容差带内：装配与缓存噪声只报观察项，不判不一致。实测两种模式的真实装配差
  // 18 token、连跑波动数百 token（全来自提供商侧提示缓存），都在带内
  {
    const r = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), makeRun({ tokens: { input: 105, output: 23 } }))
    ok(r.ok === true, 'token 差在容差带内判一致', JSON.stringify(r.diffs))
    ok(r.notes.some((x) => x.startsWith('input')) && r.notes.some((x) => x.startsWith('output')), '带内的差作为观察项报出来', JSON.stringify(r.notes))
  }

  // 超带：一侧整个不发用量是 100% 级偏差，容差带抓得住
  {
    const r = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), makeRun({ tokens: { input: 0, output: 0 } }))
    ok(r.ok === false && r.diffs.filter((d) => d.aspect === '用量').length === 2, '一侧丢用量判不一致', JSON.stringify(r.diffs))
  }

  // 边界：差正好等于容差不判，超一个 token 就判
  {
    const r = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), makeRun({ tokens: { input: 106, output: 20 } }))
    ok(r.ok === true, '差等于容差不判不一致', JSON.stringify(r.diffs))
    const r2 = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), makeRun({ tokens: { input: 107, output: 20 } }))
    ok(r2.ok === false, '差超容差一个 token 也判不一致', JSON.stringify(r2.diffs))
  }

  // cacheRead 只报不断定：两条路顺序跑，后跑的吃前一侧刚热的缓存，它反映
  // 的是执行顺序不是实现差异
  const r2 = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), makeRun({ tokens: { input: 100, output: 20, cacheRead: 40 } }))
  ok(r2.ok === true, 'cacheRead 不同不断差异', JSON.stringify(r2))
  ok(r2.notes.some((x) => x.includes('cacheRead')), 'cacheRead 的差作为观察项报出来', JSON.stringify(r2.notes))

  // OAR 不给金额：一边有 cost 一边没有，不算差异
  const r3 = compareProjections(
    makeRun({ tokens: { input: 100, output: 20, cost: 0.0123 } }),
    makeRun({ tokens: { input: 100, output: 20 } }),
  )
  ok(r3.ok === true, '一边有 cost 一边没有不算差异（OAR 不给金额）', JSON.stringify(r3.diffs))

  // cacheRead 一边报 0、一边不报：等价，不算差异
  const r4 = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), withCacheRead(makeRun({ tokens: { input: 100, output: 20 } }), 0))
  ok(r4.ok === true, 'cacheRead 一边 0 一边缺失不算差异', JSON.stringify(r4.diffs))
  const r5 = compareProjections(makeRun({ tokens: { input: 100, output: 20 } }), withCacheRead(makeRun({ tokens: { input: 100, output: 20 } }), 40))
  ok(r5.ok === true && r5.notes.some((x) => x.includes('cacheRead')), 'cacheRead 真的不同也只报不断定', JSON.stringify(r5))
}

// ---------- 6. 该容忍的噪声不误报 ----------

{
  const r = compareProjections(
    makeRun({ text: '写入了 /tmp/build-1234/out.log，时间 2026-11-18T10:00:00Z' }),
    makeRun({ text: '写入了 /tmp/build-9999/out.log，时间 2026-11-18T11:22:33Z' }),
  )
  ok(r.ok === true, '临时路径与时间戳归一化后不误报', JSON.stringify(r.diffs))

  const r2 = compareProjections(makeRun({ text: '第一段\n\n第二段' }), makeRun({ text: '第一段  第二段' }))
  ok(r2.ok === true, '空白差异归一化后不误报', JSON.stringify(r2.diffs))

  const r3 = compareProjections(
    makeRun({ tools: [tool('bash', { command: 'ls', extra: 1 })] }),
    makeRun({ tools: [tool('bash', { command: 'ls', extra: 2 })] }),
  )
  ok(r3.ok === true, '工具参数的键集合相同即算一致，值不同不误报', JSON.stringify(r3.diffs))
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
