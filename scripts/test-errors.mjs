#!/usr/bin/env node
/**
 * 错误分类的离线测试：不连飞书、不起后端。
 *   node scripts/test-errors.mjs
 *
 * src/errors.js 是「原始错误文本 → 这是什么问题 + 接下来干什么」的唯一
 * 翻译点（卡片渲染层调用）。这里测两件事：
 *   1. classifyError 本体：每类真实见过的错误文本都能归对类、hint 带上
 *      可执行的下一步；认不出来返回 null（调用方据此不加提示）
 *   2. runCard 集成：失败卡片渲染分类标签与提示，未知错误不臆测
 */
import { RunState } from '../src/render.js'
import { runCard } from '../src/cards.js'
import { classifyError } from '../src/errors.js'

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

// ---------- classifyError 本体 ----------

{
  ok(classifyError(undefined) === null, 'undefined 输入返回 null')
  ok(classifyError(null) === null, 'null 输入返回 null')
  ok(classifyError('') === null, '空串返回 null')
  ok(classifyError(42) === null, '非字符串返回 null（不抛错）')
  ok(classifyError('some totally unknown failure') === null, '认不出的错误返回 null')
}

{
  // 每一类：真实踩到过（或结构上必然出现）的错误原文 + 期望的下一步
  const cases = [
    ['Failed to decode message msg_1a680b70f001 in session ses_ede75d73', 'decode', 'recent'],
    ['RegionError: This model is not available in your country', 'region', '/model'],
    ['Session.BusyError: session is busy', 'busy', '/stop'],
    ['Session.NotFoundError: no such session', 'session-lost', '/new'],
    ['provider.invalid-request: The input you provided is invalid', 'context', '/new'],
    ['401 Unauthorized', 'auth', 'password'],
    ['HTTP 429: Too Many Requests', 'rate-limit', '稍等'],
    ['connect ECONNREFUSED 127.0.0.1:19876', 'network', 'up.sh'],
    ['fetch failed', 'network', 'status'],
    ['503 Service Unavailable', 'network', 'network|网络'],
    ['model not found: some-model-id', 'model', '/model'],
  ]
  for (const [raw, kind, hintPart] of cases) {
    const cls = classifyError(raw)
    ok(cls?.kind === kind, `「${raw.slice(0, 40)}」归类为 ${kind}`, `实际: ${cls?.kind}`)
    const re = new RegExp(hintPart, 'i')
    ok(Boolean(cls && re.test(cls.hint)), `「${raw.slice(0, 40)}」的 hint 含 ${hintPart}`, cls?.hint)
    ok(Boolean(cls && cls.label), '分类结果带人能读的 label')
  }
}

{
  // 优先级：RegionError 的原文里带「model」字样，必须归 region 而不是 model。
  // 宽泛规则放后面，就是为了让具体错误名先被认走
  const cls = classifyError('RegionError: model xxx is not available in your country')
  ok(cls?.kind === 'region', 'RegionError 抢在 model 之前命中')
  // decode 的原文里带「message」/「session」，也不能被 session-lost 抢走
  const cls2 = classifyError('Failed to decode message msg_x in session ses_y')
  ok(cls2?.kind === 'decode', 'decode 抢在 session-lost 之前命中')
}

// ---------- runCard 集成 ----------

{
  const mk = (message) => {
    const s = new RunState('ses_err')
    s.status = 'failed'
    s.startedAt = Date.now() - 500
    s.updatedAt = Date.now()
    s.error = { message }
    return JSON.stringify(runCard(s, { directory: '/Users/x/proj' }))
  }
  ok(mk('connect ECONNREFUSED 127.0.0.1:19876').includes('💡'), '已知错误渲染提示')
  ok(mk('connect ECONNREFUSED 127.0.0.1:19876').includes('网络或服务不可达'), '提示里带分类标签')
  ok(!mk('some totally unknown failure').includes('💡'), '未知错误不加臆测提示')
  ok(mk('The input you provided is invalid').includes('/new'), '输入被拒给 /new 续命提示')
  // 错误原文仍然完整上卡片：分类提示是补充，不是替代
  ok(mk('connect ECONNREFUSED 127.0.0.1:19876').includes('ECONNREFUSED'), '原始错误文本保留在卡片上')
}

{
  // 提示走 notation 小字（2.0 没有 note 组件），位置在错误正文之后
  const s = new RunState('ses_net')
  s.status = 'failed'
  s.error = { message: 'fetch failed' }
  const card = runCard(s, {})
  const els = card.body.elements
  const errIdx = els.findIndex((e) => e.tag === 'div' && /fetch failed/.test(e?.text?.content || ''))
  const noteIdx = els.findIndex((e) => e.tag === 'markdown' && /💡/.test(e?.content || ''))
  ok(errIdx >= 0 && noteIdx > errIdx, '分类提示紧跟错误正文之后')
  ok(els[noteIdx]?.text_size === 'notation', '提示用 notation 小字样式')
}

{
  // 非失败状态不渲染错误区
  const s = new RunState('ses_ok')
  s.status = 'done'
  s.text = 'done'
  const out = JSON.stringify(runCard(s, { directory: '/tmp' }))
  ok(!out.includes('**错误**'), '成功卡片不渲染错误区')
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
