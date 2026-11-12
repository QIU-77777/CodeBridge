#!/usr/bin/env node
/**
 * pi 后端离线测试。
 *
 * 不连飞书、不跑真模型：用一个 node 子进程冒充 pi，输出与 pi --mode json
 * 同形状的 JSONL。这样能真实验证子进程生命周期（退出码、SIGTERM、超时、
 * 孤儿进程与进程组清理），又不会消耗额度或依赖本机装没装 pi。
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
import { runCard, helpCard, statusCard } from '../src/cards.js'
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

/** 冒充 pi 的脚本：按环境变量决定输出正常结果 / 失败 / 挂住 / 留孤儿进程 */
const FAKE_PI = `
const mode = process.env.OCB_TEST_PI_MODE || 'normal'
if (mode === 'version') { console.log('pi 1.2.3'); process.exit(0) }
if (mode === 'fail') { console.error('boom: provider unavailable'); process.exit(2) }
if (mode === 'dump-env') {
  // 把桥接注入的环境变量落盘，供测试断言身份注入（飞书 + GitHub）
  require('node:fs').writeFileSync(process.env.OCB_TEST_ENV_DUMP, JSON.stringify({
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
  process.exit(0)
}
const usage = { input: 17, output: 3, cacheRead: 4608, cacheWrite: 0, totalTokens: 4628,
  cost: { input: 0.00002244, output: 0.00001188, cacheRead: 0.000202752, cacheWrite: 0, total: 0.000237072 } }
const emit = (o) => console.log(JSON.stringify(o))
emit({ type: 'session', id: 'fake', cwd: process.cwd() })
emit({ type: 'agent_start' })
if (mode === 'provider-error') {
  // 复现真实故障：模型调用被 provider 拒（429 限流、provider 未配置）。
  // pi 打一条 stopReason=error、errorMessage 带原文的助手消息后不退出——
  // 修复前只能等满 backend.pi.timeoutMs 才终态，用户白等
  emit({ type: 'message', id: 'err1', message: { role: 'assistant', content: [],
    provider: 'stepfun-platform', model: 'step-5-preview', usage,
    stopReason: 'error',
    errorMessage: 'stepfun-platform API error (429): request limited TPM reached, current: 565751, limit: 500000' } })
  setInterval(() => {}, 1000)
  process.stdout.write('')
}
else if (mode === 'quiet-final') {
  // 复现真实故障：最终回答产出了，agent_settled 永远不来，进程也不退。
  // 实测一次卡片在「执行中」停了 6 分 58 秒——桥接只能等进程退出
  emit({ type: 'message_end', message: { role: 'assistant',
    content: [{ type: 'text', text: 'QUIETDONE' }], provider: 'stepfun-platform',
    model: 'step-5-preview', usage } })
  emit({ type: 'turn_end', message: { role: 'assistant',
    content: [{ type: 'text', text: 'QUIETDONE' }], usage } })
  setInterval(() => {}, 1000)
  process.stdout.write('')
}
else if (mode === 'quiet-empty') {
  // 最终轮次没有正文：不能按已完成收尾，那可能只是还没产出回答的慢运行，
  // 切掉会把真正的答案丢掉。继续等进程退出 / 超时
  emit({ type: 'message_end', message: { role: 'assistant', content: [],
    provider: 'stepfun-platform', model: 'step-5-preview', usage } })
  emit({ type: 'turn_end', message: { role: 'assistant', content: [], usage } })
  setInterval(() => {}, 1000)
  process.stdout.write('')
}
else if (mode === 'slow-but-alive') {
  // 复现真实事故（2026-11-08 11:41）：一个运行 10 分钟里产出 16290 行、12 步，
  // 一直在干活，被「按总时长算的超时」杀掉。修复后超时按活跃度算：每隔 200ms
  // 吐一片同一段答案的文本增量，8 片之后给出这段的权威全文并正常退出——
  // 总时长远超 timeoutMs 也不该被杀
  const pieces = ['我先', '读了桥接状态', '，确认进程在跑', '，又核了对', '一遍版本', '与注入', '，全部正常', '。']
  let n = 0
  const timer = setInterval(() => {
    emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: pieces[n] } })
    n++
    if (n >= pieces.length) {
      clearInterval(timer)
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: pieces.join('') }],
        provider: 'stepfun-platform', model: 'step-5-preview', usage } })
      emit({ type: 'agent_settled', aborted: false })
      process.exit(0)
    }
  }, 200)
}
else if (mode === 'tool-silent') {
  // 复现真实故障（2026-11-12 凌晨，小P 第二轮中断）：助手产出文本、发出
  // bash 工具调用，tool_execution_start 之后工具结果永远不回流，进程挂住。
  // 实测那条命令只要 1.5 分钟——不是慢，是挂。修复后工具在飞按
  // toolTimeoutMs 单独算预算，且超时杀进程时已产出的文本不丢
  const asst = (id, text, stop) => ({ role: 'assistant', id, content: text ? [{ type: 'text', text }] : [],
    provider: 'stepfun-platform', model: 'step-5-preview', stopReason: stop, usage })
  emit({ type: 'turn_start' })
  emit({ type: 'message_start', message: asst('a1', '', 'pending') })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'PARTIAL' } })
  emit({ type: 'message_end', message: asst('a1', 'PARTIAL', 'toolUse') })
  emit({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'find ~ -name prompts.json' } })
  setInterval(() => {}, 1000)
  process.stdout.write('')
}
else if (mode === 'tool-then-idle') {
  // 工具正常结束（tool_execution_end）之后模型挂住：预算要切回模型静默档
  // timeoutMs，不能还在工具档干等 toolTimeoutMs
  const asst = (id, text, stop) => ({ role: 'assistant', id, content: text ? [{ type: 'text', text }] : [],
    provider: 'stepfun-platform', model: 'step-5-preview', stopReason: stop, usage })
  emit({ type: 'turn_start' })
  emit({ type: 'message_start', message: asst('a1', '', 'pending') })
  emit({ type: 'message_end', message: asst('a1', '', 'toolUse') })
  emit({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } })
  emit({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', isError: false, durationMs: 5,
    result: { content: [{ type: 'text', text: 'a.js' }], details: {} } })
  setInterval(() => {}, 1000)
  process.stdout.write('')
}
else if (mode === 'stream') {
  // 复现真实多轮运行的事件序列（形状见 pi 文档 docs/json.md）：两轮助手
  // 消息，第一轮带 bash 工具调用，文本分片流出，模型名写在消息里。
  // 修复前这些行只进缓冲区，卡片在运行中一次都不刷新
  const asst = (id, text, stop) => ({ role: 'assistant', id, content: text ? [{ type: 'text', text }] : [],
    provider: 'stepfun-platform', model: 'step-5-preview', stopReason: stop, usage })
  emit({ type: 'turn_start' })
  emit({ type: 'message_start', message: { role: 'user', id: 'u1', content: '读一下' } })
  emit({ type: 'message_end', message: { role: 'user', id: 'u1', content: '读一下' } })
  emit({ type: 'message_start', message: asst('a1', '', 'pending') })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '我先' } })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '看一下。' } })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '我先看一下。' } })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call_1', toolName: 'bash' } })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'call_1', name: 'bash', args: { command: 'ls' } } } })
  emit({ type: 'message_end', message: asst('a1', '我先看一下。', 'toolUse') })
  emit({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } })
  emit({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', isError: false, durationMs: 12,
    result: { content: [{ type: 'text', text: 'a.js 与 b.js' }], details: {} } })
  emit({ type: 'turn_end', message: asst('a1', '我先看一下。', 'toolUse'), toolResults: [] })
  emit({ type: 'turn_start' })
  emit({ type: 'message_start', message: asst('a2', '', 'pending') })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '目录里有' } })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '目录里有 a.js 和 b.js。' } })
  emit({ type: 'message_end', message: asst('a2', '目录里有 a.js 和 b.js。', 'stop') })
  emit({ type: 'turn_end', message: asst('a2', '目录里有 a.js 和 b.js。', 'stop'), toolResults: [] })
  emit({ type: 'agent_end', messages: [] })
  emit({ type: 'agent_settled', aborted: false })
}
else if (mode === 'hang') { setInterval(() => {}, 1000); process.stdout.write('') }
else if (mode === 'orphan') {
  // 模拟 pi 的 bash 工具留下的长驻子进程：继承 stdout/stderr，不随父进程退出，
  // 存活 OCB_TEST_ORPHAN_LIFE_MS 毫秒后写一个标记文件，用来验证它到底有没有被杀掉
  const { spawn } = require('node:child_process')
  const life = Number(process.env.OCB_TEST_ORPHAN_LIFE_MS) || 3000
  spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.env.OCB_TEST_ORPHAN_MARKER, "survived"), ' + life + ')'],
    { stdio: ['ignore', 'inherit', 'inherit'] })
  setInterval(() => {}, 1000)
  process.stdout.write('')
}
else {
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'HEL' } })
  emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'HELLO' } })
  emit({ type: 'message_end', message: { role: 'assistant',
    content: [{ type: 'text', text: 'HELLO' }], provider: 'deepseek', model: 'deepseek-v4-pro', usage } })
  emit({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'HELLO' }], usage } })
  emit({ type: 'agent_end', messages: [] })
  emit({ type: 'agent_settled', aborted: false })
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
    env: { ...(opts.env || process.env), OCB_TEST_PI_MODE: mode },
  })
  calls.push({ bin, args, opts, child })
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

function makeBackend(patch = {}) {
  const { configDir, ...rest } = patch
  return new PiBackend({
    cfg: { ...cfg, ...rest },
    sessionDir,
    configDir,
    spawnImpl: fakeSpawn,
    logger: { warn() {}, info() {} },
  })
}

/** 把合成事件喂给 RunState，返回最终状态 */
function collect(events, sid) {
  const st = new RunState(sid)
  for (const ev of events) st.apply(ev)
  return st
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
    ok(a.oneShot && !a.streaming && !a.agents && !a.permissions, 'pi 能力表：一次性、无流式/agent/权限')
    ok(!b.oneShot && b.streaming && b.agents && b.permissions, 'opencode 能力表：全功能')
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

    // 启动参数：会话续聊、cwd、-- 分隔、授权
    const args = calls[0].args
    ok(args.includes('-p') && args.includes('--mode') && args.includes('json'), '带 -p --mode json')
    ok(args.includes('--session-id') && args[args.indexOf('--session-id') + 1] === s.id, '带 --session-id 续聊')
    ok(args.includes('--session-dir'), '带 --session-dir')
    ok(args.includes('--'), '用 -- 分隔 prompt，避免以 - 开头的消息被当选项')
    ok(args.at(-1) === '说 HELLO', 'prompt 原样传到最后一个参数')
    ok(args.includes('--approve'), '飞书里点不了授权按钮，用 --approve')
    ok(calls[0].opts.cwd === root, 'cwd 是话题绑定的工作目录')
  }

  section('运行中流式：文本、工具、步数、模型边收边发')
  {
    // 复现真实故障（2026-11-07）：pi 后端运行期间不发任何事件，卡片从创建起
    // 就是一张静态图。用户 14:18 发的追问，Lil_P 实际从 14:18:19 干活到
    // 14:25:52，卡片 8 分 24 秒没有任何变化，用户看不到一个字
    const b = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 8000, extraArgs: [] } },
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
    ok(collect(events, s.id).status === 'failed', '非零退出 → RunState failed')
    ok(events.at(-1).type === 'session.execution.failed', '发出 execution.failed')
    ok(String(events.at(-1).data.error.message).includes('boom'), '错误信息带上 stderr')

    currentMode = 'hang'
    events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const pending = b.prompt(s.id, '挂着')
    await new Promise((r) => setTimeout(r, 60))
    ok(await b.interrupt(s.id), 'interrupt 找得到在跑的子进程')
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
    const bFast = makeBackend({ backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 5000, extraArgs: [] } } })
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
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 1200, extraArgs: [] } },
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
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 600, toolTimeoutMs: 2500, settleQuietMs: 0, extraArgs: [] } },
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
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 600, toolTimeoutMs: 8000, settleQuietMs: 0, extraArgs: [] } },
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

  section('孤儿进程不再拖住收尾')
  {
    // 评审实测复现：pi 的 bash 工具留下长驻子进程，持有继承来的 stdout/stderr。
    // 修复前收尾听 close，要等孤儿退出，中断后 29 秒才发 interrupted。
    const b = makeBackend()
    const s = await b.createSession({ title: '孤儿进程', directory: root })
    const marker = join(root, 'orphan-marker-a')
    process.env.OCB_TEST_ORPHAN_MARKER = marker

    currentMode = 'orphan'
    let events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const t0 = Date.now()
    const pending = b.prompt(s.id, '挂着')
    await new Promise((r) => setTimeout(r, 150))
    ok(await b.interrupt(s.id), 'interrupt 找得到在跑的子进程')
    await pending
    const elapsed = Date.now() - t0
    ok(elapsed < 1500, `有孤儿进程时中断也秒级收尾（实际 ${elapsed}ms，修复前要等孤儿退出）`)
    ok(collect(events, s.id).status === 'aborted', '主动中止 → aborted')
    ok(events.at(-1).type === 'session.execution.interrupted', '发出 execution.interrupted')
    // 进程组一起杀掉：孤儿进程到点也不会写标记文件
    await new Promise((r) => setTimeout(r, 3000))
    ok(!existsSync(marker), 'kill 的是整个进程组，孤儿进程没有活下来')
    delete process.env.OCB_TEST_ORPHAN_MARKER

    // 超时路径同样 kill 进程组、同样秒级收尾（cfg.timeoutMs = 800）
    const marker2 = join(root, 'orphan-marker-b')
    process.env.OCB_TEST_ORPHAN_MARKER = marker2
    events = []
    b.subscribe((ev) => events.push(ev), () => {})
    const t1 = Date.now()
    const timed = await b.prompt(s.id, '超时')
    ok(timed.ok === false, '超时返回失败')
    ok(Date.now() - t1 < 2500, `有孤儿进程时超时也秒级收尾（实际 ${Date.now() - t1}ms）`)
    ok(collect(events, s.id).status === 'failed', '超时 → RunState failed')
    await new Promise((r) => setTimeout(r, 2500))
    ok(!existsSync(marker2), '超时也 kill 整个进程组')
    delete process.env.OCB_TEST_ORPHAN_MARKER

    // _runOnce（health 检查走的同一条路）也不再被孤儿进程拖住：
    // 孤儿比 5 秒超时活得久，修复前 health 要等孤儿退出才返回
    forceMode = 'orphan'
    process.env.OCB_TEST_ORPHAN_LIFE_MS = '10000'
    const b2 = makeBackend()
    const t2 = Date.now()
    const h = await b2.health()
    ok(h.ok === true, 'health 仍然返回 ok')
    ok(Date.now() - t2 < 8000, `health 不再被孤儿进程拖过 5 秒超时（实际 ${Date.now() - t2}ms）`)
    forceMode = null
    delete process.env.OCB_TEST_ORPHAN_LIFE_MS
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
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 5000, settleQuietMs: 0, extraArgs: [] } },
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
    ok(r.ok === true, 'dump-env 正常退出')
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
  }

  section('最终消息后静默：按已完成收尾，不等进程退出')
  {
    // 真实故障：pi 产出最终回答后不退出（agent_settled 永远不来），卡片在
    // 「执行中」停了 6 分 58 秒。修复前桥接只能等进程退出，用户干看着
    const bQuiet = makeBackend({
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 30000, settleQuietMs: 400, extraArgs: [] } },
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
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 800, settleQuietMs: 0, extraArgs: [] } },
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
      backend: { type: 'pi', pi: { bin: 'pi', model: '', timeoutMs: 800, settleQuietMs: 400, extraArgs: [] } },
    })
    const sEmpty = await bEmpty.createSession({ title: '空正文', directory: root })
    currentMode = 'quiet-empty'
    events = []
    bEmpty.subscribe((ev) => events.push(ev), () => {})
    const empty = await bEmpty.prompt(sEmpty.id, '没正文')
    ok(empty.ok === false && empty.quietSettled === undefined, '最终轮次没有正文时不做静默收尾')
    ok(collect(events, sEmpty.id).status === 'failed', '仍走超时失败，不会把慢运行误判成完成')
  }

  section('卡片按后端能力降级')
  {
    const pi = helpCard(capabilitiesFor(cfg))
    const oc = helpCard(capabilitiesFor({ backend: { type: 'opencode' } }))
    ok(JSON.stringify(pi).includes('pi 桥接'), 'pi 的帮助卡片标题带后端名')
    ok(JSON.stringify(pi).includes('一次性执行'), 'pi 的帮助卡片说明一次性执行')
    ok(!JSON.stringify(pi).includes('/agent'), 'pi 的帮助卡片不列 /agent')
    ok(JSON.stringify(oc).includes('/agent'), 'opencode 的帮助卡片保留 /agent')
    ok(JSON.stringify(statusCard({ server: { ok: true }, backendLabel: 'pi' })).includes('**pi**'), '状态卡片显示后端名而不是 opencode')
  }

  section('默认配置与多实例 label')
  {
    const c = loadConfig()
    ok(c.backend?.type === 'opencode' || c.backend?.type === 'pi', 'loadConfig 补出了 backend 段（老配置不会 undefined）')
    ok(c.backend?.pi?.timeoutMs > 0, 'pi 默认超时存在')
    ok(c.backend?.pi?.toolTimeoutMs > 0, 'pi 默认工具档超时存在')
    const { execFileSync } = await import('node:child_process')
    const script = `. '${process.cwd()}/scripts/lib/config-dir.sh'; ocb_label app; echo; OCB_INSTANCE=pi; ocb_label app; echo; ocb_label serve`
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim().split('\n')
    ok(out[0] === 'ai.qiguang.ocbridge.app', '缺省实例 label 不变（老部署零改动）')
    ok(out[1] === 'ai.qiguang.ocbridge.pi.app' && out[2] === 'ai.qiguang.ocbridge.pi.serve', 'OCB_INSTANCE 隔开两个实例')
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
