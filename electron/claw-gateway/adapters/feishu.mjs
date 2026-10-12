/**
 * 飞书适配器（Claw 渠道之一）。
 *
 * 入站：飞书开放平台「事件订阅」把 im.message.receive_v1 推到回调地址（网关内
 * 的本地 HTTP 服务器，见 webhook.mjs）。开启事件加密时回调体是 {encrypt}，
 * 用 Encrypt Key 按 AES-256-CBC 解密（见 crypto.mjs）；无论是否加密，都要先应答
 * 平台的 url_verification 握手。
 *
 * 出站：用 app_id/app_secret 换 tenant_access_token，再调 IM API 往 chat_id
 * 发文本。群聊里必须 @ 机器人才会收到事件（飞书只推 @机器人 的群消息），
 * 适配器把 `@_user_N` 占位符剥掉并置 mentioned。
 */
import { decryptFeishu } from '../crypto.mjs'

export const meta = { id: 'feishu', loginMode: 'credentials', webhook: true }

const DEFAULT_API_BASE = 'https://open.feishu.cn'
const REQUEST_TIMEOUT_MS = 30_000
/** tenant_access_token 提前 60 秒续期，避免边界过期。 */
const TOKEN_EXPIRY_SKEW_MS = 60_000

export function createAdapter(ctx) {
  const emit = ctx.emit
  const log = ctx.log
  const values = ctx.config.values ?? {}

  const apiBase = (values.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '')
  const appId = String(values.appId ?? '').trim()
  const appSecret = String(values.appSecret ?? '').trim()
  const encryptKey = String(values.encryptKey ?? '').trim()
  const verificationToken = String(values.verificationToken ?? '').trim()

  let state = 'idle'
  let tokenCache = { value: '', expiresAt: 0 }
  let botOpenId = ''
  let botName = ''
  let server = null
  let localUrl = null

  function setState(next) {
    if (state === next) return
    state = next
    emit({ event: 'status', state: next, ...(botName ? { accountId: botName } : {}) })
  }

  async function fetchJson(url, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      const json = await res.json().catch(() => null)
      return { status: res.status, json }
    } finally {
      clearTimeout(timer)
    }
  }

  async function tenantToken() {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value
    const { json } = await fetchJson(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    if (!json || json.code !== 0 || !json.tenant_access_token) {
      throw new Error(json?.msg ? `换取 tenant_access_token 失败：${json.msg}（code=${json.code}）` : '换取 tenant_access_token 失败')
    }
    tokenCache = {
      value: json.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, Number(json.expire ?? 7200)) * 1000 - TOKEN_EXPIRY_SKEW_MS,
    }
    return tokenCache.value
  }

  /** 机器人自身信息：取 open_id 用于判断群里是否 @ 了机器人。 */
  async function loadBotInfo() {
    try {
      const token = await tenantToken()
      const { json } = await fetchJson(`${apiBase}/open-apis/bot/v3/info`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      })
      const info = json?.bot
      if (info?.open_id) {
        botOpenId = info.open_id
        botName = String(info.app_name ?? '') || appId
      }
    } catch (err) {
      log(`loadBotInfo: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleCallback({ method, rawBody }) {
    const result = processFeishuCallback(
      { method, rawBody },
      { encryptKey, verificationToken, botOpenId },
      log,
    )
    if (result.inbound) {
      // 先回 200 再去处理：飞书 3 秒内要求响应，而 agent 可能要跑很久。
      setImmediate(() => emit(result.inbound))
    }
    return result.reply
  }

  return {
    async start() {
      if (!appId || !appSecret) {
        emit({ event: 'loginFailed', message: '缺少 App ID / App Secret' })
        setState('disconnected')
        return
      }
      setState('loggingIn')
      try {
        await tenantToken()
      } catch (err) {
        emit({ event: 'loginFailed', message: err instanceof Error ? err.message : String(err) })
        setState('disconnected')
        return
      }
      await loadBotInfo()
      const { createWebhookServer } = await import('../webhook.mjs')
      server = createWebhookServer({
        channel: 'feishu',
        token: ctx.config.webhookToken,
        handler: handleCallback,
        log,
      })
      const bound = await server.start(Number(values.webhookPort) || 0, values.webhookHost || '0.0.0.0')
      localUrl = bound.localUrl
      emit({ event: 'webhook', url: localUrl })
      setState('connected')
    },
    async stop() {
      if (server) {
        await server.stop()
        server = null
      }
      state = 'stopped'
    },
    async sendText({ to, text }) {
      try {
        const token = await tenantToken()
        const { status, json } = await fetchJson(`${apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
          body: JSON.stringify({ receive_id: to, msg_type: 'text', content: JSON.stringify({ text }) }),
        })
        if (json?.code !== 0) {
          return { ok: false, error: json?.msg ? `${json.msg}（code=${json.code}, HTTP ${status}）` : `HTTP ${status}` }
        }
        return { ok: true, messageId: String(json?.data?.message_id ?? '') }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    status() {
      return { state, accountId: botOpenId || undefined }
    },
  }
}

