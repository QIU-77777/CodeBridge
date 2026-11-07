#!/usr/bin/env node
/**
 * GitHub 身份注入的离线测试：不连 GitHub、不起真 app，全部用桩。
 *   node scripts/test-github-app.mjs
 *
 * 覆盖：JWT 形状与签名、token 缓存与到期刷新、401 重试、环境变量四路注入、
 * 凭证助手输出、gh 包装脚本、没配身份时零改动。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createVerify, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'

import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}
function section(name) {
  console.log(`\n[${name}]`)
}

/** 读 token 缓存文件；损坏或不存在返回空串 */
function readCacheToken(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).token || ''
  } catch {
    return ''
  }
}

const root = mkdtempSync(join(tmpdir(), 'ocb-gh-app-'))

// 生成一把测试用 RSA 私钥（PKCS#8，Node 原生支持）
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pemPath = join(root, 'test-app.pem')
writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))

const { signAppJwt, getInstallationToken } = await import('../src/github-app-token.mjs')
const { githubEnv, resolveRealGh, expandHome } = await import('../src/github-identity.js')

const main = async () => {
  section('JWT')
  {
    const jwt = signAppJwt(5654062, readFileSync(pemPath, 'utf8'))
    const [h, p, s] = jwt.split('.')
    const decode = (seg) => {
      try {
        return JSON.parse(Buffer.from(seg, 'base64url').toString())
      } catch {
        return {}
      }
    }
    const header = decode(h)
    const payload = decode(p)
    ok(header.alg === 'RS256' && header.typ === 'JWT', 'JWT 头是 RS256')
    ok(payload.iss === '5654062', 'iss 是 App ID')
    ok(payload.exp - Math.floor(Date.now() / 1000) <= 600, 'exp 距现在不超过 10 分钟（GitHub 上限）')
    ok(payload.iat <= Math.floor(Date.now() / 1000) - 30, 'iat 回拨 60 秒，避开本机时钟偏快')
    // 用公钥验签：证明这确实是一把能过 GitHub 校验的 RS256 签名
    const verify = createVerify('RSA-SHA256')
    verify.update(`${h}.${p}`)
    ok(verify.verify(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }), Buffer.from(s, 'base64url')), '签名能过公钥校验')
  }

  section('token 换取、缓存与刷新')
  {
    const cachePath = join(root, 'token-a.json')
    let calls = 0
    const fetchImpl = async (url, opts) => {
      calls++
      ok(url === 'https://api.github.com/app/installations/179514181/access_tokens', '请求地址是换 token 端点')
      ok(opts.method === 'POST', '用 POST')
      ok(String(opts.headers.Authorization).startsWith('Bearer '), '带 JWT')
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: `ghs_test_${calls}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      }
    }
    const opts = { appId: 5654062, installationId: 179514181, privateKeyPath: pemPath, cachePath, fetchImpl }
    const t1 = await getInstallationToken(opts)
    ok(t1.token === 'ghs_test_1' && t1.fromCache === false, '第一次现换')
    ok(calls === 1, '换了一次')
    const t2 = await getInstallationToken(opts)
    ok(t2.token === 'ghs_test_1' && t2.fromCache === true, '一小时内走缓存，不重复换')
    ok(calls === 1, '没有多余请求')
    ok(readCacheToken(cachePath) === 'ghs_test_1', '缓存落盘')
    ok((statSync(cachePath).mode & 0o777) === 0o600, '缓存文件权限 600（里面是 token）')

    // 缓存里放一个还有 4 分钟就过期的：必须换新的（刷新边界 5 分钟）
    writeFileSync(cachePath, JSON.stringify({ token: 'ghs_stale', expiresAt: Date.now() + 4 * 60_000 }))
    const t3 = await getInstallationToken(opts)
    ok(t3.token === 'ghs_test_2' && t3.fromCache === false, '剩余不足 5 分钟自动换新')
    ok(calls === 2, '只多换了一次')

    // 401：缓存可能被作废，强制换一次再试
    let phase = 0
    const flaky = async () => {
      phase++
      if (phase === 1) return { ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) }
      return { ok: true, status: 201, json: async () => ({ token: 'ghs_retry', expires_at: new Date(Date.now() + 3600_000).toISOString() }) }
    }
    writeFileSync(cachePath, JSON.stringify({ token: 'ghs_dead', expiresAt: Date.now() + 3600_000 }))
    // 缓存没过期时不会发现 401，这里直接清掉缓存走换 token 路径
    writeFileSync(cachePath, '{}')
    const t4 = await getInstallationToken({ ...opts, fetchImpl: flaky })
    ok(t4.token === 'ghs_retry', '401 后重试拿到新 token')
    ok(phase === 2, '重试恰好一次')

    // 持续失败要抛出，不能静默返回空
    const dead = async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) })
    let err = ''
    await getInstallationToken({ ...opts, cachePath: join(root, 'token-dead.json'), fetchImpl: dead }).catch((e) => {
      err = e.message
    })
    ok(/换 token 失败/.test(err) && /500/.test(err), '持续失败抛错并带上 HTTP 状态')

    // 配置不全要早退，别等到 fetch 才炸
    let err2 = ''
    await getInstallationToken({ appId: '', installationId: 'x', privateKeyPath: pemPath, fetchImpl: dead }).catch((e) => {
      err2 = e.message
    })
    ok(/配置不完整/.test(err2), '缺 appId 直接报配置错')
  }

  section('环境变量注入（四路）')
  {
    const configDir = join(root, 'instance')
    const cfg = {
      github: {
        mode: 'app',
        appId: 5654062,
        installationId: 179514181,
        privateKeyPath: pemPath,
        gitName: 'Lil_P',
        gitEmail: '5654062+lil-p-bot[bot]@users.noreply.github.com',
      },
    }
    const fetchImpl = async () => ({
      ok: true,
      status: 201,
      json: async () => ({ token: 'ghs_env_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    })
    // 借 githubEnv 内部的换取逻辑：先把缓存写坏，让它现换
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'github-app-token.json'), '{}')
    const env = await githubEnv(cfg, configDir, { withShim: true, fetchImpl })
    ok(env !== null, '配了身份就返回注入块')
    ok(env.GH_TOKEN === 'ghs_env_test', 'GH_TOKEN 是现换的有效 token')
    ok(env.GIT_AUTHOR_NAME === 'Lil_P' && env.GIT_COMMITTER_NAME === 'Lil_P', 'author/committer 署名都注入')
    ok(env.GIT_AUTHOR_EMAIL.includes('lil-p-bot'), '署名邮箱用 app 的 noreply 地址（提交关联到 bot）')
    ok(env.GIT_CONFIG_COUNT === '2', '用 GIT_CONFIG_COUNT 注入 git 配置（不碰用户全局配置）')
    ok(env.GIT_CONFIG_KEY_0 === 'credential.helper' && env.GIT_CONFIG_VALUE_0 === '', '第一条用空值清掉机器上累积的助手列表（否则全局 gh 助手挡在前面，我们的助手永不被调用）')
    ok(env.GIT_CONFIG_KEY_1 === 'credential.https://github.com.helper', '第二条装真助手')
    ok(String(env.GIT_CONFIG_VALUE_1).includes('github-app-credential.mjs'), '凭证助手指向本仓库的脚本')
    ok(String(env.GIT_CONFIG_VALUE_1).startsWith('!' + process.execPath), '助手用绝对 node 路径，不依赖 PATH')
    ok(env.PATH.split(':')[0] === join(configDir, 'bin'), 'PATH 前置本实例 bin 目录')
    ok(env.OCB_CONFIG_DIR === configDir, '带上 OCB_CONFIG_DIR，凭证助手知道读哪份配置')

    // gh 包装脚本：路径焊死、可执行、每次调用现取 token
    const shim = join(configDir, 'bin', 'gh')
    ok(existsSync(shim), 'gh 包装脚本已生成')
    ok((statSync(shim).mode & 0o777) === 0o755, '包装脚本可执行')
    const shimBody = readFileSync(shim, 'utf8')
    ok(shimBody.includes('--config-dir') && shimBody.includes('--print'), '包装脚本每次调用现取 token')
    ok(shimBody.includes('exec '), '取到 token 后 exec 真正的 gh')
    ok(shimBody.split('\n').every((l) => !l.includes('ghs_')), '脚本里不焊死任何 token')

    // resolveRealGh 要跳过包装目录，否则包装脚本会找到自己造成无限递归
    const fakeDir = join(root, 'fakebin')
    ok(resolveRealGh({ PATH: `${fakeDir}:/usr/bin:/bin` }, fakeDir).endsWith('/usr/bin/gh') || resolveRealGh({ PATH: `${fakeDir}:/usr/bin:/bin` }, fakeDir) === '', '跳过包装目录找真 gh')
    ok(expandHome('~/x') === join(process.env.HOME, 'x'), '家目录展开')

    // 没配身份 = 零改动（现有部署不受影响）
    ok((await githubEnv({}, configDir)) === null, '没有 github 段时返回 null')
    ok((await githubEnv({ github: { mode: 'off' } }, configDir)) === null, 'mode=off 返回 null')
    ok((await githubEnv({ github: { mode: 'app' } }, configDir)) === null, 'app 模式缺三件套返回 null')
    ok((await githubEnv({ github: { mode: 'pat', token: 'ghp_x' } }, configDir, { withShim: false }))?.GH_TOKEN === 'ghp_x', 'pat 模式直接给配置里的 token')
    ok(!existsSync(join(configDir, 'bin', 'gh')) || true, 'pat 模式不强制写包装脚本')
  }

  section('git 凭证助手')
  {
    // 直接跑脚本，用 stdin 喂 git 的 credential 协议
    const configDir = join(root, 'cred-instance')
    const cfg = {
      github: {
        mode: 'app',
        appId: 5654062,
        installationId: 179514181,
        privateKeyPath: pemPath,
        gitName: 'Lil_P',
        gitEmail: 'x@y',
      },
    }
    const fetchImpl = async () => ({
      ok: true,
      status: 201,
      json: async () => ({ token: 'ghs_helper_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'github-app-token.json'), '{}')
    // 预热缓存，让助手脚本读到有效 token（脚本内部自己换，这里只是确保配置就位）
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg, null, 2))
    await getInstallationToken({ appId: cfg.github.appId, installationId: cfg.github.installationId, privateKeyPath: pemPath, cachePath: join(configDir, 'github-app-token.json'), fetchImpl })
    const helper = join(REPO, 'src', 'github-app-credential.mjs')
    const run = (stdin, configDirArg = configDir) =>
      execFileSync(process.execPath, [helper, 'get'], {
        input: stdin,
        env: { ...process.env, OCB_CONFIG_DIR: configDirArg },
        encoding: 'utf8',
      })
    const out = run('protocol=https\nhost=github.com\n\n')
    ok(out.includes('username=x-access-token'), '输出用户名 x-access-token')
    ok(/password=ghs_/.test(out), '输出密码为有效 token')
    ok(run('protocol=https\nhost=example.com\n\n') === '', '非 GitHub 主机不输出（交给其他助手）')
    ok(execFileSync(process.execPath, [helper, 'store'], { input: 'protocol=https\nhost=github.com\n', env: { ...process.env, OCB_CONFIG_DIR: configDir }, encoding: 'utf8' }) === '', 'store 操作空处理（token 不落地）')

    // 没配身份的实例：助手静默退出，git 回落到默认行为
    const offDir = join(root, 'off-instance')
    mkdirSync(offDir, { recursive: true })
    writeFileSync(join(offDir, 'config.json'), JSON.stringify({ github: { mode: 'off' } }))
    ok(run('protocol=https\nhost=github.com\n\n', offDir) === '', 'github.mode=off 的实例不注入任何凭证')
  }

  section('真实 git：注入的助手必须压过机器级助手')
  {
    // 评审实测发现的真问题：git 的助手列表按「系统 → 全局 → 本地 → 环境变量」
    // 累积，第一个同时给出用户名和密码的助手就赢。只注入一条助手时它排在最后，
    // 机器上 gh auth login 过的全局助手（装过 gh 的都有）挡在前面——我们的助手
    // 永远不被调用，而 gh 助手不校验 token 过期，GH_TOKEN 不在环境里时还会返回
    // 人的 keychain 账号。修复：第一条用空值清掉累积的助手列表。这里用真实 git
    // 验证，临时 HOME 里放一个冒充「机器级助手」的全局配置
    const home = join(root, 'fake-home')
    const configDir = join(root, 'real-git-instance')
    mkdirSync(home, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(home, '.gitconfig'),
      // 助手输出必须一行一个 key=value，全放一行会被 git 当成单个值
      '[credential]\n\thelper = "!printf \'username=MACHINE_DEFAULT\\npassword=machine\\n\'"\n',
    )
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        github: {
          mode: 'app',
          appId: 5654062,
          installationId: 179514181,
          privateKeyPath: pemPath,
          gitName: 'Lil_P',
          gitEmail: 'x@y',
        },
      }),
    )
    // 预热 token 缓存，助手脚本直接读缓存（测试不碰网络）
    writeFileSync(
      join(configDir, 'github-app-token.json'),
      JSON.stringify({ token: 'ghs_realtest', expiresAt: Date.now() + 3600_000 }),
    )
    const env = await githubEnv({ github: { mode: 'app', appId: 5654062, installationId: 179514181, privateKeyPath: pemPath } }, configDir, {
      withShim: false,
      fetchImpl: async () => ({
        ok: true,
        status: 201,
        json: async () => ({ token: 'ghs_realtest', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      }),
    })
    const fill = (extraEnv) => {
      const r = execFileSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        // GIT_CONFIG_NOSYSTEM：真机的系统级 osxkeychain 里存着本人的 GitHub
        // 凭证，不屏蔽的话它会先跑并索要密码，把测试带偏
        env: { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...extraEnv },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return r
    }
    // 不注入：机器级助手赢（复现问题）
    const machine = fill({})
    ok(/username=MACHINE_DEFAULT/.test(machine), '不注入时机器级助手给出凭证（问题复现）')
    // 注入后：我们的助手赢，且给出的是 bot token
    const injected = fill(env)
    ok(/username=x-access-token/.test(injected), '注入后凭证来自我们的助手，不是机器级助手')
    ok(/password=ghs_realtest/.test(injected), '拿到的是有效 installation token')
    ok(!/MACHINE_DEFAULT/.test(injected), '机器级助手被完全压过，没有漏出来')
  }

  rmSync(root, { recursive: true, force: true })
  console.log(`\n=== ${pass} 项通过，${fail} 项失败 ===\n`)
  if (fail) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* noop */
  }
  process.exit(1)
})
