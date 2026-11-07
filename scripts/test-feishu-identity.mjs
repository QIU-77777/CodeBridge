#!/usr/bin/env node
/**
 * 飞书身份注入的离线测试：不连飞书、不起 serve，只用临时配置目录跑
 * scripts/lib/feishu-identity.sh，断言导出的环境变量与生成的 lark-cli 配置。
 *
 *   node scripts/test-feishu-identity.mjs
 *
 * 背景：opencode 的代理跑在常驻 serve 里，桥接无法向已启动的进程注入环境
 * 变量，所以注入点挪到 serve 启动处（scripts/agent/serve.sh 与 up.sh 都调
 * 这里的 ocb_export_feishu_identity）。语义与 src/pi.js 的 childEnv() 一致。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const LIB = join(REPO, 'scripts', 'lib', 'feishu-identity.sh')

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`❌ ${name} ${extra}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'ocb-identity-'))

/** 在 bash 里 source 库、调用函数，把导出后的环境变量落盘返回 */
function runIdentity(configDir, extraSetup = '') {
  const dump = join(root, `env-${Math.random().toString(36).slice(2)}.txt`)
  const script = `
    set -u
    . '${LIB}'
    ${extraSetup}
    ocb_export_feishu_identity '${configDir}' node
    {
      echo "FEISHU_APP_ID=\${FEISHU_APP_ID:-<unset>}"
      echo "FEISHU_APP_SECRET=\${FEISHU_APP_SECRET:-<unset>}"
      echo "FEISHU_DOMAIN=\${FEISHU_DOMAIN:-<unset>}"
      echo "LARKSUITE_CLI_CONFIG_DIR=\${LARKSUITE_CLI_CONFIG_DIR:-<unset>}"
    } > '${dump}'
  `
  execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const out = {}
  for (const line of readFileSync(dump, 'utf8').trim().split('\n')) {
    const i = line.indexOf('=')
    out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

function makeConfigDir(name, cfg) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (cfg !== null) writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
  return dir
}

try {
  // 1. 有飞书凭证：环境变量全部注入，lark-cli 实例配置生成且权限 600
  {
    const dir = makeConfigDir('with-creds', {
      backend: { type: 'opencode' },
      feishu: { appId: 'cli_identity01', appSecret: 'sec_identity01', domain: 'feishu' },
    })
    const env = runIdentity(dir)
    ok(env.FEISHU_APP_ID === 'cli_identity01', '注入本实例的 FEISHU_APP_ID', env.FEISHU_APP_ID)
    ok(env.FEISHU_APP_SECRET === 'sec_identity01', '注入本实例的 FEISHU_APP_SECRET')
    ok(env.FEISHU_DOMAIN === 'feishu', '注入 domain')
    const larkFile = join(dir, 'lark-cli', 'config.json')
    ok(existsSync(larkFile), '生成了 lark-cli 实例配置')
    const lark = JSON.parse(readFileSync(larkFile, 'utf8'))
    ok(lark.strictMode === 'bot', 'lark-cli 配置 strictMode=bot')
    ok(lark.apps?.length === 1 && lark.apps[0].appId === 'cli_identity01', 'lark-cli 配置只含本实例应用')
    ok(env.LARKSUITE_CLI_CONFIG_DIR === join(dir, 'lark-cli'), 'LARKSUITE_CLI_CONFIG_DIR 指向该配置')
    ok((statSync(larkFile).mode & 0o777) === 0o600, 'lark-cli 配置权限 600（含 appSecret）')

    // 幂等：再跑一次内容不变（不重复写）
    const before = readFileSync(larkFile, 'utf8')
    runIdentity(dir)
    ok(readFileSync(larkFile, 'utf8') === before, '重复调用不改写配置')
  }

  // 2. 没有飞书凭证：什么都不导出，不生成 lark-cli 配置（老部署零改动）
  {
    const dir = makeConfigDir('no-creds', { backend: { type: 'opencode' }, feishu: {} })
    const env = runIdentity(dir)
    ok(env.FEISHU_APP_ID === '<unset>', '没有 appId 时不注入')
    ok(env.LARKSUITE_CLI_CONFIG_DIR === '<unset>', '不生成 lark-cli 配置')
    ok(!existsSync(join(dir, 'lark-cli')), '磁盘上没有 lark-cli 目录')
  }

  // 3. 配置损坏 / 目录不存在：安静跳过，不炸启动脚本
  {
    const dir = makeConfigDir('broken', null)
    writeFileSync(join(dir, 'config.json'), '{ 不是 JSON')
    const env = runIdentity(dir)
    ok(env.FEISHU_APP_ID === '<unset>', '配置损坏时不注入、不报错')
    const missing = join(root, 'not-exist')
    const env2 = runIdentity(missing)
    ok(env2.FEISHU_APP_ID === '<unset>', '配置目录不存在时安静返回')
  }

  // 4. 换绑机器人：改配置即换身份，重启 serve 后生效（这里是改完再跑一次）
  {
    const dir = makeConfigDir('rebound', {
      feishu: { appId: 'cli_old', appSecret: 'sec_old' },
    })
    runIdentity(dir)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ feishu: { appId: 'cli_new', appSecret: 'sec_new' } }))
    const env = runIdentity(dir)
    ok(env.FEISHU_APP_ID === 'cli_new', '换绑后注入新应用的 appId')
    const lark = JSON.parse(readFileSync(join(dir, 'lark-cli', 'config.json'), 'utf8'))
    ok(lark.apps[0].appId === 'cli_new', 'lark-cli 实例配置同步换成新应用')
  }

  // 5. 两条 serve 启动路径都接了注入（防回归：有人删掉调用时测试会红）
  {
    const serve = readFileSync(join(REPO, 'scripts', 'agent', 'serve.sh'), 'utf8')
    const up = readFileSync(join(REPO, 'scripts', 'up.sh'), 'utf8')
    ok(serve.includes('ocb_export_feishu_identity'), 'launchd 路径 serve.sh 调用了注入')
    ok(up.includes('ocb_export_feishu_identity'), '手动路径 up.sh 调用了注入')
  }
} catch (err) {
  fail++
  console.log(`❌ 测试本身出错: ${err.stack || err.message}`)
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
