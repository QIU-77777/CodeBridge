#!/usr/bin/env node
/**
 * OAR 后端的离线测试：不装任何 harness、不登录、不连模型提供商。
 *   node scripts/test-oar-backend.mjs
 *
 * 用脚本运行时冒充注册表里的一个 id（kimi），驱动 src/oar.js 的整条链路：
 * 建会话、发消息、事件翻译、复用、回收后恢复、切模型、删会话、能力解析。
 * 每个小节一份独立的会话索引目录，互不看见。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntimeRegistry } from '@botiverse/oar'
import { scriptedRuntime } from '@botiverse/oar/testing'
import { OarBackend } from '../src/oar.js'

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

const root = mkdtempSync(join(tmpdir(), 'oar-backend-'))
let dirSeq = 0
const cfg = {
  backend: { type: 'oar', oar: { runtime: 'kimi', env: { KIMI_MODEL_PROVIDER_TYPE: 'openai' } } },
  opencode: { defaultDirectory: root },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 脚本运行时，id 顶成 kimi 才能过开放表 */
function makeRuntime(turn, extra = {}) {
  const rt = scriptedRuntime({ id: 'kimi', turn })
  return { ...rt, ...extra }
}

function makeBackend(runtime) {
  const registry = createRuntimeRegistry([runtime])
  return new OarBackend({
    cfg,
    sessionDir: join(root, `s${dirSeq++}`),
    registry,
    logger: { info() {}, warn() {}, error() {} },
  })
}

/** 等启动解析落地：能力与安装状态都在构造里异步查 */
const ready = (be) => be._ready.catch(() => {})

/**
 * 发一条消息并等它跑到终态。
 *
 * 桥接的 run 由事件驱动，prompt() 只保证控制被接受，所以这里显式等终态。
 * from 之前的终态不算——同一个会话会跑好几轮。
 */
async function promptAndSettle(be, seen, sid, text) {
  const from = seen.length
  await be.prompt(sid, text)
  const t0 = Date.now()
  for (;;) {
    const types = seen.slice(from).filter((e) => e.data.sessionID === sid).map((e) => e.type)
    if (types.some((t) => /^session\.execution\.(succeeded|failed|aborted)$/.test(t))) return types
    if (Date.now() - t0 > 10000) throw new Error('等终态超时')
    await sleep(20)
  }
}

// ---------- 1. 配置校验 ----------

{
  const registry = createRuntimeRegistry([makeRuntime((t) => t.say('x'))])
  let threw = ''
  try {
    new OarBackend({ cfg: { backend: { type: 'oar', oar: {} } }, sessionDir: root, registry })
  } catch (e) {
    threw = e.message
  }
  ok(threw.includes('runtime 未配置'), 'runtime 未配置时报错并列出可选值', threw)

  threw = ''
  try {
    new OarBackend({ cfg: { backend: { type: 'oar', oar: { runtime: 'cursor' } } }, sessionDir: root, registry })
  } catch (e) {
    threw = e.message
  }
  ok(threw.includes('不支持的 backend.oar.runtime'), '不在开放表内的运行时报错', threw)

  threw = ''
  try {
    new OarBackend({ cfg: { backend: { type: 'oar', oar: { runtime: '不存在的' } } }, sessionDir: root, registry })
  } catch (e) {
    threw = e.message
  }
  ok(threw.includes('不支持的 backend.oar.runtime'), '拼错的运行时报错', threw)
}

// ---------- 2. 建会话不开进程 ----------

{
  const be = makeBackend(makeRuntime((t) => t.say('不该被调用')))
  await ready(be)
  const s = await be.createSession({ directory: root, title: '第一个' })
  ok(s.id.startsWith('oar-'), '建会话得到桥接 id', s.id)
  ok(s.oarId === null, '建会话不打开 OAR 会话', JSON.stringify(s.oarId))
  ok(s.location.directory === root, '目录记进索引', s.location.directory)
  ok(be.live.size === 0, '没有运行中的会话')
  const list = await be.listSessions()
  ok(list.length === 1 && list[0].title === '第一个', '列表能读到自己建的')
}

