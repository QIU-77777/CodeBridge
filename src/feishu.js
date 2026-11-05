import * as Lark from '@larksuiteoapi/node-sdk'

/**
 * 飞书侧传输层：长连接收事件 + 发/改卡片。
 * 长连接模式不需要公网 IP、不需要内网穿透。
 */
export class FeishuTransport {
  constructor(config, { onMessage, onCardAction, onTopicKnown, logger = console }) {
    this.cfg = config.feishu
    this.log = logger
    this.onMessage = onMessage
    this.onCardAction = onCardAction
    /** 话题里已经绑过会话就返回 true（用于话题内免 @） */
    this.onTopicKnown = onTopicKnown

    this.client = new Lark.Client({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      domain: this.cfg.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn,
    })
  }

  async start() {
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

  async handleImMessage(data) {
    const m = data?.message
    if (!m) return
    if (m.message_type !== 'text') {
      const replyTo = m.chat_type === 'group' ? m.root_id || m.message_id : null
      await this.sendText(m.chat_id, `暂不支持 ${m.message_type} 类型消息，请发送文本。`, { replyTo })
      return
    }
    let text = ''
    try {
      text = JSON.parse(m.content || '{}').text || ''
    } catch {
      text = ''
    }
    // 去掉 @机器人 占位符（@_user_1 形式）
    text = text.replace(/@_user_\d+/g, '').trim()
    if (!text) return

    /**
     * 群里一条话题 = 一个会话。话题的「根」就是那条被回复的消息：
     *   - 已经在话题里的消息：root_id 指向话题根
     *   - 主聊天流里新 @ 的消息：root_id 为空，它自己就成为新话题的根
     * 两种情况的键用同一个公式，所以开完话题不需要再改绑定。
     */
    const isGroup = m.chat_type === 'group'
    const rootId = isGroup ? m.root_id || m.message_id : null
    const key = isGroup ? `root:${rootId}` : m.chat_id
    const threadId = m.thread_id || null

    // 群聊要求 @ 机器人
    if (isGroup && this.cfg.requireMention) {
      const mentioned = Array.isArray(m.mentions) && m.mentions.length > 0
      // 已经服务过的话题里继续说话，不用再 @ 一次 —— 否则每句话都要点一次机器人，没法用
      const known = !mentioned && this.onTopicKnown?.({ key })
      if (!mentioned && !known) return
    }

    // 群消息记一行原始上下文：话题绑定要看 thread_id / root_id，
    // 出了问题先看这行，不用再去翻飞书后台的事件原始包。
    if (isGroup) {
      this.log.info(
        `[group] chat=${String(m.chat_id).slice(-6)} key=${key} thread=${threadId || '-'} ` +
          `root=${m.root_id || '-'} parent=${m.parent_id || '-'} msg=${m.message_id}`,
      )
    }

    await this.onMessage({
      chatId: m.chat_id,
      key,
      rootId,
      threadId,
      isGroup,
      userId: data?.sender?.sender_id?.open_id || data?.sender?.sender_id?.user_id || '',
      text,
      messageId: m.message_id,
      chatType: m.chat_type,
    })
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
      const res = await this.client.im.v1.message.reply({
        path: { message_id: replyTo },
        data: { msg_type: msgType, content, reply_in_thread: true },
      })
      if (res?.code !== 0 && res?.code !== undefined) {
        throw new Error(`发送消息失败 code=${res.code} msg=${res.msg}`)
      }
      return res?.data?.message_id
    }
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: msgType, content },
    })
    if (res?.code !== 0 && res?.code !== undefined) {
      throw new Error(`发送消息失败 code=${res.code} msg=${res.msg}`)
    }
    return res?.data?.message_id
  }

  async sendCard(chatId, card, { replyTo = null } = {}) {
    return this._send(chatId, 'interactive', JSON.stringify(card), replyTo)
  }

  async patchCard(messageId, card) {
    const res = await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })
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
