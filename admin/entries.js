/**
 * 飞书应用条目的纯函数：白名单增删、名字对照增改删、生效名字解析。
 *
 * server.js 的 HTTP 接口与离线测试共用这一份逻辑，接口里只做取参、校验
 * 与落盘。拆成模块的原因：加白名单时顺手填名字，要让 allowlist 与
 * feishu.names 两处条目一起变，这段逻辑必须能被测试直接钉住，不能只
 * 活在 HTTP 处理函数里。
 */

/** 名字最长 50 个字符。它显示在消息来源标注里，超长会把标注撑变形 */
export const NAME_MAX = 50

/**
 * open_id 校验。飞书 open_id 是 ou_ 开头，user_id 由租户自定，格式不统一，
 * 所以这里只挡空值与含空白的输入，不假装认识所有 id 格式。
 */
export function checkOpenId(openId) {
  const id = String(openId ?? '').trim()
  if (!id) return 'open_id 不能为空'
  if (/\s/.test(id)) return 'open_id 不能包含空白字符'
  return null
}

/** 名字校验：非空，且不超过 NAME_MAX */
export function checkName(name) {
  const n = String(name ?? '').trim()
  if (!n) return '名字不能为空'
  if (n.length > NAME_MAX) return `名字最长 ${NAME_MAX} 个字符`
  return null
}

/** 白名单加一条。已在名单里时原样返回（幂等），返回新数组，不改入参 */
export function applyAllowlistAdd(list, openId) {
  const arr = Array.isArray(list) ? [...list] : []
  const id = String(openId ?? '').trim()
  if (!arr.includes(id)) arr.push(id)
  return arr
}

/** 白名单移除一条。不在名单里时原样返回 */
export function applyAllowlistRemove(list, openId) {
  const arr = Array.isArray(list) ? [...list] : []
  const idx = arr.indexOf(String(openId ?? '').trim())
  if (idx !== -1) arr.splice(idx, 1)
  return arr
}

/**
 * 写一条名字。空名字视为清除声明：删掉这个 open_id 的覆盖项，之后生效名字
 * 为空。入参不是对象时按空表处理。
 */
export function applyNameSet(names, openId, name) {
  const out = names && typeof names === 'object' && !Array.isArray(names) ? { ...names } : {}
  const id = String(openId ?? '').trim()
  const n = String(name ?? '').trim()
  if (n) out[id] = n
  else delete out[id]
  return out
}

/** 删一条名字声明。没有这个键时原样返回 */
export function applyNameRemove(names, openId) {
  const out = names && typeof names === 'object' && !Array.isArray(names) ? { ...names } : {}
  delete out[String(openId ?? '').trim()]
  return out
}

/**
 * 生效名字：配置里人工声明的那个，没有就是空。
 *
 * 顺序必须和 src/handler.js 的 nameOf() 一致：那边决定飞书卡片上显示什么，
 * 管理后台显示的必须是同一个值。两边不同，用户就会在后台看到一个
 * 卡片上并不显示的名字。
 */
export function effectiveName(configNames, openId) {
  return configNames?.[String(openId ?? '')] || ''
}

/**
 * 「谁能唤醒它」主表的行视图模型。
 *
 * 后台原本是三张表（allowlist / names / contacts），同一个实体在三处各出现一次，
 * 用户分不清哪张表是权威源。这里把三个配置数据源取并集，派生出「一个体一行」
 * 的视图：
 *
 *   allowlist —— 手写白名单（config）
 *   listen   —— 通讯录面板的开关（config）
 *   names    —— 手写名字声明（config）
 *
 * 三者都是人手动维护的。以前还有第四源 contacts（运行时自动攒的认识层），
 * 已下线：自动攒出来的 open_id 用不上（放行名单是人手写的），攒得越多越像
 * 一份查不到重点的档案。
 *
 * 放行语义与 src/handler.js 的 isAllowed() 一致：allowlist ∪ listen 取并集。
 * allowedVia 标明这个放行来自哪张名单，界面据此决定移除时该动哪个端点。
 */
export function buildPeople({ allowlist, listen, names } = {}) {
  const allow = new Set(Array.isArray(allowlist) ? allowlist : [])
  const lis = new Set(Array.isArray(listen) ? listen : [])
  const cfgNames = names && typeof names === 'object' && !Array.isArray(names) ? names : {}

  const ids = new Set([...allow, ...lis, ...Object.keys(cfgNames)])
  const rows = []
  for (const id of ids) {
    const allowedVia = allow.has(id) ? 'manual' : lis.has(id) ? 'listen' : null
    rows.push({
      id,
      name: cfgNames[id] || '',
      nameSource: cfgNames[id] ? 'cfg' : '',
      allowed: Boolean(allowedVia),
      allowedVia,
    })
  }
  // 放行的置顶（手写先于开关），纯 names 声明垫底
  const rank = (r) => (r.allowedVia === 'manual' ? 0 : r.allowedVia === 'listen' ? 1 : 2)
  rows.sort((a, b) => rank(a) - rank(b))
  return rows
}
