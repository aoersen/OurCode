/**
 * Telegram 适配器（Claw 渠道之一）。
 *
 * 用成熟库 grammY + **长轮询（getUpdates）**：一条 Bot Token 就能跑，不需要公网
 * 地址、不需要 setWebhook。群聊里 Telegram 只把 @机器人 或回复机器人的消息推给
 * 我们（Bot API 的 privacy mode），因此 mentioned 直接按「群消息即提及」处理，
 * 由 Claw 的接入控制决定是否真的应答。
 */
export const meta = { id: 'telegram', loginMode: 'credentials' }

/** grammY 上下文 → Claw 入站消息（纯函数，供离线单测）。 */
export function parseTelegramContext(ctx) {
  const message = ctx?.message
  const text = String(message?.text ?? '').trim()
  if (!text) return null
  const chat = message?.chat ?? {}
  const from = message?.from ?? {}
  const isGroup = chat.type === 'group' || chat.type === 'supergroup'
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || ''
  return {
    event: 'inbound',
    msgId: String(message.message_id ?? ''),
    from: String(from.id ?? chat.id ?? ''),
    fromName: name || undefined,
    replyTo: String(chat.id ?? from.id ?? ''),
    isGroup,
    text,
    ts: message?.date ? message.date * 1000 : Date.now(),
    contextToken: String(message.message_id ?? ''),
    mentioned: isGroup ? true : undefined,
  }
}

export function createAdapter(ctx) {
  const emit = ctx.emit
  const log = ctx.log
  const values = ctx.config.values ?? {}

  const token = String(values.botToken ?? '').trim()

  let bot = null
  let state = 'idle'
  let botName = ''
  let me = null

  function setState(next) {
    if (state === next) return
    state = next
    emit({ event: 'status', state: next, ...(me?.id ? { accountId: String(me.id) } : {}) })
  }

  return {
    async start() {
      if (!token) {
        emit({ event: 'loginFailed', message: '缺少 Bot Token' })
        setState('disconnected')
        return
      }
      setState('loggingIn')
      let Bot
      try {
        ;({ Bot } = await import('grammy'))
      } catch (err) {
        emit({ event: 'loginFailed', message: `grammY 加载失败：${err instanceof Error ? err.message : String(err)}` })
        setState('disconnected')
        return
      }

      bot = new Bot(token)
      // grammY 会把 poll 期间的一切异常交给 catch；不接住会直接崩掉进程。
      bot.catch((err) => log(`poll 错误：${err?.error?.message ?? err?.message ?? String(err)}`))

      bot.on('message:text', (ctxMsg) => {
        const inbound = parseTelegramContext(ctxMsg)
        if (!inbound) return
        emit(inbound)
      })

      try {
        me = await bot.api.getMe()
        botName = me.username ?? me.first_name ?? ''
        emit({ event: 'status', state: 'connected', accountId: String(me.id) })
        state = 'connected'
      } catch (err) {
        emit({ event: 'loginFailed', message: `Telegram 连接失败：${err instanceof Error ? err.message : String(err)}` })
        setState('disconnected')
        return
      }

      // 长轮询：不 await（它会一直跑），停机时用 bot.stop() 结束。
      void bot.start({ drop_pending_updates: true, onStart: () => log('长轮询已启动') })
    },

    async stop() {
      try {
        // grammY 的 stop() 只置信号，待当前长轮询返回；超时由宿主兜底强杀。
        await bot?.stop()
      } catch (err) {
        log(`停止失败：${err instanceof Error ? err.message : String(err)}`)
      }
      bot = null
      state = 'stopped'
    },

    /** 发文本：chatId 直接来自 replyTo。 */
    async sendText({ to, text }) {
      if (!bot) return { ok: false, error: '通道未连接' }
      try {
        const sent = await bot.api.sendMessage(String(to), text, { link_preview_options: { is_disabled: true } })
        return { ok: true, messageId: String(sent?.message_id ?? '') }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    status() {
      return { state, accountId: me?.id ? String(me.id) : undefined }
    },
  }
}