/**
 * 处理一次飞书事件回调（纯函数）。
 *
 * 覆盖三种输入：加密报文（用 Encrypt Key 解）、`url_verification` 握手（回
 * challenge）、以及普通事件（校验 Verification Token 后取出文本消息）。
 * 解析与「emit / 应答」分开，是为了让这条路径能离线单测。
 */
export function processFeishuCallback({ method, rawBody }, opts, log = () => {}) {
  const { encryptKey, verificationToken, botOpenId = '' } = opts
  const textBody = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
  let payload = null
  try {
    payload = JSON.parse(textBody)
  } catch {
    return { reply: { status: 400, body: 'bad json' } }
  }

  if (payload && typeof payload.encrypt === 'string') {
    if (!encryptKey) {
      log('收到加密回调但没有配置 Encrypt Key，已丢弃')
      return { reply: { status: 400, body: 'encrypt key missing' } }
    }
    try {
      payload = JSON.parse(decryptFeishu({ encryptKey, encrypt: payload.encrypt }))
    } catch (err) {
      log(`解密回调失败：${err instanceof Error ? err.message : String(err)}`)
      return { reply: { status: 400, body: 'decrypt failed' } }
    }
  }
  if (!payload || typeof payload !== 'object') return { reply: { status: 400, body: 'bad payload' } }

  // URL 校验握手。
  if (payload.type === 'url_verification' && payload.challenge) {
    if (verificationToken && String(payload.token ?? '') !== verificationToken) {
      log('url_verification 的 token 与配置不一致，已拒绝')
      return { reply: { status: 401, body: 'token mismatch' } }
    }
    return {
      reply: { status: 200, body: JSON.stringify({ challenge: payload.challenge }), contentType: 'application/json' },
    }
  }

  const header = payload.header ?? {}
  if (verificationToken && String(header.token ?? '') !== verificationToken) {
    log('事件回调的 token 与配置不一致，已拒绝')
    return { reply: { status: 401, body: 'token mismatch' } }
  }

  if (header.event_type === 'im.message.receive_v1') {
    const inbound = parseFeishuMessage(payload.event?.message, payload.event?.sender, botOpenId, log)
    return { reply: { status: 200, body: '{}', contentType: 'application/json' }, ...(inbound ? { inbound } : {}) }
  }

  log(`忽略事件类型 ${header.event_type ?? '(未知)'}`)
  return { reply: { status: 200, body: '{}', contentType: 'application/json' } }
}

/** 飞书消息事件 → Claw 入站事件（只处理文本消息）。 */
export function parseFeishuMessage(message, sender, botOpenId = '', log = () => {}) {
  if (message?.message_type !== 'text') {
    log(`忽略非文本消息（message_type=${message?.message_type ?? '未知'}）`)
    return null
  }
  let parsed = {}
  try {
    parsed = JSON.parse(String(message.content ?? '{}'))
  } catch {
    return null
  }
  const { text, mentioned } = normalizeFeishuText(String(parsed?.text ?? ''), message.mentions, botOpenId)
  if (!text) return null
  const isGroup = message.chat_type === 'group'
  return {
    event: 'inbound',
    msgId: String(message.message_id ?? ''),
    from: String(sender?.sender_id?.open_id ?? ''),
    replyTo: String(message.chat_id ?? ''),
    isGroup,
    text,
    ts: message.create_time ? Number(message.create_time) : Date.now(),
    contextToken: String(message.message_id ?? ''),
    mentioned: isGroup ? mentioned : undefined,
  }
}

/** 剥离飞书文本里的 @ 占位符（@_user_1），返回 {text, mentioned}。 */
export function normalizeFeishuText(content, mentions, botOpenId = '') {
  let text = content
  const list = Array.isArray(mentions) ? mentions : []
  // 机器人自身 open_id 拿不到时退化为「有 @ 即视为提及」——群里能收到事件本身
  // 就说明有人在 @ 机器人（飞书只推 @机器人 的群消息）。
  const mentioned = list.some((m) => !botOpenId || String(m?.id?.open_id ?? '') === botOpenId)
  for (const m of list) {
    const key = String(m?.key ?? '')
    if (key && text.includes(key)) text = text.split(key).join(' ')
  }
  return { text: text.replace(/\s{2,}/g, ' ').trim(), mentioned }
}
