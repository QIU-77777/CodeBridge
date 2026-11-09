import * as Lark from '@larksuiteoapi/node-sdk'
import { PROMPT_TEMPLATES, deepMerge } from './config.js'

/** 用运行时数据填充 {{变量}}。缺失的变量替换成空串，避免占位符泄漏给模型 */
function render(template, vars) {
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key]),
  )
}

/**
 * 飞书侧传输层：长连接收事件 + 发/改卡片。
 * 长连接模式不需要公网 IP、不需要内网穿透。
 */
/**
 * 给 SDK 调用加超时。
 *
 * 为什么必须加：SDK 底层 HTTP 请求没有默认超时。长驻进程里，静默死亡的
 * keep-alive socket（笔记本合盖、切换 Wi-Fi）会让请求永挂——await 永远
 * 不返回，调用方整个卡死。实测代价：一次终态卡片 patch 挂住，run 卡在
 * 终态出不去，看门狗只认 running 也收不了殓，飞书上那张卡片永远停在
 * 「执行中」。超时后抛错，上层（flushRun 的 try/catch）记录后继续走
 * 终态收尾，状态不卡死。
 */
/** 调用时读取，测试可以调小 */
const sdkTimeoutMs = () => Number(process.env.OCB_SDK_TIMEOUT_MS) || 20_000
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const ms = sdkTimeoutMs()
      const t = setTimeout(() => reject(new Error(`飞书 ${label} 请求超过 ${ms / 1000} 秒未响应`)), ms)
      t.unref?.()
    }),
  ])
}

export class FeishuTransport {
  constructor(config, { onMessage, onCardAction, nameOf, backendType = '', logger = console }) {
    this.cfg = config.feishu
    // prompt 前缀配置（src/config.js 的 prompt 段）：来源标注是每条消息都带的
    // 动态数据，协作规则这类静态说明走 once 模式，每个会话只带一次
    this.promptCfg = config.prompt || {}
    // 发给模型的文案模板。默认来自 prompts.json，按 always / once 分组，组内
    // 字典是互斥选项。测试与探针直接构造时 config 里没有 templates，这里兜底。
    // 深合并让实例只覆盖一个选项也能保留同组其余选项。
    this.tpl = deepMerge(PROMPT_TEMPLATES, config.prompt?.templates || {})
    this.log = logger
    this.onMessage = onMessage
    this.onCardAction = onCardAction
    /** open_id -> 显示名；拿不到就空串，标注里退回只显示 id */
    this.nameOf = nameOf
    /** 后端类型（opencode / pi）。pi 后端的桥接会把本实例凭证注入子进程，
     *  身份声明据此给不同文案 */
    this.backendType = backendType

    /** 机器人自己的身份，start() 时取一次并缓存 */
    this.self = null
    /** chat_id -> 群名，取不到就记空串，避免每来一条消息打一次接口 */
    this.chatNames = new Map()
    /** chat_id -> Map<open_id, 名字>，开了 im:chat.members:read 才有 */
    this.members = new Map()
    /** 成员接口被拒过一次就不再试，免得每条消息都撞 403 */
    this.membersDenied = false

    this.client = new Lark.Client({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      domain: this.cfg.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn,
    })
  }

  /**
   * 拿机器人自己的 open_id / 名字。
   *
   * 为什么必须知道「我是谁」：一个群里可以同时躺着好几个机器人，飞书会把
   * im.message.receive_v1 推给**每一个**在群里的机器人。只判断「mentions 非空」
   * 的话，用户 @A 时 A 和 B 会一起抢答。要靠 open_id 精确比对，才能做到
   * 「只响应 @ 我的」。
   *
   * 配置里写了 feishu.botOpenId 就直接用，省掉一次网络请求（也方便接口取不到时兜底）。
   */
  async resolveSelf() {
    if (this.self) return this.self
    if (this.cfg.botOpenId) {
      this.self = { open_id: this.cfg.botOpenId, name: this.cfg.botName || '我' }
    } else {
      try {
        const res = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
        const bot = res?.bot || res?.data?.bot || {}
        if (!bot.open_id) throw new Error('返回里没有 open_id')
        this.self = { open_id: bot.open_id, name: bot.app_name || '我' }
        this.log.info(`机器人身份: ${this.self.name} (${this.self.open_id})`)
      } catch (err) {
        // 拿不到就退化成「@ 了谁都算」，多机器人同群时会抢答，必须让用户看见
        this.self = { open_id: null, name: this.cfg.botName || '我' }
        this.log.warn(
          `拿不到机器人自身 open_id（${err.message}），已退化为「@ 到任何人都会响应」。` +
          '多机器人同群请把 feishu.botOpenId 写进配置，否则会互相抢答。',
        )
      }
    }
    return this.self
  }

