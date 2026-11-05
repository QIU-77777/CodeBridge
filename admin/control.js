/**
 * 实例控制：起停、体检、日志。
 *
 * 起停不写平行的进程管理，全部转调仓库既有的 scripts/up.sh 与 down.sh，
 * 带上对应实例的 OCB_CONFIG_DIR 与 OCB_INSTANCE。这样 launchd 托管和 pid
 * 文件两条路、单实例锁语义、serve 密码对齐，全都走脚本里已经验证过的逻辑，
 * admin 不做 second implementation。
 */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
// 实例环境变量从 instances.js 导入，不在这里写第二份：两份实现迟早会漂移
import { instanceEnv } from './instances.js'

const REPO = resolve(fileURLToPath(import.meta.url), '../..')
const LOG_DIR = join(REPO, 'logs')

function runScript(script, env, timeoutMs = 90_000) {
  return new Promise((res) => {
    const p = spawn('bash', [join(REPO, 'scripts', script)], {
      cwd: REPO,
      env: { ...process.env, ...env },
    })
    let out = ''
    const onData = (d) => {
      // 脚本输出里可能出现整份配置的回显，截断保留尾部即可，不做全文落库
      out += d.toString()
      if (out.length > 8000) out = out.slice(-8000)
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    const timer = setTimeout(() => {
      p.kill('SIGTERM')
      res({ code: -1, output: out + '\n[admin] 超过 90 秒未结束，已终止' })
    }, timeoutMs)
    p.on('close', (code) => {
      clearTimeout(timer)
      res({ code, output: out })
    })
    p.on('error', (err) => {
      clearTimeout(timer)
      res({ code: -1, output: `启动脚本失败: ${err.message}` })
    })
  })
}

function runDoctor(env) {
  return runScript('doctor.mjs', env, 120_000)
}

export function startInstance(name, dir) {
  return runScript('up.sh', instanceEnv(name, dir))
}

export function stopInstance(name, dir) {
  return runScript('down.sh', instanceEnv(name, dir))
}

export async function restartInstance(name, dir) {
  const down = await stopInstance(name, dir)
  const up = await startInstance(name, dir)
  return { down, up, code: up.code }
}

export function doctor(name, dir) {
  // doctor.mjs 是 node 脚本，借 bash 跑不起来，直接 node 调
  return new Promise((res) => {
    const p = spawn(process.execPath, [join(REPO, 'scripts', 'doctor.mjs')], {
      cwd: REPO,
      env: { ...process.env, ...instanceEnv(name, dir) },
    })
    let out = ''
    const onData = (d) => {
      out += d.toString()
      if (out.length > 16_000) out = out.slice(-16_000)
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    const timer = setTimeout(() => {
      p.kill('SIGTERM')
      res({ code: -1, output: out + '\n[admin] 体检超过 120 秒未结束，已终止' })
    }, 120_000)
    p.on('close', (code) => {
      clearTimeout(timer)
      res({ code, output: out })
    })
    p.on('error', (err) => {
      clearTimeout(timer)
      res({ code: -1, output: `启动体检失败: ${err.message}` })
    })
  })
}

const LOG_FILES = { bridge: 'bridge.log', serve: 'serve.log' }

/**
 * 日志增量读取。since 是字节偏移：返回该偏移之后的新内容与文件当前大小，
 * 页面按两秒一轮持续拉取，实现近实时跟随，不用 WebSocket。
 */
export function readLog(file, since = 0) {
  const name = LOG_FILES[file]
  if (!name) return { error: '未知日志文件，只支持 bridge 与 serve' }
  const path = join(LOG_DIR, name)
  if (!existsSync(path)) return { exists: false, size: 0, chunk: '' }
  const size = statSync(path).size
  const from = Math.max(0, Math.min(Number(since) || 0, size))
  const chunk = from >= size ? '' : readFileSync(path).subarray(from, size).toString('utf8')
  return { exists: true, size, chunk }
}
