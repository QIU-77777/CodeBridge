#!/usr/bin/env node
/**
 * 把仓库里的 bridge-collaboration skill 装到本机技能目录。
 *
 *   node scripts/install-skill.mjs                 # 装到 ~/.agents/skills/
 *   node scripts/install-skill.mjs --target opencode
 *   node scripts/install-skill.mjs --dry-run       # 只看会写什么
 *   node scripts/install-skill.mjs --remove        # 卸掉
 *
 * 为什么要有这个脚本：技能目录是各家 harness 自己的机制，没有一份所有工具都
 * 认的位置。~/.agents/skills/ 是 Agent Skills 规范里的开放位置，pi、kimi、codex
 * 都认它；opencode 用自己的 ~/.config/opencode/skills。所以同一份内容要装到
 * 多个位置，脚本负责按目标复制并保持幂等。
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
  // Agent Skills 规范里的开放位置：pi、kimi、codex 都扫它
  agents: join(homedir(), '.agents', 'skills'),
  // opencode 自己的全局技能目录
  opencode: join(homedir(), '.config', 'opencode', 'skills'),
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
      console.log('用法：node scripts/install-skill.mjs [--target agents|opencode|claude] [--dry-run] [--remove]')
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

/** 技能正文 + 原则副本，算一个指纹，用来判断是否需要重写 */
function buildPayload() {
  const body = readFileSync(join(SOURCE_DIR, 'SKILL.md'), 'utf8')
  const principles = readFileSync(PRINCIPLES, 'utf8')
  // 带版本指纹：读的人能看出手上是哪一版；也用于幂等判断
  const digest = createHash('sha256').update(body).update('\n---\n').update(principles).digest('hex').slice(0, 12)
  return { body, principles, digest }
}

/**
 * 装一份到目标目录。幂等：目录里已经是同一版就什么都不写。
 * @returns {'created'|'updated'|'unchanged'}
 */
function installTo(root, payload, { dryRun = false } = {}) {
  const dir = join(root, SKILL_NAME)
  const refDir = join(dir, 'references')
  const marker = join(dir, '.version')
  const want = payload.digest

  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === want) return 'unchanged'

  const state = existsSync(dir) ? 'updated' : 'created'
  if (dryRun) return state

  mkdirSync(refDir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), payload.body, 'utf8')
  writeFileSync(join(refDir, 'principles.md'), payload.principles, 'utf8')
  writeFileSync(marker, want + '\n', 'utf8')
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
