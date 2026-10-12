/**
 * QQ 适配器（Claw 渠道之一）。
 *
 * 入站：QQ 机器人开放平台的回调（网关内的本地 HTTP 服务器）。平台用
 * X-Signature-Ed25519 / X-Signature-Timestamp 对 `timestamp + body` 签名：
 * 配置了平台公钥时逐条校验，未配置则接受但记日志（面板会标「来源未验证」）。
 * 回调地址校验（op=13）需要用开发者后台生成的 **Ed25519 私钥种子** 对
 * `event_ts + plain_token` 签名后回传。
 *
 * 出站：AppID + AppSecret 换 AppAccessToken，再调 v2 单聊/群聊消息接口。
 * QQ 的单聊与群消息都属于**被动回复**（必须带 msg_id，且有次数/时限约束），
 * 因此 replyTo 编码为 `user:<openid>` / `group:<group_openid>`，适配器据此选接口。
 */
import { signEd25519, verifyEd25519 } from '../crypto.mjs'

export const meta = { id: 'qq', loginMode: 'credentials', webhook: true }

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const DEFAULT_API_BASE = 'https://api.sgroup.qq.com'
const REQUEST_TIMEOUT_MS = 30_000
const TOKEN_EXPIRY_SKEW_MS = 60_000
/** 同一条被动消息的回复序号（QQ 要求对同一 msg_id 的多次回复递增 msg_seq）。 */
const MAX_MSG_SEQ = 5

