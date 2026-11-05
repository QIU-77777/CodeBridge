/**
 * 配置热重载。
 *
 * 痛点：改个名字（`feishu.names`）或者加个白名单，就得重启整个桥接。
 * 重启会打断正在跑的任务，代价远大于改一个字符串。但也不能什么都热更 ——
 * 换了 appId 还接着用旧连接，行为会很怪。
 *
 * 所以分成两类：
 *   · **可以直接换**：纯查表/纯展示用的值，换掉立刻生效
 *   · **必须重启**：影响连接和握手的值（凭证、域名、serve 地址和密码）
 *
 * 每次热更都会把「哪些已生效、哪些要重启」写进日志，不用猜。
 */
import { readFileSync } from 'node:fs'

/** 换掉就能生效的字段：查表、展示、节流参数 */
export const RELOADABLE = [
  ['feishu', 'names'],
  ['feishu', 'allowlist'],
  ['feishu', 'requireMention'],
  ['behavior', 'streamIntervalMs'],
  ['behavior', 'showReasoning'],
  ['behavior', 'showTools'],
  ['behavior', 'maxBodyChars'],
  ['behavior', 'idleTimeoutMs'],
  ['behavior', 'maxParallel'],
  ['opencode', 'defaultModel'],
  ['opencode', 'defaultDirectory'],
]

/** 改了必须重启：涉及连接、握手、凭证 */
export const RESTART_ONLY = [
  ['feishu', 'appId'],
  ['feishu', 'appSecret'],
  ['feishu', 'domain'],
  ['feishu', 'botOpenId'],
  ['opencode', 'url'],
  ['opencode', 'password'],
]

const label = ([a, b]) => `${a}.${b}`
const grab = (obj, [a, b]) => obj?.[a]?.[b]
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)

/**
 * 把 next 里可热更的字段搬进 cfg（原地改，保持引用不变 —— handler/transport
 * 都持有同一个 cfg 对象，换对象它们就看不到新值了）。
 *
 * @returns {{applied: string[], restart: string[]}} 已生效的字段、需要重启的字段
 */
export function applyConfig(cfg, next) {
  const applied = []
  for (const key of RELOADABLE) {
    const v = grab(next, key)
    if (v === undefined) continue
    if (same(v, grab(cfg, key))) continue
    cfg[key[0]][key[1]] = v
    applied.push(label(key))
  }

  const restart = []
  for (const key of RESTART_ONLY) {
    const v = grab(next, key)
    if (v === undefined) continue
    if (same(v, grab(cfg, key))) continue
    restart.push(label(key))
  }

  return { applied, restart }
}

/**
 * 盯着 config.json。用 watchFile 而不是 watch：编辑器多是「写临时文件再 rename」，
 * fs.watch 盯着 inode，rename 之后监听就失效了，之后再也不触发。
 */
export function watchConfig({ path, cfg, log, interval = 1500, onReload }) {
  let last = ''
  const tick = () => {
    let raw = ''
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return // 文件正在被替换，下次再说
    }
    if (raw === last) return
    last = raw

    let next
    try {
      next = JSON.parse(raw)
    } catch (err) {
      log.warn?.(`[config] 改了但解析失败，仍用旧配置：${err.message}`)
      return
    }

    const { applied, restart } = applyConfig(cfg, next)
    if (applied.length) log.info(`[config] 已热更新：${applied.join(', ')}`)
    if (restart.length) log.warn?.(`[config] 这些改动要重启才生效：${restart.join(', ')}`)
    if (applied.length && onReload) {
      try {
        onReload(applied)
      } catch (err) {
        log.warn?.(`[config] 热更新后的回调出错：${err.message}`)
      }
    }
  }

  // 初始化基线，避免启动时把整份配置当成「刚改过」刷一遍日志
  try {
    last = readFileSync(path, 'utf8')
  } catch {
    last = ''
  }

  const t = setInterval(tick, interval)
  t.unref?.()
  return () => clearInterval(t)
}
