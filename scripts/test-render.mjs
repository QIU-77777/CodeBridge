#!/usr/bin/env node
/**
 * 卡片正文分段累加的测试（render.js 的 RunState）。
 *   node scripts/test-render.mjs
 *
 * 背景：人类先要求「只显示最终回复」（commit e225e57），后来改主意：
 * 中间的回复也要显示，而且每两段之间空一行，挤在一起分不清哪句是哪步的。
 * 规则：新的一段助手叙述接在旧段后面，中间一个空行；同一段内 text.ended
 * 的权威全文替换 delta 累加出来的部分，不把同一段显示两遍。
 */
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

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

const { RunState } = await import(`${REPO}src/render.js`)

const SID = 'ses_r'

try {
  // 1. 两段叙述：两段都留下，中间空一行
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '第一段中间叙述。' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '第一段中间叙述。' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm2' } })
    ok(st.text === '第一段中间叙述。', '新段落还没产出内容时，旧文本原样留着')
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '最终答复。' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '最终答复。' } })
    ok(st.text === '第一段中间叙述。\n\n最终答复。', '两段都保留，中间一个空行', JSON.stringify(st.text))
    ok(st.steps === 2, '步数正常累计')
  }

  // 2. 三段：每两段之间都空行
  {
    const st = new RunState(SID)
    for (const [i, t] of ['第一段。', '第二段。', '第三段。'].entries()) {
      st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: `m${i}` } })
      st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: t } })
    }
    ok(
      st.text === '第一段。\n\n第二段。\n\n第三段。',
      '三段之间各一个空行',
      JSON.stringify(st.text),
    )
  }

  // 3. 最后一段没有文本产出（只调了工具）：旧文本保留，卡片不变空白
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '这是结论。' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm2' } })
    st.apply({ type: 'session.tool.called', data: { sessionID: SID, id: 't1', name: 'shell' } })
    ok(st.text === '这是结论。', '末段无文本产出时不清空，卡片不会变空白')
  }

  // 4. 同一段内 text.ended 的整条替换仍然生效
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '半句' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '完整的一句话。' } })
    ok(st.text === '完整的一句话。', '同一段内 text.ended 整条替换生效')
  }

  // 5. 单段运行：行为与原来一致
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '你' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '好' } })
    ok(st.text === '你好', '没有 step.started 的运行照常累加')
  }

  // 6. 只有 text.ended、没有 delta 的新段（pi 后端就是这样）：也要空行分段
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '第一段。' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm2' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '第二段。' } })
    ok(st.text === '第一段。\n\n第二段。', '纯 text.ended 的两段也空行分开', JSON.stringify(st.text))
  }

  // 7. 思考过程仍然只保留最新一段
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.reasoning.delta', data: { sessionID: SID, delta: '第一段思考' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm2' } })
    st.apply({ type: 'session.reasoning.delta', data: { sessionID: SID, delta: '第二段思考' } })
    ok(st.reasoning === '第二段思考', '思考过程只保留最新一段', JSON.stringify(st.reasoning))
  }

  // 8. 相同 assistantMessageID 重复出现不另起一段（防御）
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '同一段' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '继续' } })
    ok(st.text === '同一段继续', '同一消息 id 重复不触发分段')
  }

  // 9. 比当前段还短的 text.ended 是残包，不能覆盖掉已累加的内容
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '完整的一句话。' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '半句' } })
    ok(st.text === '完整的一句话。', '残包不覆盖已累加的正文', JSON.stringify(st.text))
  }

  // 10. 三段之后再来一段权威全文：只替换最后一段，前面的不动
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '第一段。' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm2' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '第二段' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '第二段补充完整。' } })
    ok(
      st.text === '第一段。\n\n第二段补充完整。',
      '权威全文只替换它所在的那一段',
      JSON.stringify(st.text),
    )
  }
} catch (err) {
  fail++
  console.log(`❌ 测试本身出错: ${err.stack || err.message}`)
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
