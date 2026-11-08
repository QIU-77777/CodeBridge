#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadConfig, writeExampleConfig, CONFIG_PATH, CONFIG_DIR } from './config.js'
import { Store } from './store.js'
import { createBackend, capabilitiesFor } from './backend.js'
import { Bridge } from './handler.js'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry') || argv.includes('-d')
const LOCK_PATH = join(CONFIG_DIR, 'bridge.lock')

/** 单实例锁：重复启动会导致同一条消息被回两遍 */
function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    const old = Number(readFileSync(LOCK_PATH, 'utf8').trim())
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0)
        console.error(`
❌ 已有一个桥接进程在运行 (pid ${old})
   同一条消息被两个实例收到会重复回复。
   先停掉: ./scripts/down.sh   或   kill ${old}
`)
        process.exit(1)
      } catch {
        // 进程已不存在，接管锁
      }
    }
  }
  mkdirSync(dirname(LOCK_PATH), { recursive: true })
  writeFileSync(LOCK_PATH, String(process.pid), 'utf8')
  const release = () => {
    try {
      if (existsSync(LOCK_PATH) && readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) {
        unlinkSync(LOCK_PATH)
      }
    } catch {
      /* noop */
    }
  }
  process.on('exit', release)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

// ---------- 终端卡片渲染（dry 模式用） ----------
function cardToText(card) {
  const out = []
  const title = card?.header?.title?.content
  if (title) out.push(`┌─ ${title}`)
  // 兼容 card 2.0（body.elements）与 1.0（根级 elements）
  for (const el of card?.body?.elements || card?.elements || []) {
    if (el.tag === 'div' && el.text?.content) {
      out.push('│ ' + el.text.content.split('\n').join('\n│ '))
    } else if (el.tag === 'markdown' && el.content) {
      out.push('│ ' + el.content.split('\n').join('\n│ '))
    } else if (el.tag === 'table') {
      const cols = (el.columns || []).map((c) => c.display_name).join(' | ')
      out.push('│ ' + cols)
      out.push('│ ' + '-'.repeat(Math.min(cols.length, 60)))
      for (const r of el.rows || []) {
        out.push('│ ' + (el.columns || []).map((c) => r[c.name] ?? '').join(' | '))
      }
    } else if (el.tag === 'hr') {
      out.push('├' + '─'.repeat(40))
    } else if (el.tag === 'button') {
      out.push('│ [' + (el.text?.content || '按钮') + ']')
    } else if (el.tag === 'action') {
      const btns = (el.actions || []).map((b) => `[${b.text?.content}]`).join(' ')
      out.push('│ ' + btns)
    } else if (el.tag === 'note') {
      out.push('│ ' + (el.elements || []).map((e) => e.content).join(' '))
    } else if (el.tag === 'column_set') {
      const cells = (el.columns || []).map((c) =>
        (c.elements || [])
          .map((e) => (e.tag === 'button' ? `[${e.text?.content}]` : e.text?.content ? e.text.content.replace(/\n/g, ' ') : ''))
          .filter(Boolean)
          .join(' '),
      )
      out.push('│ ' + cells.filter(Boolean).join('  '))
    }
  }
  out.push('└' + '─'.repeat(40))
  return out.join('\n')
}

class DryTransport {
  constructor() {
    this.cards = new Map()
    this.seq = 0
  }
  async sendCard(chatId, card) {
    const id = `dry-${++this.seq}`
    this.cards.set(id, card)
    process.stdout.write('\n' + cardToText(card) + '\n')
    return id
  }
  async patchCard(messageId, card) {
    if (!this.cards.has(messageId)) return false
    this.cards.set(messageId, card)
    process.stdout.write('\n[卡片更新 #' + messageId + ']\n' + cardToText(card) + '\n')
    return true
  }
  async sendText(chatId, text) {
    process.stdout.write(`\n💬 ${text}\n`)
    return `dry-text-${++this.seq}`
  }
}

function printBanner(cfg, caps) {
  const backendLine =
    caps.type === 'opencode'
      ? `  opencode : ${cfg.opencode.url}`
      : `  ${caps.label}     : ${cfg.backend.pi.bin}${cfg.backend.pi.model ? ` (${cfg.backend.pi.model})` : ''}`
  console.log(`
┌──────────────────────────────────────────────┐
│  ${caps.label} ⇄ 飞书 桥接${DRY ? '（dry 模式：不连飞书）' : '                        '}│
└──────────────────────────────────────────────┘
${backendLine}
  配置     : ${CONFIG_PATH}
  默认目录 : ${cfg.opencode.defaultDirectory}
`)
}

