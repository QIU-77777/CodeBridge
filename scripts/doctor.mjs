#!/usr/bin/env node
/**
 * 环境体检：不连飞书，只检查本地依赖与配置是否就绪。
 * 用法: npm run doctor
 */
import { existsSync } from 'node:fs'
import { loadConfig, CONFIG_PATH, STATE_PATH } from '../src/config.js'
import { OpencodeClient } from '../src/oc.js'
import { Store } from '../src/store.js'
import { resolveOpencode, SOURCE_LABEL } from '../src/which-opencode.js'

const line = (s = '') => console.log(s)
const okMark = '✅'
const badMark = '❌'
const warnMark = '⚠️ '

let problems = 0
const problem = (msg) => {
  problems++
  line(`   ${badMark} ${msg}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** serve 刚起来时 plugin 还在激活，/api/model 会返回 503，等一会儿 */
async function withRetry(fn, times = 20) {
  for (let i = 0; i < times; i++) {
    try {
      return await fn()
    } catch (err) {
      if (!/503/.test(err.message) || i === times - 1) throw err
      await sleep(1000)
    }
  }
}

async function main() {
  line('\n=== opencode ⇄ 飞书 桥接 环境体检 ===\n')

  // 1. Node
  line('[Node]')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) problem(`Node ${process.versions.node} 太旧，需要 >= 20`)
  else line(`   ${okMark} Node ${process.versions.node}`)

  // 2. 配置
  line('\n[配置]')
  const cfg = loadConfig()
  if (!existsSync(CONFIG_PATH)) {
    problem(`配置文件不存在: ${CONFIG_PATH}（运行一次 npm start 会生成模板）`)
  } else {
    line(`   ${okMark} ${CONFIG_PATH}`)
  }

  const appId = cfg.feishu.appId || ''
  if (!appId || appId.includes('xxxx')) {
    problem('feishu.appId 未填写')
  } else if (!/^cli_[a-zA-Z0-9]+$/.test(appId)) {
    problem(`feishu.appId 格式可疑: ${appId}（应为 cli_ 开头）`)
  } else {
    line(`   ${okMark} appId ${appId.slice(0, 8)}…`)
  }

  const secret = cfg.feishu.appSecret || ''
  if (!secret || secret.includes('xxxx')) problem('feishu.appSecret 未填写')
  else line(`   ${okMark} appSecret 已填写（${secret.length} 字符）`)

  if (!cfg.feishu.allowlist?.length) {
    line(`   ${warnMark} allowlist 为空 = 任何人私聊机器人都能操作你本机的 opencode`)
    line(`      建议填入自己的 open_id，拿到方法：给机器人发消息后看控制台日志里的 userId，或看下方排障一节`)
  } else {
    line(`   ${okMark} allowlist ${cfg.feishu.allowlist.length} 个用户`)
  }

  // 3. opencode
  line('\n[opencode serve]')
  const picked = resolveOpencode()
  if (picked) {
    line(`   ${okMark} 将用 ${SOURCE_LABEL[picked.source]} v${picked.version || '?'}`)
    line(`      ${picked.bin}`)
  } else {
    problem('没找到 opencode（桌面版没装、PATH 里也没有）')
    line('      装桌面版 OpenCode.app，或用 OPENCODE_BIN 指定一个')
  }

  const oc = new OpencodeClient({ url: cfg.opencode.url, password: cfg.opencode.password, logger: { warn: () => {} } })
  let healthy = false
  try {
    const h = await oc.health()
    healthy = true
    line(`   ${okMark} ${cfg.opencode.url} v${h.version} pid=${h.pid}`)
    // 两个版本共用一个数据库会出 schema 漂移，版本一致是这里最该守住的一条
    if (picked?.version && h.version && picked.version !== h.version) {
      line(`   ${warnMark} serve 的 v${h.version} 和本地 CLI 的 v${picked.version} 不一致`)
      line('      两个版本写同一个 ~/.local/share/opencode/opencode.db，容易新旧互不兼容')
      line('      建议 ./scripts/down.sh 后用 ./scripts/up.sh 重起，让它用同一份二进制')
    }
  } catch (err) {
    if (err.status === 401) {
      problem(`连上了但认证失败：检查 opencode.password 是否与启动 serve 时的 OPENCODE_SERVER_PASSWORD 一致`)
      line(`      当前密码字段: ${cfg.opencode.password ? '已设置' : '为空'}`)
      line(`      serve 启动时会打印 "server password xxx"，或自己指定 OPENCODE_SERVER_PASSWORD`)
    } else {
      problem(`连不上 ${cfg.opencode.url}: ${err.message}`)
      line(`      启动: ./scripts/up.sh（会自动选本地 CLI 并设好密码）`)
    }
  }

  if (healthy) {
    try {
      const models = await withRetry(() => oc.listModels())
      line(`   ${okMark} 可用模型 ${models.length} 个`)

      const want = cfg.opencode.defaultModel
      if (want) {
        const [pid, ...rest] = want.split('/')
        const id = rest.join('/')
        const found = models.find((m) => m.providerID === pid && m.id === id)
        if (!found) problem(`defaultModel "${want}" 不在模型列表里`)
        else line(`   ${okMark} defaultModel ${want}`)
      } else {
        const def = await withRetry(() => oc.defaultModel()).catch(() => null)
        line(`   ${warnMark} defaultModel 未指定，将使用 opencode 默认：${def ? def.providerID + '/' + def.id : '未知'}`)
        if (def && /free$/.test(def.id)) {
          line(`      注意：*-free 模型在中国大陆常报 RegionError，建议在配置里设 defaultModel`)
          line(`      例如: "stepfun-step-plan/step-3.5-flash"`)
        }
      }

      const agents = await withRetry(() => oc.listAgents())
      line(`   ${okMark} Agent: ${agents.map((a) => a.id).join(', ')}`)

      const loc = await oc.location().catch(() => null)
      if (loc) line(`   ${okMark} serve 工作目录 ${loc.directory}`)
    } catch (err) {
      problem(`枚举模型/agent 失败: ${err.message}`)
    }
  }

  // 4. 状态文件
  line('\n[本地状态]')
  if (existsSync(STATE_PATH)) {
    const s = new Store(STATE_PATH)
    const chats = s.all().filter((c) => c.sessionId)
    line(`   ${okMark} ${STATE_PATH}（${chats.length} 个会话绑定）`)
    for (const c of chats.slice(0, 5)) {
      line(`      ${c.chatId.slice(0, 12)}… → ${c.sessionId}  ${c.directory || ''}`)
    }
  } else {
    line(`   ${warnMark} 还没有状态文件（首次对话后生成）`)
  }

  // 5. 默认目录
  line('\n[目录]')
  if (!existsSync(cfg.opencode.defaultDirectory)) {
    problem(`defaultDirectory 不存在: ${cfg.opencode.defaultDirectory}`)
  } else {
    line(`   ${okMark} ${cfg.opencode.defaultDirectory}`)
  }

  line('')
  if (problems) {
    line(`=== ${problems} 项需要处理 ===\n`)
    process.exit(1)
  }
  line('=== 全部就绪，可以 npm start ===\n')
}

main().catch((e) => {
  console.error('体检失败: ' + (e?.stack || e))
  process.exit(1)
})
