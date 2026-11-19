/**
 * OAR 运行时探测。
 *
 * 配置流程的第一步：本机装了哪些编码 agent 运行时、各是什么版本、登没登录、
 * 能用哪些模型、配额余多少——一页看清，用户不用自己去终端逐个确认。
 *
 * 数据全部来自 OAR 的 orient()：一次有界快照，覆盖安装、登录状态、账号用量、
 * 模型目录。它不开会话、不发 prompt、不跑安装。深度取 models，因为模型目录
 * 要解析凭据，登录状态与用量也在这一层。
 *
 * 环境变量叠加从实例配置的 backend.oar.env 来：探测的是「这个实例将会看到的
 * 那个环境」，不是桥接进程自己的环境。
 */
import { defaultRuntimes, orient } from '@botiverse/oar'

/** 桥接第一版放开的运行时。cursor 与 pi-durable 要宿主传 SDK，不在表内 */
const SUPPORTED = [
  'claude',
  'codex',
  'pi',
  'kimi',
  'qwen',
  'grok',
  'opencode',
  'antigravity',
  'codebuddy',
  'qoder',
  'devin',
  'factory',
  'dsh',
]

/** 一次快照的墙钟上限。账号层要起进程、可能连服务，给足但兜住 */
const TIMEOUT_MS = 60_000

/** 安装状态归一成页面能直接用的三态 */
function installationOf(probe) {
  if (!probe || probe.kind === 'unsupported') return { installed: false, state: 'unsupported', detail: '这个运行时不支持安装探测' }
  if (probe.kind === 'skipped') return { installed: false, state: 'unknown', detail: '探测被跳过' }
  if (probe.kind === 'failed') return { installed: false, state: 'unknown', detail: probe.reason || '探测失败' }
  if (probe.kind === 'timed_out') return { installed: false, state: 'unknown', detail: '探测超时' }
  const snap = probe.value
  if (snap.kind === 'available') {
    return {
      installed: true,
      state: 'available',
      version: snap.version || '',
      command: snap.command || '',
      via: snap.via === 'bundled' ? '随包' : '本机可执行文件',
    }
  }
  if (snap.kind === 'unsupported') {
    return {
      installed: true,
      state: 'version_unsupported',
      version: snap.installedVersion || '',
      detail: `版本过低：${snap.installedVersion || '未知'}，要求 ${snap.requiredVersion || '未知'}。${snap.reason || ''}`,
    }
  }
  // 说「探测器没找到」而不是「没有装」：运行时装在 PATH 之外（桌面版 App 自带的
  // CLI 就是这样）时，探测器同样找不到，那并不是没装
  return { installed: false, state: 'not_found', detail: '探测器没找到：PATH 与常见安装位置都没有可执行文件' }
}

/** 登录状态归一。unknown 与超时都算没确认，不当成已登录 */
function authOf(probe) {
  if (!probe) return { loggedIn: false, state: 'unsupported', detail: '这个运行时不报告登录状态' }
  if (probe.kind === 'ok') {
    const v = probe.value || {}
    const loggedIn = v.kind === 'logged_in'
    return {
      loggedIn,
      state: v.kind,
      detail: v.detail || (loggedIn ? v.account?.email || v.account?.name || '' : ''),
      configured: v.configured || [],
    }
  }
  if (probe.kind === 'skipped') return { loggedIn: false, state: 'unknown', detail: '没装，跳过' }
  if (probe.kind === 'unsupported') return { loggedIn: false, state: 'unsupported', detail: '不报告登录状态' }
  return { loggedIn: false, state: 'unknown', detail: probe.reason || '读取超时' }
}

/** 模型提供方：pi 这类把凭据挂在提供方上的运行时，登录状态在这里看 */
function providersOf(probe) {
  if (!probe || probe.kind !== 'ok') return null
  const list = probe.value || []
  const configured = list.filter((p) => p.configured || p.status === 'configured')
  return { total: list.length, configured: configured.length }
}

/** 账号用量：套餐配额与重置时间，没有就不编 */
function usageOf(probe) {
  if (!probe || probe.kind !== 'ok') return null
  const v = probe.value || {}
  // 快照本身带 kind：拿不到就是 unavailable，不当成零用量
  if (v.kind && v.kind !== 'available') return null
  const windows = Array.isArray(v.windows) ? v.windows : []
  const rows = windows.map((w) => ({
    label: w.label || w.id || '',
    used: typeof w.usedRatio === 'number' ? w.usedRatio : null,
    resetsAt: w.resetsAt || '',
    scope: w.scope?.kind === 'model' ? w.scope.name || '' : '',
  }))
  if (!rows.length && !v.plan) return null
  return { plan: v.plan || '', email: v.email || '', rows }
}

/**
 * 探一遍本机的 OAR 运行时。
 *
 * @param {object} [opts]
 * @param {object} [opts.env] 环境变量叠加，来自实例配置的 backend.oar.env
 * @param {object} [opts.registry] 运行时注册表；测试注入脚本运行时用
 * @returns {Promise<{observedAt:string, runtimes:Array<object>}>}
 */
export async function probeOarRuntimes({ env, registry } = {}) {
  const reg = registry || defaultRuntimes
  // 只探注册表里真有的：换一个 OAR 版本，它的注册表可能少几个 id，按缺失的
  // 去问会整次快照失败
  const ids = SUPPORTED.filter((id) => reg.list().some((r) => r.id === id))
  const snapshot = await orient(reg, {
    runtimes: ids,
    depth: 'models',
    env: env && typeof env === 'object' ? env : undefined,
    timeoutMs: TIMEOUT_MS,
  })

  const runtimes = snapshot.runtimes.map((r) => {
    const inst = installationOf(r.installation)
    const auth = authOf(r.auth)
    const providers = providersOf(r.providers)
    const models =
      r.models && r.models.kind === 'ok' ? (r.models.value || []).map((m) => ({ id: m.id || m.model || '', name: m.name || '' })) : null
    return {
      id: r.id,
      name: r.brand?.name || r.id,
      supported: SUPPORTED.includes(r.id),
      installed: inst.installed,
      installation: inst,
      auth,
      providers,
      usage: usageOf(r.accountUsage),
      models,
    }
  })

  // 装了的排前面，同状态按名字，页面第一眼看到能用的
  runtimes.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1
    if (a.auth.loggedIn !== b.auth.loggedIn) return a.auth.loggedIn ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return { observedAt: snapshot.observedAt, runtimes }
}

export { SUPPORTED as SUPPORTED_OAR_RUNTIMES }
