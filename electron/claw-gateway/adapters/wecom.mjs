/**
 * 企业微信适配器（Claw 渠道之一）。
 *
 * 用腾讯官方 SDK `@wecom/aibot-node-sdk` 的 **WebSocket 长连接通道**：插件主动
 * 连到 `wss://openws.work.weixin.qq.com` 并发送认证帧，消息经同一条连接双向流
 * 动。因此**不需要公网 IP、域名、回调地址、Token、EncodingAESKey**——使用者只
 * 需要在企业微信后台建一个「智能机器人」并开启 API 模式，拿到机器人 ID + Secret。
 *
 * 能力对应（SDK 提供、我们只做映射）：
 *   - 连接与重连：SDK 内部退避重连，这里把状态翻译成 Claw 的 status 事件；
 *   - 入站：`message` / `message.text` 事件 → Claw inbound；
 *   - 出站：优先用**流式回复**（replyStream）——agent 本来就是一段一段产出的；
 *     `final=true` 时发收尾帧。SDK 对同一 req_id 的回复队列有上限，因此中间帧
 *     走非阻塞版本（排队积压时跳过），最终帧始终发。
 */
export const meta = { id: 'wecom', loginMode: 'credentials' }

/** 流式回复的累计上限：超过就先收尾再开一条新流，避免单条消息无限增长。 */
const STREAM_ROLLOVER_CHARS = 3_500
/** 启动后多久还没连上就提示用户检查凭据（SDK 会继续在内部重连，不打断它）。 */
const CONNECT_HINT_MS = 15_000

/** 企业微信帧 → Claw 入站消息（纯函数，供离线单测）。 */
export function parseWecomFrame(frame) {
  const body = frame?.body ?? {}
  const content = String(body?.text?.content ?? '').trim()
  if (!content) return null
  const isGroup = body?.chattype === 'group'
  return {
    event: 'inbound',
    msgId: body?.msgid,
    from: String(body?.from?.userid ?? ''),
    fromName: body?.from?.name,
    replyTo: String(body?.chatid ?? body?.from?.userid ?? ''),
    isGroup,
    text: content,
    ts: body?.create_time ? Number(body.create_time) * 1000 : Date.now(),
    contextToken: String(frame?.headers?.req_id ?? ''),
    // 企业微信机器人只推「发给它」的消息，群消息视为已提及。
    mentioned: isGroup ? true : undefined,
  }
}

export function createAdapter(ctx) {
  const emit = ctx.emit
  const log = ctx.log
  const values = ctx.config.values ?? {}

  const botId = String(values.botId ?? '').trim()
  const secret = String(values.secret ?? '').trim()

  let client = null
  let state = 'idle'
  /** req_id → 收到的原始帧（被动回复必须透传它）。 */
  const frames = new Map()
  /** req_id → { streamId, text }：流式回复的累计内容。 */
  const streams = new Map()

  function setState(next) {
    if (state === next) return
    state = next
    emit({ event: 'status', state: next, accountId: botId || undefined })
  }

  function rememberFrame(reqId, frame) {
    frames.set(reqId, frame)
    if (frames.size > 200) frames.delete(frames.keys().next().value)
  }

  return {
    async start() {
      if (!botId || !secret) {
        emit({ event: 'loginFailed', message: '缺少机器人 ID / Secret' })
        setState('disconnected')
        return
      }
      setState('loggingIn')
      let WSClient
      try {
        const sdk = await import('@wecom/aibot-node-sdk')
        // SDK 把底层长连接客户端作为具名导出 WSClient（默认导出是更高层的 AiBot）。
        // 这里用 WSClient：replyStream / sendMessage 的语义与返回值都有明确文档。
        WSClient = sdk.WSClient ?? sdk.default
        if (typeof WSClient !== 'function') throw new Error('SDK 未导出可用的客户端类')
      } catch (err) {
        emit({ event: 'loginFailed', message: `企业微信 SDK 加载失败：${err instanceof Error ? err.message : String(err)}` })
        setState('disconnected')
        return
      }

      client = new WSClient({
        botId,
        secret,
        logger: { info: () => {}, debug: () => {}, warn: (m) => log(`warn: ${m}`), error: (m) => log(`error: ${m}`) },
      })

      client.on('connected', () => setState('connected'))
      client.on('authenticated', () => setState('connected'))
      client.on('disconnected', (reason) => {
        log(`连接断开：${reason}`)
        setState('disconnected')
      })
      client.on('reconnecting', (attempt) => log(`重连中（第 ${attempt} 次）`))
      client.on('error', (err) => emit({ event: 'error', message: `企业微信连接错误：${err?.message ?? String(err)}` }))

      const onMessage = (frame) => {
        const reqId = String(frame?.headers?.req_id ?? '')
        if (reqId) rememberFrame(reqId, frame)
        const inbound = parseWecomFrame(frame)
        if (!inbound) {
          log(`忽略非文本消息（msgtype=${frame?.body?.msgtype ?? '未知'}）`)
          return
        }
        emit(inbound)
      }

      client.on('message', onMessage)
      client.on('message.text', onMessage)
      client.connect()

      // 凭据错误时 SDK 只在内部重连、不报错，界面会一直显示「登录中」。超时给一条
      // 明确提示（不停止重连：网络抖动也可能导致慢连上）。
      setTimeout(() => {
        if (state === 'loggingIn') {
          emit({ event: 'error', message: '企业微信连接未在 15 秒内建立：请检查机器人 ID / Secret，或在后台确认机器人已开启 API 模式。' })
        }
      }, CONNECT_HINT_MS)
    },

    async stop() {
      try {
        client?.disconnect()
      } catch (err) {
        log(`断开失败：${err instanceof Error ? err.message : String(err)}`)
      }
      client = null
      frames.clear()
      streams.clear()
      state = 'stopped'
    },

    /**
     * 发文本。首次回复走 replyStream 建立流，后续帧追加，`final=true` 收尾；
     * 拿不到原始帧时退化为 SDK 的主动发送（sendMessage）。
     */
    async sendText({ to, text, contextToken, final }) {
      const reqId = String(contextToken ?? '')
      const frame = reqId ? frames.get(reqId) : undefined
      try {
        if (!frame) {
          await client?.sendMessage(to, { msgtype: 'markdown', markdown: { content: text } })
          return { ok: true }
        }
        const entry = streams.get(reqId) ?? {
          streamId: `claw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: '',
        }
        const nextText = entry.text ? `${entry.text}${text}` : text
        const streamId = entry.streamId

        if (nextText.length > STREAM_ROLLOVER_CHARS && !final) {
          // 单条流太长：先收尾，再开一条新流继续（否则平台侧会截断/拒绝）。
          await client.replyStream(frame.headers, streamId, nextText, true)
          streams.set(reqId, { streamId: `claw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: '' })
          return { ok: true }
        }

        if (entry.text) {
          // 已有流：中间帧用非阻塞版本（上一条未 ack 时跳过），最终帧仍走阻塞版。
          if (final) await client.replyStream(frame.headers, streamId, nextText, true)
          else await client.replyStreamNonBlocking(frame.headers, streamId, nextText, false)
          streams.set(reqId, { streamId, text: nextText })
          return { ok: true }
        }

        await client.replyStream(frame.headers, streamId, nextText, Boolean(final))
        if (final) streams.delete(reqId)
        else streams.set(reqId, { streamId, text: nextText })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    status() {
      return { state, accountId: botId || undefined }
    },
  }
}
