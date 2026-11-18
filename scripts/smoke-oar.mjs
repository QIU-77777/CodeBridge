#!/usr/bin/env node
/**
 * OAR 后端冒烟：六项检查跑一遍，判定在 src/oar-smoke.js，这里只采观测。
 *
 *   node scripts/smoke-oar.mjs kimi
 *   node scripts/smoke-oar.mjs kimi --dir /tmp/x --model kimi-code/k3
 *   node scripts/smoke-oar.mjs claude --env ANTHROPIC_BASE_URL=https://...
 *
 * 六项：安装探测、一句话回合、工具回合（看 exitCode）、abort、忙时注入、图片输入。
 * 判定逻辑与已知限制在 src/oar-smoke.js（KNOWN_REFUSALS）。
 *
 * 真实模型调用：会花钱，要本机装好并登录对应运行时。手动跑，不进 CI。
 * 离线部分（判定逻辑加采集器形状）由 scripts/test-oar-smoke.mjs 覆盖，那个
 * 不装 harness、不登录、不连模型提供商。
 *
 * 配置从实例配置的 backend.oar 取默认值（env 与 model），命令行参数覆盖；
 * OCB_CONFIG_DIR 指哪份配置就读哪份。
 *
 * 退出码：0 六项全过，1 有失败，2 运行本身出错。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultRuntimes } from '@botiverse/oar'
import { OarBackend } from '../src/oar.js'
import { RunState } from '../src/render.js'
import { loadConfig } from '../src/config.js'
import { judgeSmokeRun, formatSmokeReport } from '../src/oar-smoke.js'

// ---------- 提示词 ----------

/** 第 2 项：一句话回合。不让它跑工具，正文干净 */
const TURN_PROMPT = '用一句话说明当前目录这个项目是做什么的。不要运行任何命令，不要读文件，直接根据你知道的说。'
/** 第 3 项：工具回合。断言落在工具名、命令与结果状态上，exitCode 拿得到就连它一起断 */
const TOOL_PROMPT = '运行 node --version，只运行这一个命令，不要做别的事。'
/** 第 4、5 项共用：长任务跑起来后先忙时注入一条，再 abort */
const LONG_PROMPT = '执行 sleep 30，只执行这一个命令，不要做别的事。'
const INJECT_PROMPT = '忙时插一句：收到请继续，不用回复这条。'
/** 第 6 项：图片输入。判的是输入被收下还是整份拒绝，不是模型能不能看懂 */
const IMAGE_PROMPT = '描述这张图片里有什么。'

/** 1x1 绿色 PNG：图片项要一个真实可读的图片文件，不外带资源 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 采集 ----------

/** 安装探测结果归一成判定层认的形状 */
function summarizeInstallation(inst) {
  if (!inst) return { kind: 'not_found' }
  if (inst.kind === 'available') return { kind: 'available', version: inst.version || '' }
  if (inst.kind === 'unsupported') {
    return {
      kind: 'version_unsupported',
      installedVersion: inst.installedVersion || '',
      requiredVersion: inst.requiredVersion || '',
    }
  }
  return { kind: inst.kind || 'unknown' }
}

/** 从原始会话的事件里摘工具观测：名字、命令、结果状态、exitCode（拿不到是 null） */
function observeTool(events) {
  const tool = { name: '', command: '', status: '', exitCode: null }
  const commandOf = (input) => {
    try {
      const j = JSON.parse(input || '{}')
      return j.command || j.cmd || ''
    } catch {
      return ''
    }
  }
  for (const ev of events) {
    if (ev.kind === 'tool_call_started' && ev.tool) {
      tool.name = ev.tool
      // 脚本运行把参数放在 started 上；kimi 这类流式的后补一条完整的
      // tool_call_input。谁后到谁完整，后来者覆盖
      if (!tool.command && ev.input) tool.command = commandOf(ev.input)
    } else if (ev.kind === 'tool_call_input' && ev.input) {
      const c = commandOf(ev.input)
      if (c) tool.command = c
    } else if (ev.kind === 'tool_call_ended') {
      if (ev.result) tool.status = ev.result
      if (ev.exitCode !== undefined && ev.exitCode !== null) tool.exitCode = ev.exitCode
    }
  }
  return tool
}