async function main() {
  // 首次运行生成配置示例
  const created = writeExampleConfig()

  const cfg = loadConfig()

  if (!DRY) acquireLock()

  if (!DRY && (!cfg.feishu.appId || !cfg.feishu.appSecret || cfg.feishu.appId.includes('xxxx'))) {
    console.error(`
❌ 还没配置飞书应用凭证。
   配置文件：${CONFIG_PATH}
${created ? '   已为你生成模板，请填入 appId / appSecret。\n' : '   请填写 feishu.appId 和 feishu.appSecret。\n'}
   步骤见 README.md「创建飞书应用」一节。
`)
    process.exit(1)
  }

  const caps = capabilitiesFor(cfg)
  printBanner(cfg, caps)

  const store = new Store()
  const oc = createBackend(cfg)
  const transport = DRY ? new DryTransport() : null

  const bridge = new Bridge({ oc, store, config: cfg, transport, capabilities: caps })

  // 健康检查。opencode 是连 HTTP 服务，pi 是确认 CLI 能跑起来。
  try {
    const h = await oc.health()
    console.log(`✅ ${caps.label} 后端就绪，版本 ${h.version || '?'}`)
  } catch (err) {
    if (caps.type === 'opencode') {
      const auth = /401|认证/.test(err.message || '')
      console.error(`❌ 连不上 opencode serve (${cfg.opencode.url}): ${err.message}`)
      if (auth) {
        // 认证失败时 serve 是活着的，让人去「启动」它会把排查带偏。真正的
        // 成因是密码不一致：serve 启动时把密码定格在进程环境里，之后改配置
        // 不会跟着变，重启 serve 才能让两边重新一致
        console.error('   serve 在跑，但两边密码不一致。重启 serve 让配置里的密码生效：')
        console.error('   launchctl kickstart -k gui/$(id -u)/ai.qiguang.ocbridge.serve')
        console.error(`   配置里的 opencode.password：${cfg.opencode.password ? '已填写' : '为空'}`)
      } else {
        console.error('   请先启动：opencode serve --port 19876 --hostname 127.0.0.1')
      }
    } else {
      console.error(`❌ ${caps.label} 后端不可用: ${err.message}`)
      console.error(`   检查 backend.pi.bin 指向的 CLI 是否存在、能否执行。`)
    }
    process.exit(1)
  }

  if (DRY) {
    await bridge.start()
    const chatId = 'dry-chat'
    store.set(chatId, { directory: cfg.opencode.defaultDirectory })
    console.log('输入消息开始（/help 看命令，/quit 退出）。dry 模式下所有卡片直接打到终端。\n')

    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '飞书> ' })
    rl.prompt()
    rl.on('line', async (line) => {
      const text = line.trim()
      if (!text) return rl.prompt()
      if (text === '/quit' || text === '/exit') {
        rl.close()
        return
      }
      rl.pause()
      try {
        await bridge.onMessage({ chatId, userId: 'dry-user', text, messageId: `dry-msg-${Date.now()}` })
      } catch (err) {
        console.error('❌ ' + err.message)
      }
      rl.resume()
      rl.prompt()
    })
    rl.on('close', () => {
      bridge.stop()
      store.flush()
      process.exit(0)
    })
    return
  }

  // ---------- 正式模式 ----------
  const { FeishuTransport } = await import('./feishu.js')
  const ft = new FeishuTransport(cfg, {
    onMessage: (msg) => bridge.onMessage(msg),
    onCardAction: (ctx) => bridge.onCardAction(ctx),
    nameOf: (id) => bridge.nameOf(id),
    // 身份声明按后端给文案：pi 后端的桥接会注入本实例凭证，opencode 不会
    backendType: caps.type,
  })
  bridge.t = ft

  await bridge.start()
  await ft.start()

  console.log('✅ 桥接已就绪，去飞书里给机器人发消息吧。\n')

  const shutdown = async () => {
    console.log('\n正在退出…')
    bridge.stop()
    store.flush()
    await ft.stop().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('启动失败: ' + (err?.stack || err))
  process.exit(1)
})
