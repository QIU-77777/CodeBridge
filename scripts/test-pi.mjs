#!/usr/bin/env node
/**
 * pi 后端离线测试。
 *
 * 不连飞书、不跑真模型：用一个 node 子进程冒充 pi。它有两种行为：
 *   - 一次性路径（--version 与 parsePiJsonl 的离线取样）：输出与
 *     `pi -p --mode json` 同形状的 JSONL
 *   - RPC 路径（--mode rpc）：长驻服务循环，stdin 收一行一条 JSON 命令
 *     （prompt / steer / follow_up / abort），stdout 出同 id 的 response
 *     回执与会话事件，事件形状与 --mode json 同构
 *
 * 这样能真实验证子进程生命周期（退出码、SIGTERM、超时、崩溃与进程组清理）、
 * RPC 命令的收发与 steer 注入，又不会消耗额度或依赖本机装没装 pi。
 *
 * 用法: npm run test:pi
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePiJsonl, providerErrorOf, PiBackend, capabilitiesFor } from '../src/pi.js'
import { createBackend } from '../src/backend.js'
import { RunState } from '../src/render.js'
import { Bridge } from '../src/handler.js'
import { runCard, helpCard, statusCard, queuedCard } from '../src/cards.js'
import { loadConfig } from '../src/config.js'

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`  ❌ ${msg}`)
  }
}
function section(name) {
  console.log(`\n[${name}]`)
}

/** 冒充 pi 的脚本：一次性路径按环境变量决定输出；RPC 路径是长驻服务循环 */
const FAKE_PI = `
const fs = require('node:fs')
const mode = process.env.OCB_TEST_PI_MODE || 'normal'
const piArgs = JSON.parse(process.env.OCB_TEST_PI_ARGS || '[]')
const isRpc = piArgs[0] === '--mode' && piArgs[1] === 'rpc'
if (mode === 'version') { console.log('pi 1.2.3'); process.exit(0) }
const usage = { input: 17, output: 3, cacheRead: 4608, cacheWrite: 0, totalTokens: 4628,
  cost: { input: 0.00002244, output: 0.00001188, cacheRead: 0.000202752, cacheWrite: 0, total: 0.000237072 } }
const emit = (o) => console.log(JSON.stringify(o))
const asst = (id, text, stop) => ({ role: 'assistant', id, content: text ? [{ type: 'text', text }] : [],
  provider: 'stepfun-platform', model: 'step-5-preview', stopReason: stop, usage })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const slowPieces = ['我先', '读了桥接状态', '，确认进程在跑', '，又核了对', '一遍版本', '与注入', '，全部正常', '。']

// 每种模式按「回合」分批的事件：一个数组是一个回合里的事件，回合与回合之间
// 是 steer 的交付点（真实 pi 在下一步模型调用前交付）。数组里的数字元素是
// 停顿毫秒数，给运行中到达的 steer 留出窗口
const scripts = {
  normal: [[
    { type: 'message_update', usage, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    { type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'HEL' } },
    { type: 'message_update', usage, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'HELLO' } },
    { type: 'message_end', message: { role: 'assistant',
      content: [{ type: 'text', text: 'HELLO' }], provider: 'deepseek', model: 'deepseek-v4-pro', usage } },
    { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'HELLO' }], usage } },
    { type: 'agent_end', messages: [] },
  ]],
  stream: [
    [
      { type: 'turn_start' },
      { type: 'message_start', message: asst('a1', '', 'pending') },
      { type: 'message_update', usage, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
      { type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '我先' } },
      { type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '看一下。' } },
      { type: 'message_update', usage, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '我先看一下。' } },
      { type: 'message_update', usage, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call_1', toolName: 'bash' } },
      { type: 'message_update', usage, assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'call_1', name: 'bash', args: { command: 'ls' } } } },
      { type: 'message_end', message: asst('a1', '我先看一下。', 'toolUse') },
      { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } },
      600,
      { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', isError: false, durationMs: 12,
        result: { content: [{ type: 'text', text: 'a.js 与 b.js' }], details: {} } },
      { type: 'turn_end', message: asst('a1', '我先看一下。', 'toolUse'), toolResults: [] },
    ],
    [
      { type: 'turn_start' },
      { type: 'message_start', message: asst('a2', '', 'pending') },
      { type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '目录里有' } },
      { type: 'message_update', usage, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '目录里有 a.js 和 b.js。' } },
      { type: 'message_end', message: asst('a2', '目录里有 a.js 和 b.js。', 'stop') },
      { type: 'turn_end', message: asst('a2', '目录里有 a.js 和 b.js。', 'stop'), toolResults: [] },
      { type: 'agent_end', messages: [] },
    ],
  ],
  'provider-error': [[
    // 复现真实故障：模型调用被 provider 拒（429 限流、provider 未配置）。
    // pi 打一条 stopReason=error、errorMessage 带原文的助手消息后不退出——
    // 修复前只能等满 backend.pi.timeoutMs 才终态，用户白等
    { type: 'message', id: 'err1', message: { role: 'assistant', content: [],
      provider: 'stepfun-platform', model: 'step-5-preview', usage,
      stopReason: 'error',
      errorMessage: 'stepfun-platform API error (429): request limited TPM reached, current: 565751, limit: 500000' } },
  ]],
  'quiet-final': [[
    // 复现真实故障：最终回答产出了，agent_settled 永远不来，进程也不退。
    // 实测一次卡片在「执行中」停了 6 分 58 秒——桥接只能等进程退出
    { type: 'message_end', message: { role: 'assistant',
      content: [{ type: 'text', text: 'QUIETDONE' }], provider: 'stepfun-platform',
      model: 'step-5-preview', usage } },
    { type: 'turn_end', message: { role: 'assistant',
      content: [{ type: 'text', text: 'QUIETDONE' }], usage } },
  ]],
  'quiet-empty': [[
    // 最终轮次没有正文：不能按已完成收尾，那可能只是还没产出回答的慢运行，
    // 切掉会把真正的答案丢掉。继续等进程退出 / 超时
    { type: 'message_end', message: { role: 'assistant', content: [],
      provider: 'stepfun-platform', model: 'step-5-preview', usage } },
    { type: 'turn_end', message: { role: 'assistant', content: [], usage } },
  ]],
  'tool-silent': [[
    // 复现真实故障（2026-11-12 凌晨，小P 第二轮中断）：助手产出文本、发出
    // bash 工具调用，tool_execution_start 之后工具结果永远不回流，进程挂住。
    // 实测那条命令只要 1.5 分钟——不是慢，是挂。修复后工具在飞按
    // toolTimeoutMs 单独算预算，且超时杀进程时已产出的文本不丢
    { type: 'turn_start' },
    { type: 'message_start', message: asst('a1', '', 'pending') },
    { type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'PARTIAL' } },
    { type: 'message_end', message: asst('a1', 'PARTIAL', 'toolUse') },
    { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'find ~ -name prompts.json' } },
  ]],
  'tool-then-idle': [[
    // 工具正常结束（tool_execution_end）之后模型挂住：预算要切回模型静默档
    // timeoutMs，不能还在工具档干等 toolTimeoutMs
    { type: 'turn_start' },
    { type: 'message_start', message: asst('a1', '', 'pending') },
    { type: 'message_end', message: asst('a1', '', 'toolUse') },
    { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } },
    { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', isError: false, durationMs: 5,
      result: { content: [{ type: 'text', text: 'a.js' }], details: {} } },
  ]],
  hang: [[]],
}
// 发完脚本就挂住不再回应的模式：等桥接的看门狗或静默兜底收尾
const hangsAfter = { 'provider-error': true, 'quiet-final': true, 'quiet-empty': true,
  'tool-silent': true, 'tool-then-idle': true, hang: true }

const rpcLog = process.env.OCB_TEST_RPC_LOG || ''
const logRpc = (kind, text) => {
  if (!rpcLog) return
  try { fs.appendFileSync(rpcLog, JSON.stringify({ t: Date.now(), kind, text }) + '\\n') } catch {}
}
const dumpEnv = () => {
  // 把桥接注入的环境变量落盘，供测试断言身份注入（飞书 + GitHub）
  fs.writeFileSync(process.env.OCB_TEST_ENV_DUMP, JSON.stringify({
    FEISHU_APP_ID: process.env.FEISHU_APP_ID ?? null,
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET ?? null,
    FEISHU_DOMAIN: process.env.FEISHU_DOMAIN ?? null,
    LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR ?? null,
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? null,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? null,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? null,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? null,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT ?? null,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0 ?? null,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 ?? null,
    GIT_CONFIG_KEY_1: process.env.GIT_CONFIG_KEY_1 ?? null,
    GIT_CONFIG_VALUE_1: process.env.GIT_CONFIG_VALUE_1 ?? null,
    OCB_CONFIG_DIR: process.env.OCB_CONFIG_DIR ?? null,
  }))
}

if (isRpc) {
  // ---------- RPC 长驻循环 ----------
  let running = false
  let runToken = 0
  let uid = 0
  const steerQueue = []
  const followQueue = []
  let buf = ''
  const dead = (token) => token !== runToken
  const respond = (cmd, obj) => emit({ id: cmd.id, type: 'response', command: cmd.type, ...obj })
  const emitUser = async (token, text) => {
    logRpc('user delivered', text)
    const id = 'u' + ++uid
    emit({ type: 'message_start', message: { role: 'user', id, content: text } })
    await sleep(20)
    if (dead(token)) return
    emit({ type: 'message_end', message: { role: 'user', id, content: text } })
    await sleep(20)
  }
  const runSegments = async (token, segments) => {
    for (const seg of segments) {
      if (dead(token)) return
      for (const rec of seg) {
        if (typeof rec === 'number') { await sleep(rec); continue }
        if (dead(token)) return
        emit(rec)
        await sleep(15)
      }
      // 回合边界：真实 pi 在这时把排队的 steer 当 user 消息交给 agent
      while (steerQueue.length && !dead(token)) {
        const t = steerQueue.shift()
        logRpc('steer delivered', t)
        await emitUser(token, t)
      }
    }
  }
  const startRun = async (text) => {
    const token = ++runToken
    running = true
    logRpc('run start', text)
    if (process.env.OCB_TEST_PI_UI_DIALOG) {
      // 对话类（confirm，没带 timeout——不回应 agent 会一直等）与即发即忘类
      // （setStatus）各来一条，考桥接的分流处理
      emit({ type: 'extension_ui_request', id: 'ui-dialog-1', method: 'confirm', title: '允许这个命令吗？', message: '测试对话' })
      emit({ type: 'extension_ui_request', id: 'ui-status-1', method: 'setStatus', statusKey: 'mcp' })
    }
    await emitUser(token, text)
    if (dead(token)) { logRpc('run aborted'); return }
    if (mode === 'fail') {
      process.stderr.write('boom: provider unavailable\\n')
      process.exit(2)
    }
    if (mode === 'crash') {
      emit({ type: 'message_start', message: asst('a1', '', 'pending') })
      await sleep(20)
      emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'PARTIAL' } })
      await sleep(20)
      process.stderr.write('crash: fake pi 半路死了\\n')
      process.exit(1)
    }
    if (mode === 'dump-env') dumpEnv()
    while (true) {
      if (dead(token)) { logRpc('run aborted'); return }
      if (mode === 'slow-but-alive') {
        // 复现真实事故（2026-11-08 11:41）：一个运行 10 分钟里产出 16290 行、
        // 12 步，一直在干活，被「按总时长算的超时」杀掉。修复后超时按活跃度
        // 算：每 200ms 吐一片文本增量，总时长远超 timeoutMs 也不该被杀
        for (const piece of slowPieces) {
          if (dead(token)) { logRpc('run aborted'); return }
          emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: piece } })
          await sleep(200)
        }
        emit({ type: 'message_end', message: { role: 'assistant',
          content: [{ type: 'text', text: slowPieces.join('') }],
          provider: 'stepfun-platform', model: 'step-5-preview', usage } })
      } else {
        await runSegments(token, scripts[mode] || scripts.normal)
      }
      if (dead(token)) { logRpc('run aborted'); return }
      if (!followQueue.length) break
      // 排队的 follow_up 依次跑；agent_settled 要等队列排空才发（它覆盖整条 drain）
      const next = followQueue.shift()
      logRpc('follow_up delivered', next)
      await emitUser(token, next)
    }
    if (hangsAfter[mode]) { logRpc('hang: 不再回应，等桥接收尾'); return }
    running = false
    logRpc('settled')
    emit({ type: 'agent_settled', aborted: false })
  }
  const onCommand = (cmd) => {
    logRpc('cmd', cmd.type + ' ' + (cmd.message || ''))
    if (cmd.type === 'prompt') {
      if (cmd.streamingBehavior === 'steer') {
        steerQueue.push(cmd.message)
        respond(cmd, { success: true, data: { disposition: 'queued' } })
        return
      }
      if (cmd.streamingBehavior === 'followUp') {
        // 空闲时收到的 followUp：真实 pi 会让它静静躺在队列里永不交付（这就是
        // 坑）。桥接只在「pi 说已经在处理」之后才发它，这里直接当新的一轮跑起来
        respond(cmd, { success: true, data: { disposition: 'queued' } })
        if (running) followQueue.push(cmd.message)
        else {
          logRpc('follow_up delivered', cmd.message)
          startRun(cmd.message)
        }
        return
      }
      // 运行中发普通 prompt 会被直接拒绝（陷阱二）。OCB_TEST_PI_REJECT_FIRST
      // 模拟竞态：pi 侧有在飞的工作，而桥接侧的 run 刚建起来
      if (running || process.env.OCB_TEST_PI_REJECT_FIRST) {
        respond(cmd, { success: false,
          error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." })
        return
      }
      respond(cmd, { success: true, data: { disposition: 'started' } })
      startRun(cmd.message)
      return
    }
    if (cmd.type === 'steer' || cmd.type === 'follow_up') {
      // 空闲时也回 queued：真实 pi 就是这个行为，消息随后永不交付
      if (!process.env.OCB_TEST_PI_STEER_DROP) {
        if (cmd.type === 'steer') steerQueue.push(cmd.message)
        else followQueue.push(cmd.message)
      }
      respond(cmd, { success: true, data: { disposition: 'queued' } })
      return
    }
    if (cmd.type === 'abort') {
      logRpc('abort: 先发 agent_settled(aborted) 再回执')
      running = false
      runToken++
      emit({ type: 'agent_settled', aborted: true })
      respond(cmd, { success: true })
      return
    }
    respond(cmd, { success: false, error: 'unknown command: ' + cmd.type })
  }
  process.stdin.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let cmd
      try { cmd = JSON.parse(line) } catch { continue }
      onCommand(cmd)
    }
  })
  process.stdin.on('end', () => process.exit(0))
} else {
  // ---------- 一次性路径：只剩 --version 与 parsePiJsonl 的离线取样用 ----------
  emit({ type: 'session', id: 'fake', cwd: process.cwd() })
  emit({ type: 'agent_start' })
  if (mode === 'fail') { console.error('boom: provider unavailable'); process.exit(2) }
  if (mode === 'dump-env') { dumpEnv(); process.exit(0) }
  if (mode === 'slow-but-alive') {
    let n = 0
    const timer = setInterval(() => {
      emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: slowPieces[n] } })
      n++
      if (n >= slowPieces.length) {
        clearInterval(timer)
        emit({ type: 'message_end', message: { role: 'assistant',
          content: [{ type: 'text', text: slowPieces.join('') }],
          provider: 'stepfun-platform', model: 'step-5-preview', usage } })
        emit({ type: 'agent_settled', aborted: false })
        process.exit(0)
      }
    }, 200)
  } else {
    for (const seg of scripts[mode] || scripts.normal) {
      for (const rec of seg) if (typeof rec !== 'number') emit(rec)
    }
    if (hangsAfter[mode]) {
      setInterval(() => {}, 1000)
      process.stdout.write('')
    } else {
      emit({ type: 'agent_settled', aborted: false })
    }
  }
}
`

