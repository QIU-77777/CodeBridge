#!/usr/bin/env node
/**
 * pi 双实现对照：同一条 prompt 走两条路，比投影到卡片状态机的结果。
 *
 *   node scripts/parity-pi-oar.mjs "这个仓库是做什么的"
 *   node scripts/parity-pi-oar.mjs --dir /tmp/x "跑一下 node --version"
 *   OC_PARITY_SUBPROCESS=1 node scripts/parity-pi-oar.mjs "..."   # OAR 侧用每会话一个 RPC 进程
 *
 * 两条路：
 *   A 桥接现有 pi 后端：长驻 pi --mode rpc 进程，stdin JSONL 命令，合成事件
 *   B OAR 的 pi 适配器：默认进程内 SDK
 *
 * 这一条要真实模型调用：会花钱，要本机 pi 已登录。它不进 CI，手动跑。
 * 判定分两类，依据见 src/parity.js 文件头：
 *   进判定  终态、工具（名字序列与结果状态）
 *   只观察  文本（模型采样不确定性）、用量（两侧读数口径不同）、工具参数
 *
 * 每侧连跑两遍，同模式自检必跑：跨模式判定弱化之后，自检是抓「装配不确定」
 * 类回归的主要信号。自检同样只判定终态与工具。
 *
 * 每行都打原始用量（input / output / cacheRead）。两侧读数口径不同——OAR 报
 * 整个回合所有模型调用的累计并把缓存加回 input，桥接报单次调用不含缓存且取
 * 哪次不确定——不看原始数字，只看判定项，看不出一个差是口径还是实现。
 *
 * 退出码：0 判定项全一致，1 有不一致，2 运行本身失败。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiRuntime } from '@botiverse/oar/runtimes/pi'
import { promptAndWait } from '@botiverse/oar'
import { PiBackend } from '../src/pi.js'
import { RunState } from '../src/render.js'
import { createEventTranslator } from '../src/oar-events.js'
import { compareProjections, formatComparison } from '../src/parity.js'

const args = process.argv.slice(2)
const dirIdx = args.indexOf('--dir')
const directory = dirIdx >= 0 ? args[dirIdx + 1] : process.cwd()
const prompt = args.filter((a, i) => a !== '--dir' && args[i - 1] !== '--dir').join(' ').trim()
if (!prompt) {
  console.error('用法：node scripts/parity-pi-oar.mjs [--dir <目录>] <prompt>')
  process.exit(2)
}

const useSubprocess = process.env.OC_PARITY_SUBPROCESS === '1'
const model = process.env.OC_PARITY_MODEL || ''

/**
 * 把一段事件流喂进 RunState，跑完返回运行态。
 *
 * RunState 的 sessionId 必须跟事件里的 sessionID 一致，否则 apply 全部返回
 * false，运行态永远停在初始值——对照会报「桥接侧空文本」，那是脚本的 bug，
 * 不是实现的差异。
 */
async function drive(getEvents, apply, sessionId) {
  const state = new RunState(sessionId)
  await getEvents((ev) => {
    for (const b of apply(ev)) state.apply(b)
  })
  return state
}

async function runBridgeSide() {
  const sessionDir = mkdtempSync(join(tmpdir(), 'parity-bridge-'))
  const cfg = {
    backend: { type: 'pi', pi: { bin: process.env.OCB_PI_BIN || 'pi', model, timeoutMs: 600000, toolTimeoutMs: 1800000 } },
    opencode: { defaultDirectory: directory },
  }
  const be = new PiBackend({ cfg, sessionDir, logger: { info() {}, warn() {}, error() {} } })
  const session = await be.createSession({ directory })
  const state = await drive(
    (cb) => be.subscribe(cb, () => {}),
    (ev) => [ev],
    session.id,
  )
  await be.prompt(session.id, prompt)
  // pi 的回合由事件收尾，等终态
  const t0 = Date.now()
  while (!['done', 'failed', 'aborted'].includes(state.status) && Date.now() - t0 < 600000) {
    await new Promise((r) => setTimeout(r, 200))
  }
  await be.deleteSession(session.id).catch(() => {})
  return state
}

