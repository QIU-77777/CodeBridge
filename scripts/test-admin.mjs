#!/usr/bin/env node
/**
 * admin 管理后台的离线测试：只测本地逻辑，不碰飞书接口、不起停进程。
 *   node scripts/test-admin.mjs
 *
 * 重点断言四件事：
 *   1. admin 的目录解析和 src/config.js 的 resolveConfigDir 逐字一致
 *      （无环境变量、绝对路径、相对路径三种输入）——配置目录解析不允许有第二套规则；
 *   2. 实例名从 launchd label 推断正确，起停环境变量按实例名生成；
 *   3. 飞书条目（白名单、名字对照）的纯函数行为，含生效名字的优先级；
 *   4. 页面上名字与工作目录的编辑入口真实存在（结构断言挡回归）。
 *
 * HTTP 接口到落盘的整条路由在 scripts/test-admin-api.mjs。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
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

  // 4b. 总览表格：表头列数必须和 loadOverview 每行渲染的单元格数一致。
  // 曾经表头 9 列、行里只有 8 个单元格（配置目录挤进第一列当副标题），
  // 导致后端、飞书应用、状态等每一列都左移一格，「操作」列空着
  const indexHtml = await import('node:fs').then((fs) =>
    fs.readFileSync(join(REPO, 'admin', 'public', 'index.html'), 'utf8'),
  )
  const ovTable = indexHtml.slice(indexHtml.indexOf('<table id="ov-table">'))
  const ovHead = ovTable.slice(0, ovTable.indexOf('</thead>'))
  const thCount = (ovHead.match(/<th>/g) || []).length
  const rowStart = indexHtml.indexOf('return `<tr>', indexHtml.indexOf('async function loadOverview'))
  const rowTpl = indexHtml.slice(rowStart, indexHtml.indexOf('</tr>`', rowStart))
  const tdCount = (rowTpl.match(/<td[\s>]/g) || []).length
  ok(
    thCount === 9 && tdCount === thCount,
    `总览表格每行单元格数与表头一致（${thCount} 列）`,
    `th=${thCount} td=${tdCount}`,
  )

  // 4c. 长列截断与操作列按钮分流：
  //   - 配置目录、飞书应用两列用 .clip 截断并带完整值 title（不截断会把操作列挤到折行）
  //   - 操作列按运行状态给按钮：运行中只有重启/停止，未运行只有启动（三种全列曾把用户看懵）
  const ovFn = indexHtml.slice(indexHtml.indexOf('async function loadOverview'))
  const actionsTpl = ovFn.slice(ovFn.indexOf('const actions ='), ovFn.indexOf('return `<tr>'))
  const runAt = actionsTpl.indexOf('i.process.running')
  ok(runAt > 0, '操作列按 i.process.running 分流按钮')
  const elseAt = actionsTpl.indexOf(': `<div', runAt)
  const runBranch = actionsTpl.slice(runAt, elseAt)
  const stopBranch = actionsTpl.slice(elseAt)
  ok(
    runBranch.includes("'restart'") && runBranch.includes("'stop'") && !runBranch.includes("'start'"),
    '运行中的实例只有重启/停止按钮',
    runBranch.replace(/\s+/g, ' ').slice(0, 120),
  )
  ok(
    stopBranch.includes("'start'") && !stopBranch.includes("'restart'") && !stopBranch.includes("'stop'"),
    '未运行的实例只有启动按钮',
    stopBranch.replace(/\s+/g, ' ').slice(0, 120),
  )
  ok(rowTpl.includes('class="clip" title="${esc(i.dir)}"'), '配置目录列截断并带完整路径 title')
  ok(rowTpl.includes('class="clip" title="${esc(i.appId'), '飞书应用列截断并带完整 appId title')
  ok(
    /\.clip \{[^}]*text-overflow: ellipsis/.test(indexHtml),
    '截断样式超出宽度时显示省略号',
  )

  // 4d. 配置页按后端显隐：opencode 连接与 pi 参数各自成组，随后端类型切显隐。
  // 用户原话：「配置的明明是 pi，右侧还给我 open code 连接的选项」——
  // 常驻显示的 opencode 分区与写死的后端清单都不允许回来
  ok(indexHtml.includes('id="c-oc-group"'), '配置页有 opencode 字段组')
  ok(indexHtml.includes('id="c-pi-group"'), '配置页有 pi 字段组')
  ok(indexHtml.includes('id="c-backendType"'), '配置页有后端选择框')
  ok(indexHtml.includes('id="c-backend-scan"'), '配置页有「复用本地」说明行')
  ok(!indexHtml.includes('<h3>opencode 连接</h3>'), '配置页没有常驻显示的 opencode 连接分区')
  ok(!indexHtml.includes('<h3>backend</h3>'), '配置页底部没有独立的后端分区（已并入 coding agent 组）')
  const cfgToggle = indexHtml.slice(indexHtml.indexOf('function toggleConfigBackend'))
  ok(
    cfgToggle.includes("$('c-pi-group').classList.toggle('hidden', !pi)") &&
      cfgToggle.includes("$('c-oc-group').classList.toggle('hidden', pi)"),
    'toggleConfigBackend 按后端类型切换两组的显隐',
  )
  ok(
    /async function loadConfigTab[\s\S]*?loadBackends\(\)/.test(indexHtml),
    '配置页加载时一并取本地 coding agent 扫描',
  )
  ok(
    /fillBackendSelect\(\$\(['"]c-backendType['"]\)/.test(indexHtml),
    '配置页的后端选项由扫描结果填充',
  )

  // 4e. 新建实例弹窗：后端选项来自扫描，默认落在本机可用的那个上
  const createModal = indexHtml.slice(indexHtml.indexOf('id="create-modal"'))
  ok(createModal.includes('id="n-backend-scan"'), '新建弹窗有「复用本地」说明行')
  ok(!/<option value="opencode">/.test(createModal), '新建弹窗不再写死后端选项')
  const openCreate = indexHtml.slice(indexHtml.indexOf('async function openCreateModal'))
  ok(
    openCreate.includes("loadBackends(true)") && openCreate.includes("fillBackendSelect($('n-backend')"),
    '打开弹窗时重扫并填充后端选项',
  )
  ok(
    /backends\.find\(\(b\) => b\.available\)/.test(openCreate),
    '默认选中本机可用的后端',
  )
  ok(
    !indexHtml.includes('opencode 后端要填 serve 密码'),
    '新建弹窗不再前置拦截空 serve 密码（服务端自动生成）',
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

  // 5c. pi 健康检查带回版本号：总览 serve 列的 pi 徽章直接显示它（与 opencode 的 serve 版本同一列）
  const { piCliHealth } = await import(join(REPO, 'admin', 'instances.js'))
  if (hasPi) {
    const ph = await piCliHealth({ backend: { type: 'pi', pi: { bin: 'pi' } } })
    ok(
      ph.applicable === true && ph.ok === true && typeof ph.version === 'string' && ph.version.length > 0,
      'pi 健康检查 ok 时带回非空版本号',
      JSON.stringify(ph).slice(0, 120),
    )
  } else {
    console.log('… 跳过：本机没有 ~/.npm-global/bin/pi，pi 健康检查用例不适用')
  }
  const phOpen = await piCliHealth({ backend: { type: 'opencode' } })
  ok(phOpen.applicable === false, 'opencode 实例的 pi 健康检查不适用')

  // 5d. 本地 coding agent 扫描：形状稳定，与本机装没装无关。
  // 配置页与新建弹窗的后端选项全部来自这一次扫描，字段契约在这里钉住
  const { scanBackends } = await import(join(REPO, 'admin', 'backends.js'))
  const scanned = await scanBackends()
  ok(Array.isArray(scanned) && scanned.length === 2, '扫描返回两个受支持的后端')
  ok(
    scanned.map((b) => b.type).join(',') === 'opencode,pi',
    '后端顺序固定：opencode、pi',
    scanned.map((b) => b.type).join(','),
  )
  for (const b of scanned) {
    ok(
      typeof b.summary === 'string' && b.summary.length > 0 &&
      typeof b.available === 'boolean' && typeof b.bin === 'string' &&
      typeof b.version === 'string' && typeof b.detail === 'string' && typeof b.reason === 'string',
      `${b.type} 条目字段完整`,
      JSON.stringify(b).slice(0, 160),
    )
    ok(
      b.available ? b.bin.length > 0 : b.reason.length > 0,
      b.available ? `${b.type} 可用时给出解析路径` : `${b.type} 不可用时给出原因`,
    )
  }

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

  // opencode 后端的 serve 密码留空时自动生成：serve 与桥接从同一份配置读它，
  // 两边同源就不存在用户填错；空密码才会连到别人需要密码的 serve 报 401
  const autoPw = planNewInstance({ name: 'pw', feishu: goodBody.feishu }, [])
  ok(autoPw.errors.length === 0, 'opencode 后端不填 serve 密码也能建（自动生成）')
  const generated = autoPw.plan?.config.opencode?.password || ''
  ok(generated.length >= 32, '自动生成的 serve 密码足够长', `len=${generated.length}`)
  ok(
    planNewInstance({ name: 'pw2', feishu: goodBody.feishu }, []).plan?.config.opencode?.password !== generated,
    '每次生成的密码不同',
  )
  ok(
    planNewInstance({ name: 'pw', feishu: goodBody.feishu, opencode: { password: 's3cret' } }, []).plan?.config
      .opencode?.password === 's3cret',
    '显式填了 serve 密码时尊重输入',
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

  // 7. 飞书条目纯函数：白名单增删、名字增改删、生效名字优先级
  const {
    applyAllowlistAdd,
    applyAllowlistRemove,
    applyNameSet,
    applyNameRemove,
    effectiveName,
    checkOpenId,
    checkName,
    NAME_MAX,
  } = await import(join(REPO, 'admin', 'entries.js'))
  ok(checkOpenId('ou_abc123') === null, '合法 open_id 通过校验')
  ok(checkOpenId('') !== null, '空 open_id 被拒绝')
  ok(checkOpenId('ou_a b') !== null, '含空白的 open_id 被拒绝')
  ok(checkName('邱琪光') === null, '普通名字通过校验')
  ok(checkName('') !== null, '空名字被拒绝')
  ok(checkName('x'.repeat(NAME_MAX + 1)) !== null, `超过 ${NAME_MAX} 个字符的名字被拒绝`)

  ok(applyAllowlistAdd(['ou_a'], 'ou_b').join() === 'ou_a,ou_b', '白名单加一条')
  ok(applyAllowlistAdd(['ou_a'], 'ou_a').length === 1, '白名单重复添加幂等')
  ok(applyAllowlistRemove(['ou_a', 'ou_b'], 'ou_a').join() === 'ou_b', '白名单移除一条')
  ok(applyAllowlistRemove(['ou_a'], 'ou_z').length === 1, '移除不存在的条目原样返回')
  ok(applyAllowlistAdd(null, 'ou_a').join() === 'ou_a', '白名单入参不是数组时按空表处理')

  ok(applyNameSet({}, 'ou_a', '邱琪光').ou_a === '邱琪光', '写一条名字')
  ok(applyNameSet({ ou_a: '旧' }, 'ou_a', '新').ou_a === '新', '改一条名字')
  ok(!('ou_a' in applyNameSet({ ou_a: '旧' }, 'ou_a', '  ')), '空名字等于删除声明')
  ok(!('ou_a' in applyNameRemove({ ou_a: 'x' }, 'ou_a')), '移除名字声明')
  ok(!('ou_z' in applyNameRemove({ ou_a: 'x' }, 'ou_z')), '移除不存在的名字声明原样返回')

  ok(effectiveName({ ou_a: '声明' }, { ou_a: '攒到' }, 'ou_a') === '声明', '生效名字以配置声明优先')
  ok(effectiveName({}, { ou_a: '攒到' }, 'ou_a') === '攒到', '没有声明时用攒到的名字')
  ok(effectiveName({}, {}, 'ou_a') === '', '两者都没有时为空')
  // 生效名字的顺序必须和 src/handler.js 的 nameOf() 一致：后台显示的即是卡片上显示的
  const handlerSrc = await import('node:fs').then((fs) =>
    fs.readFileSync(join(REPO, 'src', 'handler.js'), 'utf8'),
  )
  ok(
    /cfg\.feishu\?\.names\?\.\[openId\] \|\| this\.store\.getName\?\.\(openId\)/.test(handlerSrc),
    '生效名字顺序与 handler.js 的 nameOf() 一致',
  )

  // 7b. 通讯录与 listen：store 的入册 / 类型补充 / 旧数据迁移，闸门并集
  {
    const { Store } = await import(join(REPO, 'src', 'store.js'))
    const dir = mkdtempSync(join(tmpdir(), 'ocb-contacts-'))
    const st = new Store(join(dir, 'state.json'))

    // 入册只认被 @：有名字才建册
    st.learnContact('ou_lilp', 'Lil_P')
    ok(st.getName('ou_lilp') === 'Lil_P', '被 @ 到就入册，名字可查')
    st.learnContact('ou_noname', '')
    ok(!st.data.contacts?.['ou_noname'], '没有名字的 mention 不建册')
    ok(st.getName('ou_noname') === '', '查不到的 id 返回空串')

    // 类型补充：只更新已入册的，不建册
    st.markContactKind('ou_lilp', 'app')
    ok(st.data.contacts['ou_lilp'].kind === 'app', '类型补进已入册条目')
    st.markContactKind('ou_never_seen', 'app')
    ok(!st.data.contacts?.['ou_never_seen'], '类型补充不给没见过的 id 建册')
    st.markContactKind('ou_lilp', 'user')
    ok(st.data.contacts['ou_lilp'].kind === 'user', '类型可被后续消息更正')

    // 时间戳：只记首次见到，不记最近见到（admin 通讯录只看「什么时候认识的」）
    const firstSeen = st.data.contacts['ou_lilp'].firstSeen
    await new Promise((r) => setTimeout(r, 5))
    st.learnContact('ou_lilp', 'Lil_P')
    ok(st.data.contacts['ou_lilp'].firstSeen === firstSeen, '重复见到不翻新首次时间')
    ok(!('lastSeen' in st.data.contacts['ou_lilp']), '不再记录最近见到时间')

    // 自己不入册：桥接解析出自身 open_id 时清掉存量里的「自己」
    st.dropContact('ou_lilp')
    ok(!st.data.contacts['ou_lilp'], 'dropContact 把自己清出通讯录')
    ok(st.getName('ou_lilp') === '', '清掉后名字查不到')
    st.dropContact('ou_not_there')
    ok(true, 'dropContact 对不存在的 id 安全返回')

    // 重新入册，供后面的闸门断言使用
    st.learnContact('ou_lilp', 'Lil_P')

    // 通讯录全量下发（admin 面板数据源）不带 lastSeen
    const list = st.contactList()
    ok(list.every((c) => !('lastSeen' in c)), 'contactList 不下发 lastSeen')
    ok(list[0]?.openId && list[0]?.firstSeen, 'contactList 带 openId 与 firstSeen')

    // 旧版平铺 names 迁移
    const legacy = join(dir, 'legacy.json')
    writeFileSync(legacy, JSON.stringify({ version: 1, chats: {}, names: { ou_old: '老名字' } }))
    const st2 = new Store(legacy)
    ok(st2.getName('ou_old') === '老名字', '旧版平铺 names 迁移后可查')
    ok(st2.data.contacts?.['ou_old']?.name === '老名字', '迁移落进 contacts 结构')
    ok(!st2.data.names, '迁移后旧的平铺字段被清掉')

    // 闸门：allowlist 与 listen 并集，单向下放行的是「它的 @」
    const { Bridge } = await import(join(REPO, 'src', 'handler.js'))
    const mkBridge = (feishu) =>
      new Bridge({
        oc: {}, store: st, config: { behavior: {}, feishu },
        transport: {}, capabilities: {},
        logger: { info() {}, warn() {}, error() {} },
      })
    const both = mkBridge({ allowlist: ['ou_human'], listen: ['ou_lilp'] })
    ok(both.isAllowed('ou_human'), 'allowlist 里的个体放行')
    ok(both.isAllowed('ou_lilp'), 'listen 里的个体放行（它的 @ 能到达我）')
    ok(!both.isAllowed('ou_stranger'), '两个名单都没有的个体挡在外面')
    ok(
      mkBridge({ allowlist: [], listen: [] }).isAllowed('ou_anyone') === true,
      '两个名单都空时不限制（与旧行为一致）',
    )
    const listenOnly = mkBridge({ allowlist: ['ou_human'], listen: [] })
    ok(listenOnly.isAllowed('ou_human') && !listenOnly.isAllowed('ou_lilp'), '只配 allowlist 时 listen 不放行')
    // 通讯录里「认识」不等于「许可」：入册了但没进 listen 的，闸门照样挡
    st.learnContact('ou_acquaintance', '只认识')
    ok(
      st.data.contacts['ou_acquaintance'] && !both.isAllowed('ou_acquaintance'),
      '通讯录里认识但没放行的个体，闸门照样挡',
    )

    rmSync(dir, { recursive: true, force: true })
  }

  // 7c. 主表行模型 buildPeople：四源取并集、放行分流、排序
  {
    const { buildPeople, kindBadge } = await import(join(REPO, 'admin', 'entries.js'))
    const people = buildPeople({
      contacts: { ou_a: { name: '小A', kind: 'app', firstSeen: 100 },
                  ou_b: { name: '小B', kind: 'user', firstSeen: 200 } },
      allowlist: ['ou_a'],
      listen: ['ou_c'],
      names: { ou_d: '手写D' },
    })
    const byId = Object.fromEntries(people.map((p) => [p.id, p]))
    ok(people.length === 4, '四个数据源取并集，一个体一行')
    ok(byId.ou_a.allowed && byId.ou_a.allowedVia === 'manual', 'allowlist 里的个体放行来源是手写')
    ok(byId.ou_c.allowed && byId.ou_c.allowedVia === 'listen', 'listen 里的个体放行来源是开关')
    ok(!byId.ou_b.allowed && byId.ou_b.inContacts, '只在通讯录里的个体：认识但放行')
    ok(byId.ou_d.name === '手写D' && byId.ou_d.nameSource === 'cfg' && !byId.ou_d.inContacts, '纯 names 声明也有一行')
    ok(byId.ou_a.nameSource === 'auto' && byId.ou_b.nameSource === 'auto', '通讯录名字标记为自动攒的')
    ok(people[0].id === 'ou_a' && people[1].id === 'ou_c', '放行行置顶，手写先于开关')
    ok(kindBadge('app').label === '机器人' && kindBadge('user').label === '人类', '类型徽章分人/机器人')
    ok(kindBadge('').label === '未知', '没有类型信息时是未知')
    // 与页面内联副本必须等价：页面是给浏览器用的，模块源是给测试用的，
    // 两边漂移就会出现「后台显示的和实际逻辑不同」。用文本断言钉住关键语义
    // （不动态执行页面代码——本地后台也不该在测试里跑任意 JS）
    const html = await import('node:fs').then((fs) =>
      fs.readFileSync(join(REPO, 'admin', 'public', 'index.html'), 'utf8'),
    )
    ok(/function buildPeople\(/.test(html), '页面内联了 buildPeople（与 entries.js 同源）')
    ok(/function kindBadge\(/.test(html), '页面内联了 kindBadge')
    const inlineFn = html.match(/function buildPeople\([\s\S]*?\n\}/)[0]
    ok(inlineFn.includes('allow.has(id)'), '内联副本按 allowlist 判手写放行')
    ok(inlineFn.includes("lis.has(id) ? 'listen'"), '内联副本按 listen 判开关放行')
    ok(inlineFn.includes('rank(a) - rank(b)'), '内联副本用同一套排序规则')
    ok(html.includes('fs-gate-summary'), '页面有闸门摘要行')
    ok(html.includes('当前不限制'), '空表时把闸门真实语义（不限制）说清楚')
    ok(!/\u{1f916}/.test(html), '通讯录不再用 emoji 图标（设计规范禁用）')
  }

  // 8. 页面结构：名字编辑入口必须真的在页面上。
  // 「加白名单只能填 open_id」「名字对照表只读」两个缺陷都出过，这里挡住回归
  ok(indexHtml.includes('id="fs-allow-add-name"'), '白名单添加行有名字输入框')
  ok(indexHtml.includes('id="fs-allow-btn"'), '主表有添加入口')
  ok(indexHtml.includes('id="fs-add-listen"'), '加入时可选择是否放行它唤醒')
  // 四页重构后的新结构（总览摘要/状态行、会话页错误分支、日志页体检结论）
  ok(indexHtml.includes('id="ov-summary"'), '总览页有健康摘要行')
  ok(indexHtml.includes('id="ov-msg"'), '总览页写操作有归一状态行')
  ok(/overviewHealth/.test(indexHtml), '总览页健康判定抽成了可复用函数')
  ok(/renderSummary/.test(indexHtml), '总览页有摘要渲染')
  ok(indexHtml.includes('id="ss-status"'), '会话页有状态行（数据时间/失败原因）')
  ok(indexHtml.includes('id="ss-chats"'), '会话页有飞书绑定表')
  ok(/读不到会话列表/.test(indexHtml), '会话表区分「读不到」与「没有会话」')
  ok(/无法判断有没有卡住的卡片/.test(indexHtml), 'inflight 读取失败不再伪装成空态')
  ok(/超过看门狗阈值/.test(indexHtml), '进行中卡片标注是否超过看门狗阈值')
  ok(indexHtml.includes('id="lg-doctor-summary"'), '体检有结论行')
  ok(/全部通过/.test(indexHtml), '体检结论用中文徽章（全部通过/N 项警告/N 项未通过）')
  ok(indexHtml.includes('id="lg-doctor-raw"'), '体检保留原始输出入口')
  ok(!/lg-instance[^>]*style/.test(indexHtml) || indexHtml.indexOf('id="lg-instance"') > indexHtml.indexOf('id="lg-doctor-card"'), '实例选择器移到体检卡（日志是机器级共享）')
  ok(/所有实例共用同一份日志/.test(indexHtml), '日志页说明所有实例共用日志')
  // opencode 专属组的内容到「工作目录与模型」小节为止，这一片里不该有工作目录字段
  const nOcGroup = indexHtml.slice(indexHtml.indexOf('<div id="n-oc-group">'), indexHtml.indexOf('<h3>工作目录与模型</h3>'))
  ok(
    !nOcGroup.includes('n-defaultDirectory'),
    '新建实例弹窗：默认工作目录不在 opencode 专属组里，pi 后端也能填',
  )
  ok(indexHtml.includes('默认工作目录（两个后端都用'), '配置页标注默认工作目录两个后端都用')
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
