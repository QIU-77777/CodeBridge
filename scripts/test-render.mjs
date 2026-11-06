#!/usr/bin/env node
/**
 * 卡片正文只保留最新一段叙述的测试（render.js 的 RunState）。
 *   node scripts/test-render.mjs
 *
 * 背景：人类实测多步运行的卡片正文把每一段的中间叙述全部拼接起来，
 * 终态卡片成了过程记录。修复：新的一段助手叙述产出内容时，清掉上一段
 * 累加的文本与思考，只保留最新一段；清空延迟到首个内容事件，防止运行
 * 的最后一段没有文本产出时卡片变空白。
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
  // 1. 两段叙述：第二段产出后，正文只剩第二段
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '第一段中间叙述。' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '第一段中间叙述。' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm2' } })
    ok(st.text === '第一段中间叙述。', '新段落还没产出内容时，旧文本暂时保留')
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '最终答复。' } })
    ok(st.text === '最终答复。', '新段落产出内容后，正文只剩最新一段', JSON.stringify(st.text))
    ok(st.steps === 2, '步数正常累计')
  }

  // 2. 最后一段没有文本产出（只调了工具）：旧文本保留，卡片不变空白
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '这是结论。' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm2' } })
    st.apply({ type: 'session.tool.called', data: { sessionID: SID, id: 't1', name: 'shell' } })
    ok(st.text === '这是结论。', '末段无文本产出时不清空，卡片不会变空白')
  }

  // 3. 同一段内 text.ended 的整条替换仍然生效
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '半句' } })
    st.apply({ type: 'session.text.ended', data: { sessionID: SID, text: '完整的一句话。' } })
    ok(st.text === '完整的一句话。', '同一段内 text.ended 整条替换生效')
  }

  // 4. 单段运行：行为与原来一致
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '你' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '好' } })
    ok(st.text === '你好', '没有 step.started 的运行照常累加')
  }

  // 5. 思考过程同样只保留最新一段
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.reasoning.delta', data: { sessionID: SID, delta: '第一段思考' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm2' } })
    st.apply({ type: 'session.reasoning.delta', data: { sessionID: SID, delta: '第二段思考' } })
    ok(st.reasoning === '第二段思考', '思考过程也只保留最新一段', JSON.stringify(st.reasoning))
  }

  // 6. 相同 assistantMessageID 重复出现不误清（防御）
  {
    const st = new RunState(SID)
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '同一段' } })
    st.apply({ type: 'session.step.started', data: { sessionID: SID, assistantMessageID: 'm1' } })
    st.apply({ type: 'session.text.delta', data: { sessionID: SID, delta: '继续' } })
    ok(st.text === '同一段继续', '同一消息 id 重复不触发清空')
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
