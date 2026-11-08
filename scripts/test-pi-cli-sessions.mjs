#!/usr/bin/env node
/**
 * 桥接进终端 pi 会话的离线测试：不跑真模型，全用桩。
 *   node scripts/test-pi-cli-sessions.mjs
 *
 * 背景：桥接自建的会话在 <CONFIG_DIR>/pi-sessions 平铺存放，人类在终端
 * `pi -r` 看到的会话在 ~/.pi/agent/sessions/<按目录编码>/ 下，两处原本
 * 互不可见。本测试覆盖把终端会话接进桥接的整条链路：扫描发现、列表合并、
 * getSession 回退、/switch 后续聊走 --session <file>、以及改名/删除/切模型
 * 的明确拒绝（那些是终端 pi 的地盘）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiBackend } from '../src/pi.js'
import { sessionsCard } from '../src/cards.js'
import { Bridge } from '../src/handler.js'
import { Store } from '../src/store.js'

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
function section(name) {
  console.log(`\n[${name}]`)
}

const root = mkdtempSync(join(tmpdir(), 'ocb-pi-cli-'))
const sessionDir = join(root, 'pi-sessions')
const cliRoot = join(root, 'cli-sessions')
const REPO_DIR = '/Users/tester/repo'
const OTHER_DIR = '/Users/tester/other'

const cfg = {
  backend: { type: 'pi', pi: { bin: 'pi', model: 'deepseek/deepseek-v4-pro', timeoutMs: 5000, extraArgs: [], cliSessionRoot: cliRoot } },
  feishu: {},
  opencode: { url: 'http://127.0.0.1:19876', password: '', defaultDirectory: REPO_DIR, defaultModel: '' },
  behavior: {},
}

/** 终端目录名的编码规则（/ → -，前后加 --）。只用于造测试数据 */
const mangle = (dir) => `--${dir.replace(/\//g, '-')}--`

