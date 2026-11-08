#!/usr/bin/env node
/**
 * serve 密码写回的测试。
 *
 * 背景：scripts/agent/serve.sh 启动时把配置里的 opencode.password 导出成
 * OPENCODE_SERVER_PASSWORD。serve 是长跑进程，密码就此定格在它的环境里；
 * 配置是可改的。两边一不一致，桥接每个请求都 401——而现象是「毫无反应」。
 *
 * 更糟的是「密码为空」不等于「无需认证」：实测 opencode 在收到空的
 * OPENCODE_SERVER_PASSWORD 时会自己生成一个随机密码并只打印到 stdout
 * （"server password xxx"）。那个值没有任何地方记录，桥接永远认证不了。
 * 所以 serve.sh 在配置为空时生成一个写回配置，让配置重新成为权威源。
 *
 * 这里钉三件事：
 *   1. 空密码 → 生成 48 位十六进制并写回，配置其余字段不动
 *   2. 已有密码 → 一个字都不改，也不产生 .bak
 *   3. 写回的密码与 serve 实际使用的一致（用生成的规则反推不出值，只能
 *      断言「配置里的值被导出进了环境」——这条由真跑一次 serve.sh 覆盖）
 *
 * 不真起 serve 进程（那会占端口、依赖 opencode 二进制）：把 serve.sh 里
 * 密码那一段抽出来在这里跑，端口探测与 exec 都跳过。
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

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

const ROOT = new URL('..', import.meta.url).pathname
const SERVE_SH = join(ROOT, 'scripts', 'agent', 'serve.sh')
const HEX48 = /^[0-9a-f]{48}$/

/** 从 serve.sh 里截出「读密码 → 为空则生成并写回 → 导出」那一段 */
function extractPwBlock() {
  const src = readFileSync(SERVE_SH, 'utf8')
  const start = src.indexOf('PW=$(')
  // 终点用「飞书身份」那段注释：密码逻辑排在端口探测之后、身份注入之前，
  // 用 PORT= 当锚点会把整段密码逻辑切掉
  const end = src.indexOf('# 本实例的飞书身份')
  if (start === -1 || end === -1) throw new Error('没在 serve.sh 里找到密码段')
  const pwBlock = src.slice(start, end)
  // export 那行在文件更后面（身份注入之后），单独取出来拼回，保证测的是
  // 「配置里的值真的被导出给了 serve」
  const exportLine = /^export OPENCODE_SERVER_PASSWORD=.*$/m.exec(src)?.[0]
  if (!exportLine) throw new Error('没在 serve.sh 里找到 export OPENCODE_SERVER_PASSWORD')
  return `${pwBlock}\n${exportLine}\n`
}

/**
 * 在临时配置目录里跑密码段。stubNode 为真时把 node 换成一个包装脚本：
 * 用 --import 预加载补丁，把 crypto.randomBytes 钉成固定输出——这样 serve.sh
 * 里的生成调用会得到可预测的值，从而断言「密码确实来自 randomBytes」，
 * 而读配置、写文件全都走真 node，不必在测试里重写 shell 逻辑
 */
function runPwBlock(configPath, { stubNode = false } = {}) {
  const block = extractPwBlock()
  let nodeBin = process.execPath
  let cleanup = () => {}
  if (stubNode) {
    const dir = mkdtempSync(join(tmpdir(), 'ocb-servepw-stub-'))
    writeFileSync(
      join(dir, 'patch.mjs'),
      'import crypto from "node:crypto"\ncrypto.randomBytes = (n) => Buffer.alloc(n, 7)\n',
    )
    const wrapper = join(dir, 'node')
    writeFileSync(wrapper, `#!/bin/bash\nexec ${process.execPath} --import "${join(dir, 'patch.mjs')}" "$@"\n`)
    chmodSync(wrapper, 0o755)
    nodeBin = wrapper
    cleanup = () => rmSync(dir, { recursive: true, force: true })
  }
  const script = [
    'set -euo pipefail',
    `NODE="${nodeBin}"`,
    `CONFIG="${configPath}"`,
    // 端口探测那两行不属于密码逻辑，但它引用的 $URL 得有个值，否则 set -u
    // 直接报错。给个假 URL，端口推算结果本次用不到
    'URL="http://127.0.0.1:19876"',
    block,
    'echo "EXPORTED=${OPENCODE_SERVER_PASSWORD-}"',
  ].join('\n')
  try {
    return execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' })
  } finally {
    cleanup()
  }
}

