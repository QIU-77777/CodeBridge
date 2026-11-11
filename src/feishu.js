import * as Lark from '@larksuiteoapi/node-sdk'
import { PROMPT_TEMPLATES, deepMerge } from './config.js'
import { TopicLog, contextKeyOf, flattenContent, renderTopicContext } from './topic-context.js'
import { render } from './template.js'

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

    /**
     * 话题近况：群消息的近况缓冲（见 src/topic-context.js）。采集点在 @ 闸门
     * 之前——没 @ 我的轮次正是要替模型留着的。behavior.topicContext=false 关闭。
     */
    this.behaviorCfg = config.behavior || {}
    this.topicLog = new TopicLog()

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
     * 话题近况采集。必须在 @ 闸门**之前**：这里丢掉的没 @ 轮次，正是被 @ 唤醒
     * 时要替模型带上的盲区。只记群消息；自己发的（卡片 / 回复回流）不记——
     * 模型知道自己说过什么，记了反而是噪声。
     *
     * 主聊天流按 chat:<群> 聚（那里每次 @ 都是新会话，近况是唯一上下文来源），
     * 话题内按 root:<根> 聚，键语义见 src/topic-context.js。
     */
    if (isGroup && this.topicContextOn()) {
      const senderId = data?.sender?.sender_id?.open_id || data?.sender?.sender_id?.user_id || ''
      const isOwn = self?.open_id && senderId === self.open_id
      if (!isOwn) {
        const flat = flattenContent(m.message_type, m.content, mentions)
        if (flat) {
          const atMe = self?.open_id
            ? mentions.some((x) => x?.id?.open_id === self.open_id)
            : mentions.length > 0
          this.topicLog.push(contextKeyOf(m), {
            messageId: m.message_id,
            // 飞书 im.message.receive_v1 的 message.create_time 是**毫秒**级
            // 时间戳字符串（13 位）。buildPrefix 的 when 与 probe-msg 都直接
            // new Date(Number(...))，这里必须同口径。写成 *1000 会把毫秒再乘
            // 一千倍，近况行的 [HH:MM] 落到公元五万年——实测探针抓到的
            ts: Number(m.create_time) || Date.now(),
            senderId,
            senderType: data?.sender?.sender_type || '',
            kind: flat.kind,
            text: flat.text,
            atMe,
          })
        }
      }
    }

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
     * 给模型拼前缀。
     *
     * 以前只发正文，模型看到的就是一句光秃秃的中文，于是它得靠 `ls` / 读仓库
     * 反推「我在哪儿、谁在跟我说话」—— 实测一次打招呼花了 9 分 12 秒、48 步。
     * 名字只来自配置里的 feishu.names（人工声明）或群成员接口，攒不到就只给
     * id —— id 必须完整，截断了就 @ 不回去。
     *
     * 四行：来源标注（在哪、谁说的）→ 协作 id → 身份 → 可@的同伴，最后拼配置里
     * 的 always 前缀。拼装在 buildPrefix 里，纯函数，测试直接喂事件字段。
     */
    const chatName = isGroup ? await this.resolveChatName(m.chat_id) : ''
    const nick = (await this.resolveSenderName(m.chat_id, userId)) || ''
    // 配置里的 prompt 前缀，按模式分两路。always 的（含用户自定义）并进本条
    // 消息的前缀；once 的（协作规则）单独交给上层——它只在该会话的第一条消息
    // 拼，之后靠上下文记住，每轮重复只是白烧 token
    const { always, once } = this.prefixTexts(isGroup)
    const originBlock = this.buildPrefix({ m, self, userId, isBot, chatName, nick, always })
    // 话题近况：群消息被 @ 唤醒时带上盲区原文（本条自身排除，它就是 prompt）。
    // 拆出 header / lines / count：plain 要拼成一块字符串，xml 要单独的原文行
    const tcp = isGroup ? this.topicContextParts(m) : { header: '', lines: '', count: 0 }
    const topicContext = tcp.lines ? `${tcp.header}\n${tcp.lines}` : ''
    // origin / oncePrefix / topicContext 三个字段两种模式都照旧生成：它们是
    // msg 的稳定契约（排队快照、命令分流、既有测试都靠它们）。xml 只是额外
    // 带一份结构化 layout，由 runPrompt 决定最终用哪套拼 body。
    const layout = this.promptLayout() === 'xml'
      ? {
          mode: 'xml',
          xml: this.tpl.layout.xml,
          parts: this.buildLayoutParts({
            m, self, userId, isBot, chatName, nick,
            rules: [always, once].filter(Boolean).join('\n'),
            topicLines: tcp.lines,
            topicCount: tcp.count,
          }),
        }
      : null

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
      topicContext,
      layout,
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
  /**
   * 话题近况的开关与限额。默认开：这是「话题内失忆」的直接补法，关掉的人
   * 自己知道为什么。条数 / 字数都留了配置口。
   */
  topicContextOn() {
    return this.behaviorCfg.topicContext !== false
  }

  /**
   * body 结构开关：xml = 三段 XML 键值，plain = 旧的方括号线性拼装。
   * 只认这两个值；写错配置按 xml 处理，不静默退回旧行为。
   */
  promptLayout() {
    return this.behaviorCfg.promptLayout === 'plain' ? 'plain' : 'xml'
  }

  /**
   * 话题近况拆成 header / lines / count：plain 要「头 + 行」一整块字符串，
   * xml 要单独的原文行与条数去填「话题近况」键。快照是纯读，一次算完共用。
   */
  topicContextParts(m) {
    const empty = { header: '', lines: '', count: 0 }
    if (!this.topicContextOn()) return empty
    const limit = Number(this.behaviorCfg.topicContextMessages) || 20
    const maxChars = Number(this.behaviorCfg.topicContextChars) || 2500
    const items = this.topicLog.snapshot(contextKeyOf(m), { excludeId: m.message_id, limit })
    if (!items.length) return empty
    const { text, count } = renderTopicContext(items, (id) => this.nameOf?.(id) || '', { maxChars })
    if (!text) return empty
    return { header: render(this.tpl.always.topicContext, { n: count }), lines: text, count }
  }

  /** 兼容旧调用：拼成 plain 模式要的「头 + 行」一块 */
  buildTopicContext(m) {
    const { header, lines } = this.topicContextParts(m)
    return lines ? `${header}\n${lines}` : ''
  }

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
   * 把一条消息的事实算成一组变量：来源标注、协作 id、身份、可@的同伴。
   * plain 与 xml 两套布局共用同一份事实，避免「方括号版本说在话题内、
   * XML 版本说在主聊天流」这类分叉。
   *
   * 为什么把 id 全给出来：飞书里 agent 之间的每一次互动都要落到具体的
   * chat / thread / message 上——@ 唤醒别人要 chat_id，拉话题历史要
   * thread_id，回话题里发言要 root 消息 id，精确回复本条要 msg id。这些 id
   * 事件里全都有，以前只往下传了一个 thread，于是每次协作都得先去
   * logs/bridge.log 里翻剩下的（真实事故：回复话题前满仓库找 root 消息 id）。
   *
   * 纯函数、不碰网络：测试直接喂事件字段（scripts/test-prompt-ids.mjs）。
   */
  prefixVars({ m, self, userId = '', isBot = false, chatName = '', nick = '' }) {
    const a = this.tpl.always
    const isGroup = m.chat_type === 'group'
    const sender = nick
      ? render(a.sender.named, { name: nick, id: userId })
      : userId
        ? render(a.sender.idOnly, { id: userId })
        : a.sender.unknown
    // 可@的同伴：来源只有配置里的 feishu.names。open_id 按应用隔离——我眼里
    // Lil_O 的 id 和 Lil_O 眼里自己的 id 不是同一个值，所以这里给的必须是
    // 「本应用视角」的那一个，也正是 @ 唤醒时要传的值。按 id 排自己；自身
    // open_id 没拿到时（bot/v3/info 失败且没配 botOpenId）退一级按名字排，
    // 否则名单里会有自己，@ 自己会直接起循环
    const peers = Object.entries(this.cfg.names || {})
      .filter(([id, name]) => id && id !== self?.open_id && name !== self?.name)
      .map(([id, name]) => `${name || '?'}=${id}`)
      .join(' · ')
    // 变量一次备齐，每个模板自己取所需：实例覆盖了某个模板时，不会因为
    // 「代码只给那一版传了变量」而渲染出空占位符
    const vars = {
      name: chatName,
      chat: m.chat_id || '',
      thread: m.thread_id || '',
      root: m.root_id || '',
      msg: m.message_id || '',
      self: self?.open_id || '未知',
      peers,
      sender,
      senderType: isBot ? a.senderType.bot : a.senderType.user,
      when: new Date(Number(m.create_time) || Date.now()).toLocaleString('zh-CN', { hour12: false }),
    }
    const where = isGroup
      ? chatName
        ? render(a.where.groupNamed, vars)
        : a.where.groupFallback
      : a.where.private
    // 会话 id 是溯源主键：只有真话题消息才带 thread_id。root_id 在任何回复
    // 场景都会返回——主聊天流里一句普通的引用回复也带 root_id（指向被引用的
    // 那条），拿它当「在话题里」的判据会把主聊天流的回复误标成话题内，thread
    // 一行还会拿到 om_ 消息 id，模型照着跑 msg thread-messages 必然失败。所以
    // 位置与 id 的判定一律看 thread_id；id 本身在下面的 ids 行
    const inThread = isGroup && Boolean(m.thread_id)
    vars.where = where
    vars.scope = isGroup ? render(inThread ? a.scope.thread : a.scope.main, vars) : ''
    return { a, isGroup, inThread, peers, vars }
  }

  /** plain 布局：来源标注 + 协作 id + 身份 + 可@的同伴 + 自定义前缀 */
  buildPrefix({ m, self, userId = '', isBot = false, chatName = '', nick = '', always = '' }) {
    const { a, isGroup, inThread, peers, vars } = this.prefixVars({ m, self, userId, isBot, chatName, nick })
    const origin = isGroup ? render(a.origin.group, vars) : render(a.origin.private, vars)
    const ids = isGroup
      ? inThread
        ? render(a.ids.thread, vars)
        : render(a.ids.main, vars)
      : render(a.ids.private, vars)
    // 私聊里没有群可 @，同伴行是死信息，不拼
    const peersLine = isGroup && peers ? render(a.peers.list, vars) : a.peers.empty || ''
    // 身份行：告诉模型「你是谁」。两个后端都注入了本实例凭证，只是注入点
    // 不同（pi 起子进程时、opencode 起 serve 时），文案按后端选一句；
    // opencode 那句额外提醒「serve 若不是由桥接脚本启动则未注入」。
    // 修的就是「Lil_P 的代理发出的问候以 Lil_O 的应用到达群里」那次事故
    const identity = this.identityLine(self)

    return [origin, ids, identity, peersLine, always].filter(Boolean).join('\n')
  }

  /**
   * xml 布局要填的字段。所有文案仍在 prompts.json：where / scope / sender /
   * senderType 复用 always 组的模板值，身份句用 layout.xml.identityLine，
   * 这里只做取值和分隔符转换，不写任何发给模型的句子。
   *
   * rules = 配置里的 always + once 前缀，一并放进 <profile>：它们本来就是
   * 静态说明，首条发过之后靠会话历史记住，与 once 的省 token 契约一致。
   */
  buildLayoutParts({ m, self, userId = '', isBot = false, chatName = '', nick = '', rules = '', topicLines = '', topicCount = 0 }) {
    const { isGroup, inThread, peers, vars } = this.prefixVars({ m, self, userId, isBot, chatName, nick })
    const { who, app, key } = this.identityParts(self)
    return {
      ...vars,
      isGroup,
      inThread,
      peers: isGroup && peers ? peers.split(' · ').join('，') : '',
      who,
      app,
      identityKey: key,
      rules,
      topicLines,
      topicCount,
    }
  }

  /** 身份文案的变量：两个后端注入点不同，文案按后端选一句 */
  identityParts(self) {
    const a = this.tpl.always
    return {
      who: self?.name || this.cfg.botName || '',
      app: this.cfg.appId ? render(a.identityApp, { appId: this.cfg.appId }) : '',
      key: this.backendType === 'pi' ? 'pi' : 'opencode',
    }
  }

  /**
   * 身份声明行（plain 用）：本机器人是谁、飞书应用是哪个、飞书 CLI 的身份
   * 从哪来。拿不到名字时返回空串（不加行），老行为不变。
   * xml 用的是 layout.xml.identityLine，不带方括号。
   */
  identityLine(self) {
    const { who, app, key } = this.identityParts(self)
    if (!who) return ''
    return render(this.tpl.always.identityLine[key], { who, app })
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
