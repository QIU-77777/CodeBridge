import * as Lark from '@larksuiteoapi/node-sdk'

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
  constructor(config, { onMessage, onCardAction, nameOf, onSeenNames, onContactKind, onSelf, backendType = '', logger = console }) {
    this.cfg = config.feishu
    // prompt 前缀配置（src/config.js 的 prompt 段）：来源标注是每条消息都带的
    // 动态数据，协作规则这类静态说明走 once 模式，每个会话只带一次
    this.promptCfg = config.prompt || {}
    this.log = logger
    this.onMessage = onMessage
    this.onCardAction = onCardAction
    /** open_id -> 显示名；拿不到就空串，标注里退回只显示 id */
    this.nameOf = nameOf
    /** 把消息 mentions 里的 (open_id, name) 交给上层攒起来 */
    this.onSeenNames = onSeenNames
    /** 补充通讯录条目的「人是机器人」：只说它见过面的类型，不建册 */
    this.onContactKind = onContactKind
    /** 解析出自身 open_id 时通知上层：用于把存量数据里的「自己」清出通讯录 */
    this.onSelf = onSelf
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
    // 身份一到手就清掉通讯录里的「自己」：机器人被 @ 时自己也在 mentions 里，
    // 老版本没排除，存量数据留着这一条。收集端已修，这里清存量
    if (this.self.open_id) this.onSelf?.(this.self.open_id)
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
      // 一次拿到的全家名字顺手交给上层存起来，下次连接口都不用打
      if (map.size) this.onSeenNames?.([...map].map(([id, name]) => ({ openId: id, name })))
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

    // 只抹掉 @我自己 的占位符；@别人 保留成 @名字。
    // 否则模型既不知道被 @ 的是谁，也不知道这句话是冲谁说的。
    let text = raw
    for (const mt of mentions) {
      if (!mt?.key) continue
      text = text.split(mt.key).join(mt === selfMention ? '' : `@${mt.name || '某人'}`)
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

    // 顺手把这条消息里被 @ 的人记下来。飞书没有「open_id 反查名字」的接口
    // （contact 对机器人 open_id 直接 41050），mentions 里的 name 是唯一免费来源。
    // 排除自己：机器人被 @ 时自己也在 mentions 里，入册了通讯录就会把自己
    // 列成「一个需要放行的同伴」，没有意义
    if (this.onSeenNames && mentions.length) {
      this.onSeenNames(
        mentions
          .map((x) => ({ openId: x?.id?.open_id, name: x?.name }))
          .filter((x) => x.openId && x.name && x.id?.open_id !== self.open_id),
      )
    }

    // 发送者的类型（人 / 机器人）补充进通讯录。只更新已入册的条目、不建册——
    // 入册只认被 @（见 store.learnContact）。机器人被 @ 之后通常就会在群里说话，
    // 说过一次话它的 kind 就准了，admin 的通讯录图标才有东西可显示。
    // 自己不入册，所以这里也不用排除
    this.onContactKind?.(userId, isBot ? 'app' : 'user')

    /**
     * 给模型标一行来源。
     *
     * 以前只发正文，模型看到的就是一句光秃秃的中文，于是它得靠 `ls` / 读仓库
     * 反推「我在哪儿、谁在跟我说话」—— 实测一次打招呼花了 9 分 12 秒、48 步。
     * 把来源和发送者 open_id 一并给出来：既省掉这轮探索，也让它有能力 @ 回去
     * （@ 某人需要对方完整的 open_id，靠猜是猜不到的）。
     *
     * 名字能攒到就带名字，攒不到就只给 id —— id 必须完整，截断了就 @ 不回去。
     */
    const chatName = isGroup ? await this.resolveChatName(m.chat_id) : ''
    const where = isGroup ? (chatName ? `群「${chatName}」` : '群聊') : '私聊'
    const scope = isGroup ? (m.root_id ? '话题内' : '主聊天流') : ''
    const when = new Date(Number(m.create_time) || Date.now()).toLocaleString('zh-CN', { hour12: false })
    const nick = (await this.resolveSenderName(m.chat_id, userId)) || ''
    const sender = nick ? `${nick} · ${userId}` : userId || '未知'
    const origin =
      `[飞书 · ${where}${scope ? ` · ${scope}` : ''} · ` +
      `发送者 ${sender}（${isBot ? '机器人' : '用户'}） · ${when}]`
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
      messageId: m.message_id,
      chatType: m.chat_type,
    })
  }

  /**
   * 协作机制说明：怎么唤醒另一个 agent。
   *
   * 唯一的方法是某一方用飞书 CLI 发一条**新的 text 消息**，内容里带真正的
   * at 标签。写在卡片正文或普通文本里的 `@名字` 只是字面字符，不产生飞书提醒
   * ——这条规则不可能靠模型自己悟出来，而 agent 之间的每次对话都要用它。
   *
   * 光说「要发真 mention」不够：实测 agent 知道规则却发不出来，因为它同时缺
   * 两样东西——对方的 open_id（按应用隔离，没有按名查的接口）和 at 标签的
   * 命令写法。所以这行把命令模板、id 来源、拿不到时的出路一次给全：
   *
   *   - id 来源只有两类：它给你发过的消息（「发送者」标注）、它被 @ 到的消息
   *     （mentions）。桥接把两类都存进了通讯录（$OCB_CONFIG_DIR/state.json 的
   *     contacts），先读那里；没有再让人类转发，不要猜 id。
   *   - at 标签必须写在 --text 里，open_id 从通讯录查；话题内用 --reply 回到
   *     同一个话题。命令模板照抄，只替换 id。
   */
  collabLine() {
    return (
      '[协作 · 唤醒另一个 agent 的唯一方法：用 feishu-cli 发一条带 at 标签的新 text 消息。' +
      '命令模板（只替换 open_id，其余照抄）：feishu-cli msg send --receive-id <群 chat_id> --receive-id-type chat_id ' +
      '--text \'<at user_id="对方 open_id"></at> 要说的话\'。' +
      '对方 open_id 只认本应用视角，来源只有两类：它给你发过的消息（本行上方「发送者」标注）或它被 @ 到的消息（mentions）；' +
      '两类桥接都已存进 $OCB_CONFIG_DIR/state.json 的 contacts，先读那里。' +
      '通讯录里没有的对象，飞书没有按应用查机器人 open_id 的接口，你拿不到——请人类在中间转发，不要猜 id、也不要用普通文本 @名字 冒充（那只是字面字符，唤不醒任何人）。' +
      '在话题里发言要用 --reply 回复该话题内已有的一条 om_ 消息，不要新开发布到主聊天流。' +
      '你的终态回复呈现在卡片上，卡片不唤醒任何人]'
    )
  }

  /**
   * 把配置里的 prompt 前缀按模式分成两堆。
   *
   * always：每条消息都拼——静态文本（用户自定义条目）并进来源标注那段。
   * once：每个会话的第一条消息拼一次——由上层在新建会话时决定要不要拼。
   *
   * 内置的 `rules` 条目：text 留空用内置默认（collabLine），填写则覆盖；
   * 只在群里拼（私聊没有同伴）。自定义条目纯静态文本，两种模式都生效。
   * 删掉某个条目就是关闭它——所以这里不做任何「必须有一个」的兜底。
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
        text = p.text || this.collabLine()
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
    const app = this.cfg.appId ? `（飞书应用 ${this.cfg.appId}）` : ''
    if (this.backendType === 'pi') {
      return `[身份 · 你是 ${who}${app} · 桥接已为本进程注入你的飞书凭证，用 feishu-cli / lark-cli 发言就是以你的身份发出]`
    }
    return `[身份 · 你是 ${who}${app} · 本机飞书 CLI 的默认身份以机器配置为准，不一定是你的应用，发言前请核对]`
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