/**
 * 跑六项，采一份观测。判定与报告在 src/oar-smoke.js。
 *
 * 第 2、4、5 项走后端产品路径（OarBackend：prompt 加事件翻译、deliver、interrupt），
 * 第 3、6 项走原始会话——exitCode 字段与图片输入不在桥接的事件契约里，只有
 * OAR 的 Session 面上看得到。第 4、5 项共用同一个长回合：注入落点看 landed，
 * 中止看终态，省一次模型调用。
 *
 * @param {object} opts
 * @param {string} opts.runtimeId OAR 注册表 id
 * @param {string} opts.directory 会话目录
 * @param {string} [opts.model]
 * @param {object} [opts.env] SessionOptions.env 的叠加
 * @param {object} [opts.registry] 运行时注册表；离线测试注入脚本运行时
 * @param {object} [opts.logger]
 * @param {number} [opts.turnTimeoutMs] 单项回合的等待上限。kimi 开回合约 2 秒，
 *   提供商 5xx 时自己的重试能到 140 秒，默认给足
 * @returns {Promise<object>} 观测
 */
export async function collectSmokeObservations({
  runtimeId,
  directory,
  model = '',
  env = {},
  registry,
  logger = console,
  turnTimeoutMs = 240_000,
} = {}) {
  const cfg = {
    backend: { type: 'oar', oar: { runtime: runtimeId, model, env } },
    opencode: { defaultDirectory: directory },
  }
  // 先建后端再建临时目录：运行时不支持时构造就抛，免得留一个空目录在 /tmp
  const be = new OarBackend({ cfg, sessionDir: mkdtempSync(join(tmpdir(), 'oar-smoke-')), registry, logger })
  const sessionDir = be.sessionDir
  // 能力与安装状态在构造里异步解析，等它落地再采（解析失败也继续，下面给明确的话）
  await be._ready.catch(() => {})

  const obs = { runtimeId, installation: null, reportsTokens: false }
  const cleanup = async () => {
    await be.close?.().catch(() => {})
    rmSync(sessionDir, { recursive: true, force: true })
  }

  try {
    // 1. 安装探测：直接问运行时，拿真实 kind（后端只记 available 与否）
    const inst = await be.runtime.installation?.()
    obs.installation = summarizeInstallation(inst)
    if (!inst || inst.kind !== 'available') return obs

    const seen = []
    be.subscribe((ev) => seen.push(ev), () => {})
    const session = await be.createSession({ directory, title: '冒烟' })

    /**
     * 等桥接侧跑到终态，返回这一轮的运行态。
     *
     * 每一轮一份新的 RunState：共用一份的话，上一轮跑完 status 已经是 done，
     * 下一轮的等待第一圈就把它当终态返回，真实的终态（尤其 abort 后的 aborted）
     * 永远采不到——那会把冒烟判成「abort 后终态是 done」。
     */
    const settleBridge = async (from) => {
      const state = new RunState(session.id)
      const t0 = Date.now()
      for (;;) {
        for (const ev of seen.slice(from)) {
          if (ev.data?.sessionID === session.id) state.apply(ev)
        }
        if (['done', 'failed', 'aborted'].includes(state.status)) return state
        if (Date.now() - t0 > turnTimeoutMs) throw new Error(`等终态超时（${Math.round(turnTimeoutMs / 1000)} 秒），最后状态 ${state.status}`)
        await sleep(50)
      }
    }
    /** 等这一轮真的开始出内容：忙时注入必须落在进行中的回合上 */
    const waitTurnActive = async (from) => {
      const t0 = Date.now()
      for (;;) {
        if (seen.slice(from).some((ev) => ev.data?.sessionID === session.id)) return
        if (Date.now() - t0 > turnTimeoutMs) throw new Error('等回合开始超时')
        await sleep(50)
      }
    }

    // 2. 一句话回合（产品路径）
    const from = seen.length
    await be.prompt(session.id, TURN_PROMPT)
    const turnState = await settleBridge(from)
    obs.turn = {
      text: turnState.text,
      terminal: turnState.status,
      tokens: turnState.tokens && (turnState.tokens.input || turnState.tokens.output) ? turnState.tokens : null,
    }

    // 3. 工具回合（原始会话：要看 exitCode 字段）
    const raw = await be.runtime.session(be.installation, {
      cwd: directory,
      ...(model ? { model } : {}),
      ...(env && Object.keys(env).length ? { env } : {}),
    })
    // raw 不在 be.live 里，外层 finally 的 be.close() 管不到它：第 3 到 6 项
    // 任何一步抛异常，这个进程就留在机器上，手动跑冒烟失败的人得自己杀。
    // 包一层 finally，成功失败都 dispose（契约保证 dispose 幂等）
    try {
      const rawEvents = []
      raw.events((ev) => {
        if (!ev.agentPath || ev.agentPath.length === 0) rawEvents.push(ev)
      })
      await raw.prompt(TOOL_PROMPT)
      {
        const t0 = Date.now()
        for (;;) {
          if (rawEvents.some((ev) => ev.kind === 'turn_ended')) break
          if (Date.now() - t0 > turnTimeoutMs) throw new Error('等工具回合结束超时')
          await sleep(50)
        }
      }
      obs.tool = observeTool(rawEvents)
      // 运行时到底上不上报 token 总量：原始会话的读数，判定层据此决定断不断用量
      obs.reportsTokens = Boolean(raw.usage().value?.total)

      // 4、5. 长任务：忙时注入 + abort（产品路径，共用同一回合）
      const running = be.prompt(session.id, LONG_PROMPT)
      // 等待起点取在 prompt 之后、注入与中断之前：abort 的终止事件在中断调用
      // 返回前就已经同步进 seen，起点取在中断之后会把它漏掉，新一轮的运行态
      // 永远等不到终态（实测：等到超时，状态停在 running）
      const abortFrom = seen.length
      await waitTurnActive(abortFrom)
      await sleep(500) // 让回合真的进入工具执行，注入才落在忙时
      const landed = await be.prompt(session.id, INJECT_PROMPT, { delivery: 'steer' })
      const accepted = await be.interrupt(session.id)
      const abortState = await settleBridge(abortFrom)
      await running.catch(() => {})
      obs.abort = { accepted, terminal: abortState.status }
      obs.inject = { landed, declaredSteer: be.caps.steer === true }

      // 6. 图片输入（原始会话：图片不在桥接的事件契约里）
      const declaredImages = be.runtime.sessionCapabilities?.(be.installation)?.images === true
      const sessionImages = raw.capabilities?.images === true
      const png = join(sessionDir, 'smoke.png')
      writeFileSync(png, TINY_PNG)
      const r = await raw.prompt(IMAGE_PROMPT, { images: [{ path: png }] })
      obs.image = {
        declaredImages,
        sessionImages,
        outcome: r.kind === 'rejected' ? 'rejected' : 'accepted',
        code: r.code,
        reason: r.reason,
      }
    } finally {
      await raw.dispose().catch(() => {})
    }

    return obs
  } finally {
    await cleanup()
  }
}