export function createAdapter(ctx) {
  const emit = ctx.emit
  const log = ctx.log
  const values = ctx.config.values ?? {}

  const apiBase = (values.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '')
  const appId = String(values.appId ?? '').trim()
  const appSecret = String(values.appSecret ?? '').trim()
  const privateKeySeed = String(values.privateKeySeed ?? '').trim()
  const publicKey = String(values.publicKey ?? '').trim()

  let state = 'idle'
  let tokenCache = { value: '', expiresAt: 0 }
  let server = null
  let sequence = 0
  const msgSeq = new Map()

  function setState(next) {
    if (state === next) return
    state = next
    emit({ event: 'status', state: next, accountId: appId || undefined })
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

  async function appToken() {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value
    const { json } = await fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    })
    if (!json?.access_token) {
      throw new Error(json?.message ? `换取 AppAccessToken 失败：${json.message}` : '换取 AppAccessToken 失败')
    }
    tokenCache = {
      value: json.access_token,
      expiresAt: Date.now() + Math.max(60, Number(json.expires_in ?? 7200)) * 1000 - TOKEN_EXPIRY_SKEW_MS,
    }
    return tokenCache.value
  }

  function verifySignature(headers, rawBody) {
    const signature = String(headers['x-signature-ed25519'] ?? '')
    const timestamp = String(headers['x-signature-timestamp'] ?? '')
    if (!signature || !timestamp) return false
    if (!publicKey) {
      log('未配置平台公钥：跳过回调签名校验（请把平台公钥填入渠道设置以校验来源）')
      return true
    }
    return verifyEd25519({
      publicKeyHex: publicKey,
      message: `${timestamp}${rawBody.toString('utf8')}`,
      signatureHex: signature,
    })
  }

  function emitInbound(type, d) {
    const inbound = parseQqMessage(type, d, log)
    if (inbound) emit(inbound)
  }

  async function handleCallback({ headers, rawBody }) {
    if (!verifySignature(headers, rawBody)) {
      log('回调签名校验失败，已拒绝')
      return { status: 401, body: 'bad signature' }
    }
    let payload = null
    try {
      payload = JSON.parse(rawBody.toString('utf8'))
    } catch {
      return { status: 400, body: 'bad json' }
    }

    // op=13：回调地址校验，用私钥种子对 event_ts + plain_token 签名回传。
    if (payload?.op === 13) {
      const plainToken = String(payload?.d?.plain_token ?? '')
      const eventTs = String(payload?.d?.event_ts ?? '')
      if (!privateKeySeed) {
        log('收到回调地址校验但未配置 Ed25519 私钥种子，无法回签')
        return { status: 400, body: 'private key missing' }
      }
      let signature
      try {
        signature = signEd25519({ privateKeySeedHex: privateKeySeed, message: `${eventTs}${plainToken}` })
      } catch (err) {
        log(`回调校验签名失败：${err instanceof Error ? err.message : String(err)}`)
        return { status: 400, body: 'sign failed' }
      }
      return {
        status: 200,
        body: JSON.stringify({ plain_token: plainToken, signature }),
        contentType: 'application/json',
      }
    }

    if (payload?.op === 0 && typeof payload.t === 'string') {
      setImmediate(() => {
        try {
          emitInbound(payload.t, payload.d)
        } catch (err) {
          log(`emitInbound: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      return { status: 200, body: '{"op":12,"d":{}}', contentType: 'application/json' }
    }

    return { status: 200, body: '{"op":12,"d":{}}', contentType: 'application/json' }
  }

  return {
    async start() {
      if (!appId || !appSecret) {
        emit({ event: 'loginFailed', message: '缺少 AppID / AppSecret' })
        setState('disconnected')
        return
      }
      setState('loggingIn')
      try {
        await appToken()
      } catch (err) {
        emit({ event: 'loginFailed', message: err instanceof Error ? err.message : String(err) })
        setState('disconnected')
        return
      }
      if (!publicKey) {
        emit({ event: 'error', message: '未配置平台公钥：入站回调来源未验证' })
      }
      const { createWebhookServer } = await import('../webhook.mjs')
      server = createWebhookServer({
        channel: 'qq',
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
    async sendText({ to, text, contextToken }) {
      const target = String(to ?? '')
      const isGroup = target.startsWith('group:')
      const openid = target.replace(/^(group|user):/, '')
      if (!openid) return { ok: false, error: `无法解析回复目标：${target}` }
      // 同一 msg_id 的多次回复必须递增 msg_seq（平台限制最多 5 次）。
      const replyId = String(contextToken ?? '')
      const seq = replyId ? (msgSeq.get(replyId) ?? 0) + 1 : 1
      if (replyId) {
        if (seq > MAX_MSG_SEQ) {
          return { ok: false, error: `同一条消息的被动回复已达上限（${MAX_MSG_SEQ} 次）` }
        }
        msgSeq.set(replyId, seq)
        if (msgSeq.size > 500) msgSeq.delete(msgSeq.keys().next().value)
      }
      // 没有 msg_id 时按主动消息发送（单聊/群主动消息有独立配额，可能被平台拒绝）。
      sequence = Math.min(sequence + 1, 1_000_000)
      const body = {
        content: text,
        msg_type: 0,
        ...(replyId ? { msg_id: replyId, msg_seq: seq } : { msg_seq: sequence }),
      }
      try {
        const token = await appToken()
        const path = isGroup ? `/v2/groups/${encodeURIComponent(openid)}/messages` : `/v2/users/${encodeURIComponent(openid)}/messages`
        const { status, json } = await fetchJson(`${apiBase}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `QQBot ${token}`,
            'x-union-appid': appId,
          },
          body: JSON.stringify(body),
        })
        if (status >= 400 || json?.code) {
          const detail = json?.message ?? json?.err_msg ?? `HTTP ${status}`
          return { ok: false, error: `${detail}${json?.code ? `（code=${json.code}）` : ''}` }
        }
        return { ok: true, messageId: String(json?.id ?? '') }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    status() {
      return { state, accountId: appId || undefined }
    },
  }
}

/**
 * QQ 回调载荷 → Claw 入站事件（纯函数）。
 *
 * `replyTo` 编码为 `group:<group_openid>` / `user:<openid>`：QQ 的单聊与群消息走
 * 不同接口，且被动回复必须带 msg_id，适配器据此选接口并把 msg_id 作为回执令牌。
 */
export function parseQqMessage(type, d, log = () => {}) {
  const content = String(d?.content ?? '').replace(/^[\s　]+/, '').trim()
  if (!content) return null
  const ts = d?.timestamp ? Date.parse(String(d.timestamp)) || Date.now() : Date.now()
  if (type === 'C2C_MESSAGE_CREATE') {
    const openid = String(d?.author?.user_openid ?? '')
    if (!openid) return null
    return {
      event: 'inbound',
      msgId: String(d?.id ?? ''),
      from: openid,
      replyTo: `user:${openid}`,
      isGroup: false,
      text: content,
      ts,
      contextToken: String(d?.id ?? ''),
    }
  }
  if (type === 'GROUP_AT_MESSAGE_CREATE') {
    const group = String(d?.group_openid ?? '')
    if (!group) return null
    return {
      event: 'inbound',
      msgId: String(d?.id ?? ''),
      from: String(d?.author?.member_openid ?? ''),
      replyTo: `group:${group}`,
      isGroup: true,
      text: content,
      ts,
      contextToken: String(d?.id ?? ''),
      // 群消息能推给机器人就说明有人 @ 了它。
      mentioned: true,
    }
  }
  log(`忽略事件类型 ${type}`)
  return null
}
