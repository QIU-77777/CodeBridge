#!/usr/bin/env node
/**
 * OAR 冒烟的离线测试：不装任何 harness、不登录、不连模型提供商。
 *   node scripts/test-oar-smoke.mjs
 *
 * 两层，与 parity 同构：
 *   1. 判定层（src/oar-smoke.js）：合成观测喂 judgeSmokeRun，验六项的通过与
 *      失败分支、kimi 的固有拒绝不当 bug、降级路径（steer 落 queued、图片整份
 *      拒绝）判为通过
 *   2. 采集层（scripts/smoke-oar.mjs 的 collectSmokeObservations）：用脚本运行
 *      时冒充注册表里的 id 跑一遍真采集，验观测形状与「每个回合一份运行态」
 *      那条坑——共用一份时 abort 后的终态采不到，会报成 done
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntimeRegistry } from '@botiverse/oar'
import { scriptedRuntime } from '@botiverse/oar/testing'
import { judgeSmokeRun, formatSmokeReport, KNOWN_REFUSALS } from '../src/oar-smoke.js'
import { collectSmokeObservations } from './smoke-oar.mjs'

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

/** 一份全过的观测 */
function goodObs(over = {}) {
  return {
    runtimeId: 'kimi',
    installation: { kind: 'available', version: '2.3.3' },
    reportsTokens: true,
    turn: { text: '这是一个演示目录。', terminal: 'done', tokens: { input: 100, output: 20 } },
    tool: { name: 'bash', command: 'node --version', status: 'ok', exitCode: 0 },
    abort: { accepted: true, terminal: 'aborted' },
    inject: { landed: 'queued', declaredSteer: false },
    image: { declaredImages: false, sessionImages: false, outcome: 'rejected', code: 'unsupported' },
    ...over,
  }
}

// ---------- 1. 全过 ----------

{
  const r = judgeSmokeRun(goodObs())
  ok(r.ok === true, '六项全过判通过', JSON.stringify(r.failures))
  ok(r.notes.length > 0, '观察项有内容（安装版本、exitCode、降级说明）', JSON.stringify(r.notes))
  const report = formatSmokeReport('kimi 冒烟', r)
  ok(report.includes('六项全部通过'), '报告说清通过')
  ok(report.includes('已知限制'), '报告带已知限制')
  ok(report.includes('steer 缺失') || KNOWN_REFUSALS.some((k) => k.includes('steer')), '已知限制里有 kimi 的 steer 缺失')
}

// ---------- 2. 安装探测 ----------

{
  const r = judgeSmokeRun(goodObs({ installation: { kind: 'not_found' } }))
  ok(r.ok === false && r.failures[0].item === '安装探测', '没装判失败', JSON.stringify(r.failures))
  ok(r.failures[0].detail.includes('先在本机安装并登录'), '没装时说清下一步', r.failures[0].detail)

  const r2 = judgeSmokeRun(
    goodObs({
      installation: { kind: 'version_unsupported', installedVersion: '2.0.0', requiredVersion: '2.3.0' },
      // 安装不可用时采集层直接返回，其余五项没有观测，各项自己报，不是静默通过
      turn: undefined,
      tool: undefined,
      abort: undefined,
      inject: undefined,
      image: undefined,
    }),
  )
  ok(r2.ok === false && r2.failures[0].detail.includes('2.0.0') && r2.failures[0].detail.includes('2.3.0'), '版本过低说清两个版本', JSON.stringify(r2.failures))
  ok(r2.failures.length === 6, '安装不可用时间项都报出来，不当成通过', String(r2.failures.length))
}

// ---------- 3. 一句话回合 ----------

{
  const r = judgeSmokeRun(goodObs({ turn: { text: '', terminal: 'completed', tokens: null } }))
  ok(r.ok === false, '没有正文判失败（kimi 的失败回合看起来是 completed，靠这条兜）', JSON.stringify(r.failures))
  ok(r.failures.some((f) => f.item === '一句话回合' && f.detail.includes('没有收到正文')), '失败原因说清是没收到正文', JSON.stringify(r.failures))

  const r2 = judgeSmokeRun(goodObs({ turn: { text: '有内容', terminal: 'failed', tokens: null } }))
  ok(r2.ok === false && r2.failures.some((f) => f.detail.includes('终态是 failed')), '终态不对判失败', JSON.stringify(r2.failures))

  // 运行时不上报 token 总量（kimi 已知）：用量不断，不判失败
  const r3 = judgeSmokeRun(goodObs({ reportsTokens: false, turn: { text: 'x', terminal: 'done', tokens: null } }))
  ok(r3.ok === true, '运行时不上报 token 总量时不断用量', JSON.stringify(r3.failures))
  ok(r3.notes.some((x) => x.includes('不上报 token 总量')), '观察项记清为什么不断', JSON.stringify(r3.notes))

  // 运行时上报但桥接没收到：翻译层丢了 usage
  const r4 = judgeSmokeRun(goodObs({ reportsTokens: true, turn: { text: 'x', terminal: 'done', tokens: null } }))
  ok(r4.ok === false && r4.failures.some((f) => f.detail.includes('翻译层丢了 usage')), '上报了却没收到判失败', JSON.stringify(r4.failures))
}