// ---------- 命令行 ----------

function parseArgs(argv) {
  const args = argv.slice(2)
  const out = { runtime: '', dir: '', model: '', env: {} }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dir') out.dir = args[++i] || ''
    else if (a === '--model') out.model = args[++i] || ''
    else if (a === '--env') {
      const kv = args[++i] || ''
      const eq = kv.indexOf('=')
      if (eq > 0) out.env[kv.slice(0, eq)] = kv.slice(eq + 1)
    } else if (!a.startsWith('--')) out.runtime = a
  }
  return out
}

async function main() {
  const flags = parseArgs(process.argv)
  let fileEnv = {}
  let fileModel = ''
  let fileRuntime = ''
  try {
    const cfg = loadConfig()
    fileEnv = cfg.backend?.oar?.env && typeof cfg.backend.oar.env === 'object' ? cfg.backend.oar.env : {}
    fileModel = cfg.backend?.oar?.model || ''
    fileRuntime = cfg.backend?.oar?.runtime || ''
  } catch (err) {
    console.log(`（读实例配置失败，只用命令行参数：${err.message}）`)
  }
  const runtimeId = flags.runtime || fileRuntime
  if (!runtimeId) {
    console.error('用法：node scripts/smoke-oar.mjs <runtime id> [--dir 目录] [--model 模型] [--env K=V ...]')
    console.error('runtime id 例如 kimi / claude / codex / pi；也可在实例配置的 backend.oar.runtime 里给')
    process.exit(2)
  }
  const directory = flags.dir || process.cwd()
  const model = flags.model || fileModel
  const env = { ...fileEnv, ...flags.env }

  console.log(`OAR 冒烟 · 运行时 ${runtimeId}${model ? ` · 模型 ${model}` : ''}`)
  console.log(`目录 ${directory}`)
  console.log('')

  let obs
  try {
    obs = await collectSmokeObservations({ runtimeId, directory, model, env, registry: defaultRuntimes })
  } catch (err) {
    console.error(`冒烟运行失败：${err?.message || err}`)
    process.exit(2)
  }

  const result = judgeSmokeRun(obs)
  console.log(formatSmokeReport(`${runtimeId} 冒烟`, result))
  process.exit(result.ok ? 0 : 1)
}

// 被测试 import 时不跑命令行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`冒烟运行失败：${err?.message || err}`)
    process.exit(2)
  })
}