const mkConfig = (dir, password) => {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'config.json')
  writeFileSync(
    p,
    JSON.stringify(
      {
        backend: { type: 'opencode' },
        feishu: { appId: 'cli_test', appSecret: 'sec', allowlist: ['ou_a'], names: { ou_a: 'A' } },
        opencode: { url: 'http://127.0.0.1:19876', password, defaultDirectory: '/tmp/x', defaultModel: 'm/n' },
        behavior: { idleTimeoutMs: 120000, maxParallel: 2 },
      },
      null,
      2,
    ),
  )
  return p
}

try {
  // ---- 1. 空密码：生成并写回 ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'ocb-servepw-empty-'))
    const cfg = mkConfig(join(dir, 'inst'), '')
    const before = JSON.parse(readFileSync(cfg, 'utf8'))

    const out = runPwBlock(cfg)
    const after = JSON.parse(readFileSync(cfg, 'utf8'))

    ok(HEX48.test(after.opencode.password), '空密码生成 48 位十六进制写回配置', after.opencode.password)
    ok(after.opencode.password !== before.opencode.password, '写回的值确实替换了空值')
    // 权威源是配置：serve 导出的必须就是写回的那个
    ok(
      out.includes(`EXPORTED=${after.opencode.password}`),
      '导出给 serve 的密码与写回配置的一致（两边同源）',
    )
    // 只加密码，别的一个字不动
    const stripped = { ...after, opencode: { ...after.opencode, password: before.opencode.password } }
    ok(
      JSON.stringify(stripped) === JSON.stringify(before),
      '除 password 外配置其余字段未被改动',
    )
    // 权限与尾换行对齐 admin 的 writeConfigAtomic：配置里有 appSecret 与
    // serve 密码，rename 后是 644 就等于把密钥摊开给本机所有用户读
    ok((statSync(cfg).mode & 0o777) === 0o600, '写回后配置权限为 0600', (statSync(cfg).mode & 0o777).toString(8))
    ok(readFileSync(cfg, 'utf8').endsWith('\n'), '写回后配置以换行结尾（与 admin 一致）')
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- 2. 已有密码：绝不改动 ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'ocb-servepw-set-'))
    const cfg = mkConfig(join(dir, 'inst'), 'keep-me-123')
    const before = readFileSync(cfg, 'utf8')

    const out = runPwBlock(cfg)
    const after = readFileSync(cfg, 'utf8')

    ok(after === before, '已有密码时配置一个字节都不改')
    ok(out.includes('EXPORTED=keep-me-123'), '已有密码原样导出给 serve')
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- 3. 写回用桩 node：证明生成源是 crypto.randomBytes ----
  // 桩把 randomBytes 钉成 24 个 0x07，写回的密码就应当是 "07" 重复 24 次
  {
    const dir = mkdtempSync(join(tmpdir(), 'ocb-servepw-stub-'))
    const cfg = mkConfig(join(dir, 'inst'), '')
    try {
      runPwBlock(cfg, { stubNode: true })
      const after = JSON.parse(readFileSync(cfg, 'utf8'))
      ok(after.opencode.password === '07'.repeat(24), '密码来自 crypto.randomBytes(24)', after.opencode.password)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // ---- 4. 坏 JSON：整个不写 ----
  // 读失败就退出非零，走 serve.sh 的失败分支。绝不能把坏配置覆盖成只剩
  // password 的文件——那会把其余配置连座毁掉
  {
    const dir = mkdtempSync(join(tmpdir(), 'ocb-servepw-broken-'))
    const inst = join(dir, 'inst')
    mkdirSync(inst, { recursive: true })
    const cfg = join(inst, 'config.json')
    const broken = '{ this is not json'
    writeFileSync(cfg, broken)

    const out = runPwBlock(cfg)

    ok(readFileSync(cfg, 'utf8') === broken, '坏 JSON 时配置一个字节都不动')
    ok(!existsSync(cfg + '.bak'), '坏 JSON 时不产生 .bak')
    ok(out.includes('写回配置失败'), '坏 JSON 时走失败分支，serve 以无密码运行')
    rmSync(dir, { recursive: true, force: true })
  }
} catch (err) {
  fail++
  console.log(`❌ 测试本身出错: ${err.stack || err.message}`)
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
