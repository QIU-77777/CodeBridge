#!/usr/bin/env node
/**
 * init 脚本的离线测试：只测文件行为，不碰飞书接口。
 *   node scripts/test-init.mjs
 *
 * 向导里的「验证凭证」需要真凭证，这里用 --no-input 跳过；
 * 交互提问本身靠 --wizard + 管道输入测（不联网，只看流程走不走得通）。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

const INIT = new URL('./init.mjs', import.meta.url).pathname
const root = mkdtempSync(join(tmpdir(), 'ocb-init-'))

function run(dir, args = [], input = '') {
  const r = spawnSync(process.execPath, [INIT, ...args], {
    env: { ...process.env, OCB_CONFIG_DIR: dir },
    input,
    encoding: 'utf8',
  })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const readCfg = (dir) => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))

try {
  // 1. 空目录：铺模板，不提问题
  {
    const dir = join(root, 'a')
    const r = run(dir, ['--no-input'])
    ok(existsSync(join(dir, 'config.json')), '空目录能生成 config.json')
    ok(/cli_x+/.test(readCfg(dir).feishu.appId), '生成的是占位符，不是真凭证')
    ok(!r.out.includes('初始化向导'), '非 TTY 不带 --wizard 时不提问')
    ok(r.out.includes('--add-allow'), '输出里告诉用户白名单怎么加')
    ok(r.out.includes('事件订阅') && r.out.includes('发布版本'), '输出里列出飞书后台四项')
  }

  // 2. 已存在：不覆盖
  {
    const dir = join(root, 'b')
    run(dir, ['--no-input'])
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ sentinel: true }), 'utf8')
    const r = run(dir, ['--no-input'])
    ok(r.code === 0, '已存在时正常退出')
    ok(readCfg(dir).sentinel === true, '已存在时不动原文件')
    ok(r.out.includes('--add-allow'), '已存在时给出加白名单的命令')
  }

  // 3. --force：备份后重建
  {
    const dir = join(root, 'c')
    run(dir, ['--no-input'])
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ sentinel: true }), 'utf8')
    const r = run(dir, ['--no-input', '--force'])
    ok(existsSync(join(dir, 'config.json.bak')), '--force 先备份成 .bak')
    ok(/cli_x+/.test(readCfg(dir).feishu.appId), '--force 后是新模板')
    ok(r.out.includes('已备份'), '--force 时告知备份路径')
  }

  // 4. --add-allow：追加并去重
  {
    const dir = join(root, 'd')
    run(dir, ['--no-input'])
    run(dir, ['--add-allow=ou_a'])
    run(dir, ['--add-allow=ou_b'])
    const r = run(dir, ['--add-allow=ou_a'])
    ok(JSON.stringify(readCfg(dir).feishu.allowlist) === '["ou_a","ou_b"]', '两个 id 都进去了')
    ok(r.out.includes('已经在白名单里'), '重复添加时提示已存在')
    ok(r.code === 0, '重复添加不算失败')
  }

  // 5. --add-allow 但配置不存在
  {
    const dir = join(root, 'e')
    const r = run(dir, ['--add-allow=ou_a'])
    ok(r.code === 1, '配置不存在时 add-allow 报错退出')
    ok(r.out.includes('先跑一次 npm run init'), '并告诉用户先初始化')
  }

  // 6. --wizard + 管道输入：凭证错→确认→放弃
  {
    const dir = join(root, 'f')
    const r = run(dir, ['--wizard'], 'cli_fake1234\nfakesecret\n\n\nn\n')
    ok(r.out.includes('初始化向导'), '--wizard 会提问')
    ok(r.out.includes('****'), '密钥输入不回显')
    ok(/验证凭证/.test(r.out), '会真的去验证凭证')
    ok(!existsSync(join(dir, 'config.json')), '验证失败并选择放弃时不写文件')
    ok(r.code === 1, '放弃时退出码 1')
  }

  // 7. --app-id / --app-secret 直接给，不再问这两个
  {
    const dir = join(root, 'g')
    // 假凭证验证会失败，先回答 y 表示「照样保存」，再空行跳过 open_id，最后给目录
    const r = run(dir, ['--wizard', '--app-id=cli_x', '--app-secret=y'], 'y\n\n/tmp\n')
    ok(!r.out.includes('App ID:'), '命令行给了 appId 就不再问')
    ok(r.out.includes('仍然保存'), '验证失败时会问要不要照样保存')
    ok(r.out.includes('默认工作目录'), '仍然问默认目录')
    const c = readCfg(dir)
    ok(c.feishu.appId === 'cli_x', 'appId 用命令行给的值')
    ok(c.opencode.defaultDirectory === '/tmp', '默认目录用回答的值')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
