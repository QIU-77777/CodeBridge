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
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

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

  // 5. 可执行文件解析：PATH 找不到时去常见用户 bin 目录找
  // （pi 装在 ~/.npm-global/bin，而 admin 进程的 PATH 里没有它，实测踩过）
  const { resolveBin } = await import(join(REPO, 'admin', 'instances.js'))
  const npmGlobalPi = join(homedir(), '.npm-global', 'bin', 'pi')
  const hasPi = existsSync(npmGlobalPi)
  if (hasPi) {
    ok(resolveBin('pi') === npmGlobalPi, '裸命令名在常见目录里找到（npm 全局 bin）', String(resolveBin('pi')))
  } else {
    // 没装 pi 的机器上不当失败，跳过并说明
    console.log('… 跳过：本机没有 ~/.npm-global/bin/pi，相关用例不适用')
  }
  ok(resolveBin('/usr/bin/env') === '/usr/bin/env', '显式路径直接采用')
  ok(resolveBin('/nonexistent/xyz') === null, '显式路径不存在返回 null')
  ok(resolveBin('definitely-not-a-real-binary-xyz') === null, '哪里都找不到返回 null')
  ok(resolveBin('') === null, '空名字返回 null')

  // 5b. launchd plist 的 PATH：系统目录打底，追加用户的常见 bin 目录
  // （pi 装在 npm 全局 bin，plist 只写系统目录时 launchd 拉起的桥接找不到它）
  const lp = spawnSync('bash', ['-c', '. "$1/scripts/lib/launchd-path.sh"; ocb_launchd_path', '_', REPO], {
    encoding: 'utf8',
  })
  ok(lp.status === 0, 'launchd-path.sh 可被 source 并输出 PATH')
  const lpOut = (lp.stdout || '').trim()
  ok(lpOut.startsWith('/usr/local/bin:'), 'PATH 以系统目录打底', lpOut.slice(0, 60))
  ok(
    hasPi ? lpOut.includes(join(homedir(), '.npm-global', 'bin')) : true,
    'PATH 包含 npm 全局 bin（pi 所在目录）',
    lpOut.slice(0, 120),
  )

  // 6. 新建实例：校验、端口避让、配置生成与落盘
  const { planNewInstance, writeNewInstance, nextFreeUrl, defaultDirForName } = await import(
    join(REPO, 'admin', 'create.js')
  )
  const goodBody = {
    name: 'pi',
    feishu: { appId: 'cli_test0000000000000a', appSecret: 'sec', domain: 'feishu' },
    opencode: { password: 'sec-pw' },
  }
  const okPlan = planNewInstance(goodBody, [])
  ok(okPlan.errors.length === 0, '合法输入通过校验', okPlan.errors.join('；'))
  ok(okPlan.plan?.name === 'pi' && okPlan.plan?.backend === 'opencode', '计划带实例名与后端类型')
  ok(
    okPlan.plan?.dir === defaultDirForName('pi'),
    '默认配置目录是 ~/.config/opencode-feishu-bridge-实例名',
    okPlan.plan?.dir,
  )
  ok(
    okPlan.plan?.config.feishu.appId === 'cli_test0000000000000a' &&
      okPlan.plan?.config.feishu.appSecret === 'sec',
    '凭证写进生成的配置',
  )
  ok(
    okPlan.plan?.config.behavior?.streamIntervalMs >= 1200,
    'behavior 默认值来自仓库模板，不在这里抄第二份',
  )

  ok(planNewInstance({ name: 'default', feishu: goodBody.feishu }, []).errors.length > 0, '实例名 default 被拒绝')
  ok(planNewInstance({ name: 'Default', feishu: goodBody.feishu }, []).errors.length > 0, '实例名 Default（大小写变体）同样被拒绝')
  ok(planNewInstance({ name: 'bad name!', feishu: goodBody.feishu }, []).errors.length > 0, '非法实例名被拒绝')
  ok(planNewInstance({ name: 'pi', feishu: goodBody.feishu }, [{ name: 'pi', dir: '/tmp/x' }]).errors.length > 0, '重名实例被拒绝')
  ok(planNewInstance({ name: 'pi' }, []).errors.length > 0, '缺少 appId 被拒绝')
  ok(
    planNewInstance({ name: 'pi', feishu: { appId: 'xx', appSecret: 's' } }, []).errors.length > 0,
    'appId 格式不符被拒绝',
  )
  ok(
    planNewInstance({ name: 'pi', feishu: { appId: 'cli_test0000000000000a' } }, []).errors.length > 0,
    '缺少 appSecret 被拒绝',
  )
  ok(
    planNewInstance({ name: 'pi', dir: 'rel/dir', feishu: goodBody.feishu }, []).errors.length > 0,
    '相对路径配置目录被拒绝',
  )
  const piPlan = planNewInstance(
    { name: 'pi2', backend: { type: 'pi' }, feishu: goodBody.feishu },
    [],
  )
  ok(piPlan.errors.length === 0 && piPlan.plan.backend === 'pi', 'pi 后端计划通过校验')
  ok(piPlan.plan?.config.backend?.pi?.bin === 'pi', 'pi 参数有默认值')

  // 端口避让的数据形状必须和 collectAll() 一致：配置在 config.data 里。
  // 曾经用错形状（config.opencode）导致避让静默失效，测试这里钉住真实形状
  const instShape = (url) => ({ name: 'default', dir: '/tmp/d', config: { data: { opencode: { url } } } })
  ok(
    nextFreeUrl([instShape('http://127.0.0.1:19876')]) === 'http://127.0.0.1:19877',
    'serve 端口避开现有实例已占用的端口',
  )
  ok(
    nextFreeUrl([instShape('http://127.0.0.1:19876'), instShape('http://127.0.0.1:19877')]) === 'http://127.0.0.1:19878',
    '连续占用时顺延到下一个',
  )
  ok(nextFreeUrl([]) === 'http://127.0.0.1:19876', '没有现有实例时用基础端口')
  ok(
    nextFreeUrl([], 19876) === 'http://127.0.0.1:19877',
    'admin 自身占用的端口也避让',
  )

  // opencode 后端密码必填：静默留空会连到别人需要密码的 serve 报 401
  ok(
    planNewInstance({ name: 'pw', feishu: goodBody.feishu }, []).errors.some((e) => e.includes('密码必填')),
    'opencode 后端不填 serve 密码被拒绝',
  )
  ok(
    planNewInstance({ name: 'pw', feishu: goodBody.feishu, opencode: { password: 's3cret' } }, []).errors.length === 0,
    'opencode 后端填了密码通过校验',
  )
  // 显式指定已被占用的端口要拒绝：两个实例共用一个端口必然有一个 serve 绑不上
  ok(
    planNewInstance(
      { name: 'clash', feishu: goodBody.feishu, opencode: { password: 's3cret', url: 'http://127.0.0.1:19876' } },
      [instShape('http://127.0.0.1:19876')],
    ).errors.some((e) => e.includes('端口 19876 已被实例 default 占用')),
    '显式指定已被占用的 serve 端口被拒绝',
  )
  ok(
    planNewInstance(
      { name: 'free', feishu: goodBody.feishu, opencode: { password: 's3cret', url: 'http://127.0.0.1:19999' } },
      [instShape('http://127.0.0.1:19876')],
    ).errors.length === 0,
    '显式指定未被占用的端口通过',
  )
  // pi 后端不连 serve：不校验密码，url 保留模板占位值
  const piPlan2 = planNewInstance({ name: 'pi3', backend: { type: 'pi' }, feishu: goodBody.feishu }, [])
  ok(piPlan2.errors.length === 0, 'pi 后端不要求 serve 密码')
  ok(
    piPlan2.plan?.config.opencode?.url === 'http://127.0.0.1:19876',
    'pi 后端的 url 用模板占位值，不参与避让',
  )

  // 落盘到临时目录：config.json 生成、权限 600、目录可指认
  const tmpDir = join(mkdtempSync(join(tmpdir(), 'ocb-create-')), 'sub')
  const written = writeNewInstance(tmpDir, okPlan.plan.config)
  ok(written === join(tmpDir, 'config.json'), '配置写到指定目录')
  const back = JSON.parse(readFileSync(written, 'utf8'))
  ok(back.feishu.appSecret === 'sec', '落盘的配置内容正确')
  ok((statSync(written).mode & 0o777) === 0o600, 'config.json 权限为 600（含 appSecret）')
  ok(
    planNewInstance({ ...goodBody, dir: tmpDir }, [{ name: 'x', dir: tmpDir }]).errors.some((e) => e.includes('已被实例')),
    '已存在的配置目录被拒绝覆盖',
  )
  ok(
    planNewInstance({ ...goodBody, dir: tmpDir }, []).errors.some((e) => e.includes('已有 config.json')),
    '目录里已有 config.json 时拒绝覆盖',
  )
  rmSync(tmpDir, { recursive: true, force: true })
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