/** 造一个终端会话文件。big 为真时在前面塞一条超长 system 行 */
function writeCliSession({ dir, id, title, ts = '2026-11-08T06-22-20-122Z', big = false }) {
  const d = join(cliRoot, mangle(dir))
  mkdirSync(d, { recursive: true })
  const file = join(d, `${ts}_${id}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: ts, cwd: dir }),
    JSON.stringify({ type: 'model_change', id: 'm1', parentId: null, timestamp: ts, provider: 'stepfun-platform', modelId: 'step-5-preview' }),
    JSON.stringify({ type: 'thinking_level_change', id: 't1', parentId: 'm1', timestamp: ts, thinkingLevel: 'medium' }),
  ]
  if (big) {
    // 复现真实形态：system 行带整份 AGENTS.md，能到几百 KB
    lines.push(JSON.stringify({ type: 'message', id: 'sys1', parentId: 't1', timestamp: ts, message: { role: 'system', content: 'x'.repeat(600 * 1024) } }))
  }
  lines.push(JSON.stringify({ type: 'message', id: 'u1', parentId: 't1', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: title }] } }))
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

/** 最小假子进程：不输出任何东西，立刻以 0 退出 */
function fakeSpawn(bin, args, opts) {
  fakeSpawn.calls.push({ bin, args, opts })
  const child = {
    stdout: { on() {} },
    stderr: { on() {} },
    pid: 424242,
    on(ev, cb) {
      if (ev === 'exit') setTimeout(() => cb(0), 0)
      return this
    },
    kill() {},
    unref() {},
  }
  return child
}
fakeSpawn.calls = []

function makeBackend(patch = {}) {
  const { cfgPatch, ...rest } = patch
  return new PiBackend({
    cfg: { ...cfg, ...cfgPatch },
    sessionDir,
    spawnImpl: fakeSpawn,
    logger: { warn() {}, info() {} },
    ...rest,
  })
}

try {
  section('扫描终端会话')
  {
    writeCliSession({ dir: REPO_DIR, id: '11111111-aaaa-bbbb-cccc-000000000001', title: '看一下这个项目目录下有其他会话记录吗' })
    writeCliSession({ dir: REPO_DIR, id: '22222222-aaaa-bbbb-cccc-000000000002', title: '搜一下上海11月有什么展', ts: '2026-11-08T13-00-00-000Z' })
    writeCliSession({ dir: OTHER_DIR, id: '33333333-aaaa-bbbb-cccc-000000000003', title: '别的目录的会话' })

    const b = makeBackend()
    const s = await b.getSession('11111111-aaaa-bbbb-cccc-000000000001')
    ok(!!s, 'getSession 找得到终端会话')
    ok(s.location?.directory === REPO_DIR, '目录来自 jsonl 头部的 cwd', s.location?.directory)
    ok(s.title === '看一下这个项目目录下有其他会话记录吗', '标题是第一条 user 消息', s.title)
    ok(s.model?.id === 'step-5-preview', '模型来自 model_change 行', JSON.stringify(s.model))
    ok(s.file?.endsWith('.jsonl'), '带上会话文件路径（续聊要用）')
    ok(s.cli === true, '带 cli 标记（列表卡片据此显示「终端」）')
    ok(s.time?.updated > 0, 'updated 来自文件 mtime')

    let threw = ''
    try {
      await b.getSession('nope-not-here')
    } catch (err) {
      threw = err.message
    }
    ok(/不存在/.test(threw), '不存在的 id 照旧报错', threw)
  }

  section('列表合并与排序')
  {
    const b = makeBackend()
    // 桥接自建一个会话，index.json 里应该有它
    await b.createSession({ title: '桥接项目-pi进程', directory: REPO_DIR })
    const all = await b.listSessions({ limit: '100', force: true })
    ok(all.some((s) => s.title === '桥接项目-pi进程'), '列表含桥接自建会话')
    ok(all.some((s) => s.id === '11111111-aaaa-bbbb-cccc-000000000001'), '列表含终端会话')
    ok(all.every((s) => s.id), '每个条目都有 id')
    const repo = all.filter((s) => s.location?.directory === REPO_DIR)
    ok(repo.length === 3, 'repo 目录下共 3 个会话（1 桥接 + 2 终端）', String(repo.length))
    const upd = all.map((s) => s.time.updated)
    ok(upd.every((v, i) => i === 0 || upd[i - 1] >= v), '按更新时间倒序')
    const withSearch = await b.listSessions({ limit: '100', search: '上海', force: true })
    ok(withSearch.length === 1 && withSearch[0].title.includes('上海'), 'search 对终端会话也生效')
  }

  section('扫描缓存与强制刷新')
  {
    const b = makeBackend()
    await b.listSessions({ limit: '100', force: true })
    writeCliSession({ dir: REPO_DIR, id: '44444444-aaaa-bbbb-cccc-000000000004', title: '刚在终端建的会话', ts: '2026-11-09T01-00-00-000Z' })
    const cached = await b.listSessions({ limit: '100' })
    ok(!cached.some((s) => s.id === '44444444-aaaa-bbbb-cccc-000000000004'), '缓存期内不重复扫盘')
    const fresh = await b.listSessions({ limit: '100', force: true })
    ok(fresh.some((s) => s.id === '44444444-aaaa-bbbb-cccc-000000000004'), 'force 刷新后新会话出现')
  }

  section('头部截断：超长 system 行')
  {
    writeCliSession({ dir: REPO_DIR, id: '55555555-aaaa-bbbb-cccc-000000000005', title: '标题在 512KB 之外', big: true })
    const b = makeBackend()
    const found = b._scanCliSessions({ force: true }).get('55555555-aaaa-bbbb-cccc-000000000005')
    ok(!!found, '超长 system 行的会话仍能识别')
    ok(found?.location?.directory === REPO_DIR, 'id 与 cwd 在文件第一行，不受截断影响')
    ok(found?.title === '(无标题)', '标题被截掉时降级，不崩', found?.title)
  }

  section('续聊：argv 走 --session <file>')
  {
    const b = makeBackend()
    fakeSpawn.calls = []
    await b.prompt('11111111-aaaa-bbbb-cccc-000000000001', '继续上一轮')
    const call = fakeSpawn.calls[fakeSpawn.calls.length - 1]
    const a = call.args
    ok(a.includes('--session'), '终端会话用 --session 指定文件')
    ok(a[a.indexOf('--session') + 1].endsWith('11111111-aaaa-bbbb-cccc-000000000001.jsonl'), '传的是那个会话的 jsonl 路径')
    ok(!a.includes('--session-id'), '不再传 --session-id（平铺目录里找不到它）')
    ok(!a.includes('--session-dir'), '不再传 --session-dir')
    ok(a.includes('--model') && a[a.indexOf('--model') + 1] === 'stepfun-platform/step-5-preview', '模型按会话里用过的传，保持连续')
    ok(call.opts.cwd === REPO_DIR, '子进程 cwd 是会话自己的目录', String(call.opts.cwd))

    // 桥接自建会话的 argv 必须原样不动
    const created = await b.createSession({ title: 'argv 对照', directory: REPO_DIR })
    fakeSpawn.calls = []
    await b.prompt(created.id, '你好')
    const call2 = fakeSpawn.calls[fakeSpawn.calls.length - 1]
    ok(call2.args.includes('--session-id') && call2.args[call2.args.indexOf('--session-id') + 1] === created.id, '桥接会话仍走 --session-id')
    ok(call2.args.includes('--session-dir'), '桥接会话仍带 --session-dir')
    ok(!call2.args.includes('--session'), '桥接会话不传 --session')
  }

  section('终端会话的写操作被明确拒绝')
  {
    const b = makeBackend()
    const cliId = '11111111-aaaa-bbbb-cccc-000000000001'
    let msg = ''
    try {
      await b.renameSession(cliId, '新标题')
    } catch (err) {
      msg = err.message
    }
    ok(/终端 pi/.test(msg), '改名被拒并说明原因', msg)
    msg = ''
    try {
      await b.deleteSession(cliId)
    } catch (err) {
      msg = err.message
    }
    ok(/终端 pi/.test(msg), '删除被拒并说明原因', msg)
    msg = ''
    try {
      await b.switchModel(cliId, { id: 'x', providerID: 'y' })
    } catch (err) {
      msg = err.message
    }
    ok(/终端 pi/.test(msg), '切模型被拒并说明原因', msg)
    // 桥接会话的写操作照旧
    const created = await b.createSession({ title: '可改', directory: REPO_DIR })
    const renamed = await b.renameSession(created.id, '改过了')
    ok(renamed.title === '改过了', '桥接会话改名正常')
    ok((await b.deleteSession(created.id)) === true, '桥接会话删除正常')
  }

  section('卡片：终端会话带标记')
  {
    const b = makeBackend()
    const all = await b.listSessions({ limit: '100', force: true })
    const card = sessionsCard({ sessions: all.filter((s) => s.location?.directory === REPO_DIR), currentId: '', directory: REPO_DIR })
    const text = JSON.stringify(card)
    ok(text.includes('终端'), '列表卡片显示「终端」标记')
    ok(text.includes('看一下这个项目目录下有其他会话记录吗'), '卡片带终端会话标题')
  }

  section('端到端：/switch 之后发消息真的续在终端文件上')
  {
    const store = new Store(join(root, 'state.json'))
    const b = makeBackend()
    const sent = []
    const transport = {
      sendCard: async (_chat, card) => {
        sent.push(card)
        return 'card-1'
      },
      sendText: async (_chat, text) => {
        sent.push({ text })
        return 'msg-1'
      },
      patchCard: async () => {},
    }
    const bridge = new Bridge({
      oc: b,
      store,
      config: { ...cfg },
      transport,
      capabilities: { type: 'pi', label: 'pi' },
      logger: { info() {}, warn() {}, error() {} },
    })
    const key = 'chat-cli-e2e'
    const cliId = '11111111-aaaa-bbbb-cccc-000000000001'
    store.set(key, { sessionId: cliId, directory: REPO_DIR, chatId: key, replyTo: 'r1' })
    fakeSpawn.calls = []
    await bridge.onMessage({ chatId: key, userId: 'ou_x', text: '帮我看一下这个会话', messageId: 'm-e2e', chatType: 'p2p' })
    const call = fakeSpawn.calls[fakeSpawn.calls.length - 1]
    ok(call?.args.includes('--session'), '桥接层发消息也走 --session <file>')
    ok(call?.opts.cwd === REPO_DIR, '桥接层 spawn 的 cwd 是终端会话的目录')
    ok(sent.length > 0, '执行卡片照常发出')
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
