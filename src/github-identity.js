/**
 * 每实例的 GitHub 身份注入。
 *
 * 与飞书身份注入完全同构：飞书那边是 src/pi.js 的 childEnv()（起子进程前）
 * 和 scripts/lib/feishu-identity.sh（起 serve 前），GitHub 这边是同一对注入
 * 点、同一套「读实例配置 → 导出环境变量」的做法。三个 agent 因此可以各自以
 * `lil-o-bot[bot]` / `lil-p-bot[bot]` 的身份推送和开 PR，互不串身份。
 *
 * 注进去的东西分四路，各管一件事：
 *
 *   1. GH_TOKEN                      给直接读环境变量的工具（gh CLI 等）。
 *      启动时取一个有效的；一小时后会过期，所以还有第 3、4 路兜底。
 *   2. GIT_AUTHOR_* / GIT_COMMITTER_* 提交署名，优先级高于仓库和全局配置。
 *   3. GIT_CONFIG_* 指向本仓库的凭证助手（github-app-credential.mjs），
 *      git 每次操作现场调它换有效 token——长驻进程里 token 过期对 agent 透明。
 *   4. PATH 前置本实例的 gh 包装脚本，gh 的每次调用同样现取 token。
 *
 * 没有配置 github 段（或 mode=off）时返回 null：现有部署零改动。
 */
import { writeFileSync, mkdirSync, chmodSync, statSync, readFileSync } from 'node:fs'
import { dirname, join, delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getInstallationToken } from './github-app-token.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** git 凭证助手：每次 git 操作现场调它换有效 token */
const GITHUB_CREDENTIAL_HELPER = join(REPO, 'src', 'github-app-credential.mjs')
/** token 模块：gh 包装脚本用它现取 token */
const GITHUB_TOKEN_CLI = join(REPO, 'src', 'github-app-token.mjs')

/** 家目录展开：配置里写 ~/.config/... 与写绝对路径等价 */
export function expandHome(p) {
  const s = String(p || '')
  if (!s.startsWith('~')) return s
  return s.replace('~', process.env.HOME || '')
}

/**
 * 从 PATH 里找真正的 gh，跳过本实例的 bin 目录。
 * 包装脚本也叫 gh，不跳过的话它会找到自己，无限递归。
 */
export function resolveRealGh(env = process.env, skipDir = '') {
  const dirs = String(env.PATH || '').split(delimiter)
  for (const dir of dirs) {
    if (!dir || resolve(dir) === resolve(skipDir)) continue
    const candidate = join(dir, 'gh')
    try {
      // 存在且可执行（mode 第 3 位）
      const st = statSync(candidate)
      if (st.isFile() && st.mode & 0o111) return candidate
    } catch {
      /* 这个目录里没有 gh */
    }
  }
  return ''
}

/**
 * 写本实例的 gh 包装脚本：<configDir>/bin/gh。
 * 每次调用现取一个有效的 installation token 再 exec 真正的 gh，所以长驻进程
 * （opencode serve）里也不会用到过期 token。路径全部焊死，脚本自包含。
 */