// ---------- 3. 发消息：事件翻译到桥接形状 ----------

{
  const be = makeBackend(
    makeRuntime(async (t) => {
      t.say('第一段。')
      await t.tool('bash', JSON.stringify({ command: 'node --version' }), () => 'v24.20.0\n')
      t.say('第二段。')
    }),
  )
  await ready(be)
  const seen = []
  be.subscribe((ev) => seen.push(ev), () => {})

  const s = await be.createSession({ directory: root })
  await promptAndSettle(be, seen, s.id, '你好')

  const types = seen.map((e) => e.type)
  ok(types.includes('session.execution.started'), '起步事件到达', types.join(','))
  ok(types.includes('session.text.delta'), '正文事件到达')
  ok(types.includes('session.tool.called'), '工具事件到达')
  ok(types.includes('session.tool.success'), '工具成功事件到达')
  ok(types.includes('session.execution.succeeded'), '终态事件到达')
  ok(types.includes('session.usage.updated'), '用量事件到达')
  ok(seen.every((e) => e.data.sessionID === s.id), '事件都带桥接会话 id（不是 OAR 的）')
  const text = seen.filter((e) => e.type === 'session.text.delta').map((e) => e.data.delta).join('')
  ok(text === '第一段。第二段。', '正文按顺序拼接', JSON.stringify(text))
  const entry = await be.getSession(s.id)
  ok(Boolean(entry.oarId), 'OAR 会话 id 记进索引', JSON.stringify(entry.oarId))
  ok(be.live.size === 1, '会话活着，下次直接复用')
}

// ---------- 4. 复用与恢复 ----------

{
  const opened = []
  const be = makeBackend(
    makeRuntime((t) => {
      opened.push(t.input)
      t.say('回复：' + t.input)
    }),
  )
  await ready(be)
  const seen = []
  be.subscribe((ev) => seen.push(ev), () => {})
  const s = await be.createSession({ directory: root })
  await promptAndSettle(be, seen, s.id, '第一条')
  const firstOarId = (await be.getSession(s.id)).oarId
  await promptAndSettle(be, seen, s.id, '第二条')
  ok(be.live.size === 1, '第二条消息复用同一个运行中的会话', `运行中 ${be.live.size}`)
  ok((await be.getSession(s.id)).oarId === firstOarId, 'OAR 会话 id 不变')

  // 回收后再发：走 resume，OAR 会话 id 不变，脚本重新跑一个回合
  be._dropLive(s.id, '测试回收')
  ok(be.live.size === 0, '回收后没有运行中的会话')
  await promptAndSettle(be, seen, s.id, '第三条')
  ok((await be.getSession(s.id)).oarId === firstOarId, '回收后恢复用同一个 OAR 会话 id')
  ok(opened.length === 3 && opened[2] === '第三条', '恢复后脚本跑一个新的回合', JSON.stringify(opened))
}

// ---------- 5. 中止 ----------

{
  const be = makeBackend(
    makeRuntime(async (t) => {
      t.say('开始。')
      await sleep(300)
      t.say('结束。')
    }),
  )
  await ready(be)
  const seen = []
  be.subscribe((ev) => seen.push(ev), () => {})
  const s = await be.createSession({ directory: root })
  const p = be.prompt(s.id, '跑一个长任务')
  await sleep(60)
  const stopped = await be.interrupt(s.id)
  const types = await new Promise((resolve) => {
    const t0 = Date.now()
    const check = () => {
      const got = seen.filter((e) => e.data.sessionID === s.id).map((e) => e.type)
      if (got.includes('session.execution.aborted')) return resolve(got)
      if (Date.now() - t0 > 10000) return resolve(got)
      setTimeout(check, 20)
    }
    check()
  })
  await p
  ok(stopped === true, '中止返回成功')
  ok(types.includes('session.execution.aborted'), '中止事件到达', types.join(','))
  ok(be.live.get(s.id) !== undefined, '中止后会话还在（历史留着）')
}

// ---------- 6. 切模型与删除 ----------

