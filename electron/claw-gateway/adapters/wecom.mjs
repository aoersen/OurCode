/**
 * 企业微信适配器（Claw 渠道之一）。
 *
 * 入站：自建应用「接收消息」把用户消息推到回调地址（网关内的本地 HTTP 服务器）。
 * 企业微信的报文是 XML + AES（EncodingAESKey，PKCS7 块长 32），签名是
 * sha1(sort(token, timestamp, nonce, 密文))。GET 是配置回调时的 echostr 握手，
 * POST 才是消息本体。
 *
 * 出站：corpid + corpsecret 换 access_token，再调 message/send 往成员发文本。
 * 由于 agent 一轮远超企业微信 5 秒的被动回复窗口，入站一律**先空 200 收下**，
 * 再由上层用 message/send 主动回复（企业微信允许应用主动发消息给成员）。
 */
import { decryptWechatAes, timingSafeEqualStr, wechatSignature, xmlValue } from '../crypto.mjs'

export const meta = { id: 'wecom', loginMode: 'credentials', webhook: true }

const DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com'
const REQUEST_TIMEOUT_MS = 30_000
const TOKEN_EXPIRY_SKEW_MS = 60_000

export function createAdapter(ctx) {
  const emit = ctx.emit
  const log = ctx.log
  const values = ctx.config.values ?? {}

  const apiBase = (values.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '')
  const corpId = String(values.corpId ?? '').trim()
  const corpSecret = String(values.corpSecret ?? '').trim()
  const agentIdRaw = String(values.agentId ?? '').trim()
  const callbackToken = String(values.callbackToken ?? '').trim()
  const encodingAesKey = String(values.encodingAesKey ?? '').trim()

  let state = 'idle'
  let tokenCache = { value: '', expiresAt: 0 }
  let server = null

  function setState(next) {
    if (state === next) return
    state = next
    emit({ event: 'status', state: next, accountId: corpId || undefined })
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

  async function accessToken() {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value
    const { json } = await fetchJson(
      `${apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`,
      { method: 'GET' },
    )
    if (!json || json.errcode !== 0 || !json.access_token) {
      throw new Error(json?.errmsg ? `换取 access_token 失败：${json.errmsg}（errcode=${json.errcode}）` : '换取 access_token 失败')
    }
    tokenCache = {
      value: json.access_token,
      expiresAt: Date.now() + Math.max(60, Number(json.expires_in ?? 7200)) * 1000 - TOKEN_EXPIRY_SKEW_MS,
    }
    return tokenCache.value
  }

  async function handleCallback(req) {
    const result = processWecomCallback(req, { callbackToken, encodingAesKey, corpId }, log)
    if (result.inbound) {
      // 处理与应答分离：先回 200（企业微信 5 秒窗口），入站消息下一 tick 再抛给上层。
      setImmediate(() => emit(result.inbound))
    }
    return result.reply
  }

  return {
    async start() {
      if (!corpId || !corpSecret || !agentIdRaw) {
        emit({ event: 'loginFailed', message: '缺少企业 ID / 应用 Secret / AgentId' })
        setState('disconnected')
        return
      }
      setState('loggingIn')
      try {
        await accessToken()
      } catch (err) {
        emit({ event: 'loginFailed', message: err instanceof Error ? err.message : String(err) })
        setState('disconnected')
        return
      }
      if (!encodingAesKey) {
        emit({ event: 'error', message: '未配置 EncodingAESKey：可以主动发消息，但收不到入站消息' })
      }
      const { createWebhookServer } = await import('../webhook.mjs')
      server = createWebhookServer({
        channel: 'wecom',
        token: ctx.config.webhookToken,
        handler: handleCallback,
        log,
      })
      const bound = await server.start(Number(values.webhookPort) || 0, values.webhookHost || '0.0.0.0')
      emit({ event: 'webhook', url: bound.localUrl })
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
        const token = await accessToken()
        const { status, json } = await fetchJson(`${apiBase}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            touser: to,
            msgtype: 'text',
            agentid: Number(agentIdRaw) || agentIdRaw,
            text: { content: text },
            safe: 0,
          }),
        })
        if (json?.errcode !== 0) {
          return { ok: false, error: json?.errmsg ? `${json.errmsg}（errcode=${json.errcode}）` : `HTTP ${status}` }
        }
        return { ok: true, messageId: String(json?.msgid ?? '') }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    status() {
      return { state, accountId: corpId || undefined }
    },
  }
}

/**
 * 处理一次企业微信回调（纯函数，除日志外无副作用）。
 *
 * 返回 `{ reply, inbound? }`：`reply` 是要写给平台的 HTTP 响应，`inbound` 是解析
 * 出来待抛给上层的入站消息（若有）。把「解析 + 验签 + 解密」与「emit / 定时器」
 * 分开，是为了让这条安全关键路径能离线单测——签名与解密错了就是收别人的消息。
 */
export function processWecomCallback({ method, query, rawBody }, opts, log = () => {}) {
  const { callbackToken, encodingAesKey, corpId } = opts
  const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
  const encrypt = method === 'GET' ? (query.get('echostr') ?? '') : (xmlValue(text, 'Encrypt') ?? '')
  if (!encrypt) return { reply: { status: 400, body: 'missing payload' } }

  if (!callbackToken) {
    // 未配置 Token 时不校验签名：只应出现在本机调试，且要留下痕迹。
    log('未配置回调 Token：跳过签名校验（不推荐，请在企业微信后台配置后填入）')
  } else {
    const expected = wechatSignature([callbackToken, query.get('timestamp'), query.get('nonce'), encrypt])
    if (!timingSafeEqualStr(expected, query.get('msg_signature'))) {
      log('回调签名校验失败，已拒绝')
      return { reply: { status: 401, body: 'bad signature' } }
    }
  }

  if (!encodingAesKey) {
    log('未配置 EncodingAESKey，无法解密回调')
    return { reply: { status: 400, body: 'encoding aes key missing' } }
  }

  let plain
  try {
    plain = decryptWechatAes({ encodingAesKey, encrypt, receiveId: corpId })
  } catch (err) {
    log(`解密回调失败：${err instanceof Error ? err.message : String(err)}`)
    return { reply: { status: 400, body: 'decrypt failed' } }
  }

  // GET = 配置回调地址时的 echostr 握手：原样回明文即可。
  if (method === 'GET') return { reply: { status: 200, body: plain } }

  const inbound = parseWecomMessageXml(plain, log)
  // 空 200：表示「已收到，不被动回复」，企业微信不会再重投；回复由上层主动发出。
  return { reply: { status: 200, body: '' }, ...(inbound ? { inbound } : {}) }
}

/** 企业微信消息 XML → Claw 入站事件（只处理文本，其余记日志后忽略）。 */
export function parseWecomMessageXml(xml, log = () => {}) {
  const msgType = xmlValue(xml, 'MsgType')
  if (msgType !== 'text') {
    log(`忽略非文本消息（MsgType=${msgType ?? '未知'}）`)
    return null
  }
  const from = xmlValue(xml, 'FromUserName') ?? ''
  const content = (xmlValue(xml, 'Content') ?? '').trim()
  if (!from || !content) return null
  const createTime = Number(xmlValue(xml, 'CreateTime') ?? 0)
  return {
    event: 'inbound',
    msgId: xmlValue(xml, 'MsgId') ?? undefined,
    from,
    replyTo: from,
    // 自建应用收到的是成员单聊；群聊需要另外的群机器人/会话能力。
    isGroup: false,
    text: content,
    ts: createTime > 0 ? createTime * 1000 : Date.now(),
  }
}
