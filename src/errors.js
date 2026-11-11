/**
 * 错误分类表：把 opencode / pi / 网络层抛出的原始错误文本，翻译成
 * 「这是什么问题 + 接下来干什么」。
 *
 * 面向的是在手机上看卡片的人：他只看到一段堆栈样的英文，不知道是自己的
 * 问题还是环境的问题。原则：只覆盖已经真实踩到过（或结构上必然会出现）的
 * 几类；认不出来的宁可不给提示，也不臆测——乱指路的提示比没有提示更糟
 * （用户会照着错误的方向排查）。
 *
 * 为什么是一个纯函数模块而不是留在 cards.js：
 *   1. 分类逻辑要在唯一一处维护。以前「已知错误的翻译」在 cards.js、
 *      「上下文过长的续命提示」在 handler.js，两边各写一份正则，改一处
 *      漏一处。收敛之后 handler 不再拼提示文案，卡片渲染层统一调用。
 *   2. 纯函数、零依赖，测试直接喂错误文本（scripts/test-errors.mjs），
 *      不需要起后端也不需要发卡片。
 *
 * 顺序即优先级：上面的先匹配。越具体的越靠前（decode / region / busy 这类
 * 带专有错误名的放前面，网络这种宽泛的放后面），避免宽泛规则把具体错误
 * 抢走。新增类别时先想清楚它跟现有条目的优先级关系。
 */

/**
 * @typedef {{ kind: string, label: string, hint: string }} ErrorClass
 */

/** 按优先级排列的分类规则。hint 里的命令（/new、/model、/stop）是卡片测试断言的锚点 */
const RULES = [
  {
    kind: 'decode',
    label: '会话历史损坏',
    test: /Failed to decode message .+ in session/i,
    hint:
      '这个会话的历史里有本机 opencode 旧版本写入、当前版本读不出来的压缩记录（缺 `recent` 字段）。' +
      '请求在读历史这一步就失败了，还没走到模型。\n' +
      '修复：给本地 `opencode.db` 的 `session_message` 表补字段；或先 `/new` 开个新会话继续干活。',
  },
  {
    kind: 'region',
    label: '地区限制',
    test: /not available in your country|not available in your region|RegionError/i,
    hint: '这个模型在当前地区不可用。用 `/model` 换一个。',
  },
  {
    kind: 'busy',
    label: '会话忙',
    test: /Session\.BusyError|session is busy/i,
    hint: '这个会话还有任务在跑。等它结束，或 `/stop` 后再发。',
  },
  {
    kind: 'session-lost',
    label: '会话已失效',
    test: /Session\.NotFoundError|session not found|no such session/i,
    hint: '会话已经不存在了（可能被删掉，或 pi 会话文件被移走）。用 `/new` 建一个。',
  },
  {
    kind: 'context',
    label: '输入被拒',
    // provider.invalid-request 是 opencode 事件里真实出现过的 error.type；
    // 其余是各家模型提供商「上下文过长 / 输入不合法」的常见说法
    test: /provider\.invalid-request|input you provided is invalid|invalid input|prompt is too long|too many tokens|context (length|window|size)|maximum context|payload too large|exceeds? (the )?(maximum|context|token|input)/i,
    hint: '模型提供商拒绝了这次输入，多数是上下文过长。发 `/new` 开新会话续上。',
  },
  {
    kind: 'auth',
    label: '认证失败',
    test: /\b401\b|\b403\b|unauthorized|invalid (api )?key|incorrect password|authentication (failed|error)/i,
    hint:
      '认证没过（401/403）。opencode 后端最常见的是 serve 密码与配置里的 `opencode.password` 不一致：' +
      '用 `./scripts/up.sh` 重启会自动带配置里的密码。',
  },
  {
    kind: 'rate-limit',
    label: '触发限流',
    test: /\b429\b|rate.?limit|too many requests|quota (exceeded|exhausted)|\bTPM\b|\bQPS\b|throttl/i,
    hint: '触发限流（429 / TPM / QPS）。稍等一会儿再发；频繁出现就少开几条并行话题（behavior.maxParallel）。',
  },
  {
    kind: 'network',
    label: '网络或服务不可达',
    test: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNABORTED|EAI_AGAIN|fetch failed|socket hang up|network error|connection (refused|reset|closed|timed? out)|\b50[234]\b|service unavailable/i,
    hint: '网络或服务不可达。先 `npm run status` 看 serve 是否在跑；不在就 `./scripts/up.sh`；在跑就检查本机网络。',
  },
  {
    kind: 'model',
    label: '模型不可用',
    test: /model (was )?not (found|exist)|no such model|model_not_found|unknown model|unsupported model/i,
    hint: '模型不可用（不存在或已下线）。用 `/model` 换一个，或检查 defaultModel 配置。',
  },
]

/**
 * 分类一条错误文本。
 *
 * @param {string|undefined|null} raw 错误文本（通常是 state.error.message）
 * @returns {ErrorClass|null} 认不出来返回 null——调用方据此跳过提示，
 *   不要对 null 再加「兜底提示」
 */
export function classifyError(raw) {
  if (!raw || typeof raw !== 'string') return null
  for (const rule of RULES) {
    if (rule.test.test(raw)) return { kind: rule.kind, label: rule.label, hint: rule.hint }
  }
  return null
}
