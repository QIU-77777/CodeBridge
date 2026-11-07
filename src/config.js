import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 配置目录。按优先级：
 *
 *   1. `$OCB_CONFIG_DIR`（多实例部署时每个 agent 指一份）
 *   2. `~/.config/opencode-feishu-bridge`
 *
 * 只有这两条。配置统一放家目录：appSecret 不落在仓库工作树里，换个目录、
 * 换个 clone 启动都读同一份，不会因为「从哪儿启动」换配置。
 *
 * ⚠️ 这个目录里有 appSecret。`.gitignore` 仍排除 `.config/`，防止有人把
 * 配置放回仓库里时误入库。
 */
function resolveConfigDir() {
  const explicit = process.env.OCB_CONFIG_DIR
  if (explicit) return resolve(explicit)
  return join(homedir(), '.config', 'opencode-feishu-bridge')
}

export const CONFIG_DIR = resolveConfigDir()
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
export const STATE_PATH = join(CONFIG_DIR, 'state.json')
/** 入库的模板，只有占位符；首次运行照它生成 config.json */
export const TEMPLATE_PATH = join(REPO, 'config.example.json')

const DEFAULTS = {
  backend: {
    // opencode = 常驻 HTTP + SSE 流式；pi = 一次性子进程，跑完发一张结果卡片。
    // 每起一个机器人就复制一份 config.json，把 type 和 appId 一起换掉。
    type: 'opencode',
    pi: {
      // CLI 路径。留空用 PATH 里的 pi，也可以用绝对路径或 $OCB_PI_BIN
      bin: 'pi',
      // 传给 --model 的值；留空用 pi 自己配置的默认模型
      model: '',
      // 单次执行超时（毫秒）。从进程启动算总时长，到点强杀并按失败收尾
      timeoutMs: 10 * 60_000,
      // 最终消息之后静默多久就按已完成收尾（毫秒）。0 = 关闭，恢复「只等
      // 进程退出」的老行为。pi 偶发「回答产出了却不退出」，实测一次卡片在
      // 「执行中」停了 6 分 58 秒；开了它，最坏空白约等于这个值。
      // 默认 3 分钟：实测同一轮任务里模型轮间思考间隔到过 62 秒和 107 秒，
      // 60 秒的阈值会把还在跑的运行误判成完成——杀掉进程、把中途答案标成
      // 「已完成」。见过 agent_settled 之后的阈值另算（见 src/pi.js）
      settleQuietMs: 180_000,
      // 额外启动参数，例如 ["--no-extensions"]
      extraArgs: [],
    },
  },
  feishu: {
    appId: '',
    appSecret: '',
    domain: 'feishu',
    // 白名单：填 open_id 或 user_id。空数组 = 不限制（不建议）
    allowlist: [],
    // 监听名单：通讯录里「认识且放行」的个体，填 open_id（本应用视角的值）。
    // 与 allowlist 是并集关系，语义不同：
    //   allowlist = 手写例外，人类也走这里；
    //   listen   = 「它的 @ 能到达我」，由 admin 通讯录面板的开关维护。
    // 单向：A 的 listen 里有 B，B 的 @ 能唤醒 A；反过来要看 B 自己的配置。
    // 「认识」（通讯录，运行时自动攒）不等于「许可」（这个名单）
    listen: [],
    // 群聊是否必须 @ 本机器人 才响应（@ 别的机器人 / 别人不会被触发）
    requireMention: true,
    // 机器人自己的 open_id。留空则启动时调 /open-apis/bot/v3/info 自动取；
    // 多机器人同群时建议显式填上，避免接口取不到时退化成「@ 谁都算」而互相抢答
    botOpenId: '',
    // open_id -> 显示名。飞书没有「open_id 反查机器人名字」的接口，
    // 想让标注里显示名字就在这里写；留空则只会显示 open_id
    // （从消息 @ 提及里攒到的名字也会自动补进来）
    names: {},
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
  github: {
    // GitHub 身份注入：让每个 agent 以各自的 GitHub App（xxx[bot]）身份
    // 推送和开 PR，不占用人的账号。与 feishu 段同一套注入机制（见
    // src/github-identity.js 与 scripts/lib/github-identity.sh）。
    //   off  = 不注入（默认，现有部署零改动）
    //   app  = GitHub App，需要 appId / installationId / privateKeyPath
    //   pat  = 个人访问令牌，需要 token
    mode: 'off',
    appId: '',
    installationId: '',
    // .pem 私钥路径，建议放实例配置目录（与 appSecret 同规格，权限 600）
    privateKeyPath: '',
    token: '',
    // 提交署名，注入 GIT_AUTHOR_* / GIT_COMMITTER_*
    gitName: '',
    gitEmail: '',
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
  prompt: {
    // prompt 前缀。每条消息发给模型前，正文前面会拼一段前缀，分两种模式：
    //   always = 每条消息都拼。内置的来源标注（群名/话题/发送者/时间）和身份
    //            声明属于这类——它们携带**本条消息**的动态数据，由代码生成
    //   once   = 每个会话的第一条消息拼一次，之后靠上下文记住。协作规则属于
    //            这类——规则是静态的，每轮重复只是白烧 token
    //
    // 条目说明：
    //   id: 'rules' 是内置的协作机制说明，text 留空 = 用内置默认文本，
    //               填写 = 用你的版本（只在群里拼，私聊没有同伴）
    //   其他 id     = 自定义前缀，纯静态文本，想加几条加几条
    //   mode 缺失   = 按 always 处理
    //   删掉某个条目 = 关闭该前缀
    prefixes: [{ id: 'rules', mode: 'once', text: '' }],
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
  if (process.env.OCB_BACKEND) cfg.backend.type = process.env.OCB_BACKEND
  if (process.env.OCB_PI_BIN) cfg.backend.pi.bin = process.env.OCB_PI_BIN
  if (process.env.OCB_PI_MODEL) cfg.backend.pi.model = process.env.OCB_PI_MODEL
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

/**
 * 首次运行铺一份配置。
 *
 * 模板只有一份（仓库根的 config.example.json），不在这里再写一遍 —— 两份
 * 迟早会漂移，改了一处忘了另一处。所以这里直接读模板，只补上能替用户定下来的值。
 */
export function writeExampleConfig() {
  ensureConfigDir()
  if (existsSync(CONFIG_PATH)) return false
  if (!existsSync(TEMPLATE_PATH)) {
    throw new Error(
      `找不到配置模板 ${TEMPLATE_PATH}。它应该在仓库里，重新 clone 或手动新建一份 config.json。`,
    )
  }
  let example
  try {
    example = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'))
  } catch (err) {
    throw new Error(`配置模板解析失败 ${TEMPLATE_PATH}: ${err.message}`)
  }
  // 默认目录留空没意义，直接用 home
  if (!example.opencode?.defaultDirectory) {
    example.opencode = { ...example.opencode, defaultDirectory: homedir() }
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(example, null, 2), 'utf8')
  return true
}