let currentMode = 'normal'
let forceMode = null
const calls = []
/** 把 (bin, args, opts) 换成「跑 FAKE_PI 的 node 子进程」 */
function fakeSpawn(bin, args, opts = {}) {
  const mode = forceMode || (args.includes('--version') ? 'version' : currentMode)
  const child = spawn(process.execPath, ['-e', FAKE_PI], {
    ...opts,
    env: {
      ...(opts.env || process.env),
      OCB_TEST_PI_MODE: mode,
      // pi 的命令行参数不直接传给假进程，用环境变量带过去：RPC 分支要靠
      // 它认 --mode rpc
      OCB_TEST_PI_ARGS: JSON.stringify(args),
    },
  })
  // 记录写进 stdin 的 RPC 命令：消息正文与 delivery 走这条路，不在 argv 里
  const stdin = []
  if (child.stdin) {
    const origWrite = child.stdin.write.bind(child.stdin)
    child.stdin.write = (chunk, ...rest) => {
      stdin.push(String(chunk))
      return origWrite(chunk, ...rest)
    }
  }
  calls.push({ bin, args, opts, child, stdin })
  return child
}

const root = mkdtempSync(join(tmpdir(), 'ocb-pi-test-'))
const sessionDir = join(root, 'pi-sessions')
// 终端会话根目录指向一个不存在的临时路径：测试不该扫到人类真实的
// ~/.pi/agent/sessions（那里的会话会让「listSessions 列出两个」这类断言失真）
const cliSessionRoot = join(root, 'no-such-cli-root')
const cfg = {
  backend: { type: 'pi', pi: { bin: 'pi', model: 'deepseek/deepseek-v4-pro', timeoutMs: 800, extraArgs: [], cliSessionRoot } },
  feishu: {},
  opencode: { url: 'http://127.0.0.1:19876', password: '', defaultDirectory: root, defaultModel: '' },
  behavior: {},
}

