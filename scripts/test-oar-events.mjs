#!/usr/bin/env node
/**
 * OAR 事件翻译层的离线测试：不装任何 harness、不登录、不连模型提供商。
 *   node scripts/test-oar-events.mjs
 *
 * 用 @botiverse/oar/testing 的脚本运行时跑真实 Session，事件经
 * src/oar-events.js 翻译后喂给 src/render.js 的 RunState，断言落在运行态上
 * 的结果。判定看卡片状态机，不看 OAR 的事件原型。
 */
import { scriptedRuntime } from "@botiverse/oar/testing"
import { promptAndWait } from "@botiverse/oar"
import { RunState } from "../src/render.js"
import { createEventTranslator, toBridgeEvents } from "../src/oar-events.js"

let pass = 0
let fail = 0
function ok(cond, name, extra = "") {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name} ${extra}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 带超时的等待：失败就喊出来，不要挂住 */
function withTimeout(p, ms, name) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} 超时 ${ms}ms`)), ms)),
  ])
}

/**
 * 跑一个脚本回合，把翻译后的桥接事件喂进 RunState。
 *
 * @param {(t: object) => any} script 脚本运行时的回合行为
 * @param {object} [opts]
 * @param {string} [opts.prompt] 首条消息
 * @param {(s: object) => any} [opts.actions] 回合进行中的操作（steer、queue、abort）
 * @param {boolean} [opts.waitIdle] 等会话空闲（排队的消息会再开一个回合）
 */
async function drive(script, opts = {}) {
  const rt = scriptedRuntime({ turn: script })
  const inst = await rt.installation?.()
  const s = await rt.session(inst, { cwd: process.cwd() })
  const state = new RunState(s.id)
  const bridge = []
  const translate = createEventTranslator(s.id)
  s.events((ev) => {
    for (const b of translate(ev)) {
      bridge.push(b)
      state.apply(b)
    }
  })

  const run = withTimeout(promptAndWait(s, opts.prompt ?? "你好"), 15000, "回合")
  if (opts.actions) await opts.actions(s)
  const outcome = await run

  if (opts.waitIdle) {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (s.status?.()?.busy === false) break
      await sleep(50)
    }
  }
  await s.dispose()
  return { state, bridge, outcome, session: s }
}

// ---------- 9. 收尾后到达的事件 ----------

{
  // 会话回收时 OAR 记下的进程退出，不能把已完成的卡片翻成失败
  const t = createEventTranslator("s1")
  ok(t({ kind: "text_delta", text: "正文" }).length === 1, "收尾前：正文照常翻译")
  ok(t({ kind: "turn_ended", outcome: { kind: "completed" } })[0].type === "session.execution.succeeded", "收尾：回合结束翻成成功")
  ok(t({ kind: "exited", code: 0 }).length === 0, "收尾后的进程退出被丢弃")
  ok(t({ kind: "usage", usage: { tokens: { input: 1, output: 2 } } }).length === 1, "收尾后的用量照常翻译（kimi 就在回执之后才推用量）")
  // 排队的消息在同一个会话里再开一个回合：脚本运行时的这一次连 turn_started
  // 都不发，只有正文，所以正文必须放行，否则第二个回合整段丢失
  ok(t({ kind: "text_delta", text: "第二回合" }).length === 1, "收尾后的正文放行（排队消息再开一个回合）")
  ok(t({ kind: "exited", code: 1 })[0].type === "session.execution.failed", "新回合进行中：进程退出翻成失败")
  ok(t({ kind: "turn_ended", outcome: { kind: "completed" } })[0].type === "session.execution.succeeded", "新回合：结束照常翻成成功")
  ok(t({ kind: "exited", code: 0 }).length === 0, "新回合也收尾了：进程退出被丢弃")
  // 新回合有 turn_started 的运行时同样成立
  const t2 = createEventTranslator("s2")
  t2({ kind: "turn_ended", outcome: { kind: "completed" } })
  ok(t2({ kind: "exited", code: 0 }).length === 0, "收尾后的进程退出被丢弃（有起步事件的运行时）")
  t2({ kind: "turn_started" })
  ok(t2({ kind: "exited", code: 1 })[0].type === "session.execution.failed", "新回合起步后：进程退出翻成失败")

  const rt = scriptedRuntime({ turn: (t3) => t3.say("说完就走了。") })
  const s = await rt.session(await rt.installation?.(), { cwd: process.cwd() })
  const state = new RunState(s.id)
  const translate = createEventTranslator(s.id)
  s.events((ev) => {
    for (const b of translate(ev)) state.apply(b)
  })
  await promptAndWait(s, "你好")
  const statusBeforeDispose = state.status
  await s.dispose()
  ok(statusBeforeDispose === "done", "收尾后回收会话：终态保持完成", statusBeforeDispose)
  ok(state.status === "done", "收尾后回收会话：迟到的退出事件不改终态", state.status)
}

// ---------- 1. 纯文本回合 ----------

{
  const { state, bridge } = await drive((t) => {
    t.say("这是第一段。")
    t.say("这是第二段。")
  })
  ok(state.status === "done", "纯文本回合：终态为完成", state.status)
  ok(state.text.includes("这是第一段。") && state.text.includes("这是第二段。"), "纯文本回合：正文拼接完整", JSON.stringify(state.text))
  ok(bridge.some((b) => b.type === "session.execution.started"), "纯文本回合：发得起步事件")
  ok(bridge.some((b) => b.type === "session.usage.updated"), "纯文本回合：发得用量事件")
}

// ---------- 2. 多工具回合 ----------

{
  const { state } = await drive(async (t) => {
    await t.tool("bash", JSON.stringify({ command: "node --version" }), () => "v24.20.0\n")
    await t.tool("read", JSON.stringify({ filePath: "/tmp/x" }), () => "内容")
    t.say("两个工具都跑完了。")
  })
  ok(state.status === "done", "多工具回合：终态为完成", state.status)
  ok(state.tools.length === 2, "多工具回合：两个工具都登记", JSON.stringify(state.tools.map((x) => x.name)))
  ok(state.tools.every((x) => x.status === "ok"), "多工具回合：工具都是成功", JSON.stringify(state.tools.map((x) => x.status)))
  ok(state.tools[0]?.input?.command === "node --version", "多工具回合：工具参数解析成对象", JSON.stringify(state.tools[0]?.input))
  ok(state.text.includes("两个工具都跑完了。"), "多工具回合：正文在工具之后")
}

// ---------- 3. 工具失败 ----------

{
  const { state } = await drive(async (t) => {
    // 脚本运行时会把这个错误重新抛给脚本，接住才能继续这一回合
    await t.tool("bash", JSON.stringify({ command: "false" }), () => {
      throw new Error("退出码 1")
    }).catch(() => {})
    t.say("工具失败了，我继续说。")
  })
  ok(state.tools[0]?.status === "error", "工具失败：工具行标成失败", JSON.stringify(state.tools[0]?.status))
  ok(state.tools[0]?.output.includes("退出码 1"), "工具失败：错误文本进输出", JSON.stringify(state.tools[0]?.output))
  ok(state.status === "done", "工具失败：回合本身照常完成", state.status)
}

// ---------- 4. 回合中中止 ----------

{
  const { state } = await drive(
    async (t) => {
      t.say("开始干活。")
      await sleep(400)
      if (!t.signal.aborted) t.say("这句话不该出现。")
    },
    {
      actions: async (s) => {
        await sleep(80)
        await s.abort()
      },
    },
  )
  ok(state.status === "aborted", "回合中中止：终态为已中止", state.status)
  ok(state.text.includes("开始干活。"), "回合中中止：中止前的内容保留", JSON.stringify(state.text))
  ok(!state.text.includes("这句话不该出现。"), "回合中中止：中止后的内容不记录")
}

// ---------- 5. 忙时引导 ----------

{
  const { state } = await drive(
    async (t) => {
      t.say("先做第一步。")
      while (t.steered.length === 0 && !t.signal.aborted) await sleep(20)
      t.say("收到引导：" + t.steered.join("|"))
    },
    {
      actions: async (s) => {
        await sleep(60)
        await s.steer("改个方向")
      },
    },
  )
  ok(state.text.includes("收到引导：改个方向"), "忙时引导：注入的内容进入正文", JSON.stringify(state.text))
  ok(state.status === "done", "忙时引导：回合照常收尾", state.status)
}

// ---------- 6. 忙时排队 ----------

{
  const { state } = await drive(
    async (t) => {
      t.say("第一回合：" + t.input)
      await sleep(250)
    },
    {
      actions: async (s) => {
        await sleep(60)
        const q = await s.queue("排队的消息")
        ok(q.kind === "accepted", "忙时排队：排队请求被接受", JSON.stringify(q).slice(0, 120))
      },
      waitIdle: true,
    },
  )
  ok(state.text.includes("第一回合：你好"), "忙时排队：第一个回合的内容在", JSON.stringify(state.text))
  ok(state.text.includes("第一回合：排队的消息"), "忙时排队：排队的消息另开一个回合跑完", JSON.stringify(state.text))
}

// ---------- 7. 进程意外退出 ----------

{
  const { state, bridge } = await drive((t) => {
    t.say("还没说完。")
    t.exit(1)
  })
  ok(state.status === "failed", "进程意外退出：终态为失败", state.status)
  ok(state.error?.message?.includes("运行时进程退出"), "进程意外退出：错误信息说清是进程退出", JSON.stringify(state.error))
  ok(bridge.some((b) => b.type === "session.execution.failed"), "进程意外退出：发得失败事件")
}

// ---------- 8. 没有对应位置的事件丢弃 ----------

{
  const dropped = [
    { kind: "compaction_started", agentPath: [] },
    { kind: "compaction_ended", agentPath: [] },
    { kind: "retry", agentPath: [] },
    { kind: "task_started", taskId: "t1", agentPath: [] },
    { kind: "control_rejected", action: "steer", code: "busy", reason: "busy", agentPath: [] },
    { kind: "user_message", agentPath: [] },
    { kind: "effort", effort: "high", agentPath: [] },
    { kind: "app_request", agentPath: [] },
  ]
  for (const ev of dropped) {
    ok(toBridgeEvents(ev, "s1").length === 0, `丢弃无对应位置的事件：${ev.kind}`)
  }
  ok(toBridgeEvents({ kind: "text_delta", text: "子代理的话", agentPath: ["child"] }, "s1").length === 0, "丢弃子代理的事件")
  ok(toBridgeEvents({ kind: "usage", usage: { context: { tokens: 10 } }, agentPath: [] }, "s1").length === 0, "丢弃没有 token 总量的用量事件")
  ok(toBridgeEvents(null, "s1").length === 0, "空事件不炸")
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
