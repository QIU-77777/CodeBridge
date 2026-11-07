/**
 * GitHub App 的 installation token：签 JWT → 换 token → 缓存到到期前刷新。
 *
 * 为什么需要这个模块：三个 agent 要各自以 `xxx[bot]` 的身份推送和开 PR，而
 * GitHub App 不能像人一样存一个长期 token——每次操作前要用 App 私钥签一个
 * JWT（10 分钟有效），拿它换 installation token（1 小时有效）。这层换算对
 * agent 必须透明：token 过期不能让人手动换，所以这里做磁盘缓存 + 到期前
 * 5 分钟自动换 + 401 强制换一次重试。
 *
 * 只用 Node 自带 crypto 和 fetch，不加依赖。凭证三件套来自实例配置：
 *   github.appId / github.installationId / github.privateKeyPath
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { dirname, join } from 'node:path'

/** token 1 小时过期；剩余时间少于此值就换新的，避开时钟偏差导致的临界失败 */
export const REFRESH_MARGIN_MS = 5 * 60_000
/** JWT 有效期：GitHub 规定最长 10 分钟 */
const JWT_TTL_SEC = 600

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** App ID + 私钥 → JWT（RS256）。iat 回拨 60 秒，避开本机时钟偏快被判未生效 */
export function signAppJwt(appId, privateKeyPem, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + JWT_TTL_SEC, iss: String(appId) }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`
}

/** 进程内 single-flight：同一 cachePath 的并发调用只换一次 token */
const inFlight = new Map()

/**
 * 取一个当前有效的 installation token。
 *
 * @param {object} opts
 * @param {string|number} opts.appId
 * @param {string|number} opts.installationId
 * @param {string} opts.privateKeyPath .pem 路径
 * @param {string} [opts.cachePath] 缓存文件路径，默认放在私钥同目录
 * @param {Function} [opts.fetchImpl] 测试注入
 * @returns {Promise<{token:string, expiresAt:number, fromCache:boolean}>}
 */
export async function getInstallationToken({
  appId,
  installationId,
  privateKeyPath,
  cachePath,
  fetchImpl = fetch,
}) {
  if (!appId || !installationId || !privateKeyPath) {
    throw new Error('GitHub App 配置不完整：需要 appId / installationId / privateKeyPath')
  }
  const cache = cachePath || join(dirname(privateKeyPath), 'github-app-token.json')
  const key = `${appId}:${installationId}:${cache}`

  const cached = readCache(cache)
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return { token: cached.token, expiresAt: cached.expiresAt, fromCache: true }
  }
  if (inFlight.has(key)) return inFlight.get(key)

  const task = (async () => {
    const pem = readFileSync(privateKeyPath, 'utf8')
    let token = await requestToken({ appId, installationId, jwt: signAppJwt(appId, pem), fetchImpl })
    // 401：缓存里可能躺着一个已被 GitHub 作废的 token，或权限刚被改过。换一个再试
    if (token.error && /401|403/.test(String(token.error))) {
      removeCache(cache)
      token = await requestToken({ appId, installationId, jwt: signAppJwt(appId, pem), fetchImpl })
    }
    if (token.error) throw new Error(`GitHub App 换 token 失败: ${token.error}`)
    writeCache(cache, token.token, token.expiresAt)
    return { token: token.token, expiresAt: token.expiresAt, fromCache: false }
  })()
  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

async function requestToken({ installationId, jwt, fetchImpl }) {
  const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) return { error: `HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}` }
  return { token: body.token, expiresAt: Date.parse(body.expires_at) }
}

function readCache(path) {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'))
    if (d?.token && d?.expiresAt) return d
  } catch {
    /* 缓存不存在或损坏：照常换新的 */
  }
  return null
}

function writeCache(path, token, expiresAt) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ token, expiresAt }, null, 2), { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    /* 缓存写不进去不影响使用：每次现换即可 */
  }
}

function removeCache(path) {
  try {
    if (existsSync(path)) rmSync(path)
  } catch {
    /* 删不掉也不影响：readCache 会把残留内容判废 */
  }
}

// ---------- CLI：给 gh 包装脚本和人工排障用 ----------
// 用法：node src/github-app-token.mjs --config-dir <实例配置目录> [--print]
if (process.argv[1] && process.argv[1].endsWith('github-app-token.mjs')) {
  const arg = (name) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : ''
  }
  const configDir = arg('--config-dir') || process.env.OCB_CONFIG_DIR || ''
  const run = async () => {
    if (!configDir) throw new Error('缺少 --config-dir 或 OCB_CONFIG_DIR')
    let cfg
    try {
      cfg = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
    } catch (err) {
      throw new Error(`实例配置解析失败 ${join(configDir, 'config.json')}: ${err.message}`)
    }
    const g = cfg.github || {}
    if (g.mode !== 'app') throw new Error(`github.mode=${g.mode || '未配置'}，不是 app`)
    const pk = g.privateKeyPath || ''
    const pemPath = pk.startsWith('~') ? pk.replace('~', process.env.HOME) : pk
    const { token, expiresAt } = await getInstallationToken({
      appId: g.appId,
      installationId: g.installationId,
      privateKeyPath: pemPath,
    })
    if (process.argv.includes('--print')) process.stdout.write(token + '\n')
    else process.stdout.write(`token 有效至 ${new Date(expiresAt).toISOString()}: ${token.slice(0, 7)}…\n`)
  }
  run().catch((err) => {
    console.error(`取 token 失败: ${err.message}`)
    process.exit(1)
  })
}