const warns = []
const backends = []
function makeBackend(patch = {}) {
  const { configDir, logger, ...rest } = patch
  const b = new PiBackend({
    cfg: { ...cfg, ...rest },
    sessionDir,
    configDir,
    spawnImpl: fakeSpawn,
    logger: logger || { warn(m) { warns.push(String(m)) }, info() {} },
  })
  backends.push(b)
  return b
}

/** 把合成事件喂给 RunState，返回最终状态 */
function collect(events, sid) {
  const st = new RunState(sid)
  for (const ev of events) st.apply(ev)
  return st
}

/** 读假 pi 的 RPC 行为流水（收到的命令、交付的 user 消息、settle） */
function readRpcLog(p) {
  try {
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 某次 spawn 写进 stdin 的命令 */
function stdinCmds(call) {
  return call.stdin
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

async function waitFor(cond, timeoutMs = 5000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 10))
  }
  return true
}

const main = async () => {
  section('parsePiJsonl')
  {
    const b = makeBackend()
    // 借 fakeSpawn 跑一次正常输出，拿到原始 JSONL 文本
    const r = await new Promise((res) => {
      let out = ''
      const c = fakeSpawn('pi', ['-p'], {})
      c.stdout.on('data', (d) => (out += d.toString()))
      c.on('close', () => res(out))
    })
    ok(r.split('\n').filter(Boolean).length > 5, '假 pi 输出了多行 JSONL')
    const p = parsePiJsonl(r)
    ok(p.text === 'HELLO', `最终文本来自 message_end（实际 ${p.text}）`)
    ok(p.delta === 'HELLO', 'text_delta / text_end 累积正确')
    ok(p.usage?.input === 17 && p.usage?.output === 3, 'usage 抠出 in/out')
    ok(Math.abs(p.usage?.cost - 0.000237072) < 1e-12, 'usage 抠出 cost.total')
    ok(p.model === 'deepseek/deepseek-v4-pro', '模型名是 provider/model')
    ok(p.aborted === false, 'agent_settled.aborted=false')
    ok(parsePiJsonl('').text === '', '空输出不炸')
    ok(parsePiJsonl('not json\n{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"X"}}').text === 'X', '没有 message_end 时用 delta 兜底')
    await b.health()
  }

  section('工厂与能力表')
  {
    ok(createBackend(cfg) instanceof PiBackend, 'backend.type=pi → PiBackend')
    const def = createBackend({ ...cfg, backend: undefined })
    ok(def.constructor.name === 'OpencodeClient', '没有 backend 段时仍是 OpencodeClient（现有配置零改动）')
    const a = capabilitiesFor(cfg)
    const b = capabilitiesFor({ backend: { type: 'opencode' } })
    ok(a.oneShot === false && a.steer === true, 'pi 能力表：长驻 RPC 进程，支持 steer 注入')
    ok(!a.streaming && !a.agents && !a.permissions, 'pi 能力表：没有 agent 与交互式权限')
    ok(!b.oneShot && b.streaming && b.agents && b.permissions, 'opencode 能力表：全功能')
    ok(b.steer === true, 'opencode 能力表：支持 steer（serve 的 delivery=steer）')
    ok(capabilitiesFor({}).type === 'opencode', '空配置默认 opencode')
  }

  section('会话')
  {
    const b = makeBackend()
    const s = await b.createSession({ title: '飞书', directory: root })
    ok(s.id.startsWith('pi-'), '会话 id 有 pi- 前缀')
    ok(s.location.directory === root, '会话带工作目录')
    ok(s.model?.id === 'deepseek-v4-pro', '默认模型写进会话对象')
    ok((await b.getSession(s.id)).title === '飞书', 'getSession 能读回')
    ok(existsSync(join(sessionDir, 'index.json')), '会话索引已落盘')
    await b.renameSession(s.id, '改名了')
    ok((await b.getSession(s.id)).title === '改名了', 'renameSession 生效')
    await new Promise((r) => setTimeout(r, 5))
    const s2 = await b.createSession({ title: '第二个', directory: root })
    ok((await b.listSessions()).length === 2, 'listSessions 列出两个')
    ok((await b.listSessions({ order: 'desc' }))[0].id === s2.id, '按更新时间倒序')
    ok((await b.listSessions({ search: '改名' })).length === 1, 'search 过滤')
    ok((await b.listModels()).some((m) => m.id === 'deepseek-v4-pro'), 'listModels 含配置默认模型')
    ok((await b.listAgents()).length === 0, 'pi 没有 agent 列表')
    await b.switchModel(s.id, { providerID: 'x', id: 'y' })
    ok((await b.getSession(s.id)).model.id === 'y', 'switchModel 生效')
    await b.deleteSession(s2.id)
    ok((await b.listSessions()).length === 1, 'deleteSession 生效')
    // 重启后能从索引恢复，续聊才接得上
    const b2 = new PiBackend({ cfg, sessionDir, spawnImpl: fakeSpawn })
    ok((await b2.getSession(s.id)).title === '改名了', '新实例能从磁盘索引恢复会话')
  }

  section('合成事件与卡片')
  {
    const b = makeBackend()
    const events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const s = await b.createSession({ title: '卡片', directory: root })
    currentMode = 'normal'
    calls.length = 0
    warns.length = 0
    const r = await b.prompt(s.id, '说 HELLO')
    ok(r.ok === true, 'prompt 正常结束')

    const types = events.map((e) => e.type)
    ok(types[0] === 'session.execution.started', '第一个事件是 execution.started')
    ok(types.includes('session.text.delta'), '有 text.delta')
    ok(types.includes('session.usage.updated'), '有 usage.updated')
    ok(types.includes('backend.meta'), '有 backend.meta（跑完才知道真实模型）')
    ok(types.at(-1) === 'session.execution.succeeded', '最后一个事件是 execution.succeeded')
    ok(events.every((e) => e.data?.sessionID === s.id), '每个事件都带正确的 sessionID')

    // 一次性后端跑完才知道模型，靠 backend.meta 补卡片前缀
    const br = Object.create(Bridge.prototype)
    br.runs = new Map([[s.id, { meta: { model: '' } }]])
    br.onEvent({ type: 'backend.meta', data: { sessionID: s.id, model: 'deepseek/deepseek-v4-pro' } })
    ok(br.runs.get(s.id).meta.model === 'deepseek/deepseek-v4-pro', 'backend.meta 把真实模型补进卡片前缀')

    const st = collect(events, s.id)
    ok(st.status === 'done', `RunState 收尾为 done（实际 ${st.status}）`)
    ok(st.text === 'HELLO', 'RunState 拿到最终文本')
    ok(st.tokens?.input === 17 && st.tokens?.output === 3, 'RunState 拿到 tokens')
    const c = runCard(st, { directory: root, isGroup: true })
    const text = JSON.stringify(c)
    ok(text.includes('HELLO'), '结果卡片包含正文')
    ok(text.includes('in 17 · out 3'), '结果卡片带 in/out')
    ok(text.includes('$0.00'), '结果卡片带金额（两位小数）')
    ok(text.includes('@我 并发送'), '群版帮助提示仍在')
    ok(text.includes('已完成'), '标题带状态词')

    // 启动参数：RPC 长驻模式、会话续聊、cwd、模型、授权。消息正文不在 argv
    // 里——RPC 模式拒绝命令行 prompt，消息走 stdin 的 prompt 命令
    const args = calls[0].args
    ok(args[0] === '--mode' && args[1] === 'rpc', 'RPC 长驻模式，不再是一次性 -p')
    ok(!args.includes('-p') && !args.includes('--'), '不带 -p 与 -- 分隔的正文')
    ok(args.includes('--session-id') && args[args.indexOf('--session-id') + 1] === s.id, '带 --session-id 续聊')
    ok(args.includes('--session-dir'), '带 --session-dir')
    ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'deepseek/deepseek-v4-pro', '带 --model')
    ok(args.includes('--approve'), '飞书里点不了授权按钮，用 --approve')
    ok(calls[0].opts.cwd === root, 'cwd 是话题绑定的工作目录')
    ok(calls[0].opts.stdio?.[0] === 'pipe', 'stdin 可写：RPC 命令从这儿进')
    const cmds = stdinCmds(calls[0])
    ok(cmds.some((x) => x.type === 'prompt' && x.message === '说 HELLO'), '消息正文走 stdin 的 prompt 命令')
    ok(cmds.every((x) => typeof x.id === 'string' && x.id.length > 0), '每条命令都带 id（回执按 id 对应）')
  }

  section('运行中流式：文本、工具、步数、模型边收边发')
  {
    // 复现真实故障（2026-11-07）：pi 后端运行期间不发任何事件，卡片从创建起
    // 就是一张静态图。用户 14:18 发的追问，Lil_P 实际从 14:18:19 干活到
    // 14:25:52，卡片 8 分 24 秒没有任何变化，用户看不到一个字
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 8000, extraArgs: [], cliSessionRoot } },
    })
    const s = await b.createSession({ title: '流式', directory: root })
    currentMode = 'stream'
    const events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const r = await b.prompt(s.id, '读一下项目')
    ok(r.ok === true, '流式运行正常结束')

    // 建会话时配置没写默认模型，索引里 model 是 null；跑起来后真实模型补写进去，
    // /sessions 卡片的模型位和管理后台的模型列才有东西可显示
    const idxAfter = JSON.parse(readFileSync(join(sessionDir, 'index.json'), 'utf8'))
    ok(idxAfter[s.id]?.model?.id === 'step-5-preview', '真实模型补进会话索引（模型列不再空）')
    ok(idxAfter[s.id]?.model?.providerID === 'stepfun-platform', '补写进索引的模型带 provider')

    const types = events.map((e) => e.type)
    const iTerminal = types.indexOf('session.execution.succeeded')
    const iFirstText = types.findIndex((t) => t === 'session.text.delta')
    ok(iFirstText >= 0 && iFirstText < iTerminal, '文本增量在终态之前就发出（运行中卡片就在刷新）')
    ok(
      events.slice(0, iTerminal).filter((e) => e.type === 'session.text.delta').length >= 2,
      '文本是分片流到的，不是最后一次性给',
    )
    ok(types.includes('session.step.started'), '有 step.started（步数）')
    ok(events.filter((e) => e.type === 'session.step.started').length === 2, '两轮助手消息 = 两步')
    ok(
      types.includes('session.tool.input.started') && types.includes('session.tool.called') && types.includes('session.tool.success'),
      '工具调用生命周期完整上卡',
    )
    ok(types.includes('session.usage.updated'), '用量在运行中就更新')

    // 模型名一从流里看到就补前缀，不用等跑完。旧实现只在终态补一次，中途
    // 卡片前缀一直没有模型，而 opencode 后端的卡片从头带着模型
    const iMeta = types.indexOf('backend.meta')
    ok(iMeta >= 0 && iMeta < iFirstText, '模型名在第一条文本之前就补上卡片前缀')
    ok(events[iMeta]?.data?.model === 'stepfun-platform/step-5-preview', '模型名取 provider/model')

    const st = collect(events, s.id)
    ok(st.status === 'done', 'RunState 收尾为 done')
    ok(
      st.text === '我先看一下。\n\n目录里有 a.js 和 b.js。',
      `两段中间回复都上卡，中间空一行（实际 ${JSON.stringify(st.text)}）`,
    )
    ok((st.text.match(/目录里有/g) || []).length === 1, '终态的权威覆盖不会把答案重复两遍')
    ok(st.steps === 2, '步数记到 RunState 上')
    ok(st.tools.length === 1 && st.tools[0].name === 'bash', '工具调用记到 RunState 上')
    ok(String(st.tools[0].output).includes('a.js'), '工具输出也上卡（showTools 打开时可见）')

    // 卡片前缀：模型和步数都出现，和 opencode 后端一致
    const card = runCard(st, {
      directory: root,
      model: 'stepfun-platform/step-5-preview',
      title: '流式',
      isGroup: true,
    })
    const text = JSON.stringify(card)
    ok(text.includes('**模型** stepfun-platform/step-5-preview'), '前缀带模型')
    ok(text.includes('**步数** 2'), '前缀带步数')
    ok(text.includes('已完成'), '标题是已完成')

    // 收尾只发一次权威文本，不再追加第二份
    const textEvents = events.filter((e) => e.type === 'session.text.delta' || e.type === 'session.text.ended')
    ok(textEvents.at(-1)?.type === 'session.text.ended', '收尾用 text.ended 权威覆盖')
    ok(
      textEvents.some((e) => e.type === 'session.text.ended' && e.data?.text === '目录里有 a.js 和 b.js。'),
      '权威全文上卡',
    )
  }

  section('失败 / 中止 / 超时')
  {
    const b = makeBackend()
    const s = await b.createSession({ title: '异常', directory: root })

    currentMode = 'fail'
    let events = []
    b.subscribe((ev) => events.push(ev), () => {})
    await b.prompt(s.id, '会失败')
    ok(collect(events, s.id).status === 'failed', '进程崩溃 → RunState failed')
    ok(events.at(-1).type === 'session.execution.failed', '发出 execution.failed')
    ok(String(events.at(-1).data.error.message).includes('boom'), '错误信息带上 stderr')
    ok(String(events.at(-1).data.error.message).includes('退出码 2'), '错误信息带退出码')

    currentMode = 'hang'
    events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const pending = b.prompt(s.id, '挂着')
    await waitFor(() => b.procs.get(s.id)?.busy === true)
    ok(await b.interrupt(s.id), 'interrupt 找得到在跑的任务')
    await pending
    ok(collect(events, s.id).status === 'aborted', '主动中止 → aborted，不是 failed')
    ok(events.at(-1).type === 'session.execution.interrupted', '发出 execution.interrupted')

    events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const timed = await b.prompt(s.id, '超时')
    ok(timed.ok === false, '超时返回失败')
    ok(collect(events, s.id).status === 'failed', '超时 → RunState failed')
    ok(String(events.at(-1).data.error.message).includes('分钟'), '超时文案说明可调 timeoutMs')

    // provider 报错（429 限流、未配置）：pi 打一条 error 消息后挂住。
    // 修复前要等满 5 秒超时才终态；现在认出来即杀即终态，原文上卡片
    ok(providerErrorOf({ message: { role: 'assistant', stopReason: 'error', errorMessage: 'x' } }) === 'x', '认出 stopReason=error 的助手消息')
    ok(providerErrorOf({ message: { role: 'assistant', stopReason: 'stop' } }) === null, '正常结束不算报错')
    ok(providerErrorOf({ type: 'message_update' }) === null, '无关事件返回 null')
    const bFast = makeBackend({ backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 5000, extraArgs: [], cliSessionRoot } } })
    const sFast = await bFast.createSession({ title: '限流', directory: root })
    currentMode = 'provider-error'
    events = []
    bFast.subscribe((ev) => events.push(ev), () => {})
    const t0 = Date.now()
    const fast = await bFast.prompt(sFast.id, '会被限流')
    const elapsed = Date.now() - t0
    ok(fast.ok === false, 'provider 报错返回失败')
    ok(elapsed < 2000, `报错后立即终态，不等满超时（实际 ${elapsed}ms，超时设的是 5000ms）`)
    ok(collect(events, sFast.id).status === 'failed', 'provider 报错 → RunState failed')
    ok(events.at(-1).type === 'session.execution.failed', '发出 execution.failed')
    ok(String(events.at(-1).data.error.message).includes('TPM'), '错误原文（429 限流信息）上卡片')

    // 超时按活跃度算：一直在吐输出的长运行不被杀，彻底静默的才杀。
    // 复现真实事故：一个运行 10 分钟产出 16290 行、12 步，被按总时长算的
    // 超时杀掉——她没卡住，只是活没干完
    const bSlow = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 1200, extraArgs: [], cliSessionRoot } },
    })
    const sSlow = await bSlow.createSession({ title: '慢但活着', directory: root })
    currentMode = 'slow-but-alive'
    events = []
    bSlow.subscribe((ev) => events.push(ev), () => {})
    const tSlow0 = Date.now()
    const slow = await bSlow.prompt(sSlow.id, '跑很久但一直在输出')
    const slowElapsed = Date.now() - tSlow0
    ok(slow.ok === true, '一直在输出的长运行正常跑完，不被超时杀', JSON.stringify(slow.error || ''))
    ok(collect(events, sSlow.id).status === 'done', '长运行终态是 done，不是 failed')
    ok(slowElapsed > 1200, `总时长超过 timeoutMs 也照样跑完（实际 ${slowElapsed}ms，超时设 1200ms）`)
    ok(
      String(collect(events, sSlow.id).text).includes('全部正常'),
      '长运行的最终答案完整上卡',
    )
  }

  section('看门狗分阶段：工具在飞与模型静默')
  {
    // 2026-11-12 补充。真实事故：小P 连续两轮被 10 分钟看门狗杀掉。第二轮
    // 的命令实测只要 1.5 分钟（工具结果不回流，是挂不是慢），第一轮的全家
    // grep -rl 实测要跑 6 分钟以上（是慢）。两类静默共用一个阈值，慢命令
    // 和挂住的运行分不开——现在工具在飞按 toolTimeoutMs 单独算预算
    const bTool = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 600, toolTimeoutMs: 2500, settleQuietMs: 0, extraArgs: [], cliSessionRoot } },
    })
    const sTool = await bTool.createSession({ title: '工具挂住', directory: root })
    currentMode = 'tool-silent'
    let events = []
    bTool.subscribe((ev) => events.push(ev), () => {})
    const tTool0 = Date.now()
    const pendingTool = bTool.prompt(sTool.id, '工具调用后没有结果')
    // 过了模型静默档（600ms）但没过工具档（2500ms）：不许杀
    await new Promise((r) => setTimeout(r, 1200))
    const midStatus = collect(events, sTool.id).status
    ok(midStatus !== 'failed' && midStatus !== 'done', `工具在飞、静默未过 toolTimeoutMs 时不杀（1200ms 时状态 ${midStatus}）`)
    const toolRes = await pendingTool
    const toolElapsed = Date.now() - tTool0
    ok(toolRes.ok === false, '工具结果不回流最终判失败')
    ok(toolElapsed >= 2400, `到点才杀，且杀在工具档不是模型档（实际 ${toolElapsed}ms；模型档 600ms、工具档 2500ms）`)
    ok(events.some((e) => e.type === 'session.text.ended'), '超时路径发出 text.ended')
    ok(String(collect(events, sTool.id).text).includes('PARTIAL'), '超时不丢产出：已产出的文本上卡')
    ok(String(collect(events, sTool.id).text).includes('以上是部分产出'), '部分产出附中止说明')
    ok(String(events.at(-1).data.error.message).includes('工具执行'), '失败文案区分工具档')
    ok(collect(events, sTool.id).status === 'failed', '工具档超时 → failed')

    // 工具正常结束之后模型挂住：预算切回模型静默档，按 timeoutMs 杀，
    // 不能还在工具档干等 toolTimeoutMs
    const bBack = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 600, toolTimeoutMs: 8000, settleQuietMs: 0, extraArgs: [], cliSessionRoot } },
    })
    const sBack = await bBack.createSession({ title: '工具结束又挂住', directory: root })
    currentMode = 'tool-then-idle'
    events = []
    bBack.subscribe((ev) => events.push(ev), () => {})
    const tBack0 = Date.now()
    const backRes = await bBack.prompt(sBack.id, '工具跑完又挂住')
    const backElapsed = Date.now() - tBack0
    ok(backRes.ok === false, '工具结束后模型挂住仍判失败')
    ok(backElapsed < 3000, `切回模型档后按 timeoutMs 杀，不等工具档（实际 ${backElapsed}ms；模型档 600ms、工具档 8000ms）`)
    ok(String(events.at(-1).data.error.message).includes('没有任何输出'), '失败文案是模型静默档')
  }

  section('进程崩溃：在飞的一轮按失败收尾，重启接着聊')
  {
    // 老实现里「孤儿进程拖着 stdout 让 close 不来」这件事在 RPC 下不成立：
    // 完成信号是 agent_settled，不是进程退出。真正要覆盖的是另一种故障——
    // pi 自己死在一轮中间（段错误、被 OOM 杀掉、扩展把进程搞崩）。那时
    // 注册表要清干净，下次 prompt 能起来一个新进程，同 session 参数历史还在
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 5000, settleQuietMs: 0, extraArgs: [], cliSessionRoot } },
    })
    const s = await b.createSession({ title: '崩溃', directory: root })
    currentMode = 'crash'
    let events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const crashed = await b.prompt(s.id, '半路死掉')
    ok(crashed.ok === false, '进程崩溃 → 运行失败')
    ok(collect(events, s.id).status === 'failed', '崩溃 → RunState failed')
    ok(String(events.at(-1).data.error.message).includes('crash'), '错误信息带 stderr 原文')
    ok(!b.procs.has(s.id), '注册表清理：崩溃的进程不留给下一条消息复用')

    // 重启之后同 session 参数接着聊
    const before = calls.length
    currentMode = 'normal'
    events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const again = await b.prompt(s.id, '崩溃后重启')
    ok(again.ok === true, '重启之后能接着跑')
    ok(calls.length === before + 1, '崩溃之后重起了进程')
    const args = calls.at(-1).args
    ok(args.includes('--session-id') && args[args.indexOf('--session-id') + 1] === s.id, '重启用同样的 session 参数（历史延续）')
    ok(args.includes('--session-dir'), '重启用同样的 --session-dir')
  }

  section('子进程注入本实例飞书身份')
  {
    // 多机器人同机：代理用飞书 CLI 发言读的是机器级配置，默认应用可能是别的
    // 实例的（真实事故：Lil_P 的代理发出的问候以 Lil_O 的应用到达群里）。
    // 桥接把本实例凭证注入子进程，并给一份只含本实例应用的 lark-cli 配置
    const bPlain = makeBackend()
    ok(bPlain.ensureLarkCliConfig() === null, '没有飞书凭证时不生成 lark-cli 实例配置')
    ok(
      (await bPlain.childEnv()).FEISHU_APP_ID === (process.env.FEISHU_APP_ID || undefined),
      '没有凭证时不注入 FEISHU_APP_ID，子进程沿用机器级配置（老部署零改动）',
    )

    const configDir = join(root, 'instance-config')
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 5000, settleQuietMs: 0, extraArgs: [], cliSessionRoot } },
      feishu: { appId: 'cli_testenv', appSecret: 'sec_testenv', domain: 'feishu' },
      // GitHub 身份一起进同一份配置：pi 侧的接线（childEnv → spawn env → 子进程
      // 环境）要有覆盖，不能只有 githubEnv 的单测
      github: {
        mode: 'pat',
        token: 'ghp_test_dump',
        gitName: 'Lil_P',
        gitEmail: '353668500+lil-p-bot[bot]@users.noreply.github.com',
      },
      configDir,
    })
    const s = await b.createSession({ title: '身份', directory: root })
    const dump = join(root, 'env-dump.json')
    process.env.OCB_TEST_ENV_DUMP = dump
    currentMode = 'dump-env'
    const r = await b.prompt(s.id, '把环境变量落盘')
    delete process.env.OCB_TEST_ENV_DUMP
    ok(r.ok === true, 'dump-env 正常运行完（RPC 模式下也走同一条注入链）')
    // 读不到文件时给一条断言失败，别让裸栈把整份测试冲掉
    const readJson = (p) => {
      try {
        return JSON.parse(readFileSync(p, 'utf8'))
      } catch {
        return null
      }
    }
    const env = readJson(dump)
    ok(env !== null, '环境变量落盘文件已生成')
    ok(env?.FEISHU_APP_ID === 'cli_testenv', 'feishu-cli 的 appId 环境变量用本实例的')
    ok(env?.FEISHU_APP_SECRET === 'sec_testenv', 'feishu-cli 的 appSecret 环境变量用本实例的')
    ok(env?.FEISHU_DOMAIN === 'feishu', 'domain 一并注入')
    const larkFile = join(configDir, 'lark-cli', 'config.json')
    ok(existsSync(larkFile), '生成了 lark-cli 实例配置')
    const larkCfg = readJson(larkFile)
    ok(larkCfg?.apps?.length === 1 && larkCfg.apps[0].appId === 'cli_testenv', 'lark-cli 配置只含本实例应用')
    ok(env.LARKSUITE_CLI_CONFIG_DIR === join(configDir, 'lark-cli'), 'LARKSUITE_CLI_CONFIG_DIR 指向该配置')
    ok((statSync(larkFile).mode & 0o777) === 0o600, 'lark-cli 配置权限 600（含 appSecret，与桥接 config.json 同规格）')

    // GitHub 四路注入：GH_TOKEN、署名、git 配置两段式、OCB_CONFIG_DIR
    ok(env.GH_TOKEN === 'ghp_test_dump', 'GitHub 身份注入 GH_TOKEN（子进程真的拿到了）')
    ok(env.GIT_AUTHOR_NAME === 'Lil_P' && env.GIT_COMMITTER_NAME === 'Lil_P', '提交署名注入 author/committer')
    ok(env.GIT_AUTHOR_EMAIL.includes('lil-p-bot'), '署名邮箱用 bot 的 noreply 地址')
    ok(env.GIT_CONFIG_COUNT === '2' && env.GIT_CONFIG_KEY_0 === 'credential.https://github.com.helper' && env.GIT_CONFIG_VALUE_0 === '', 'git 配置两段式：第一条空值只清 github.com 上累积的助手列表')
    ok(String(env.GIT_CONFIG_VALUE_1).includes('github-app-credential.mjs'), '第二条装真助手，指向凭证助手脚本')
    ok(env.OCB_CONFIG_DIR === configDir, '凭证助手靠 OCB_CONFIG_DIR 找到实例配置')

    // 启动参数：RPC 长驻、会话续聊、cwd
    const args = calls.at(-1).args
    ok(args[0] === '--mode' && args[1] === 'rpc', 'RPC 长驻模式')
    ok(args.includes('--session-id') && args[args.indexOf('--session-id') + 1] === s.id, '带 --session-id 续聊')
    ok(calls.at(-1).opts.cwd === root, 'cwd 是话题绑定的工作目录')
  }

  section('agent_settled 即收尾：进程长驻不杀')
  {
    // RPC 的正常完成路径。老实现等进程退出才结算，quietSettle 是唯一的提前
    // 收尾手段；RPC 下 agent_settled 一到就收尾，而且进程是长驻资产，跑完
    // 要留着给下一条消息复用
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 5000, settleQuietMs: 0, extraArgs: [], cliSessionRoot } },
    })
    const s = await b.createSession({ title: 'settle 即收尾', directory: root })
    currentMode = 'normal'
    let events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const t0 = Date.now()
    const r = await b.prompt(s.id, '答完就 settle')
    ok(r.ok === true, 'settle 到达即收尾')
    ok(r.quietSettled === undefined, '不是静默兜底（那条只兜 agent 挂死）')
    ok(Date.now() - t0 < 2000, `不等进程退出（实际 ${Date.now() - t0}ms）`)
    ok(events.at(-1).type === 'session.execution.succeeded', '最后一个事件是 succeeded')
    const proc = b.procs.get(s.id)
    ok(proc !== undefined, '进程还在注册表里：长驻复用，不杀')
    ok(proc.busy === false && proc.run === null, 'run 态清理干净，进程空闲待用')
    const exited = await Promise.race([
      new Promise((res) => proc.child.once('exit', () => res(true))),
      new Promise((r) => setTimeout(() => r(false), 500)),
    ])
    ok(exited === false, '收尾没有杀进程')
  }

  section('最终消息后静默：兜底收尾，不等进程退出')
  {
    // 真实故障：pi 产出最终回答后不退出（agent_settled 永远不来），卡片在
    // 「执行中」停了 6 分 58 秒。修复前桥接只能等进程退出，用户干看着。
    // RPC 下这条只兜 agent 挂死：最终回答有了、没有在飞的工作，却再无下文
    const bQuiet = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 30000, settleQuietMs: 400, extraArgs: [], cliSessionRoot } },
    })
    const sQ = await bQuiet.createSession({ title: '静默', directory: root })
    currentMode = 'quiet-final'
    let events = []
    bQuiet.subscribe((ev) => events.push(ev), () => {})
    const pending = bQuiet.prompt(sQ.id, '答完不说话')
    // childEnv 是异步的（app 模式要现换 GitHub token），spawn 随之落在一个微任务里：
    // 等新 child 真的出现再挂 exit 监听，否则挂到的是上一次调用的子进程，永远等不到
    const spawnsBefore = calls.length
    while (calls.length === spawnsBefore) await new Promise((r) => setImmediate(r))
    const exitP = new Promise((res) => calls.at(-1).child.once('exit', () => res(true)))
    const t0 = Date.now()
    const r = await pending
    const elapsed = Date.now() - t0
    ok(r.ok === true && r.quietSettled === true, '静默收尾返回 ok 并带 quietSettled 标记')
    ok(
      elapsed < 8000,
      `最终消息后约 settleQuietMs 即收尾，不等进程退出（实际 ${elapsed}ms，进程超时设的是 30000ms）`,
    )
    ok(events.at(-1).type === 'session.execution.succeeded', '最后一个事件是 succeeded')
    ok(collect(events, sQ.id).status === 'done', '静默收尾 → RunState done，不是 failed')
    const lastText = events.filter((e) => e.type === 'session.text.ended' || e.type === 'session.text.delta').at(-1)
    const body = lastText?.data?.text || lastText?.data?.delta || ''
    ok(body.includes('QUIETDONE'), '正文取最终消息的文本')
    ok(body.includes('静默'), '卡片注明这是提前收尾，用户看得出不是 pi 自己退的')
    ok(
      (await Promise.race([exitP, new Promise((res) => setTimeout(() => res(false), 3000))])) === true,
      '收尾后进程被杀死（SIGTERM，2 秒后 SIGKILL 兜底），不会永远挂着',
    )

    // settleQuietMs=0 关闭静默收尾：恢复「只等进程退出」的老行为。没有最终
    // 消息的挂死仍然走到超时失败，不会被误判成完成
    const bOff = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 800, settleQuietMs: 0, extraArgs: [], cliSessionRoot } },
    })
    const sOff = await bOff.createSession({ title: '关闭静默', directory: root })
    currentMode = 'quiet-final'
    events = []
    bOff.subscribe((ev) => events.push(ev), () => {})
    const off = await bOff.prompt(sOff.id, '答完不说话')
    ok(off.ok === false, 'settleQuietMs=0 时不会提前收尾')
    ok(collect(events, sOff.id).status === 'failed', '关闭后仍走超时失败（老行为不变）')
    ok(String(events.at(-1).data.error.message).includes('分钟'), '超时文案不变')

    // 最终轮次没有正文时不收尾：那可能只是还没产出回答的慢运行，切掉会丢答案
    const bEmpty = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 800, settleQuietMs: 400, extraArgs: [], cliSessionRoot } },
    })
    const sEmpty = await bEmpty.createSession({ title: '空正文', directory: root })
    currentMode = 'quiet-empty'
    events = []
    bEmpty.subscribe((ev) => events.push(ev), () => {})
    const empty = await bEmpty.prompt(sEmpty.id, '没正文')
    ok(empty.ok === false && empty.quietSettled === undefined, '最终轮次没有正文时不做静默收尾')
    ok(collect(events, sEmpty.id).status === 'failed', '仍走超时失败，不会把慢运行误判成完成')
  }

  section('steer：运行中注入，空闲抛错')
  {
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 8000, extraArgs: [], cliSessionRoot } },
    })
    const s = await b.createSession({ title: '引导', directory: root })
    const log = join(root, 'rpc-log-steer.jsonl')
    rmSync(log, { force: true })
    process.env.OCB_TEST_RPC_LOG = log
    currentMode = 'stream'
    warns.length = 0
    calls.length = 0
    const events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const pending = b.prompt(s.id, '读一下项目')
    ok(await waitFor(() => b.procs.get(s.id)?.busy === true), '等 run 真的在飞')

    const t0 = Date.now()
    const r = await b.prompt(s.id, 'STEER：别再执行命令，直接回答', { delivery: 'steer' })
    ok(r.ok === true, 'steer 命令被接受')
    ok(Date.now() - t0 < 500, `steer 只等命令回执，不等交付（实际 ${Date.now() - t0}ms）`)
    ok(b.procs.get(s.id).pendingSteers.size === 1, 'steer 文本记进交付核对表')

    const res = await pending
    ok(res.ok === true, '被 steer 的那一轮照样跑完')
    const recs = readRpcLog(log)
    ok(recs.some((x) => x.kind === 'cmd' && x.text.startsWith('steer')), 'steer 命令发给了 pi')
    ok(recs.some((x) => x.kind === 'steer delivered' && x.text.includes('STEER')), 'steer 文本被当 user 消息交付')
    ok(b.procs.get(s.id).pendingSteers.size === 0, '交付后核对表清空')
    ok(warns.length === 0, '交付成功，没有竞态残留告警', warns.join(' | '))
    ok(events.filter((e) => e.type === 'session.execution.started').length === 1, 'steer 没有新起一轮')
    ok(calls.filter((c) => c.args.includes('--mode')).length === 1, 'steer 没有新起进程')

    // steer 未被交付（竞态残留）：命令回执说 queued，这一轮却跑完了也没把它
    // 当 user 消息交出去。收尾时要记 warn，排障时看得出文本。
    // 另起一个后端：假 pi 的 steer-drop 行为由启动时的环境变量决定，长驻进程
    // 跑起来之后再改环境变量对它无效
    process.env.OCB_TEST_PI_STEER_DROP = '1'
    const bDrop = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 8000, extraArgs: [], cliSessionRoot } },
    })
    const sDrop = await bDrop.createSession({ title: 'steer 落空', directory: root })
    warns.length = 0
    const pendingDrop = bDrop.prompt(sDrop.id, '读一下项目')
    ok(await waitFor(() => bDrop.procs.get(sDrop.id)?.busy === true), '另一条 run 在飞')
    await bDrop.prompt(sDrop.id, 'DROP：这条不会被交付', { delivery: 'steer' })
    await pendingDrop
    ok(
      warns.some((w) => w.includes('未被交付') && w.includes('DROP')),
      '未交付的 steer 在收尾时记 warn',
      warns.join(' | '),
    )
    delete process.env.OCB_TEST_PI_STEER_DROP

    // 空闲 steer 抛错：调用方（handler）会退回排队，消息不丢
    let threw = ''
    try {
      await b.prompt(s.id, '空闲也发一条', { delivery: 'steer' })
    } catch (err) {
      threw = err.message
    }
    ok(/没有正在执行/.test(threw), '空闲时 steer 抛错，供调用方回退排队', threw)
    delete process.env.OCB_TEST_RPC_LOG
  }

  section('忙时 prompt 自动走 followUp，等完整条 drain')
  {
    // 竞态：handler 的 busy 检查与 pi 的进程状态之间有窗口，普通 prompt 会被
    // 直接拒绝（陷阱二）。桥接按 followUp 变体重试一次，然后等这条消息交付、
    // 等 agent_settled——settle 覆盖整条 drain，排队的消息全部跑完才来
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 8000, extraArgs: [], cliSessionRoot } },
    })
    const s = await b.createSession({ title: '排队', directory: root })
    const log = join(root, 'rpc-log-followup.jsonl')
    rmSync(log, { force: true })
    process.env.OCB_TEST_RPC_LOG = log
    currentMode = 'stream'
    warns.length = 0
    calls.length = 0
    let events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const first = b.prompt(s.id, '第一条')
    ok(await waitFor(() => b.procs.get(s.id)?.busy === true), '等 run 真的在飞')
    const second = b.prompt(s.id, 'FOLLOWUP：第二条')
    const [r1, r2] = await Promise.all([first, second])
    ok(r1.ok === true, '第一条正常跑完')
    ok(r2?.ok === true, '第二条跟着同一条 drain 跑完', JSON.stringify(r2))
    const recs = readRpcLog(log)
    ok(recs.some((x) => x.kind === 'follow_up delivered' && x.text.includes('FOLLOWUP')), '排队的消息被当 user 消息交付')
    ok(events.filter((e) => e.type === 'session.execution.started').length === 1, '第二条没有重新置位卡片')
    ok(calls.filter((c) => c.args.includes('--mode')).length === 1, '第二条没有新起进程')
    ok(warns.length === 0, '没有异常告警', warns.join(' | '))
    delete process.env.OCB_TEST_RPC_LOG

    // 陷阱二的竞态收口：普通 prompt 被 pi 拒绝，按 followUp 重试并跑到 settle
    const log2 = join(root, 'rpc-log-race.jsonl')
    rmSync(log2, { force: true })
    process.env.OCB_TEST_RPC_LOG = log2
    process.env.OCB_TEST_PI_REJECT_FIRST = '1'
    const b2 = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 8000, extraArgs: [], cliSessionRoot } },
    })
    const s2 = await b2.createSession({ title: '竞态', directory: root })
    currentMode = 'normal'
    events = []
    b2.subscribe((ev) => events.push(ev), () => {})
    const race = await b2.prompt(s2.id, '会被拒一次')
    ok(race.ok === true, '被拒后按 followUp 重试并跑完', JSON.stringify(race))
    const recs2 = readRpcLog(log2)
    ok(
      recs2.filter((x) => x.kind === 'cmd' && x.text.startsWith('prompt')).length === 2,
      '重试确实发了第二条命令（普通 prompt 被拒 → followUp）',
    )
    ok(recs2.some((x) => x.kind === 'follow_up delivered'), '重试的那条被当 user 消息交付')
    ok(collect(events, s2.id).status === 'done', '竞态重试后终态是 done')
    delete process.env.OCB_TEST_RPC_LOG
    delete process.env.OCB_TEST_PI_REJECT_FIRST
  }

  section('扩展 UI 请求：对话类回取消，即发即忘类忽略')
  {
    // pi 的 docs/rpc-extension-ui.md：select / confirm / input / editor 发出来
    // 会阻塞到客户端回一条 extension_ui_response（没带 timeout 的一直等）；
    // notify / setStatus / setWidget 即发即忘。桥接在飞书里弹不出这些对话框，
    // 统一按「取消」回应，别让 agent 干等一个不会有的人机交互
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 8000, extraArgs: [], cliSessionRoot } },
    })
    const s = await b.createSession({ title: '扩展 UI', directory: root })
    process.env.OCB_TEST_PI_UI_DIALOG = '1'
    currentMode = 'normal'
    calls.length = 0
    const events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const r = await b.prompt(s.id, '跑一轮')
    delete process.env.OCB_TEST_PI_UI_DIALOG
    ok(r.ok === true, '对话类请求没有把 agent 堵死，一轮照常跑完', JSON.stringify(r))
    const writes = calls.flatMap((c) => stdinCmds(c))
    ok(
      writes.some((x) => x.type === 'extension_ui_response' && x.id === 'ui-dialog-1' && x.cancelled === true),
      '对话类请求（confirm）收到取消回应，id 回显请求的 id',
      JSON.stringify(writes.filter((x) => x.type === 'extension_ui_response')),
    )
    ok(!writes.some((x) => x.type === 'extension_ui_response' && x.id === 'ui-status-1'), '即发即忘类请求（setStatus）没有白回回应')
    ok(collect(events, s.id).status === 'done', '终态照常是 done')
  }

  section('abort 之后进程可复用')
  {
    // abort 不等同于杀进程：会话回到空闲，进程是好的，下一条消息接着用它。
    // 老实现一发中止就杀进程，每条消息都要重新起一次
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 8000, extraArgs: [], cliSessionRoot } },
    })
    const s = await b.createSession({ title: '中止后重用', directory: root })
    const log = join(root, 'rpc-log-reuse.jsonl')
    rmSync(log, { force: true })
    process.env.OCB_TEST_RPC_LOG = log
    currentMode = 'normal'
    calls.length = 0
    const events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const first = b.prompt(s.id, '第一次')
    ok(await waitFor(() => b.procs.get(s.id)?.busy === true), '等 run 在飞')
    ok(await b.interrupt(s.id), 'interrupt 发 abort')
    const r1 = await first
    ok(r1.aborted === true, 'abort 之后按中止收尾')
    ok(collect(events, s.id).status === 'aborted', 'RunState 收到 interrupted')
    ok(b.procs.has(s.id), '进程善后：没被杀，留着复用')
    ok(b.procs.get(s.id).busy === false && b.procs.get(s.id).run === null, 'run 态清理干净')
    const child = b.procs.get(s.id).child
    const recs = readRpcLog(log)
    ok(recs.some((x) => x.kind === 'cmd' && x.text.startsWith('abort')), 'abort 命令发给了 pi')

    const r2 = await b.prompt(s.id, '第二次')
    ok(r2.ok === true, '同一个进程上接着跑')
    ok(b.procs.get(s.id)?.child === child, '没有新起进程')
    ok(calls.filter((c) => c.args.includes('--mode')).length === 1, '全程只起过一个进程')
    ok(
      readRpcLog(log).filter((x) => x.kind === 'cmd' && x.text.startsWith('prompt')).length === 2,
      '第二条消息也走了 prompt 命令',
    )
    delete process.env.OCB_TEST_RPC_LOG
  }

  section('空闲回收')
  {
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 5000, idleMs: 200, extraArgs: [], cliSessionRoot } },
    })
    ok(b.idleMs === 200, 'idleMs 从 backend.pi.idleMs 读')
    const s = await b.createSession({ title: '回收', directory: root })
    currentMode = 'normal'
    const r = await b.prompt(s.id, '跑完就闲着')
    ok(r.ok === true, '第一轮正常结束')
    ok(b.procs.has(s.id), '跑完进程还在（长驻复用）')
    const child = b.procs.get(s.id).child
    const exited = new Promise((res) => child.once('exit', () => res(true)))
    ok(await waitFor(() => !b.procs.has(s.id), 4000), '空闲超过 idleMs 后进程被回收')
    ok(
      (await Promise.race([exited, new Promise((r2) => setTimeout(() => r2(false), 3000))])) === true,
      '回收真的杀掉了进程',
    )

    // 重启用同样的 session 参数：实测历史还在，回收不丢会话
    const before = calls.length
    const r2 = await b.prompt(s.id, '回收后重启')
    ok(r2.ok === true, '回收之后重启还能跑')
    ok(calls.length === before + 1, '重起了新进程')
    const args = calls.at(-1).args
    ok(args.includes('--session-id') && args[args.indexOf('--session-id') + 1] === s.id, '重启用同样的 session 参数（历史延续）')
  }

  section('卡片按后端能力降级')
  {
    const pi = helpCard(capabilitiesFor(cfg))
    const oc = helpCard(capabilitiesFor({ backend: { type: 'opencode' } }))
    ok(JSON.stringify(pi).includes('pi 桥接'), 'pi 的帮助卡片标题带后端名')
    ok(!JSON.stringify(pi).includes('一次性执行'), 'pi 的帮助卡片不再宣称一次性执行（长驻进程边跑边刷新）')
    ok(!JSON.stringify(pi).includes('/agent'), 'pi 的帮助卡片不列 /agent')
    ok(JSON.stringify(oc).includes('/agent'), 'opencode 的帮助卡片保留 /agent')
    ok(JSON.stringify(statusCard({ server: { ok: true }, backendLabel: 'pi' })).includes('**pi**'), '状态卡片显示后端名而不是 opencode')
    // 排队卡片的按钮按 caps.steer 给：pi 现在也支持运行中注入，引导按钮要有
    const btnLabels = (card) => {
      const out = []
      const walk = (o) => {
        if (Array.isArray(o)) o.forEach(walk)
        else if (o && typeof o === 'object') {
          if (o.tag === 'button') out.push(o.text?.content || '')
          Object.values(o).forEach(walk)
        }
      }
      walk(card)
      return out
    }
    const withSteer = queuedCard({ preview: '插一句', from: '小P', qid: 'q1', position: 1, k: 'chat-x', rt: 'r1', steer: true })
    ok(btnLabels(withSteer).some((l) => l.includes('引导')), 'caps.steer 为真时排队卡片有「引导」按钮')
    const noSteer = queuedCard({ preview: '插一句', from: '小P', qid: 'q2', position: 1, k: 'chat-x', rt: 'r1', steer: false })
    ok(!btnLabels(noSteer).some((l) => l.includes('引导')), 'caps.steer 为假时排队卡片没有「引导」按钮')
    ok(btnLabels(noSteer).length === 1 && btnLabels(noSteer)[0].includes('取消'), '没有引导按钮时只剩取消')
  }

  section('默认配置与多实例 label')
  {
    const c = loadConfig()
    ok(c.backend?.type === 'opencode' || c.backend?.type === 'pi', 'loadConfig 补出了 backend 段（老配置不会 undefined）')
    ok(c.backend?.pi?.timeoutMs > 0, 'pi 默认超时存在')
    ok(c.backend?.pi?.toolTimeoutMs > 0, 'pi 默认工具档超时存在')
    ok(c.backend?.pi?.idleMs === 600_000, 'pi 默认空闲回收阈值 10 分钟')
    const { execFileSync } = await import('node:child_process')
    const script = `. '${process.cwd()}/scripts/lib/config-dir.sh'; ocb_label app; echo; OCB_INSTANCE=pi; ocb_label app; echo; ocb_label serve`
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim().split('\n')
    ok(out[0] === 'ai.qiguang.ocbridge.app', '缺省实例 label 不变（老部署零改动）')
    ok(out[1] === 'ai.qiguang.ocbridge.pi.app' && out[2] === 'ai.qiguang.ocbridge.pi.serve', 'OCB_INSTANCE 隔开两个实例')
  }

  // RPC 进程长驻：不杀的话测试进程被 stdout 管道拖着退不出去
  for (const b of backends) {
    for (const proc of b.procs.values()) {
      try {
        proc.child.kill('SIGKILL')
      } catch {
        /* 进程已经没了 */
      }
    }
    b.procs.clear()
  }

  rmSync(root, { recursive: true, force: true })
  console.log(`\n=== ${pass} 项通过，${fail} 项失败 ===\n`)
  if (fail) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* noop */
  }
  process.exit(1)
})