// ---------- 4. 工具回合 ----------

{
  const r = judgeSmokeRun(goodObs({ tool: { name: 'bash', command: 'node --version', status: 'ok', exitCode: null } }))
  ok(r.ok === true, '拿不到 exitCode 只验状态，判通过', JSON.stringify(r.failures))
  ok(r.notes.some((x) => x.includes('没报 exitCode')), '观察项记清没验 exitCode', JSON.stringify(r.notes))

  const r2 = judgeSmokeRun(goodObs({ tool: { name: 'bash', command: 'node --version', status: 'ok', exitCode: 1 } }))
  ok(r2.ok === false && r2.failures.some((f) => f.detail.includes('exitCode 是 1')), 'exitCode 非零判失败', JSON.stringify(r2.failures))

  const r3 = judgeSmokeRun(goodObs({ tool: { name: '', command: '', status: '', exitCode: null } }))
  ok(r3.ok === false && r3.failures.length >= 3, '没有工具调用判失败（名字、状态、命令三项）', JSON.stringify(r3.failures))

  const r4 = judgeSmokeRun(goodObs({ tool: { name: 'bash', command: 'ls -la', status: 'ok', exitCode: 0 } }))
  ok(r4.ok === false && r4.failures.some((f) => f.detail.includes('没有 node 命令')), '跑的不是 node 判失败', JSON.stringify(r4.failures))
}

// ---------- 5. abort 与忙时注入 ----------

{
  const r = judgeSmokeRun(goodObs({ abort: { accepted: true, terminal: 'done' } }))
  ok(r.ok === false && r.failures.some((f) => f.detail.includes('期望 aborted')), 'abort 后终态不是 aborted 判失败', JSON.stringify(r.failures))

  const r2 = judgeSmokeRun(goodObs({ abort: { accepted: false, terminal: 'aborted' } }))
  ok(r2.ok === false && r2.failures.some((f) => f.detail.includes('abort 被拒绝')), 'abort 被拒绝判失败', JSON.stringify(r2.failures))

  // 没有 steer 成员的运行时落 queued 是正确降级
  const r3 = judgeSmokeRun(goodObs({ inject: { landed: 'queued', declaredSteer: false } }))
  ok(r3.ok === true, '没有 steer 落排队判通过', JSON.stringify(r3.failures))
  // 声明了 steer 却落排队：deliver 的退路，也判通过但记观察
  const r4 = judgeSmokeRun(goodObs({ inject: { landed: 'queued', declaredSteer: true } }))
  ok(r4.ok === true && r4.notes.some((x) => x.includes('声明支持 steer')), '声明支持 steer 落排队也判通过并记观察', JSON.stringify(r4))
  // 引导成功
  const r5 = judgeSmokeRun(goodObs({ inject: { landed: 'steered', declaredSteer: true } }))
  ok(r5.ok === true, '引导成功判通过', JSON.stringify(r5.failures))
  // 拒绝才是要防的
  const r6 = judgeSmokeRun(goodObs({ inject: { landed: 'rejected', reason: 'busy', declaredSteer: false } }))
  ok(r6.ok === false && r6.failures.some((f) => f.detail.includes('注入被拒绝')), '注入被拒绝判失败', JSON.stringify(r6.failures))
}

// ---------- 6. 图片输入 ----------

{
  // 会话不收图片，整份拒绝：符合预期
  const r = judgeSmokeRun(goodObs({ image: { declaredImages: false, sessionImages: false, outcome: 'rejected', code: 'unsupported' } }))
  ok(r.ok === true, '不收图片且整份拒绝判通过', JSON.stringify(r.failures))
  ok(r.notes.some((x) => x.includes('整份拒绝符合预期')), '观察项记清是符合预期', JSON.stringify(r.notes))

  // 声明不收却被静默收下：失败
  const r2 = judgeSmokeRun(goodObs({ image: { declaredImages: false, sessionImages: false, outcome: 'accepted' } }))
  ok(r2.ok === false && r2.failures.some((f) => f.detail.includes('静默收下')), '静默收下图判失败', JSON.stringify(r2.failures))

  // 会话级说收，也真的收下：通过
  const r3 = judgeSmokeRun(goodObs({ image: { declaredImages: false, sessionImages: true, outcome: 'accepted' } }))
  ok(r3.ok === true, '会话级收图片且收下判通过', JSON.stringify(r3.failures))
  ok(r3.notes.some((x) => x.includes('声明不一致')), '声明不一致记观察', JSON.stringify(r3.notes))

  // 会话级说收却被拒：失败
  const r4 = judgeSmokeRun(goodObs({ image: { declaredImages: true, sessionImages: true, outcome: 'rejected', code: 'unsupported' } }))
  ok(r4.ok === false && r4.failures.some((f) => f.detail.includes('却被拒')), '会话说收却被拒判失败', JSON.stringify(r4.failures))
}