async function runOarSide() {
  const runtime = createPiRuntime(useSubprocess ? { execution: 'subprocess' } : {})
  const installation = await runtime.installation?.()
  if (!installation || installation.kind !== 'available') {
    throw new Error(`OAR 的 pi 安装探测失败：${installation?.kind || '无探测接口'}`)
  }
  const session = await runtime.session(installation, { cwd: directory, ...(model ? { model } : {}) })
  const translate = createEventTranslator(session.id)
  const state = new RunState(session.id)
  session.events((ev) => {
    for (const b of translate(ev)) state.apply(b)
  })
  const run = await Promise.race([
    promptAndWait(session, prompt),
    new Promise((_, rej) => setTimeout(() => rej(new Error('等 OAR 回合结束超时（10 分钟）')), 600000)),
  ])
  await session.dispose()
  if (run?.outcome?.kind === 'failed') {
    state.status = 'failed'
    state.error = { message: run.outcome.reason || 'OAR 侧失败' }
  }
  return state
}

/** 一行的摘要：终态、正文、工具，加原始用量。用量必须打——两侧读数口径不同，
 *  只看判定项看不出来，原始数字（含 cacheRead）摆出来才有人能判断 */
function line(label, st) {
  const t = st.tokens || {}
  const usage = `in ${t.input ?? '空'} / out ${t.output ?? '空'} / cacheRead ${t.cacheRead ?? '空'}`
  return `${label} 终态 ${st.status}，正文 ${st.text.length} 字，工具 ${st.tools.length} 个，${usage}`
}

console.log(`pi 双实现对照`)
console.log(`  目录   ${directory}`)
console.log(`  prompt ${prompt}`)
console.log(`  OAR 侧 ${useSubprocess ? '每会话一个原生 RPC 进程' : '进程内 SDK'}`)
console.log(`  模型   ${model || '运行时自己的默认'}`)
console.log()

// 每侧连跑两遍：跨模式判定已经只剩终态与工具（用量与文本是观察项），同模式
// 自检是剩下的主要信号，所以必跑，不再用 --repeat 开关
const RUNS = 2

let a, b
try {
  console.log('A 桥接 pi 后端跑…')
  a = await runBridgeSide()
  console.log(`   ${line('第1遍', a)}`)
  for (let i = 1; i < RUNS; i++) {
    const again = await runBridgeSide()
    console.log(`   ${line(`第${i + 1}遍`, again)}`)
    const self = compareProjections(a, again)
    console.log(formatComparison(`A 侧同模式自检（第1遍 对 第${i + 1}遍）`, self))
    if (!self.ok) process.exitCode = 1
  }
} catch (err) {
  console.error(`A 侧失败：${err?.message || err}`)
  process.exit(2)
}
try {
  console.log('B OAR pi 适配器跑…')
  b = await runOarSide()
  console.log(`   ${line('第1遍', b)}`)
  for (let i = 1; i < RUNS; i++) {
    const again = await runOarSide()
    console.log(`   ${line(`第${i + 1}遍`, again)}`)
    const self = compareProjections(b, again)
    console.log(formatComparison(`B 侧同模式自检（第1遍 对 第${i + 1}遍）`, self))
    if (!self.ok) process.exitCode = 1
  }
} catch (err) {
  console.error(`B 侧失败：${err?.message || err}`)
  process.exit(2)
}

console.log()
const result = compareProjections(a, b)
console.log(formatComparison('pi 对照', result))
console.log()
console.log('两侧正文（前 300 字）：')
console.log(`  A ${a.text.slice(0, 300).replace(/\n/g, ' ')}`)
console.log(`  B ${b.text.slice(0, 300).replace(/\n/g, ' ')}`)
process.exit(result.ok ? 0 : 1)
