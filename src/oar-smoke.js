/**
 * OAR 后端冒烟判定层：把一侧跑出来的观测判成通过或失败加原因。
 *
 * 为什么判定与采集分开（采集在 scripts/smoke-oar.mjs）：冒烟要覆盖的六项里，
 * 几条降级路径在脚本运行时上验不了——脚本运行时的能力是固定的（有 steer、
 * 收图片、不拒绝任何会话选项，见 @botiverse/oar/testing 的 scripted-runtime）。
 * 分开之后：判定逻辑用合成观测离线验（scripts/test-oar-smoke.mjs），采集器用
 * 脚本运行时验观测形状（exitCode 拿不到那条分支是真的走到），活体第一跑验真。
 * 与 parity 同构：src/parity.js 判定、test-parity.mjs 离线、parity-pi-oar.mjs 真跑。
 *
 * 观测的形状由运行层采，本模块只认字段不认来源。每个观测字段的含义见各
 * judge* 函数上的注释。
 */

/**
 * kimi 的已知行为：冒烟跑出同类结果时对上号，不当 bug。
 *
 * 来源：OAR 仓库 docs/runtimes/kimi.md 的活体证据（2026-09 至 2026-11 多个
 * 版本）与规范页。版本会变，条目对应的现象以该页最新证据为准。
 */
export const KNOWN_REFUSALS = [
  'name / systemPrompt / appendSystemPrompt / serviceTier / goals / endTurnProcessesOnAbort：会话选项被拒，桥接的 buildSessionOptions 会先剥掉',
  'structured output：不经过 ACP 适配器暴露最终输出 schema',
  'token 总量恒不可得：usage().total 是 null，只有上下文占用（contextUsage），也没有 cacheRead 与 cacheWrite',
  'steer 缺失：ACP 没有 steer 方法，忙时注入自动落排队（deliver 的退路）',
  '子代理不到根流：ACP 只订阅主代理，children 是 opaque',
  '失败回合看起来是 completed：限流、服务错误、上下文超限在 kimi 自己的重试后以 end_turn 结束，OAR 记 completed（上游 MoonshotAI/kimi-code#1865）；冒烟靠「正文非空」兜住',
  '图片收：initialize 广告 promptCapabilities.image，活体问过绿色 PNG 答 green；矩阵表的预开声明写 false，以会话级 capabilities 为准',
  'MCP 服务器 instructions 不交给模型（kimi 2.1.1 实测）：工具描述里写清用法，别指望 instructions 那段',
]

/** 一条失败：哪一项、为什么 */
function fail(item, detail) {
  return { item, detail }
}

/** 一条观察：真实存在但不构成失败 */
function note(text) {
  return text
}

// ---------- 各项判定 ----------

/**
 * 1. 安装探测。
 * @param {{kind: string, version?: string, installedVersion?: string, requiredVersion?: string}} obs
 */
function judgeInstallation(obs, out) {
  if (!obs || obs.kind === 'available') {
    out.notes.push(note(`运行时已安装${obs?.version ? `，版本 ${obs.version}` : ''}`))
    return
  }
  if (obs.kind === 'version_unsupported') {
    out.failures.push(
      fail('安装探测', `版本过低：已装 ${obs.installedVersion || '未知'}，适配器要求 ${obs.requiredVersion || '未知'}。先升级运行时`),
    )
    return
  }
  out.failures.push(fail('安装探测', `运行时不可用：${obs.kind || '无探测结果'}。先在本机安装并登录`))
}

/**
 * 2. 一句话回合（走后端产品路径：prompt 加事件翻译）。
 *
 * 终态判 done：桥接的 RunState 终态三值是 done / failed / aborted，翻译层把
 * OAR 的 completed 映射成 session.execution.succeeded，RunState 收到后是 done。
 * @param {{text: string, terminal: string, tokens: object|null}} obs 翻译后看到的东西
 * @param {boolean} reportsTokens 运行时原始会话的 usage().total 非 null（会上报 token 总量）
 */
function judgeTurn(obs, reportsTokens, out) {
  if (!obs) {
    out.failures.push(fail('一句话回合', '没有观测（可能上一项就失败了，后面没跑）'))
    return
  }
  if (!obs.text || !obs.text.trim()) {
    out.failures.push(fail('一句话回合', '没有收到正文。kimi 的失败回合看起来是 completed 且没有消息，这一条同时兜那种情况'))
  }
  if (obs.terminal !== 'done') {
    out.failures.push(fail('一句话回合', `终态是 ${obs.terminal || '未知'}，期望 done`))
  }
  if (reportsTokens && !obs.tokens) {
    out.failures.push(fail('一句话回合', '运行时上报 token 总量，但桥接没收到用量事件——翻译层丢了 usage'))
  } else if (reportsTokens && obs.tokens) {
    out.notes.push(note(`用量事件到达：in ${obs.tokens.input ?? '?'} / out ${obs.tokens.output ?? '?'}`))
  } else {
    out.notes.push(note('运行时不上报 token 总量（kimi 已知：只有上下文占用），用量不断'))
  }
}

/**
 * 3. 工具回合（原始会话，要看 exitCode 字段）。
 *
 * exitCode 的分支在这里，不放运行层的 try 里猜：拿得到就连它一起断，拿不到
 * 只断工具名、命令与结果状态。
 * @param {{name: string, command: string, status: string, exitCode: number|null}} obs
 */