// ---------- 7. 采集层：观测形状与每轮一份运行态 ----------

{
  const root = mkdtempSync(join(tmpdir(), 'oar-smoke-'))
  const dir = join(root, 'proj')
  mkdirSync(dir, { recursive: true })

  // 脚本运行时的能力固定：有 steer、收图片、不拒绝会话选项。所以 steer 项落
  // steered、图片项被收下——采集层要的是把观测采全，不是让六项全过。
  // 长任务那条必须真的长：秒数不够，abort 落下来时回合已经结束，采到的是
  // no_active_turn 拒绝，验不到「每轮一份运行态」那条坑
  const runtime = scriptedRuntime({
    id: 'kimi',
    turn: async (t) => {
      if (t.input.includes('sleep 30')) {
        t.say('开始。')
        await new Promise((r) => setTimeout(r, 3000))
        t.say('结束。')
        return
      }
      t.say('观测：' + t.input)
      if (t.input.includes('node --version')) {
        await t.tool('bash', JSON.stringify({ command: 'node --version' }), () => 'v24.20.0\n')
      }
      t.say('跑完了。')
    },
  })
  const registry = createRuntimeRegistry([runtime])

  const obs = await collectSmokeObservations({
    runtimeId: 'kimi',
    directory: dir,
    registry,
    logger: { info() {}, warn() {}, error() {} },
    turnTimeoutMs: 20000,
  })

  ok(obs.installation?.kind === 'available', '采集到安装探测', JSON.stringify(obs.installation))
  ok(typeof obs.turn?.text === 'string' && obs.turn.text.length > 0, '采集到一句话回合的正文', JSON.stringify(obs.turn))
  ok(obs.turn?.terminal === 'done', '采集到终态（桥接运行态的完成值是 done）', obs.turn?.terminal)
  ok(Boolean(obs.tool?.name), '采集到工具名', JSON.stringify(obs.tool))
  ok(obs.tool?.command?.includes('node'), '采集到工具命令', obs.tool?.command)
  ok(obs.tool?.status === 'ok', '采集到工具结果状态', obs.tool?.status)
  ok(typeof obs.abort?.accepted === 'boolean', '采集到 abort 是否被接受', JSON.stringify(obs.abort))
  ok(obs.abort?.terminal === 'aborted', '采集到 abort 后的终态是 aborted（每轮一份运行态）', String(obs.abort?.terminal))
  ok(typeof obs.inject?.landed === 'string', '采集到注入落点', String(obs.inject?.landed))
  ok(obs.image?.outcome === 'accepted' || obs.image?.outcome === 'rejected', '采集到图片输入的结果', JSON.stringify(obs.image))

  rmSync(root, { recursive: true, force: true })
}

// ---------- 8. 失败路径：raw 会话不泄进程 ----------

{
  // review 第 4 条：第 3 项开的 raw 会话不在 be.live 里，be.close() 管不到。
  // 第 3 到 6 项任何一步抛异常，raw 必须被 dispose，否则手动跑冒烟失败的人
  // 要自己杀进程。这里让第 3 项的用量读取炸掉，验异常抛得出、raw 被 dispose
  const opened = []
  const disposed = []
  const failRoot = mkdtempSync(join(tmpdir(), 'oar-smoke-fail-'))
  const base = scriptedRuntime({
    id: 'kimi',
    turn: async (t) => {
      t.say('观测：' + t.input)
      if (t.input.includes('node --version')) {
        await t.tool('bash', JSON.stringify({ command: 'node --version' }), () => 'v24.20.0\n')
      }
      t.say('跑完了。')
    },
  })
  const spy = {
    ...base,
    session: async (inst, opts) => {
      const s = await base.session(inst, opts)
      opened.push(s.id)
      const orig = s.dispose.bind(s)
      s.dispose = async () => {
        disposed.push(s.id)
        return orig()
      }
      s.usage = () => {
        throw new Error('用量读取炸了')
      }
      return s
    },
  }
  let threw = ''
  try {
    await collectSmokeObservations({
      runtimeId: 'kimi',
      directory: failRoot,
      registry: createRuntimeRegistry([spy]),
      logger: { info() {}, warn() {}, error() {} },
      turnTimeoutMs: 30_000,
    })
  } catch (err) {
    threw = err?.message || String(err)
  }
  ok(threw.includes('用量读取炸了'), '第 3 项失败时异常抛出来，不吞', threw)
  // 这条路径上开过两个会话：第 2 项的桥接会话（在 be.live 里，外层 finally 的
  // be.close() 收）与第 3 项的 raw（不在 live 里，内层 finally 收）。开过的
  // 每个都被 dispose 才算不漏——修之前 raw 那个会留在机器上等人手杀
  ok(opened.length === 2 && disposed.length === opened.length, '失败路径上开过的会话全部 dispose，不泄进程', `开 ${opened.length} 收 ${disposed.length}`)
  rmSync(failRoot, { recursive: true, force: true })
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
