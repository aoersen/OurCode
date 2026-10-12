/**
 * 飞书适配器（Claw 渠道之一）。
 *
 * 用官方 SDK `@larksuiteoapi/node-sdk` 的 **createLarkChannel（WebSocket 传输）**：
 * App ID + App Secret 就够，SDK 负责长连接、重连、消息去重、回复时机（单聊/群聊
 * /@机器人）与流式输出卡片。因此**不需要事件订阅地址、Verification Token、
 * Encrypt Key**。
 *
 * 与接入控制的分工（重要）：SDK 自带一套 policy（requireMention / dmMode /
 * groupAllowlist），若与 Claw 的策略并存会出现「两边都拦、行为不一致」。这里
 * 把 SDK 的策略**显式放开**，把「谁能说话」全部交给 Claw 的接入控制（主进程），
 * SDK 只提供判断结果（mentionedBot / chatType）供我们使用。
 */
export const meta = { id: 'feishu', loginMode: 'credentials' }

/** 飞书规范化消息 → Claw 入站消息（纯函数，供离线单测）。 */
export function parseFeishuMessage(msg) {
  const text = String(msg?.content ?? '').trim()
  if (!text) return null
  const isGroup = msg?.chatType === 'group' || msg?.chatType === 'topic'
  return {
    event: 'inbound',
    msgId: String(msg?.messageId ?? ''),
    from: String(msg?.senderId ?? ''),
    fromName: msg?.senderName,
    replyTo: String(msg?.chatId ?? ''),
    isGroup,
    text,
    ts: msg?.createTime ? Number(msg.createTime) : Date.now(),
    // 用消息 id 当回执令牌：回复走聊天维度即可，飞书不需要透传原始帧。
    contextToken: String(msg?.messageId ?? ''),
    mentioned: isGroup ? Boolean(msg?.mentionedBot) : undefined,
  }
}

export function createAdapter(ctx) {
  const emit = ctx.emit
  const log = ctx.log
  const values = ctx.config.values ?? {}

  const appId = String(values.appId ?? '').trim()
  const appSecret = String(values.appSecret ?? '').trim()

  let channel = null
  let state = 'idle'
  let botName = ''

  function setState(next) {
    if (state === next) return
    state = next
    emit({ event: 'status', state: next, ...(botName ? { accountId: botName } : {}) })
  }

  return {
    async start() {
      if (!appId || !appSecret) {
        emit({ event: 'loginFailed', message: '缺少 App ID / App Secret' })
        setState('disconnected')
        return
      }
      setState('loggingIn')
      let createLarkChannel
      try {
        ;({ createLarkChannel } = await import('@larksuiteoapi/node-sdk'))
      } catch (err) {
        emit({ event: 'loginFailed', message: `飞书 SDK 加载失败：${err instanceof Error ? err.message : String(err)}` })
        setState('disconnected')
        return
      }

      channel = createLarkChannel({
        appId,
        appSecret,
        transport: 'websocket',
        // 接入控制由 Claw 主进程统一负责，这里全部放开（详见文件头注释）。
        policy: { requireMention: false, dmMode: 'open', groupAllowlist: [] },
        source: 'ourcode-ide',
        loggerLevel: 'info',
        logger: { info: () => {}, debug: () => {}, warn: (m) => log(`warn: ${m}`), error: (m) => log(`error: ${m}`) },
      })

      channel.on('message', (msg) => {
        const inbound = parseFeishuMessage(msg)
        if (!inbound) {
          log(`忽略非文本消息（${msg?.rawContentType ?? 'unknown'}）`)
          return
        }
        emit(inbound)
      })
      channel.on('reconnecting', () => setState('disconnected'))
      channel.on('reconnected', () => setState('connected'))
      channel.on('error', (err) => emit({ event: 'error', message: `飞书连接错误：${err?.message ?? String(err)}` }))

      try {
        await channel.connect()
        botName = channel.botIdentity?.name ?? ''
        setState('connected')
      } catch (err) {
        emit({ event: 'loginFailed', message: `飞书连接失败：${err instanceof Error ? err.message : String(err)}` })
        setState('disconnected')
      }
    },

    async stop() {
      try {
        await channel?.disconnect()
      } catch (err) {
        log(`断开失败：${err instanceof Error ? err.message : String(err)}`)
      }
      channel = null
      state = 'stopped'
    },

    /** 发文本：SDK 的 send(to, {text})；飞书侧按 chatId 投递。 */
    async sendText({ to, text }) {
      if (!channel) return { ok: false, error: '通道未连接' }
      try {
        const res = await channel.send(String(to), { text })
        return { ok: true, messageId: String(res?.messageId ?? '') }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    status() {
      return { state, accountId: botName || appId }
    },
  }
}