  async start() {
    // 先把自己是谁搞清楚，再开始收消息，避免头几条按「@ 谁都算」误判
    await this.resolveSelf()

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        // 飞书要求 3 秒内响应，这里立即返回，真正的处理异步跑
        // （message_id 去重在 Bridge 里做，重推不会重复执行）
        Promise.resolve()
          .then(() => this.handleImMessage(data))
          .catch((err) => this.log.error('处理消息失败: ' + (err?.stack || err)))
      },
      'card.action.trigger': async (data) => {
        try {
          return await this.handleCardAction(data)
        } catch (err) {
          this.log.error('处理卡片回调失败: ' + (err?.stack || err))
          return { toast: { type: 'error', content: '处理失败: ' + err.message } }
        }
      },
    })

    this.ws = new Lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      domain: this.cfg.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
    })

    await this.ws.start({ eventDispatcher: dispatcher })
    this.log.info('飞书长连接已启动')
  }

  /**
   * 群名，用于给模型标注消息来源。
   *
   * 拿不到不算错：成员/群信息接口要 im:chat 系列权限，没开就退回「群聊」。
   * 取到一次就缓存，一条消息一个接口太浪费。
   */
  async resolveChatName(chatId) {
    if (!chatId) return ''
    if (this.chatNames.has(chatId)) return this.chatNames.get(chatId)
    let name = ''
    try {
      const res = await this.client.request({ method: 'GET', url: `/open-apis/im/v1/chats/${chatId}` })
      name = res?.data?.name || ''
    } catch {
      /* 没权限，静默降级 */
    }
    this.chatNames.set(chatId, name)
    return name
  }

  /**
   * 发送者名字：先问上层缓存（配置 / 之前 @ 攒的），没有再去拉群成员列表。
   *
   * 群成员列表要 im:chat.members:read。没开就置 membersDenied，之后不再重试，
   * 名字退回「从 @ 提及里攒」——两条路都走不通时标注里只有 open_id，不影响功能。
   */
  async resolveSenderName(chatId, openId) {
    if (!openId) return ''
    const known = this.nameOf?.(openId) || ''
    if (known) return known

    if (!chatId || this.membersDenied) return ''
    if (!this.members.has(chatId)) {
      const map = new Map()
      try {
        let pageToken = ''
        for (let page = 0; page < 5; page++) {
          const url =
            `/open-apis/im/v1/chats/${chatId}/members?member_id_type=open_id&page_size=100` +
            (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '')
          const res = await this.client.request({ method: 'GET', url })
          const items = res?.data?.items || []
          for (const m of items) if (m?.member_id && m?.name) map.set(m.member_id, m.name)
          pageToken = res?.data?.page_token || ''
          if (!res?.data?.has_more || !pageToken) break
        }
      } catch (err) {
        this.membersDenied = true
        this.log.warn(
          '群成员列表不可用（大概是缺 im:chat.members:read），名字改为从 @ 提及里攒: ' +
          (err?.message || err),
        )
      }
      this.members.set(chatId, map)
    }
    return this.members.get(chatId)?.get(openId) || ''
  }

  async handleImMessage(data) {
    const m = data?.message
    if (!m) return

    const isGroup = m.chat_type === 'group'
    const self = await this.resolveSelf()
    const mentions = Array.isArray(m.mentions) ? m.mentions : []

    /**
     * 只认「@ 我本人」。
     *
     * 一个群里可以同时躺着好几个机器人，飞书会把 im.message.receive_v1 推给
     * **每一个**在群里的机器人。只判断「mentions 非空」的话，用户 @A 的时候
     * B 也会跟着抢答 —— 所以必须按 open_id 精确比对，@ 的是别人就跟我无关。
     *
     * 闸门放在最前面，连「暂不支持图片」这类提示也一并挡住：多 agent 同群时，
     * 别人发张图不该收到五个机器人的催稿。
     */
    const selfMention = self.open_id
      ? mentions.find((x) => x?.id?.open_id === self.open_id)
      : mentions[0] // 退化：拿不到自身 open_id 时按「@ 了任何一个人」算

    if (isGroup && this.cfg.requireMention && !selfMention) {
      // 只在「@ 了别人」时记一行。纯聊天不记，否则多人群里每句话都刷日志。
      if (mentions.length > 0) {
        this.log.info(
          `[skip] @ 的不是我 names=${mentions.map((x) => x?.name).filter(Boolean).join(',')} msg=${m.message_id}`,
        )
      }
      return
    }

    if (m.message_type !== 'text') {
      const replyTo = isGroup ? m.root_id || m.message_id : null
      await this.sendText(m.chat_id, `暂不支持 ${m.message_type} 类型消息，请发送文本。`, { replyTo })
      return
    }

    let raw = ''
    try {
      raw = JSON.parse(m.content || '{}').text || ''
    } catch {
      raw = ''
    }

    // 所有 @ 占位符都还原成 @姓名，包括 @我自己的。
    // 抹掉自己的那份会让语义断裂：人类说「@Lil_O @Lil_P 你们三个」，
    // 而模型只看到「@Lil_P 你们三个」——既不知道被点的有自己，
    // 也数不清这句话冲几个人说。名字取飞书事件里 mentions 的 name
    let text = raw
    for (const mt of mentions) {
      if (!mt?.key) continue
      text = text.split(mt.key).join(`@${mt.name || '某人'}`)
    }
    text = text.trim()
    if (!text) return

    /**
     * 群里一条话题 = 一个会话。话题的「根」就是那条被回复的消息：
     *   - 已经在话题里的消息：root_id 指向话题根
     *   - 主聊天流里新 @ 的消息：root_id 为空，它自己就成为新话题的根
     * 两种情况的键用同一个公式，所以开完话题不需要再改绑定。
     */
    const rootId = isGroup ? m.root_id || m.message_id : null
    const key = isGroup ? `root:${rootId}` : m.chat_id
    const threadId = m.thread_id || null

    // 群消息记一行原始上下文：话题绑定要看 thread_id / root_id，
    // 出了问题先看这行，不用再去翻飞书后台的事件原始包。
    if (isGroup) {
      this.log.info(
        `[group] chat=${String(m.chat_id).slice(-6)} key=${key} thread=${threadId || '-'} ` +
        `root=${m.root_id || '-'} parent=${m.parent_id || '-'} msg=${m.message_id}`,
      )
    }

    const userId = data?.sender?.sender_id?.open_id || data?.sender?.sender_id?.user_id || ''
    const isBot = data?.sender?.sender_type === 'app'

    /**
     * 给模型标一行来源。
     *
     * 以前只发正文，模型看到的就是一句光秃秃的中文，于是它得靠 `ls` / 读仓库
     * 反推「我在哪儿、谁在跟我说话」—— 实测一次打招呼花了 9 分 12 秒、48 步。
     * 把来源和发送者 open_id 一并给出来：既省掉这轮探索，也让它有能力 @ 回去
     * （@ 某人需要对方完整的 open_id，靠猜是猜不到的）。
     *
     * 名字只来自配置里的 feishu.names（人工声明）或群成员接口，攒不到就只给
     * id —— id 必须完整，截断了就 @ 不回去。
     */
    const chatName = isGroup ? await this.resolveChatName(m.chat_id) : ''
    const a = this.tpl.always
    const where = isGroup
      ? chatName
        ? render(a.where.groupNamed, { name: chatName })
        : a.where.groupFallback
      : a.where.private
    // 会话 id 是溯源主键：话题内带 thread_id（omt_ 开头），拿不到时退
    // root_id——话题根消息一定带 thread_id，agent 读到根消息能顺到话题；
    // 主聊天流带 chat_id（没有 thread_id 可用）。id 走模板变量
    const scope = isGroup
      ? m.root_id
        ? render(a.scope.thread, { thread: m.thread_id || m.root_id })
        : render(a.scope.main, { chat: m.chat_id })
      : ''
    const when = new Date(Number(m.create_time) || Date.now()).toLocaleString('zh-CN', { hour12: false })
    const nick = (await this.resolveSenderName(m.chat_id, userId)) || ''
    const sender = nick
      ? render(a.sender.named, { name: nick, id: userId })
      : userId
        ? render(a.sender.idOnly, { id: userId })
        : a.sender.unknown
    const senderType = isBot ? a.senderType.bot : a.senderType.user
    const origin = isGroup
      ? render(a.origin.group, { where, scope, sender, senderType, when })
      : render(a.origin.private, { where, sender, senderType, when })
    // 第二行：告诉模型「你是谁」。多机器人同机时，代理用飞书 CLI 发言读的是
    // 机器级配置，默认应用可能是别的实例的——真实事故里 Lil_P 的代理发出的
    // 问候以 Lil_O 的应用到达群里。声明身份之外，pi 后端的桥接还会把本实例
    // 凭证注入子进程环境（src/pi.js childEnv），两句互相印证
    const identity = this.identityLine(self)
    // 第三部分：配置里的 prompt 前缀，按模式分两路。always 的（含用户自定义）
    // 并进本条消息的前缀；once 的（协作规则）单独交给上层——它只在该会话的
    // 第一条消息拼，之后靠上下文记住，每轮重复只是白烧 token
    const { always, once } = this.prefixTexts(isGroup)
    const originBlock = [origin, identity, always].filter(Boolean).join('\n')

    await this.onMessage({
      chatId: m.chat_id,
      key,
      rootId,
      threadId,
      isGroup,
      userId,
      isBot,
      origin: originBlock,
      oncePrefix: once,
      text,
      // 命令判定用剥掉开头 @ 的版本。@ 占位符全部还原之后，群里
      // 「@Lil_P /help」的 text 不再以 / 开头，handler 的命令分流认不出它，
      // 命令会被当普通消息发给模型。text 给模型看（保留 @，语义完整），
      // cmdText 专供 startsWith('/') 判定，两处各取所需
      cmdText: text.replace(/^(@\S+\s+)+/, ''),
      messageId: m.message_id,
      chatType: m.chat_type,
    })
  }

  /**
   * 把配置里的 prompt 前缀按模式分成两堆。
   *
   * always：每条消息都拼，静态文本并进来源标注那段。
   * once：每个会话的第一条消息拼一次，由上层决定要不要拼。
   *
   * id 为 rules 的条目：text 留空用 templates.once.rules（prompts.json），
   * 填写则用你的版本。只在群里拼，私聊没有同伴。删掉条目即关闭该前缀。
   */
  prefixTexts(isGroup) {
    const list = this.promptCfg?.prefixes || []
    let always = ''
    let once = ''
    const append = (bucket, text) => {
      if (bucket) bucket += '\n'
      return bucket + text
    }
    for (const p of list) {
      if (!p || typeof p !== 'object') continue
      let text
      if (p.id === 'rules') {
        if (!isGroup) continue // 协作规则只在群里有意义
        text = p.text || this.tpl.once.rules
      } else {
        text = p.text
      }
      if (!text) continue
      if (p.mode === 'once') once = append(once, text)
      else always = append(always, text)
    }
    return { always, once }
  }

  /**
   * 身份声明行：本机器人是谁、飞书应用是哪个、飞书 CLI 的身份从哪来。
   * 拿不到名字时返回空串（不加行），老行为不变。
   */
  identityLine(self) {
    const who = self?.name || this.cfg.botName || ''
    if (!who) return ''
    const a = this.tpl.always
    const app = this.cfg.appId ? render(a.identityApp, { appId: this.cfg.appId }) : ''
    const key = this.backendType === 'pi' ? 'pi' : 'opencode'
    return render(a.identityLine[key], { who, app })
  }

  async handleCardAction(data) {
    const ev = data?.event || data
    const action = ev?.action?.value || {}
    const chatId = ev?.context?.open_chat_id
    const userId = ev?.operator?.open_id || ''
    const messageId = ev?.context?.open_message_id
    if (!chatId) return { toast: { type: 'error', content: '缺少 chat 上下文' } }
    this.log.info(`卡片回调 ${JSON.stringify(action)} chat=${chatId.slice(-6)} msg=${messageId || '?'}`)
    return this.onCardAction({ chatId, userId, action, messageId })
  }

  /**
   * 发送消息。replyTo 有值就进话题（reply_in_thread），否则发到会话主聊天流。
   * 群里的所有输出都应该带 replyTo，否则卡片会散落在主群、和话题对不上。
   */
  async _send(chatId, msgType, content, replyTo) {
    if (replyTo) {
      const res = await withTimeout(
        this.client.im.v1.message.reply({
          path: { message_id: replyTo },
          data: { msg_type: msgType, content, reply_in_thread: true },
        }),
        'reply',
      )
      if (res?.code !== 0 && res?.code !== undefined) {
        throw new Error(`发送消息失败 code=${res.code} msg=${res.msg}`)
      }
      return res?.data?.message_id
    }
    const res = await withTimeout(
      this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content },
      }),
      'create',
    )
    if (res?.code !== 0 && res?.code !== undefined) {
      throw new Error(`发送消息失败 code=${res.code} msg=${res.msg}`)
    }
    return res?.data?.message_id
  }

  async sendCard(chatId, card, { replyTo = null } = {}) {
    return this._send(chatId, 'interactive', JSON.stringify(card), replyTo)
  }

  async patchCard(messageId, card) {
    const res = await withTimeout(
      this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      }),
      'patch',
    )
    if (res?.code !== 0 && res?.code !== undefined) {
      throw new Error(`更新卡片失败 code=${res.code} msg=${res.msg}`)
    }
    return true
  }

  async sendText(chatId, text, { replyTo = null } = {}) {
    return this._send(chatId, 'text', JSON.stringify({ text }), replyTo)
  }

  async stop() {
    await this.ws?.close?.()
  }
}
