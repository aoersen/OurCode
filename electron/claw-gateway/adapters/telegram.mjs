/**
 * Telegram 适配器（Claw 渠道之一）。
 *
 * Telegram Bot API 全走 HTTPS + 长轮询 getUpdates：**不需要公网回调地址**，
 * 因此在内网/无公网入口的机器上也能用（可用 apiBase 指向自建反代）。
 *
 * 群聊说明：Bot API 默认开启 privacy mode，机器人只能收到 @它 或回复它的消息；
 * 适配器据此把 text 里 `@botusername` 前缀剥掉，并把 mentioned 置位，交给
 * 接入控制策略判定（"群聊需 @ 提及" 因此天然成立）。
 */
export const meta = { id: 'telegram', loginMode: 'credentials', webhook: false }

/** 长轮询单次等待秒数（Telegram 上限 50；25 秒便于 shutdown 及时收尾）。 */
const POLL_TIMEOUT_S = 25
const REQUEST_TIMEOUT_MS = 60_000
/** 单次失败后的退避下限，避免网络中断时空转打满 CPU。 */
const RETRY_DELAY_MS = 3_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @ 提及实体（type=mention 的 text 片段形如 "@botname"）。 */
function stripBotMention(text, botUsername) {
  if (!botUsername || !text) return { text, mentioned: false }
  const needle = `@${botUsername}`
  const lower = text.toLowerCase()
  const idx = lower.indexOf(needle.toLowerCase())
  if (idx < 0) return { text, mentioned: false }
  const stripped = `${text.slice(0, idx)}${text.slice(idx + needle.length)}`.replace(/\s{2,}/g, ' ').trim()
  return { text: stripped, mentioned: true }
}

export function createAdapter(ctx) {
  const emit = ctx.emit
  const log = ctx.log
  const values = ctx.config.values ?? {}

  const apiBase = (values.apiBase || 'https://api.telegram.org').replace(/\/+$/, '')
  const token = String(values.botToken ?? '').trim()

  let offset = 0
  let running = false
  let aborted = false
  let loopPromise = null
  let bot = null // { id, username, firstName }
  let state = 'idle'
  let stopController = null

  function setState(next, extra = {}) {
    if (state === next && !extra.accountId) return
    state = next
    emit({ event: 'status', state: next, ...(bot ? { accountId: String(bot.id) } : {}), ...extra })
  }

  async function call(method, payload, { timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
    const url = `${apiBase}/bot${token}/${method}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      })
      const json = await res.json().catch(() => null)
      if (!json || typeof json !== 'object') throw new Error(`响应不是 JSON（HTTP ${res.status}）`)
      if (!json.ok) {
        throw new Error(`${json.description ?? 'Telegram API 返回失败'}${json.error_code ? `（${json.error_code}）` : ''}`)
      }
      return json.result
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  function emitInbound(msg) {
    const chat = msg.chat ?? {}
    const from = msg.from ?? {}
    const rawText = typeof msg.text === 'string' ? msg.text : ''
    const isGroup = chat.type === 'group' || chat.type === 'supergroup'
    const { text, mentioned } = isGroup
      ? stripBotMention(rawText, bot?.username)
      : { text: rawText, mentioned: false }
    if (!text) return
    const fromName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || ''
    emit({
      event: 'inbound',
      msgId: String(msg.message_id ?? ''),
      from: String(from.id ?? chat.id ?? ''),
      fromName: fromName || undefined,
      replyTo: String(chat.id ?? from.id ?? ''),
      isGroup,
      text,
      ts: msg.date ? msg.date * 1000 : Date.now(),
      contextToken: String(msg.message_id ?? ''),
      mentioned: isGroup ? mentioned || undefined : undefined,
    })
  }

  async function loop() {
    running = true
    // 长轮询的取消信号贯穿整轮循环：shutdown 时立刻中断在途请求。
    const signal = stopController.signal
    while (running && !aborted) {
      try {
        const updates = await call(
          'getUpdates',
          { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
          { timeoutMs: (POLL_TIMEOUT_S + 10) * 1000, signal },
        )
        setState('connected')
        for (const update of updates ?? []) {
          if (typeof update.update_id === 'number') offset = update.update_id + 1
          const msg = update.message ?? update.edited_message
          if (msg) emitInbound(msg)
        }
      } catch (err) {
        if (aborted || signal.aborted) break
        const message = err instanceof Error ? err.message : String(err)
        // 401/404 说明 token 无效：明确报错并停下，别用错 token 无限重试。
        if (/401|404|Unauthorized|Not Found/i.test(message)) {
          emit({ event: 'loginFailed', message: `Bot Token 无效：${message}` })
          setState('disconnected')
          running = false
          break
        }
        log(`getUpdates: ${message}`)
        setState('disconnected')
        await sleep(RETRY_DELAY_MS)
      }
    }
    if (!aborted) setState('idle')
  }

  return {
    async start() {
      if (running) return
      try {
        bot = await call('getMe')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit({ event: 'loginFailed', message: `Telegram 连接失败：${message}` })
        setState('disconnected')
        return
      }
      emit({ event: 'webhook', url: null })
      stopController = new AbortController()
      // 丢弃停机期间堆积的旧消息：只处理启动之后到达的消息。
      try {
        const pending = await call('getUpdates', { offset: -1, timeout: 0 })
        for (const update of pending ?? []) {
          if (typeof update.update_id === 'number') offset = update.update_id + 1
        }
      } catch {
        // 拉不到就从头开始，长轮询本身会重投
      }
      loopPromise = loop().catch((err) => log(`loop: ${err instanceof Error ? err.message : String(err)}`))
    },
    async stop() {
      running = false
      aborted = true
      if (stopController) {
        stopController.abort()
        stopController = null
      }
      if (loopPromise) await loopPromise.catch(() => {})
      state = 'stopped'
    },
    async sendText({ to, text }) {
      try {
        const result = await call('sendMessage', { chat_id: to, text, disable_web_page_preview: true })
        return { ok: true, messageId: String(result?.message_id ?? '') }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    status() {
      return { state, accountId: bot ? String(bot.id) : undefined }
    },
  }
}
