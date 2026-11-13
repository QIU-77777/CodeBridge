/**
 * 本地 coding agent 扫描。
 *
 * 配置流程的第一步：把本机装了哪些受支持的 coding agent 扫出来，用户在页面里
 * 只做选择，不用猜有没有装、装在哪。后端清单因此不再是写死的两个单选项，
 * 而是带可用性、版本与解析路径的数据。
 *
 * 探测各自复用既有实现，不写第二套：
 *   - opencode：src/which-opencode.js 的 resolveOpencode——桌面版 OpenCode.app
 *     自带的 CLI 优先（与桌面版共用一个数据库），PATH 兜底；
 *   - pi：admin/instances.js 的 resolveBin 覆盖常见用户 bin 目录，PATH 扫描
 *     兜底。两者合起来才覆盖「装在任意位置」的真实情况。
 *
 * 版本号起一次 `--version` 拿，5 秒超时；拿不到版本不改变可用性判定——
 * 能跑但报不出版本的 CLI 仍然是能跑的。
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveOpencode, SOURCE_LABEL } from '../src/which-opencode.js'
import { resolveBin, USER_BIN_DIRS } from './instances.js'

/** 受支持的后端。顺序即页面选项顺序 */
const SCANNERS = {
  opencode: scanOpencode,
  pi: scanPi,
}

const BACKEND_META = {
  opencode: { summary: '常驻 serve，流式输出' },
  pi: { summary: '长驻 RPC 进程，流式输出，支持 steer' },
}

/** 起一次 `bin --version`，超时或失败返回空串 */
function versionOf(bin, timeoutMs = 5000) {
  return new Promise((res) => {
    let out = ''
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        res(v)
      }
    }
    try {
      const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        p.kill()
        done('')
      }, timeoutMs)
      p.stdout?.on('data', (d) => {
        out += d.toString()
      })
      p.on('error', () => {
        clearTimeout(timer)
        done('')
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) return done('')
        const m = out.match(/(\d+\.\d+\.\d+[-\w.]*)/)
        done(m ? m[1] : out.trim().split('\n')[0] || '')
      })
    } catch {
      done('')
    }
  })
}

function isExecutable(p) {
  try {
    return existsSync(p) && (statSync(p).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** PATH 里找可执行文件。resolveBin 只覆盖常见用户 bin 目录，这里补上 PATH */
function whichOnPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(':').filter(Boolean)) {
    const full = join(dir, name)
    if (isExecutable(full)) return full
  }
  return null
}

async function scanOpencode() {
  const hit = resolveOpencode()
  if (!hit) {
    return {
      type: 'opencode',
      available: false,
      bin: '',
      version: '',
      detail: '',
      reason: '本机没有 opencode：桌面版 OpenCode.app 自带的 CLI 和 PATH 里都没有。装上桌面版，或在启动环境里给出 CLI 路径',
    }
  }
  return {
    type: 'opencode',
    available: true,
    bin: hit.bin,
    version: hit.version || (await versionOf(hit.bin)),
    detail: SOURCE_LABEL[hit.source] || hit.source,
    reason: '',
  }
}

async function scanPi() {
  const fromBinDirs = resolveBin('pi')
  const bin = fromBinDirs || whichOnPath('pi')
  if (!bin) {
    return {
      type: 'pi',
      available: false,
      bin: '',
      version: '',
      detail: '',
      reason: `本机没有 pi：PATH 与这些目录都没有（${USER_BIN_DIRS.join('、')}）。装在别处就把绝对路径填进 backend.pi.bin`,
    }
  }
  return {
    type: 'pi',
    available: true,
    bin,
    version: await versionOf(bin),
    detail: fromBinDirs ? '常见用户 bin 目录' : 'PATH 里的 pi',
    reason: '',
  }
}

/**
 * 扫本机受支持的 coding agent。页面打开配置页与新建弹窗时调用。
 * 代价是两次 `--version`（各自 5 秒超时），通常一秒内完成。
 *
 * @returns {Promise<Array<{type:string,summary:string,available:boolean,bin:string,version:string,detail:string,reason:string}>>}
 */
export async function scanBackends() {
  const out = []
  for (const type of Object.keys(SCANNERS)) {
    out.push({ ...BACKEND_META[type], ...(await SCANNERS[type]()) })
  }
  return out
}