function writeGhShim(configDir, { nodeBin = process.execPath, ghBin } = {}) {
  const binDir = join(configDir, 'bin')
  const real = ghBin || resolveRealGh(process.env, binDir)
  if (!real) return '' // 机器上没有 gh：不写包装，PATH 也不改
  mkdirSync(binDir, { recursive: true })
  const shim = join(binDir, 'gh')
  writeFileSync(
    shim,
    [
      '#!/bin/bash',
      '# 本实例的 gh：每次调用现取有效的 installation token。',
      '# 启动时导出的 GH_TOKEN 一小时后会过期，长驻进程里必须用前现取。',
      `GH_TOKEN="$(${nodeBin} ${GITHUB_TOKEN_CLI} --config-dir ${configDir} --print)" exec ${real} "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(shim, 0o755)
  return binDir
}

/**
 * 给 agent 进程用的 GitHub 环境变量块。没配身份返回 null。
 *
 * @param {object} cfg 实例配置（loadConfig 的结果）
 * @param {string} configDir 实例配置目录
 * @param {object} [opts]
 * @param {boolean} [opts.withShim] 是否写 gh 包装脚本并前置 PATH（默认 true）
 * @param {Function} [opts.fetchImpl] 测试注入；不传用全局 fetch
 */
export async function githubEnv(cfg, configDir, { withShim = true, fetchImpl } = {}) {
  const g = cfg?.github
  if (!g?.mode || g.mode === 'off') return null

  const env = {}
  if (g.gitName) {
    env.GIT_AUTHOR_NAME = g.gitName
    env.GIT_COMMITTER_NAME = g.gitName
  }
  if (g.gitEmail) {
    env.GIT_AUTHOR_EMAIL = g.gitEmail
    env.GIT_COMMITTER_EMAIL = g.gitEmail
  }

  if (g.mode === 'app') {
    const pk = expandHome(g.privateKeyPath)
    if (!g.appId || !g.installationId || !pk) return null
    // 启动时取一个有效的：给直接读环境变量的工具用；之后靠凭证助手和包装脚本
    const { token } = await getInstallationToken({
      appId: g.appId,
      installationId: g.installationId,
      privateKeyPath: pk,
      cachePath: join(configDir, 'github-app-token.json'),
      fetchImpl,
    })
    env.GH_TOKEN = token
  } else if (g.mode === 'pat') {
    if (!g.token) return null
    env.GH_TOKEN = g.token
  } else {
    return null
  }

  // git 每次操作现场调凭证助手换有效 token，长驻进程里也不会拿到过期 token。
  // 助手列表按「系统 → 全局 → 本地 → 环境变量」累积，第一个同时给出用户名和
  // 密码的助手就赢。机器上只要有 gh auth login 过的全局配置（装过 gh 的都有），
  // 它排在环境变量前面，我们的助手永远不会被调用——实测 GIT_TRACE 里只有
  // osxkeychain 和 gh 助手在跑。而 gh 助手不校验 token 是否过期，GH_TOKEN 不在
  // 环境里时还会返回人的 keychain 账号。所以第一条先用空值把前面累积的助手列表
  // 清掉（空值重置是 git 凭证助手的既有语义），第二条装真助手
  env.GIT_CONFIG_COUNT = '2'
  env.GIT_CONFIG_KEY_0 = 'credential.helper'
  env.GIT_CONFIG_VALUE_0 = ''
  env.GIT_CONFIG_KEY_1 = 'credential.https://github.com.helper'
  env.GIT_CONFIG_VALUE_1 = `!${process.execPath} ${GITHUB_CREDENTIAL_HELPER}`
  // 凭证助手靠它知道读哪份实例配置
  env.OCB_CONFIG_DIR = configDir

  if (withShim) {
    const binDir = writeGhShim(configDir)
    if (binDir) env.PATH = `${binDir}${delimiter}${process.env.PATH || ''}`
  }
  return env
}

// ---------- CLI：给 serve 启动脚本用 ----------
// 用法：node src/github-identity.js --config-dir <实例配置目录>
// 输出 KEY=VALUE 行（bash 逐行 export），没配身份时什么都不输出。
if (process.argv[1] && process.argv[1].endsWith('github-identity.js')) {
  const arg = (name) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : ''
  }
  const configDir = arg('--config-dir') || process.env.OCB_CONFIG_DIR || ''
  githubEnvFromDir(configDir)
    .then((env) => {
      if (!env) return
      for (const [k, v] of Object.entries(env)) process.stdout.write(`${k}=${v}\n`)
    })
    .catch((err) => {
      process.stderr.write(`GitHub 身份注入失败: ${err.message}\n`)
    })
}

async function githubEnvFromDir(configDir) {
  if (!configDir) return null
  let cfg
  try {
    cfg = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
  } catch {
    return null
  }
  return githubEnv(cfg, configDir)
}