function judgeTool(obs, out) {
  if (!obs) {
    out.failures.push(fail('工具回合', '没有观测'))
    return
  }
  if (!obs.name) {
    out.failures.push(fail('工具回合', '没有看到任何工具调用'))
  }
  if (obs.status !== 'ok') {
    out.failures.push(fail('工具回合', `工具结果状态是 ${obs.status || '未知'}，期望 ok`))
  }
  if (!obs.command || !obs.command.includes('node')) {
    out.failures.push(fail('工具回合', `工具参数里没有 node 命令：${obs.command || '空'}`))
  }
  if (obs.exitCode === null || obs.exitCode === undefined) {
    out.notes.push(note('运行时没报 exitCode（kimi 已知：结束帧的 content 是 terminal 引用，没有 rawOutput），只验了工具状态'))
  } else if (obs.exitCode !== 0) {
    out.failures.push(fail('工具回合', `exitCode 是 ${obs.exitCode}，期望 0`))
  } else {
    out.notes.push(note('exitCode 0'))
  }
}

/**
 * 4. abort。
 * @param {{accepted: boolean, terminal: string}} obs
 */
function judgeAbort(obs, out) {
  if (!obs) {
    out.failures.push(fail('中止', '没有观测'))
    return
  }
  if (!obs.accepted) {
    out.failures.push(fail('中止', 'abort 被拒绝（回合可能已经结束）'))
  }
  if (obs.terminal !== 'aborted') {
    out.failures.push(fail('中止', `abort 后终态是 ${obs.terminal || '未知'}，期望 aborted`))
  }
}

/**
 * 5. 忙时注入。
 *
 * 通过条件是 landed 为 steered 或 queued：没有 steer 成员的运行时落 queued
 * 是正确降级（kimi 的已知路径），不是失败。rejected 才是要防的——那会把排队
 * 消息变成失败卡片（PR #44 review 第 4 条）。
 * @param {{landed: string, reason?: string, declaredSteer: boolean}} obs
 */
function judgeInject(obs, out) {
  if (!obs) {
    out.failures.push(fail('忙时注入', '没有观测'))
    return
  }
  if (obs.landed === 'steered' || obs.landed === 'queued') {
    if (obs.landed === 'queued' && obs.declaredSteer) {
      out.notes.push(note('运行时声明支持 steer，这次落到了排队（deliver 的退路，正常）'))
    }
    if (obs.landed === 'steered' && !obs.declaredSteer) {
      out.notes.push(note('运行时没声明 steer 却引导成功了，以会话实测为准'))
    }
    return
  }
  out.failures.push(fail('忙时注入', `注入被拒绝：${obs.landed || '未知'}${obs.reason ? `（${obs.reason}）` : ''}。忙时注入必须落排队或引导，不能拒绝`))
}

/**
 * 6. 图片输入。
 *
 * 按会话级 capabilities.images 判期望，不按预开声明：kimi 的矩阵预开声明写
 * false，initialize 实测广告 image 且活体收图（kimi.md 有证据），两张表不一致
 * 时以会话级为准并记观察。静默收下（声明不收却被 accept）是失败。
 * @param {{declaredImages: boolean, sessionImages: boolean, outcome: 'accepted'|'rejected', code?: string, reason?: string}} obs
 */
function judgeImage(obs, out) {
  if (!obs) {
    out.failures.push(fail('图片输入', '没有观测'))
    return
  }
  if (obs.declaredImages !== obs.sessionImages) {
    out.notes.push(note(`图片能力声明不一致：预开声明 ${obs.declaredImages}，会话级 ${obs.sessionImages}，按会话级判`))
  }
  if (obs.sessionImages) {
    if (obs.outcome === 'accepted') return
    out.failures.push(fail('图片输入', `会话声明收图片却被拒：${obs.code || '未知'}${obs.reason ? `（${obs.reason}）` : ''}`))
    return
  }
  if (obs.outcome === 'rejected') {
    out.notes.push(note(`会话不收图片，整份拒绝符合预期：${obs.code || '未知'}`))
    return
  }
  out.failures.push(fail('图片输入', '会话声明不收图片，输入却被静默收下——图片丢了没人知道'))
}

// ---------- 总判定 ----------

/**
 * 判一次冒烟观测。
 *
 * @param {object} obs 一侧的观测，字段见各 judge* 函数
 * @returns {{ok: boolean, failures: Array<{item: string, detail: string}>, notes: string[]}}
 */
export function judgeSmokeRun(obs) {
  const out = { failures: [], notes: [] }
  const o = obs || {}
  judgeInstallation(o.installation, out)
  // 安装不可用时间项没有观测，各项自己报「没有观测」，总判定照常出失败
  judgeTurn(o.turn, o.reportsTokens === true, out)
  judgeTool(o.tool, out)
  judgeAbort(o.abort, out)
  judgeInject(o.inject, out)
  judgeImage(o.image, out)
  return { ok: out.failures.length === 0, failures: out.failures, notes: out.notes }
}

/** 人看的冒烟报告 */
export function formatSmokeReport(label, result, knownRefusals = KNOWN_REFUSALS) {
  const lines = [result.ok ? `✅ ${label}：六项全部通过` : `❌ ${label}：${result.failures.length} 项失败`]
  for (const f of result.failures) lines.push(`  [失败] ${f.item}：${f.detail}`)
  for (const n of result.notes) lines.push(`  [观察] ${n}`)
  lines.push('', '已知限制（跑出同类结果不当 bug）：')
  for (const k of knownRefusals) lines.push(`  · ${k}`)
  return lines.join('\n')
}
