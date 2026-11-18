#!/usr/bin/env node
/**
 * OAR 运行时探测的离线测试：不连服务、不依赖本机装了什么。
 *   node scripts/test-oar-probe.mjs
 *
 * 用脚本运行时冒充注册表里的几个 id，驱动 admin/oar-runtimes.js 的归一化：
 * 安装三态、登录四种结果、模型目录、配额、排序。
 */
import { createRuntimeRegistry } from '@botiverse/oar'
import { scriptedRuntime } from '@botiverse/oar/testing'
import { probeOarRuntimes } from '../admin/oar-runtimes.js'

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

/** 脚本运行时，id 顶成开放表里的一个 */
function makeRuntime(id, extra = {}) {
  const rt = scriptedRuntime({ id, turn: (t) => t.say('x') })
  return { ...rt, ...extra }
}

const registryOf = (...rts) => createRuntimeRegistry(rts)

// ---------- 1. 安装三态 ----------

{
  // 脚本运行时的安装是「随包」：装了的，但没有版本与路径
  const probe = await probeOarRuntimes({ registry: registryOf(makeRuntime('kimi')) })
  const kimi = probe.runtimes.find((r) => r.id === 'kimi')
  ok(kimi.installed === true, '随包安装算已安装', JSON.stringify(kimi.installation))
  ok(kimi.installation.via === '随包', '随包安装标注来源', kimi.installation.via)
  ok(kimi.installation.version === '', '随包安装没有版本号', JSON.stringify(kimi.installation))

  const probe2 = await probeOarRuntimes({
    registry: registryOf(makeRuntime('codex', { installation: async () => ({ kind: 'not_found' }) })),
  })
  const codex = probe2.runtimes.find((r) => r.id === 'codex')
  ok(codex.installed === false, '本机没有算未安装', JSON.stringify(codex.installation))
  ok(codex.installation.state === 'not_found', '未安装状态明确', codex.installation.state)
  ok(codex.auth.loggedIn === false, '没装时不当成已登录', codex.auth.state)

  const probe3 = await probeOarRuntimes({
    registry: registryOf(
      makeRuntime('grok', {
        installation: async () => ({
          kind: 'unsupported',
          code: 'version_unsupported',
          via: 'executable',
          command: '/usr/local/bin/grok',
          reason: 'grok 1.0.40 is older than 1.0.50',
          installedVersion: '1.0.40',
          requiredVersion: '1.0.50',
        }),
      }),
    ),
  })
  const grok = probe3.runtimes.find((r) => r.id === 'grok')
  ok(grok.installed === true, '版本过低仍然算装过', JSON.stringify(grok.installation))
  ok(grok.installation.state === 'version_unsupported', '版本过低单独一态', grok.installation.state)
  ok(grok.installation.detail.includes('1.0.40') && grok.installation.detail.includes('1.0.50'), '版本过低说清两个版本', grok.installation.detail)
}

// ---------- 2. 登录四种结果 ----------

{
  const probe = await probeOarRuntimes({
    registry: registryOf(
      makeRuntime('claude', { authStatus: async () => ({ kind: 'logged_in', account: { email: 'a@b.c' }, source: 'claude' }) }),
      makeRuntime('codex', { authStatus: async () => ({ kind: 'logged_out', source: 'codex', detail: 'Run codex login' }) }),
      makeRuntime('devin', {
        authStatus: async () => ({ kind: 'unknown', source: 'devin auth status', configured: ['stored credentials'], detail: '连不上服务' }),
      }),
      makeRuntime('pi'),
    ),
  })
  const by = (id) => probe.runtimes.find((r) => r.id === id)
  ok(by('claude').auth.loggedIn === true, '已登录判定为可用', JSON.stringify(by('claude').auth))
  ok(by('claude').auth.detail === 'a@b.c', '已登录带上账号', by('claude').auth.detail)
  ok(by('codex').auth.loggedIn === false && by('codex').auth.state === 'logged_out', '未登录判定为不可用', JSON.stringify(by('codex').auth))
  ok(by('devin').auth.state === 'unknown' && by('devin').auth.configured.length === 1, '有本地凭据但验证不了单独记', JSON.stringify(by('devin').auth))
  ok(by('devin').auth.loggedIn === false, '验证不当成已登录')
  ok(by('pi').auth.state === 'unsupported', '不报告登录状态单独一态', by('pi').auth.state)
}

// ---------- 3. 模型目录与配额 ----------

{
  const probe = await probeOarRuntimes({
    registry: registryOf(
      // 模型目录要解析凭据，没登录时 OAR 直接跳过——所以这个假运行时同时报已登录
      makeRuntime('qwen', {
        authStatus: async () => ({ kind: 'logged_in', source: 'qwen' }),
        listModels: async () => ({
          kind: 'ok',
          models: [{ id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' }, { id: 'qwen3-max', name: 'Qwen3 Max' }],
        }),
      }),
      makeRuntime('dsh', {
        accountUsage: async () => ({
          kind: 'available',
          plan: 'pro',
          rateLimited: false,
          windows: [{ label: '五小时窗口', usedRatio: 0.42, resetsAt: '2026-11-18T20:00:00Z' }],
        }),
      }),
    ),
  })
  const qwen = probe.runtimes.find((r) => r.id === 'qwen')
  ok(qwen.models.length === 2 && qwen.models[0].id === 'qwen3-coder-plus', '模型目录归一成 id 与名字', JSON.stringify(qwen.models))
  const dsh = probe.runtimes.find((r) => r.id === 'dsh')
  ok(dsh.usage?.plan === 'pro', '套餐名带出来', JSON.stringify(dsh.usage))
  ok(dsh.usage.rows[0].used === 0.42 && dsh.usage.rows[0].label === '五小时窗口', '配额窗口归一', JSON.stringify(dsh.usage.rows))
  ok(dsh.usage.rows[0].resetsAt === '2026-11-18T20:00:00Z', '重置时间带出来', dsh.usage.rows[0].resetsAt)

  // 拿不到配额（unavailable）不当成零用量，整块不显示
  const probe2 = await probeOarRuntimes({
    registry: registryOf(
      makeRuntime('devin', {
        authStatus: async () => ({ kind: 'logged_in', source: 'devin' }),
        accountUsage: async () => ({ kind: 'unavailable', reason: 'not_authenticated' }),
      }),
    ),
  })
  ok(probe2.runtimes.find((r) => r.id === 'devin').usage === null, '配额拿不到时不显示，不显示成 0%', JSON.stringify(probe2.runtimes.find((r) => r.id === 'devin').usage))
}

// ---------- 4. 排序与开放标记 ----------

{
  const probe = await probeOarRuntimes({
    registry: registryOf(
      makeRuntime('qwen', { installation: async () => ({ kind: 'not_found' }) }),
      makeRuntime('kimi', { authStatus: async () => ({ kind: 'logged_in', source: 'kimi' }) }),
      makeRuntime('codex', { authStatus: async () => ({ kind: 'logged_out', source: 'codex' }) }),
    ),
  })
  const order = probe.runtimes.map((r) => r.id)
  ok(order.indexOf('kimi') < order.indexOf('codex'), '已登录的排在未登录前面', order.join(','))
  ok(order.indexOf('codex') < order.indexOf('qwen'), '装了的排在没装的前面', order.join(','))
  ok(probe.runtimes.every((r) => r.supported === true), '开放表里的都标为第一版可用')
  ok(typeof probe.observedAt === 'string' && probe.observedAt.length > 0, '快照带观测时间', probe.observedAt)
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
