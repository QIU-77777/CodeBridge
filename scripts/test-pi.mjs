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
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
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
const usage = { input: 17, output: 3, cacheRead: 4608, cacheWrite: 0, totalTokens: 4628,
  cost: { input: 0.00002244, output: 0.00001188, cacheRead: 0.000202752, cacheWrite: 0, total: 0.000237072 } }
const emit = (o) => console.log(JSON.stringify(o))
emit({ type: 'session', id: 'fake', cwd: process.cwd() })
emit({ type: 'agent_start' })
emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'HEL' } })
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
  calls.push({ bin, args, opts })
  const mode = forceMode || (args.includes('--version') ? 'version' : currentMode)
  return spawn(process.execPath, ['-e', FAKE_PI], {
    ...opts,
    env: { ...(opts.env || process.env), OCB_TEST_PI_MODE: mode },
  })
}

const root = mkdtempSync(join(tmpdir(), 'ocb-pi-test-'))
const sessionDir = join(root, 'pi-sessions')
const cfg = {
  backend: { type: 'pi', pi: { bin: 'pi', model: 'deepseek/deepseek-v4-pro', timeoutMs: 800, extraArgs: [] } },
  feishu: {},
  opencode: { url: 'http://127.0.0.1:19876', password: '', defaultDirectory: root, defaultModel: '' },
  behavior: {},
}

function makeBackend(patch = {}) {
  return new PiBackend({ cfg: { ...cfg, ...patch }, sessionDir, spawnImpl: fakeSpawn, logger: { warn() {}, info() {} } })
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
