#!/usr/bin/env node
/**
 * 起停脚本的离线测试：不碰真实 launchd 服务（不启动、不 bootout 任何 label），
 * 只做源码断言加一次可执行的失败路径验证。
 *
 *   node scripts/test-up-sh.mjs
 *
 * 背景（真实事故形态，2026-11-10）：
 *   1. up.sh 里曾有一段 C 风格块注释。bash 不认这种语法，注释开头那两个字符是
 *      glob，匹配不到文件就按字面量当命令执行——每次跑 up.sh 都往 stderr 打一串
 *      command not found，admin 的重启输出框全显示出来。当时的验证命令末尾接了
 *      grep，正好把这些行滤掉，所以没被发现。
 *   2. start_label 第一条路是 kickstart -k，对「程序路径错误」的 label 会无限期
 *      卡住（kickstart 等一个永远起不来的进程，不返回），把 up.sh 连同 admin 的
 *      HTTP 请求一起挂死。修法是给 launchctl 调用套超时。
 *   3. status.sh 用 pgrep 取桥接 pid，多实例同机时会捡到别实例的进程，把没起来
 *      的说成「运行中」。
 * 这三条都靠断言钉住：删掉超时、把 pid 改回 pgrep、或再引入块注释，测试立刻红。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const UP = join(REPO, 'scripts', 'up.sh')
const STATUS = join(REPO, 'scripts', 'status.sh')

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const up = readFileSync(UP, 'utf8')
const status = readFileSync(STATUS, 'utf8')

// ---------- 1. bash 不认块注释：up.sh / status.sh 里不能有 ----------
// `/**` 在 bash 里是 glob，匹配不到文件就按字面量当命令执行，stderr 全是
// command not found。跑一次 up.sh 就能看见，接 grep 的验证命令会把它滤掉
for (const [name, src] of [
  ['up.sh', up],
  ['status.sh', status],
]) {
  // 三个断言都要带 m flag：只看文件开头等于没看（变异测试当场抓住过）
  ok(!/^\s*\/\*\*/m.test(src), `${name} 没有 bash 不认识的块注释开头`)
  ok(!/^\s*\*\//m.test(src), `${name} 没有块注释结尾`)
  ok(!/^\s*\*[^/]/m.test(src), `${name} 没有块注释中间行`)
}

// ---------- 2. 起不来的服务必须发出声音 ----------
ok(/start_label\(\)\s*\{/.test(up), 'up.sh 定义了 start_label')
ok(up.includes('if ! start_label "$label"; then'), 'up.sh 的循环调用 start_label 并检查返回码')
ok(/FAILED=1/.test(up), '起不来时置 FAILED=1')
ok(/\[ "\$FAILED" = 0 \] \|\| exit 1/.test(up), '有 label 起不来时 up.sh 以非 0 退出')

// ---------- 3. launchctl 必须套超时：kickstart 会无限期卡住 ----------
ok(/run_with_timeout\(\)\s*\{/.test(up), 'up.sh 定义了超时助手 run_with_timeout')
ok(
  up.includes('run_with_timeout 10 launchctl kickstart -k'),
  'kickstart 套了超时（程序路径错误的 label 会挂住不放）',
)
ok(
  up.includes('run_with_timeout 10 launchctl bootstrap'),
  '第一次 bootstrap 也套了超时',
)
// 最后一次尝试不套超时也不吞错误：失败必须把 launchctl 的原话亮出来
const bootstrapLines = up.split('\n').filter((l) => l.includes('launchctl bootstrap "gui/$UID_NUM" "$plist"'))
ok(bootstrapLines.length === 2, 'start_label 里共两次 bootstrap 尝试', String(bootstrapLines.length))
ok(
  bootstrapLines[0].includes('run_with_timeout') && bootstrapLines[0].includes('2>/dev/null'),
  '第一次 bootstrap 套超时并吞错误（失败还要往下试，不能吵）',
  bootstrapLines[0].trim(),
)
ok(
  !bootstrapLines[1].includes('2>/dev/null') && !bootstrapLines[1].includes('run_with_timeout'),
  '最后一次 bootstrap 既不套超时也不吞错误（要的就是 launchctl 的原话）',
  bootstrapLines[1].trim(),
)

// ---------- 4. 桥接 pid 必须问 launchd，不能 pgrep ----------
// 多实例同机时 `pgrep -f "node src/index.js" | head -1` 捡到的是别实例的进程，
// 把没起来的这个说成「运行中」。事故中默认实例的桥接正在重启循环，状态却显示
// 另一个实例的 pid 正常
ok(!/BPID=[^\n]*pgrep/.test(status), 'status.sh 的桥接 pid 不来自 pgrep')
ok(status.includes('launchctl print "gui/$UID_NUM/$LABEL_APP"'), 'status.sh 从 launchctl print 取信息')
ok(status.includes('pid = [0-9]+'), 'status.sh 解析 launchctl 给的 pid')
ok(/last exit code/.test(status), '进程不在时连 last exit code 一起打出来（看得出是不是重启循环）')

// ---------- 5. 可执行验证：起不来的 label 必须自己返回非 0 ----------
// 用一个不存在的 plist 路径跑真实的 start_label：agent_loaded 失败 → bootstrap
// 失败 → 等 2 秒 → bootstrap 再失败 → 返回非 0。这条路不碰任何真实 label
{
  const script = `
set -u
UID_NUM="$(id -u)"
agent_installed() { [ -f "$HOME/Library/LaunchAgents/$1.plist" ]; }
agent_loaded() { launchctl print "gui/$UID_NUM/$1" >/dev/null 2>&1; }
$(sed -n '/^run_with_timeout()/,/^}/p' up.replace(/^/, ''))
$(sed -n '/^start_label()/,/^}/p' up.replace(/^/, ''))
start_label ai.qiguang.ocbridge.definitely-not-installed
`
  let rc = 0
  let out = ''
  try {
    out = execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    rc = err.status
    out = `${err.stdout || ''}${err.stderr || ''}`
  }
  ok(rc !== 0, '起不来的 label 让 start_label 返回非 0', `rc=${rc}`)
  ok(out.trim().length > 0, '失败时有输出（错误不静默）', out.slice(0, 120))
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
