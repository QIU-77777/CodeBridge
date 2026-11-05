#!/usr/bin/env node
/**
 * admin 管理后台的离线测试：只测本地逻辑，不碰飞书接口、不起停进程。
 *   node scripts/test-admin.mjs
 *
 * 重点断言两件事：
 *   1. admin 的目录解析和 src/config.js 的 resolveConfigDir 逐字一致
 *      （无环境变量、绝对路径、相对路径三种输入）——配置目录解析不允许有第二套规则；
 *   2. 实例名从 launchd label 推断正确，起停环境变量按实例名生成。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

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

const REPO = fileURLToPath(new URL('..', import.meta.url))
const INSTANCES = join(REPO, 'admin', 'instances.js')
const CONFIG = join(REPO, 'src', 'config.js')

/** 在给定环境变量下取一个模块导出的值。子进程跑，import 时的环境才干净 */
function exportUnderEnv(modulePath, exportName, env) {
  const code = `import(${JSON.stringify(modulePath)}).then((m) => console.log(m.${exportName}()))`
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`子进程失败: ${(r.stderr || '').slice(0, 200)}`)
  return r.stdout.trim()
}

/** src/config.js 的 CONFIG_DIR 是 import 时算出的常量，同样放子进程里取 */
function configDirUnderEnv(env) {
  const code = `import(${JSON.stringify(CONFIG)}).then((m) => console.log(m.CONFIG_DIR))`
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`子进程失败: ${(r.stderr || '').slice(0, 200)}`)
  return r.stdout.trim()
}

try {
  // 1. 目录解析一致性：三种输入逐个对照
  const cases = [
    { name: '无环境变量', env: { OCB_CONFIG_DIR: '' } },
    { name: '绝对路径', env: { OCB_CONFIG_DIR: '/tmp/ocb-admin-abs' } },
    { name: '相对路径', env: { OCB_CONFIG_DIR: 'rel/path/ocb' } },
  ]
  for (const c of cases) {
    const env = { ...c.env }
    if (c.name === '无环境变量') delete env.OCB_CONFIG_DIR
    const admin = exportUnderEnv(INSTANCES, 'defaultConfigDir', env)
    const src = configDirUnderEnv(env)
    ok(admin === src, `目录解析一致（${c.name}）`, `admin=${admin} src=${src}`)
  }

  // 2. label -> 实例名。与 scripts/lib/config-dir.sh 的 ocb_label() 互逆
  const names = await import(INSTANCES)
  ok(names.instanceNameFromLabel('ai.qiguang.ocbridge.app') === 'default', '缺省 label 推出 default')
  ok(names.instanceNameFromLabel('ai.qiguang.ocbridge.pi.app') === 'pi', '带实例的 label 推出实例名')
  ok(names.instanceNameFromLabel('ai.qiguang.ocbridge.foo.bar.app') === 'foo.bar', '实例名含点也能正确切分')
  ok(names.instanceNameFromLabel('ai.qiguang.ocbridge.serve') === null, 'serve 服务不推实例名')

  // 3. 起停环境变量：default 不带 OCB_INSTANCE，其余带；OCB_CONFIG_DIR 始终传递
  const envDefault = names.instanceEnv('default', '/tmp/x')
  ok(envDefault.OCB_INSTANCE === '' && envDefault.OCB_CONFIG_DIR === '/tmp/x', 'default 实例的 OCB_INSTANCE 为空')
  const envPi = names.instanceEnv('pi', '/tmp/y')
  ok(envPi.OCB_INSTANCE === 'pi' && envPi.OCB_CONFIG_DIR === '/tmp/y', '命名实例带上 OCB_INSTANCE 与 OCB_CONFIG_DIR')

  // 4. doctor 按实例跑必须带 OCB_CONFIG_DIR（不传查的是默认实例）
  const controlSrc = await import('node:fs').then((fs) =>
    fs.readFileSync(join(REPO, 'admin', 'control.js'), 'utf8'),
  )
  ok(
    /env: \{ \.\.\.process\.env, \.\.\.instanceEnv\(name, dir\) \}/.test(controlSrc),
    'doctor 子进程带上实例的 OCB_CONFIG_DIR',
  )
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
