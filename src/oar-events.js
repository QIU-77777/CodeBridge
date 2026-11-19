/**
 * OAR 事件 → 桥接运行态事件。
 *
 * OAR 的 Event（@botiverse/oar）带 seq 与 agentPath，形状见它的
 * contracts/records.d.ts；桥接的 RunState（src/render.js）消费 session.* 一族
 * 事件。这一层只做形状翻译，聚合归 RunState。
 *
 * 只翻译根代理的事件（agentPath 为空）。子代理的事件桥接还没有展示通道，
 * 丢弃，不塞进根代理的正文。
 *
 * 成本不翻译：OAR 的 UsageReport 只有 token 与上下文，没有金额。要显示金额
 * 得宿主自己按模型单价表算，那是另一件事。
 */

/** OAR 的 tool result → 桥接的工具终态事件名 */
function toolEventOf(result) {
  return result === 'ok' ? 'session.tool.success' : 'session.tool.failed'
}

/** 工具参数是 JSON 文本，解析失败保留原文，渲染层照样能显示 */
function parseToolInput(input) {
  if (typeof input !== 'string' || input === '') return null
  try {
    return JSON.parse(input)
  } catch {
    return { raw: input }
  }
}

/** OAR 的失败回合 → 给人看的一句话 */
function failureMessage(outcome) {
  const cls = outcome.failure || 'unknown'
  const reason = outcome.reason || ''
  return reason ? `${cls}: ${reason}` : cls
}

/**
 * 翻译一条 OAR 事件。
 *
 * @param {object} ev OAR 的 Event
 * @param {string} sessionId 桥接侧会话 id（OAR 的 session.id）
 * @returns {Array<{type: string, data: object}>} 0 条到多条桥接事件
 */
export function toBridgeEvents(ev, sessionId) {
  // 子代理的事件：桥接还没有对应的展示通道
  if (!ev || (ev.agentPath && ev.agentPath.length > 0)) return []
  const sid = { sessionID: sessionId }

  switch (ev.kind) {
    case 'turn_started':
      return [{ type: 'session.execution.started', data: sid }]

    case 'text_delta':
      return [{ type: 'session.text.delta', data: { ...sid, delta: ev.text } }]

    case 'reasoning':
      // 只有可读文本一种；redacted 与 empty 是生命周期，没有内容可显示
      if (ev.content?.kind !== 'text') return []
      return [{ type: 'session.reasoning.delta', data: { ...sid, delta: ev.content.text } }]

    case 'tool_call_started': {
      // claude 的 started 不带参数，完整的后来到；先登记，参数到了再补
      const events = [
        { type: 'session.tool.input.started', data: { ...sid, id: ev.callId, name: ev.tool } },
      ]
      const input = parseToolInput(ev.input)
      if (input !== null) {
        events.push({ type: 'session.tool.called', data: { ...sid, id: ev.callId, name: ev.tool, input } })
      }
      return events
    }

    case 'tool_call_input':
      return [{ type: 'session.tool.called', data: { ...sid, id: ev.callId, input: parseToolInput(ev.input) } }]

    case 'tool_call_ended':
      return [{ type: toolEventOf(ev.result), data: { ...sid, id: ev.callId, content: ev.content } }]

    case 'turn_ended': {
      const o = ev.outcome
      if (o.kind === 'completed') return [{ type: 'session.execution.succeeded', data: sid }]
      if (o.kind === 'aborted') return [{ type: 'session.execution.aborted', data: sid }]
      return [{ type: 'session.execution.failed', data: { ...sid, error: { message: failureMessage(o) } } }]
    }

    case 'exited':
      // 运行时进程自己退出：没有 turn_ended，运行态必须收尾，不能挂在执行中
      return [
        {
          type: 'session.execution.failed',
          data: { ...sid, error: { message: `运行时进程退出（code ${ev.code ?? 'null'}）${ev.reason ? '：' + ev.reason : ''}` } },
        },
      ]

    case 'usage': {
      // 只有 token 总量有意义；context 是占用，不是消耗
      const t = ev.usage?.tokens
      if (!t) return []
      const tokens = { input: t.input, output: t.output }
      if (t.reasoning !== undefined) tokens.reasoning = t.reasoning
      if (t.cacheRead !== undefined) tokens.cacheRead = t.cacheRead
      return [{ type: 'session.usage.updated', data: { ...sid, tokens } }]
    }

    case 'model':
      return [{ type: 'backend.meta', data: { ...sid, model: ev.model } }]

    default:
      // task_*、compaction_*、retry、control_rejected、user_message、
      // app_request、app_answered、effort、session_linked、goal_changed：
      // 运行态没有对应位置，先丢弃
      return []
  }
}

/**
 * 建一个会话的事件翻译器。
 *
 * 比 toBridgeEvents 多一条收尾规则：一个回合结束后，会话被回收时 OAR 会记下
 * 一条进程退出，它不能把一张已经完成的卡片翻成失败。handler 的 run 在终态
 * 后还会留 60 秒，这段时间里任何迟到的失败事件都会被 flushRun 重新 patch 上
 * 卡片。src/pi.js 的 _onProcGone 是同一条规则（run.settled 之后不再收尾）。
 *
 * 收尾只拦进程退出，其余一律放行，原因有两类：
 *   用量与模型回读合法地晚于回合结束到达（kimi 就在 prompt 回执之后才推
 *   上下文用量），卡片底部的 token 行要靠它；
 *   排队的消息会在同一个会话里再开一个回合，脚本运行时的这一次连
 *   turn_started 都不发，只有正文和工具事件，拦内容会把第二个回合整段丢掉。
 *   所以内容事件同时充当新回合的信号，把收尾状态清掉。
 *
 * @param {string} sessionId 桥接侧会话 id
 * @returns {(ev: object) => Array<{type: string, data: object}>}
 */

/** 这些事件意味着一个新回合开始了，要把收尾状态清掉 */
const TURN_CONTENT = new Set([
  "turn_started",
  "text_delta",
  "reasoning",
  "tool_call_started",
  "tool_call_input",
  "tool_call_ended",
  "task_started",
  "task_updated",
  "task_ended",
])

export function createEventTranslator(sessionId) {
  let settled = false
  return (ev) => {
    if (!ev || (ev.agentPath && ev.agentPath.length > 0)) return []
    if (TURN_CONTENT.has(ev.kind)) settled = false
    // 收尾后唯一要拦的：进程退出
    else if (settled && ev.kind === "exited") return []
    const out = toBridgeEvents(ev, sessionId)
    if (ev.kind === "turn_ended") settled = true
    return out
  }
}

/**
 * 把一串 OAR 事件翻译成桥接事件。
 *
 * @param {Iterable<object>} events OAR 事件
 * @param {string} sessionId 桥接侧会话 id
 * @returns {Array<{type: string, data: object}>}
 */
export function toBridgeEventList(events, sessionId) {
  const out = []
  for (const ev of events) out.push(...toBridgeEvents(ev, sessionId))
  return out
}