{
  const be = makeBackend(makeRuntime((t) => t.say('x')))
  await ready(be)
  const seen = []
  be.subscribe((ev) => seen.push(ev), () => {})
  const s = await be.createSession({ directory: root })
  await promptAndSettle(be, seen, s.id, '第一条')
  ok(be.live.size === 1, '发过消息后会话活着')
  let msg = ''
  try {
    await be.renameSession(s.id, '新名字')
  } catch (e) {
    msg = e.message
  }
  ok(msg.includes('不支持改会话名'), '改名明确拒绝并说清原因', msg)

  await be.deleteSession(s.id)
  ok((await be.listSessions()).length === 0, '删除后列表为空')
  ok(be.live.size === 0, '删除时运行中的会话也关掉')
}

// ---------- 7. 能力解析 ----------

{
  const be = makeBackend(
    makeRuntime((t) => t.say('x'), {
      sessionCapabilities: () => ({ steer: true, images: true }),
      brand: { name: 'Kimi Code', icon: null },
      refusedSessionOptions: { name: '没有名字设置', systemPrompt: '不带系统提示词' },
    }),
  )
  ok(be.caps.steer === false, '解析前 steer 是 false（不渲染按钮）')
  ok(be.caps.label === 'kimi', '解析前标签用运行时 id')
  await ready(be)
  ok(be.caps.steer === true, '解析后 steer 按声明', JSON.stringify(be.caps))
  ok(be.caps.images === true, '解析后 images 按声明')
  ok(be.caps.label === 'Kimi Code', '解析后标签用 brand.name', be.caps.label)
  ok(be.caps.permissions === false && be.caps.agents === false && be.caps.oneShot === false, '权限、agent、一次性都是 false')
  ok(be.caps.streaming === true, '流式为 true')

  // 状态事件把能力带上去
  let pushed = null
  be.subscribe(() => {}, (s) => {
    if (s.caps) pushed = s.caps
  })
  await sleep(30)
  ok(pushed?.steer === true, 'subscribe 时补发能力', JSON.stringify(pushed))
  ok(pushed?.type === 'oar', '推上去的 caps 带 type，setCaps 整体替换后才不会丢掉', JSON.stringify(pushed))
  ok(be.caps.type === 'oar', '解析后的 caps 也带 type', JSON.stringify(be.caps))

  // 解析前的保守值同样带 type：解析完成前 /login 就能走对分支
  const be2 = makeBackend(
    makeRuntime((t) => t.say('x'), {
      sessionCapabilities: () => ({ steer: true }),
      installation: async () => {
        await sleep(200)
        return { kind: 'available', via: 'bundled' }
      },
    }),
  )
  ok(be2.caps.type === 'oar', '解析前的 caps 也带 type', JSON.stringify(be2.caps))
  ok(be2.caps.steer === false, '解析前 steer 仍是 false')

  const opts = be.buildSessionOptions({ directory: root, model: 'kimi-code/k3', name: '起个名字' })
  ok(opts.cwd === root && opts.model === 'kimi-code/k3', '目录与模型进选项', JSON.stringify(opts))
  ok(opts.name === undefined, '被拒的 name 剥掉', JSON.stringify(opts))
  ok(JSON.stringify(opts.env) === JSON.stringify(cfg.backend.oar.env), 'env 原样进选项', JSON.stringify(opts.env))
}

// ---------- 8. 模型列表 ----------

{
  const be = makeBackend(
    makeRuntime((t) => t.say('x'), {
      listModels: async () => [{ id: 'kimi-code/k3', name: 'K3' }, { id: 'kimi-code/k2', name: 'K2' }],
    }),
  )
  await ready(be)
  ok((await be.listAgents()).length === 0, 'agent 列表为空')
  let msg = ''
  try {
    await be.switchAgent('x')
  } catch (e) {
    msg = e.message
  }
  ok(msg.includes('没有 opencode 的 agent 概念'), '切 agent 明确拒绝', msg)
}

// ---------- 9. 忙等守卫与空闲回收竞态 ----------

