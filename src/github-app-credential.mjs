/**
 * git 凭证助手：git 每次需要认证时调用它，它现取一个有效的 installation token。
 *
 * 为什么不让 git 直接用环境里的 GH_TOKEN：小O 的 agent 跑在常驻的 opencode
 * serve 里，启动时导出的 token 一小时后会过期，之后所有 git push 都会失败。
 * 凭证助手是 git 在每次操作时现场调用的，天然就是「用前现取」——token 过期
 * 对 agent 完全透明，长驻进程和一次性进程走同一条路。
 *
 * git 的调用约定（credential.<url>.helper = !<cmd>）：stdin 进
 * protocol/host 等键值对，命令执行 `get` 时输出 username/password。
 *
 * 实例配置从 OCB_CONFIG_DIR 读（launchd 与 serve 启动脚本都会导出它）。
 */
import { getInstallationToken } from './github-app-token.mjs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** 按实例配置取出 git 密码：app 模式现换 token，pat 模式直接读配置 */
async function resolvePassword(g, configDir) {
  if (g.mode === 'pat') {
    if (!g.token) {
      process.stderr.write('github.mode=pat 但没配 token\n')
      return ''
    }
    return g.token
  }
  const pk = String(g.privateKeyPath || '')
  if (!pk) {
    process.stderr.write('github.mode=app 但没配 privateKeyPath\n')
    return ''
  }
  try {
    const { token } = await getInstallationToken({
      appId: g.appId,
      installationId: g.installationId,
      privateKeyPath: pk.startsWith('~') ? pk.replace('~', homedir()) : pk,
      cachePath: join(configDir, 'github-app-token.json'),
    })
    return token
  } catch (err) {
    process.stderr.write(`github-credential 取 token 失败: ${err.message}\n`)
    return ''
  }
}

async function main() {
  const input = readStdin()
  const op = process.argv[2] || 'get'
  if (op !== 'get') return // store / erase：token 不落地，无需处理
  if (!/\bhost=github\.com\b/.test(input)) return // 不是 GitHub，交给其他助手

  const configDir = process.env.OCB_CONFIG_DIR || join(homedir(), '.config', 'opencode-feishu-bridge')
  let cfg
  try {
    cfg = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
  } catch (err) {
    process.stderr.write(`github-credential 读不到实例配置 ${configDir}: ${err.message}\n`)
    return
  }
  const g = cfg.github || {}
  if (!g.mode || g.mode === 'off') return // 没配 GitHub 身份：保持默认行为

  const password = await resolvePassword(g, configDir)
  if (!password) return
  // GitHub 的 token 认证：用户名固定 x-access-token，密码是 token
  process.stdout.write(`username=x-access-token\npassword=${password}\n\n`)
}

main().catch((err) => {
  process.stderr.write(`github-credential 失败: ${err.message}\n`)
  process.exit(1)
})
