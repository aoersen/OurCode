/**
 * QQ 适配器（Claw 渠道之一）。
 *
 * QQ 官方 SDK 只有「QQ 频道」那一代（`@tencent-connect/bot-node-sdk`），社区包
 * （如 @karinjs/adapter-qqbot）绑死各自的 bot 框架、不能作为独立 SDK 使用，因此
 * 这里直接按官方公开协议实现 **WebSocket 网关**：
 *
 *   1. POST https://bots.qq.com/app/getAppAccessToken { appId, clientSecret } → access_token
 *   2. GET  https://api.sgroup.qq.com/gateway  （Authorization: QQBot <token>）→ wss url
 *   3. WS：op10 HELLO → op2 IDENTIFY（intents = GROUP_AND_C2C_EVENT）→ op0 dispatch；
 *      心跳 op1 按服务端给的间隔发，op11 ack；op7 重连，op9 重新鉴权
 *   4. 回复：POST /v2/users/{openid}/messages 或 /v2/groups/{group_openid}/messages
 *      （被动回复必须带 msg_id，同一 msg_id 多次回复要递增 msg_seq）
 *
 * 于是使用者只需要 AppID + AppSecret：**不需要回调地址、不需要 HTTPS 证书、
 * 不需要 Ed25519 密钥**。QQ 的平台行为细节多（配额、被动回复时限），因此标注
 * 为 beta——需要真实账号联调才能确认，配置文件里不含任何回调参数。
 */
import { WebSocket } from 'ws'

export const meta = { id: 'qq', loginMode: 'credentials' }

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'
const REQUEST_TIMEOUT_MS = 20_000
/** 提前 60 秒续期 access_token。 */
const TOKEN_EXPIRY_SKEW_MS = 60_000
/** 群与单聊消息事件（GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE）。 */
const INTENT_GROUP_AND_C2C = 1 << 25
/** 同一 msg_id 的被动回复上限（平台限制 5 次）。 */
const MAX_MSG_SEQ = 5

/** 心跳帧（op1）。导出供单测。 */
export function buildHeartbeat(d = null) {
  return { op: 1, d }
}

/** 鉴权帧（op2）。intents 只订阅群/单聊消息，避免拿到无关事件。导出供单测。 */
export function buildIdentify(token, shard = [0, 1]) {
  return { op: 2, d: { token: `QQBot ${token}`, intents: INTENT_GROUP_AND_C2C, shard, properties: { $os: process.platform, $device: 'ourcode-ide' } } }
}

/** 会话恢复帧（op6）：断线后带着 session_id + 最后序号续传，避免漏消息。导出供单测。 */
export function buildResume(token, sessionId, seq) {
  return { op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq } }
}

/**
 * 网关事件 → Claw 入站消息（纯函数，供离线单测）。
 * replyTo 编码为 `group:<group_openid>` / `user:<openid>`：QQ 的单聊与群消息走
 * 不同接口，且被动回复必须带 msg_id（作为回执令牌）。
 */
export function parseQqGatewayEvent(type, d) {
  const content = String(d?.content ?? '').replace(/^[\s\u3000]+/, '').trim()
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
  return null
}

