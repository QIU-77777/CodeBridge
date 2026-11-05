import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CONFIG_DIR = join(homedir(), '.config', 'opencode-feishu-bridge')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
export const STATE_PATH = join(CONFIG_DIR, 'state.json')

const DEFAULTS = {
  feishu: {
    appId: '',
    appSecret: '',
    domain: 'feishu',
    // 白名单：填 open_id 或 user_id。空数组 = 不限制（不建议）
    allowlist: [],
    // 群聊是否必须 @ 本机器人 才响应（@ 别的机器人 / 别人不会被触发）
    requireMention: true,
    // 机器人自己的 open_id。留空则启动时调 /open-apis/bot/v3/info 自动取；
    // 多机器人同群时建议显式填上，避免接口取不到时退化成「@ 谁都算」而互相抢答
    botOpenId: '',
  },
  opencode: {
    url: 'http://127.0.0.1:19876',
    // 与 opencode serve 的 OPENCODE_SERVER_PASSWORD 对应；未设密码留空
    password: '',
    // /new 时不指定目录则用这个
    defaultDirectory: process.env.HOME || '/',
    // 默认模型（providerID/modelID）；留空用 opencode 默认
    defaultModel: '',
  },
  behavior: {
    // 卡片流式刷新间隔（毫秒），飞书 message.patch 有 QPS 限制，别低于 1200
    streamIntervalMs: 1800,
    // 是否把 reasoning（思考过程）也推到卡片
    showReasoning: false,
    // 是否在卡片上展示工具调用链路。默认 false：飞书只看结论，要轨迹去电脑上看
    showTools: false,
    // 单次卡片正文最大字符数
    maxBodyChars: 6000,
    // 超时多久（毫秒）认为执行卡死
    idleTimeoutMs: 15 * 60 * 1000,
    // 同时最多跑几个任务（群里每个话题是一个独立会话，彼此并行）。
    // 设 0 = 不限。每个会话都在真跑 bash/node，开太多会打满本机，建议 2–3
    maxParallel: 2,
  },
}

function deepMerge(base, override) {
  const out = { ...base }
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

export function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
}

export function loadConfig() {
  ensureConfigDir()
  let fileCfg = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    } catch (err) {
      throw new Error(`配置文件解析失败 ${CONFIG_PATH}: ${err.message}`)
    }
  }

  const cfg = deepMerge(DEFAULTS, fileCfg)

  // 环境变量优先于文件
  if (process.env.FEISHU_APP_ID) cfg.feishu.appId = process.env.FEISHU_APP_ID
  if (process.env.FEISHU_APP_SECRET) cfg.feishu.appSecret = process.env.FEISHU_APP_SECRET
  if (process.env.FEISHU_DOMAIN) cfg.feishu.domain = process.env.FEISHU_DOMAIN
  if (process.env.OPENCODE_URL) cfg.opencode.url = process.env.OPENCODE_URL
  if (process.env.OPENCODE_SERVER_PASSWORD) cfg.opencode.password = process.env.OPENCODE_SERVER_PASSWORD
  if (process.env.BRIDGE_DEFAULT_DIR) cfg.opencode.defaultDirectory = process.env.BRIDGE_DEFAULT_DIR
  if (process.env.BRIDGE_DEFAULT_MODEL) cfg.opencode.defaultModel = process.env.BRIDGE_DEFAULT_MODEL
  if (process.env.BRIDGE_ALLOWLIST) {
    cfg.feishu.allowlist = process.env.BRIDGE_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
  }

  return cfg
}

export function writeExampleConfig() {
  ensureConfigDir()
  if (existsSync(CONFIG_PATH)) return false
  const example = {
    feishu: {
      appId: 'cli_xxxxxxxxxxxxxxxx',
      appSecret: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      domain: 'feishu',
      allowlist: [],
      requireMention: true,
      botOpenId: '',
    },
    opencode: {
      url: 'http://127.0.0.1:19876',
      password: '',
      defaultDirectory: process.env.HOME || '/',
      defaultModel: '',
    },
    behavior: {
      streamIntervalMs: 1800,
      showReasoning: false,
      showTools: false,
      maxBodyChars: 6000,
      idleTimeoutMs: 900000,
      maxParallel: 2,
    },
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(example, null, 2), 'utf8')
  return true
}
