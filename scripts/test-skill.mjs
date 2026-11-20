#!/usr/bin/env node
/**
 * 协作分层（提示词硬约束 + skill 长篇经验）的离线测试。不装 harness、不连飞书。
 *   node scripts/test-skill.mjs
 *
 * 三层：
 *   1. skill 文件本身：frontmatter 有 name 与 description、名字与目录一致、
 *      正文覆盖六件必做的事
 *   2. 提示词与 skill 的分工：提示词里必须留住的硬约束还在；提示词里的长度
 *      降下来了；提示词指向 skill 名
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const SKILL_NAME = 'bridge-collaboration'

const REPO = fileURLToPath(new URL('..', import.meta.url))

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name} ${extra}`)
  }
}

// ---------- 1. skill 文件 ----------

const skillPath = join(REPO, 'skills', SKILL_NAME, 'SKILL.md')
const skill = readFileSync(skillPath, 'utf8')

{
  const fm = skill.match(/^---\n([\s\S]*?)\n---\n/)
  ok(Boolean(fm), 'SKILL.md 以 frontmatter 开头')
  const head = fm ? fm[1] : ''
  ok(/^name:\s*bridge-collaboration\s*$/m.test(head), 'frontmatter 的 name 与目录名一致', head.slice(0, 60))
  const desc = (head.match(/^description:\s*(.+)$/m) || [, ''])[1].trim()
  ok(desc.length > 40, 'description 写清什么时候该用（够长才有用）', `${desc.length} 字`)

  // 六件必做的事，少一件这份手册就不完整
  const musts = [
    ['身份：怎么确认自己是哪个应用', /FEISHU_APP_ID/],
    ['发言：reply 到话题 vs send 到主聊天流', /msg reply[\s\S]*msg send/],
    ['@：at 标签与 open_id', /<at user_id=/],
    ['忙时：引导与排队的语义', /排队/],
    ['轮询：thread-messages 与四个坑', /thread-messages[\s\S]*230001/],
    ['更早历史：230027 如实说明', /230027/],
  ]
  for (const [label, re] of musts) ok(re.test(skill), `手册覆盖：${label}`)
}

// ---------- 2. 提示词与 skill 的分工 ----------

{
  // prompts.json 坏了就该在这里喊出来，别让后面的断言拿空字符串继续跑
  let prompts = null
  try {
    prompts = JSON.parse(readFileSync(join(REPO, 'prompts.json'), 'utf8'))
  } catch (err) {
    console.log(`❌ prompts.json 解析失败：${err.message}`)
    process.exit(1)
  }
  const rules = prompts.once.rules || ''

  // 硬约束：不知道就会发错消息，必须无条件送达，不能只放在 skill 里
  const hard = [
    ['回复用 msg reply', /msg reply/],
    ['另起话题用 msg send', /msg send/],
    ['@ 用 at 标签加 open_id', /<at user_id="[^"]*"/],
    ['230027 时请人贴原文或开权限', /230027[\s\S]*贴原文/],
    ['指向 skill 名', /bridge-collaboration/],
    ['CLI 不在 PATH 时怎么找', /command -v feishu-cli/],
    ['发出消息后不退出，轮询前先读 skill 第四节', /发出消息后不要退出[\s\S]*bridge-collaboration 第四节[\s\S]*轮询/],
    ['重放去重：回复前先查已有回复', /重放[\s\S]*已有你的回复[\s\S]*跳过/],
    ['只用注入的应用身份，不换别的凭证', /不要换用别的应用凭证/],
  ]
  for (const [label, re] of hard) ok(re.test(rules), `提示词留住硬约束：${label}`)

  // 长度：细则搬走之后应该明显变短。1200 字是给将来加内容留的余量
  ok(rules.length < 1200, '提示词已收窄（细则搬进 skill）', `${rules.length} 字`)
  // 反过来：不该再出现只有 skill 才需要的东西
  ok(!/--start-time/.test(rules), '轮询的坑搬进 skill，不占提示词', '提示词里仍有 --start-time')
  ok(!/--page-size|ByCreateTimeDesc/.test(rules), '轮询命令细节搬进 skill', '提示词里仍有轮询命令')

  // 提示词里出现的每个 feishu-cli 子命令，skill 里都要有完整用法可查
  const cmds = new Set([...rules.matchAll(/feishu-cli (msg \w+)/g)].map((m) => m[1]))
  for (const c of cmds) ok(skill.includes(`feishu-cli ${c}`), `提示词用到的 feishu-cli ${c} 在 skill 里有用法`)

  // 提示词指向的 skill 章节必须真实存在
  ok(/^## 四、发出消息后：轮询新消息$/m.test(skill), 'skill 第四节标题与提示词的指向一致')
  ok(/对方正忙时消息会引导还是排队[\s\S]*需要等待回复时怎么轮询/.test(skill.split('---')[1] || ''), 'description 含「等待回复」与「正忙」触发词')
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
