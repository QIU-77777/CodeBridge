/**
 * 决定用哪个 opencode 可执行文件。
 *
 * 优先级：
 *   1. 环境变量 OPENCODE_BIN（显式覆盖，排障用）
 *   2. 桌面版 OpenCode.app 自带的 CLI
 *   3. PATH 里的 opencode
 *
 * 为什么优先桌面版：桌面版和它的 CLI 是同一个版本，写的是同一个数据库
 * （~/.local/share/opencode/opencode.db）。如果桥接用 npm 装的另一个版本，
 * 两个版本会各自往同一个库里写，schema 一漂移就会出现「新版本写入、旧版本
 * 读不出来」——2026-11 就因此整批会话发不出消息（compaction 记录缺 recent 字段）。
 *
 * 桌面版升级后目录名里的版本号会变（cli/2.2.5-arm64/），所以按版本号倒序探测，
 * 不能写死路径。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

export const DESKTOP_CLI_DIR = join(
  homedir(),
  'Library/Application Support/ai.opencode.desktop/cli',
)

/** "2.2.5-arm64" → [2,2,5] */
export function parseVersion(name) {
  const m = String(name).match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}

function compareDesc(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]
  return 0
}

function isExecutable(p) {
  try {
    return existsSync(p) && (statSync(p).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** 取二进制自己报的版本，拿不到就返回空串 */
export function binaryVersion(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 })
    const m = out.match(/(\d+\.\d+\.\d+[-\w.]*)/)
    return m ? m[1] : out.trim().split('\n')[0]
  } catch {
    return ''
  }
}

/**
 * @returns {{bin: string, source: 'env'|'desktop'|'path', version: string}|null}
 */
export function resolveOpencode(env = process.env, desktopDir = DESKTOP_CLI_DIR) {
  const fromEnv = env.OPENCODE_BIN
  if (fromEnv && isExecutable(fromEnv)) {
    return { bin: fromEnv, source: 'env', version: binaryVersion(fromEnv) }
  }

  if (existsSync(desktopDir)) {
    const cands = readdirSync(desktopDir)
      .map((dir) => ({ dir, bin: join(desktopDir, dir, 'opencode-cli') }))
      .filter((c) => isExecutable(c.bin))
      .sort((a, b) => compareDesc(a.dir, b.dir))
    if (cands.length) {
      return {
        bin: cands[0].bin,
        source: 'desktop',
        version: binaryVersion(cands[0].bin),
      }
    }
  }

  const paths = String(env.PATH || '').split(':').filter(Boolean)
  for (const p of paths) {
    const full = join(p, 'opencode')
    if (isExecutable(full)) {
      return { bin: full, source: 'path', version: binaryVersion(full) }
    }
  }

  return null
}

export const SOURCE_LABEL = {
  env: '环境变量 OPENCODE_BIN',
  desktop: '桌面版自带 CLI',
  path: 'PATH 里的 opencode',
}