export function createAdapter(ctx) {
  const emit = ctx.emit
  const log = ctx.log
  const values = ctx.config.values ?? {}

  const appId = String(values.appId ?? '').trim()
  const appSecret = String(values.appSecret ?? '').trim()
  const sandbox = String(values.sandbox ?? '').toLowerCase() === 'true' || String(values.sandbox ?? '') === '1'
  const apiBase = sandbox ? SANDBOX_API_BASE : API_BASE

  let state = 'idle'
  let ws = null
  let tokenCache = { value: '', expiresAt: 0 }
  let heartbeatTimer = null
  let sessionId = null
  let lastSeq = 0
  let stopping = false
  let reconnectAttempts = 0
  const msgSeq = new Map()

  function setState(next) {
    if (state === next) return
    state = next
    emit({ event: 'status', state: next, accountId: appId || undefined })
  }

  async function fetchJson(url, init = {}) {
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

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function startHeartbeat(intervalMs) {
    clearHeartbeat()
    const interval = Math.max(5_000, Number(intervalMs) || 30_000)
    heartbeatTimer = setInterval(() => {
      try {
        ws?.send(JSON.stringify(buildHeartbeat(lastSeq || null)))
      } catch (err) {
        log(`心跳发送失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }, interval)
  }

  function handleFrame(frame) {
    switch (frame?.op) {
      case 10: // HELLO：有可复用的会话就续传，否则重新鉴权
        try {
          ws?.send(
            JSON.stringify(
              sessionId && lastSeq
                ? buildResume(tokenCache.value, sessionId, lastSeq)
                : buildIdentify(tokenCache.value),
            ),
          )
        } catch (err) {
          log(`鉴权帧发送失败：${err instanceof Error ? err.message : String(err)}`)
        }
        startHeartbeat(frame?.d?.heartbeat_interval)
        return
      case 11: // 心跳 ack
        return
      case 0: {
        // 事件分发：s 是序号（断线续传用），READY 帧带回 session_id。
        if (typeof frame.s === 'number') lastSeq = frame.s
        if (frame.t === 'READY') {
          sessionId = String(frame?.d?.session_id ?? '') || null
          return
        }
        if (frame.t === 'RESUMED') {
          log('会话已恢复')
          return
        }
        const inbound = parseQqGatewayEvent(String(frame.t ?? ''), frame.d)
        if (inbound) emit(inbound)
        return
      }
      case 7: // 要求重连
        log('服务端要求重连')
        reconnectAttempts = 0
        void reconnect()
        return
      case 9: // 鉴权失败 / 会话失效：重新取 token 再连
        log('会话失效，重新鉴权')
        tokenCache = { value: '', expiresAt: 0 }
        sessionId = null
        lastSeq = 0
        void reconnect()
        return
      default:
        return
    }
  }

  function connectGateway(url) {
    return new Promise((resolve, reject) => {
      let settled = false
      const socket = new WebSocket(url)
      ws = socket
      socket.on('open', () => {
        if (!settled) {
          settled = true
          resolve()
        }
      })
      socket.on('message', (raw) => {
        try {
          handleFrame(JSON.parse(String(raw)))
        } catch (err) {
          log(`网关帧解析失败：${err instanceof Error ? err.message : String(err)}`)
        }
      })
      socket.on('error', (err) => {
        const message = err instanceof Error ? err.message : String(err)
        if (!settled) {
          settled = true
          reject(new Error(message))
          return
        }
        emit({ event: 'error', message: `QQ 网关错误：${message}` })
      })
      socket.on('close', (code) => {
        clearHeartbeat()
        ws = null
        if (stopping) return
        setState('disconnected')
        // 有限次自动重连；超过就停下并说明（避免静默空转）。
        if (reconnectAttempts < 5) {
          reconnectAttempts++
          setTimeout(() => void reconnect(), Math.min(30_000, 2_000 * reconnectAttempts))
        } else {
          emit({ event: 'error', message: `QQ 网关多次断开（code=${code}），已停止自动重连` })
        }
      })
    })
  }

  async function reconnect() {
    if (stopping) return
    try {
      const token = await appToken()
      const { json } = await fetchJson(`${apiBase}/gateway`, {
        headers: { authorization: `QQBot ${token}`, 'x-union-appid': appId },
      })
      const url = json?.url
      if (!url) throw new Error(json?.message ?? '网关地址获取失败')
      await connectGateway(url)
      reconnectAttempts = 0
      setState('connected')
    } catch (err) {
      setState('disconnected')
      emit({ event: 'loginFailed', message: `QQ 连接失败：${err instanceof Error ? err.message : String(err)}` })
    }
  }

  return {
    async start() {
      if (!appId || !appSecret) {
        emit({ event: 'loginFailed', message: '缺少 AppID / AppSecret' })
        setState('disconnected')
        return
      }
      stopping = false
      setState('loggingIn')
      try {
        await appToken()
      } catch (err) {
        emit({ event: 'loginFailed', message: err instanceof Error ? err.message : String(err) })
        setState('disconnected')
        return
      }
      await reconnect()
    },

    async stop() {
      stopping = true
      clearHeartbeat()
      try {
        ws?.close()
      } catch {
        // 已关闭
      }
      ws = null
      state = 'stopped'
    },

    /** 被动回复：带上 msg_id 与递增的 msg_seq。 */
    async sendText({ to, text, contextToken }) {
      const target = String(to ?? '')
      const isGroup = target.startsWith('group:')
      const openid = target.replace(/^(group|user):/, '')
      if (!openid) return { ok: false, error: `无法解析回复目标：${target}` }
      const replyId = String(contextToken ?? '')
      let seq = 1
      if (replyId) {
        seq = (msgSeq.get(replyId) ?? 0) + 1
        if (seq > MAX_MSG_SEQ) return { ok: false, error: `同一条消息的被动回复已达上限（${MAX_MSG_SEQ} 次）` }
        msgSeq.set(replyId, seq)
        if (msgSeq.size > 500) msgSeq.delete(msgSeq.keys().next().value)
      }
      try {
        const token = await appToken()
        const path = isGroup
          ? `/v2/groups/${encodeURIComponent(openid)}/messages`
          : `/v2/users/${encodeURIComponent(openid)}/messages`
        const { status, json } = await fetchJson(`${apiBase}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `QQBot ${token}`, 'x-union-appid': appId },
          body: JSON.stringify({ content: text, msg_type: 0, ...(replyId ? { msg_id: replyId, msg_seq: seq } : { msg_seq: seq }) }),
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
