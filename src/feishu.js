import * as Lark from '@larksuiteoapi/node-sdk'

/**
 * 飞书侧传输层：长连接收事件 + 发/改卡片。
 * 长连接模式不需要公网 IP、不需要内网穿透。
 */
export class FeishuTransport {
  constructor(config, { onMessage, onCardAction, logger = console }) {
    this.cfg = config.feishu
    this.log = logger
    this.onMessage = onMessage
    this.onCardAction = onCardAction

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
      await this.sendText(m.chat_id, `暂不支持 ${m.message_type} 类型消息，请发送文本。`)
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

    // 群聊要求 @ 机器人
    if (m.chat_type === 'group' && this.cfg.requireMention) {
      const mentioned = Array.isArray(m.mentions) && m.mentions.length > 0
      if (!mentioned) return
    }

    await this.onMessage({
      chatId: m.chat_id,
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

  async sendCard(chatId, card) {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    if (res?.code !== 0 && res?.code !== undefined) {
      throw new Error(`发送卡片失败 code=${res.code} msg=${res.msg}`)
    }
    return res?.data?.message_id
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

  async sendText(chatId, text) {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
    if (res?.code !== 0 && res?.code !== undefined) {
      throw new Error(`发送文本失败 code=${res.code} msg=${res.msg}`)
    }
    return res?.data?.message_id
  }

  async stop() {
    await this.ws?.close?.()
  }
}
