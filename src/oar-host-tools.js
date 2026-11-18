/**
 * 飞书能力作为宿主工具，通过 MCP 提供给任何 harness。
 *
 * 背景：现在只有 pi 后端能让 agent 在飞书上发言，做法是把本实例的飞书凭证注进
 * 子进程环境、让 agent 自己敲 feishu-cli。多机器人同机部署时，那个机器级配置
 * 经常是另一个实例的，代理就以别人的身份发言（真实事故记在 src/pi.js 的注释
 * 里）。OAR 的 serveMcpTools 把这件事换成：桥接在自己进程内起一个 MCP 服务器，
 * 把「给指定会话发消息」做成工具，任何 harness 通过自己的 MCP 通道挂上来。
 *
 * 三个性质：
 *   1. 身份由桥接进程持有，就是这个实例的飞书应用，不进子进程环境、不拼 CLI
 *      参数、不依赖机器级配置文件。
 *   2. 工具面所有 harness 一致，接入新 harness 不用再解决一次身份注入。
 *   3. 不是 agent 间通信：传输仍然是飞书群消息，@、话题、忙时 steer 都不变。
 *      这是宿主给 agent 发工具，不是建立父子关系。
 *
 * 一个 harness 挂不上就不挂：pi-durable 拒绝 mcpServers、antigravity 拒绝带头
 * 部的条目、dsh 只收 stdio。由 buildSessionOptions 按 refusedSessionOptions
 * 决定挂不挂。
 */
import { serveMcpTools } from '@botiverse/oar'

/** MCP 服务器名：^[\w-]+$，且不能占某些运行时保留的名字 */
const SERVER_NAME = 'feishu'

const SEND_SCHEMA = {
  type: 'object',
  properties: {
    chat_id: { type: 'string', description: '目标飞书会话 id（oc_ 开头）' },
    text: { type: 'string', description: '要发的内容，markdown 子集' },
    reply_to: { type: 'string', description: '可选，回复这条消息（带它的 id 就落在同一话题下）' },
  },
  required: ['chat_id', 'text'],
}

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    chat_id: { type: 'string', description: '要问哪个飞书会话' },
    question: { type: 'string', description: '问题本身' },
    timeout_ms: { type: 'number', description: '等回答的毫秒数，默认 300000，上限 3600000' },
  },
  required: ['chat_id', 'question'],
}

const LIST_SCHEMA = {
  type: 'object',
  properties: {},
}

/**
 * 造一组飞书宿主工具。
 *
 * @param {object} opts
 * @param {object} opts.transport 飞书传输层（bridge.t）
 * @param {object} [opts.store] 桥接的状态存储，用来列已知会话
 * @param {(chatId: string, question: string, timeoutMs: number) => Promise<string|null>} [opts.askHuman]
 *   等人回答的实现，由桥接给（它才握有消息路由）。不给就退化成只发问题不等回答
 * @param {Function} [opts.logger]
 */
export function feishuHostTools({ transport, store, askHuman, logger = console } = {}) {
  if (!transport) return []

  const tools = [
    {
      name: 'send_message',
      description:
        '给一个飞书会话发消息，以本实例这个飞书应用的身份发出。用来把结论、进度或需要人知道的事告诉群里。',
      inputSchema: SEND_SCHEMA,
      annotations: { destructiveHint: false, openWorldHint: true, idempotentHint: false },
      handler: async (input) => {
        const chatId = String(input.chat_id || '')
        const text = String(input.text || '')
        if (!chatId || !text) return { content: [{ type: 'text', text: 'chat_id 与 text 都不能为空' }], isError: true }
        const replyTo = input.reply_to ? String(input.reply_to) : null
        const id = await transport.sendText(chatId, text, { replyTo })
        return `已发送，消息 id ${id}`
      },
    },
    {
      name: 'list_chats',
      description: '列出这个桥接实例知道的飞书会话：绑定键、会话 id、目录、当前会话。用来找到该往哪里发消息。',
      inputSchema: LIST_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async () => {
        if (!store) return '这个实例没有可列的会话。'
        // store.all() 给的是绑定条目：key 是哪个话题、chatId 是发消息的目标
        const chats = typeof store.all === 'function' ? store.all() : []
        if (!chats.length) return '还没有任何会话绑定。'
        return chats
          .map((c) => `${c.key} | ${c.chatId} | 目录 ${c.directory || '未定'} | 会话 ${c.sessionId || '未绑定'}`)
          .join('\n')
      },
    },
  ]

  if (typeof askHuman === 'function') {
    tools.push({
      name: 'ask_human',
      description: '向一个飞书会话里的人提一个问题，等到回答或超时。需要人做决定、给确认、补信息时用。',
      inputSchema: ASK_SCHEMA,
      annotations: { destructiveHint: false, openWorldHint: true },
      handler: async (input) => {
        const chatId = String(input.chat_id || '')
        const question = String(input.question || '')
        if (!chatId || !question) return { content: [{ type: 'text', text: 'chat_id 与 question 都不能为空' }], isError: true }
        const raw = Number(input.timeout_ms)
        const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3_600_000) : 300_000
        const answer = await askHuman(chatId, question, timeoutMs)
        if (answer === null) return { content: [{ type: 'text', text: '超时，没有人回答。' }], isError: true }
        return answer
      },
    })
  }

  return tools
}

/**
 * 起 MCP 服务器并把工具挂上去。
 *
 * @returns {Promise<{server: object, close: () => Promise<void>}>} server 是
 *   SessionOptions.mcpServers 的条目
 */
export async function serveFeishuTools({ transport, store, askHuman, logger = console } = {}) {
  const tools = feishuHostTools({ transport, store, askHuman, logger })
  if (!tools.length) return null
  const served = await serveMcpTools({
    name: SERVER_NAME,
    tools,
    instructions:
      '这些工具让你以这个飞书应用的身份在飞书里说话。要给群里发结论用 send_message，要先找到该发哪里用 list_chats，' +
      '需要人做决定或补信息用 ask_human。飞书是人与人、agent 与 agent 平等协作的地方，不是层级汇报的通道。',
  })
  return { server: served.server, close: () => served.close(), setTools: (t) => served.setTools(t) }
}