{
  // 切模型与删会话都会 dispose 正在跑的会话，等于杀掉当前回合，必须拒绝
  const be = makeBackend(
    makeRuntime(async (t) => {
      t.say('开始。')
      await sleep(400)
      t.say('结束。')
    }),
  )
  await ready(be)
  const seen = []
  be.subscribe((ev) => seen.push(ev), () => {})
  const s = await be.createSession({ directory: root })
  const p = be.prompt(s.id, '长任务')
  await sleep(60)

  ok(be.isBusy(s.id) === true, '回合进行中 isBusy 为 true')
  let msg2 = ''
  try {
    await be.deleteSession(s.id)
  } catch (e) {
    msg2 = e.message
  }
  ok(msg2 === '有任务正在跑，等它结束再删会话', '忙时删会话明确拒绝', msg2)
  ok(be.live.size === 1, '被拒之后会话还在跑')

  await promptAndSettle(be, seen, s.id, '等它结束')
  await p
  ok(be.isBusy(s.id) === false, '回合结束 isBusy 为 false')
}

{
  // 空闲回收竞态：复用会话时必须清掉上一轮装的定时器，否则长回合会被腰斩
  const be = makeBackend(
    makeRuntime(async (t) => {
      t.say('回合：' + t.input)
      await sleep(500)
      t.say('（跑完）')
    }),
  )
  await ready(be)
  const seen = []
  be.subscribe((ev) => seen.push(ev), () => {})
  const s = await be.createSession({ directory: root })
  // 第一轮跑完，handler 的 _finalizeRun 会调 noteRunEnded 装定时器（这里
  // 手动调，idleMs 收到 30ms 模拟那个定时器）
  be.idleMs = 30
  await promptAndSettle(be, seen, s.id, '第一条')
  be.noteRunEnded(s.id)
  ok(be.idleTimers.get(s.id) !== undefined, '第一轮跑完装了空闲定时器')
  ok(be.live.size === 1, '会话还活着（定时器还没触发）')

  // 第二条消息立刻到：复用会话前定时器必须被清掉，否则这一轮跑到一半被 dispose
  be.idleMs = 30
  await promptAndSettle(be, seen, s.id, '第二条')
  const types = seen.slice(seen.indexOf(seen.find((e) => e.data.sessionID === s.id && e.type === 'session.execution.succeeded'))).map((e) => e.type)
  ok(!types.includes('session.execution.failed'), '复用会话后长回合没被腰斩', types.join(','))
  ok(be.live.size === 1, '复用后会话还在')
  ok((await be.getSession(s.id)).oarId, 'OAR 会话 id 还在')
}

// ---------- 10. 忙时注入不抛 busy ----------

{
  // 统一走 deliver：忙时 steer 或排队，不把用户的消息变成失败卡片
  const be = makeBackend(
    makeRuntime(async (t) => {
      t.say('第一轮：' + t.input)
      while (t.steered.length === 0 && !t.signal.aborted) await sleep(20)
      t.say('收到：' + t.steered.join('|'))
    }),
  )
  await ready(be)
  const seen = []
  be.subscribe((ev) => seen.push(ev), () => {})
  const s = await be.createSession({ directory: root })
  const p = be.prompt(s.id, '先跑着')
  await sleep(60)
  // 忙时再发一条：必须落到 queued 或 steered，不能抛 busy
  const landed = await be.prompt(s.id, '忙时插一句')
  ok(landed === 'queued' || landed === 'steered', '忙时发送落到排队或引导，不抛错', landed)
  await promptAndSettle(be, seen, s.id, '再跑一轮')
  await p
}

// ---------- 11. 运行时没装 ----------

{
  const be = makeBackend(
    makeRuntime((t) => t.say('x'), {
      installation: async () => ({ kind: 'not_found' }),
    }),
  )
  await ready(be)
  const h = await be.health()
  ok(h.ok === false, '没装时健康检查报不可用', JSON.stringify(h))
  const s = await be.createSession({ directory: root })
  let msg = ''
  try {
    await be.prompt(s.id, '你好')
  } catch (e) {
    msg = e.message
  }
  ok(msg.includes('未安装或未登录'), '没装时发消息给一句明确的话', msg)
}

rmSync(root, { recursive: true, force: true })

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
