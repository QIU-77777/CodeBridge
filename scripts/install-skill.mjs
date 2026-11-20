#!/usr/bin/env node
/**
 * 把仓库里的 bridge-collaboration skill 装到本机技能目录。
 *
 *   node scripts/install-skill.mjs                 # 装到 ~/.agents/skills/
 *   node scripts/install-skill.mjs --target claude
 *   node scripts/install-skill.mjs --dry-run       # 只看会写什么
 *   node scripts/install-skill.mjs --remove        # 卸掉
 *
 * 为什么要有这个脚本：技能目录是各家 harness 自己的机制，没有一份所有工具都
 * 认的位置。~/.agents/skills/ 是 Agent Skills 规范里的开放位置，opencode 也会扫
 * 它；Claude Code 只扫 ~/.claude/skills。所以同一份内容要装到多个位置，脚本负责
 * 按目标复制并保持幂等。
 *
 * 事实来源只有两处，都在仓库里：
 *   skills/bridge-collaboration/SKILL.md        协作手册正文
 *   docs/collaboration-principles.md            为人处事原则（复制成 references/principles.md）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_NAME = 'bridge-collaboration'
const SOURCE_DIR = join(REPO, 'skills', SKILL_NAME)
const PRINCIPLES = join(REPO, 'docs', 'collaboration-principles.md')

/** 各 harness 的技能根目录。键是 --target 的取值 */
const TARGETS = {
  // Agent Skills 规范里的开放位置：opencode 等 harness 都扫它
  agents: join(homedir(), '.agents', 'skills'),
  // claude code 的全局技能目录
  claude: join(homedir(), '.claude', 'skills'),
}

function parseArgs(argv) {
  const out = { targets: [], dryRun: false, remove: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') {
      const v = argv[++i]
      if (!TARGETS[v]) {
        console.error(`未知目标: ${v}（可选：${Object.keys(TARGETS).join(' / ')}）`)
        process.exit(2)
      }
      if (!out.targets.includes(v)) out.targets.push(v)
    } else if (a === '--dry-run') out.dryRun = true
    else if (a === '--remove') out.remove = true
    else if (a === '--quiet') out.quiet = true
    else if (a === '--help' || a === '-h') {
      console.log('用法：node scripts/install-skill.mjs [--target agents|claude] [--dry-run] [--remove]')
      process.exit(0)
    } else {
      console.error(`未知参数: ${a}`)
      process.exit(2)
    }
  }
  // 没给 --target 时默认装到 agents（开放位置）；给了就只装给的那些
  if (!argv.includes('--target')) out.targets = ['agents']
  return out
}

const REF_REL = join('references', 'principles.md')

/** 一组文件（相对路径 + 内容）的指纹，路径也计入 */
function fingerprint(files) {
  const h = createHash('sha256')
  for (const [rel, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    h.update(rel).update('\0').update(content).update('\0')
  }
  return h.digest('hex').slice(0, 12)
}

/** 要安装的文件清单与指纹 */
function buildPayload() {
  const body = readFileSync(join(SOURCE_DIR, 'SKILL.md'), 'utf8')
  const principles = readFileSync(PRINCIPLES, 'utf8')
  const files = { 'SKILL.md': body, [REF_REL]: principles }
  return { body, principles, files, digest: fingerprint(files) }
}

/** 读目标目录里实际存在的文件算指纹，缺文件或读不到都算不一致 */
function installedDigest(dir, payload) {
  try {
    const files = {}
    for (const rel of Object.keys(payload.files)) files[rel] = readFileSync(join(dir, rel), 'utf8')
    return fingerprint(files)
  } catch {
    return null
  }
}

/**
 * 装一份到目标目录。幂等：磁盘上的文件内容与要装的一致就什么都不写。
 * @returns {'created'|'updated'|'unchanged'}
 */
function installTo(root, payload, { dryRun = false } = {}) {
  const dir = join(root, SKILL_NAME)
  if (installedDigest(dir, payload) === payload.digest) return 'unchanged'

  const state = existsSync(dir) ? 'updated' : 'created'
  if (dryRun) return state

  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), payload.body, 'utf8')
  writeFileSync(join(dir, REF_REL), payload.principles, 'utf8')
  writeFileSync(join(dir, '.version'), payload.digest + '\n', 'utf8')
  return state
}

function removeFrom(root, { dryRun = false } = {}) {
  const dir = join(root, SKILL_NAME)
  if (!existsSync(dir)) return false
  if (!dryRun) rmSync(dir, { recursive: true, force: true })
  return true
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(join(SOURCE_DIR, 'SKILL.md')) || !existsSync(PRINCIPLES)) {
    console.error('仓库里缺 skills/bridge-collaboration/SKILL.md 或 docs/collaboration-principles.md')
    process.exit(1)
  }
  const payload = buildPayload()
  const log = args.quiet ? () => {} : (m) => console.log(m)

  for (const name of args.targets) {
    const root = TARGETS[name]
    if (args.remove) {
      const done = removeFrom(root, args)
      log(done ? `已卸载 ${name}（${join(root, SKILL_NAME)}）` : `${name} 没有安装，跳过`)
      continue
    }
    const state = installTo(root, payload, args)
    const label = { created: '已安装', updated: '已更新', unchanged: '已是最新，跳过写入' }[state]
    log(`${label} ${name} → ${join(root, SKILL_NAME)}（版本 ${payload.digest}）`)
  }

  if (!args.quiet) {
    console.log('')
    console.log('提示：新装的 skill 要在新会话里才会被读到（各 harness 只在启动或新会话时扫描技能目录）。')
  }
}

export { buildPayload, installTo, removeFrom, TARGETS, SKILL_NAME }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
