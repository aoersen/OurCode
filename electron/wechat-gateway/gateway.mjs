/**
 * OurCode WeChat 通道网关（子进程）。
 *
 * 由 Electron 主进程以 ELECTRON_RUN_AS_NODE=1 拉起，经 stdio 走 NDJSON 协议：
 * stdin 收命令、stdout 发事件；stderr 仅用于诊断日志。凭证与同步状态存放在
 * OPENCLAW_STATE_DIR（主进程指向应用 userData 下），由捆绑进来的官方协议层
 * 管理，本文件只负责：扫码登录状态机、getUpdates 长轮询、文本收发。
 *
 * 协议层来自腾讯官方通道插件 @tencent-weixin/openclaw-weixin（MIT），按其
 * dist 源码深引用；其 openclaw/plugin-sdk/* 依赖在打包时由 sdk-stubs 顶替
 * （见 bundle.mjs）。
 */
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"

import {
  apiGetFetch,
  apiPostFetch,
  getUpdates,
  notifyStart,
  notifyStop,
  sendMessage,
} from "@tencent-weixin/openclaw-weixin/dist/src/api/api.js"
import {
  DEFAULT_BASE_URL,
  clearWeixinAccount,
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  registerWeixinAccountId,
  saveWeixinAccount,
  unregisterWeixinAccountId,
} from "@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js"
import {
  getSyncBufFilePath,
  loadGetUpdatesBuf,
  saveGetUpdatesBuf,
} from "@tencent-weixin/openclaw-weixin/dist/src/storage/sync-buf.js"

const BOT_TYPE = "3" // 与插件的 DEFAULT_ILINK_BOT_TYPE 一致
const QR_STATUS_POLL_TIMEOUT_MS = 30_000
const QR_TOTAL_TIMEOUT_MS = 8 * 60_000
const MAX_QR_REFRESHES = 3
const MAX_CONSECUTIVE_POLL_FAILURES = 10
const STALE_TOKEN_ERRCODE = -14
const MESSAGE_TYPE_BOT = 2
const ITEM_TYPE_TEXT = 1
/** 去重缓存上限：长轮询可能重投已处理的消息，按 message_id 去重。 */
const SEEN_MSG_ID_CAP = 2_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n")
}

function logError(context, err) {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(`[wechat-gateway] ${context}: ${detail}\n`)
}

// 账号 id 归一化，与 sdk-stubs/account-id.mjs 保持一致。
function normalizeAccountId(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[@.]/g, "-")
}

// ---------------------------------------------------------------------------
// 共享状态
// ---------------------------------------------------------------------------
let mode = "idle" // idle | loggingIn | connected | disconnected | stopped
let account = null // { accountId, baseUrl, token } | null
let loopAbort = null // getUpdates 长轮询的取消信号
let loopPromise = null // 消息循环的 Promise，logout/shutdown 时等待收尾
let verifyCodeResolve = null // 待输入的配对码 Promise
const seenMsgIds = new Set() // 已处理消息去重（防止长轮询重投导致重复回复）

function setMode(next) {
  mode = next
  emit({ event: "status", state: next, ...(account ? { accountId: account.accountId } : {}) })
}

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------
async function fetchQr(baseUrl) {
  // 携带本地已有 bot token（最多 10 个），让服务端识别"重绑"场景。
  const ids = listIndexedWeixinAccountIds()
  const tokens = []
  for (let i = ids.length - 1; i >= 0 && tokens.length < 10; i--) {
    const token = loadWeixinAccount(ids[i])?.token?.trim()
    if (token) tokens.push(token)
  }
  const rawText = await apiPostFetch({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    body: JSON.stringify({ local_token_list: tokens }),
    label: "fetchQRCode",
  })
  const parsed = JSON.parse(rawText)
  return { qrcode: parsed.qrcode, qrcodeUrl: parsed.qrcode_img_content }
}

async function pollQrStatus(baseUrl, qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
  const rawText = await apiGetFetch({
    baseUrl,
    endpoint,
    timeoutMs: QR_STATUS_POLL_TIMEOUT_MS,
    label: "pollQRStatus",
  })
  return JSON.parse(rawText)
}

function requestVerifyCode() {
  emit({ event: "needVerifyCode" })
  return new Promise((resolve) => {
    verifyCodeResolve = resolve
  })
}

function resumeExistingAccount() {
  const ids = listIndexedWeixinAccountIds()
  for (let i = ids.length - 1; i >= 0; i--) {
    const data = loadWeixinAccount(ids[i])
    const token = data?.token?.trim()
    if (token) {
      return {
        accountId: ids[i],
        baseUrl: data?.baseUrl?.trim() || DEFAULT_BASE_URL,
        token,
      }
    }
  }
  return null
}

async function startLogin() {
  if (mode === "loggingIn") return
  if (mode === "connected") {
    // 已有连接时重新登录：先收掉消息循环。
    if (loopAbort) loopAbort.abort()
    if (loopPromise) await loopPromise.catch(() => {})
  }

  setMode("loggingIn")
  let baseUrl = DEFAULT_BASE_URL
  let qrcode = null
  let pendingVerifyCode = undefined
  let refreshCount = 0
  let consecutiveFailures = 0
  const deadline = Date.now() + QR_TOTAL_TIMEOUT_MS

  try {
    const first = await fetchQr(baseUrl)
    qrcode = first.qrcode
    emit({ event: "qr", qrcodeUrl: first.qrcodeUrl })

    while (Date.now() < deadline && mode === "loggingIn") {
      let status
      try {
        status = await pollQrStatus(baseUrl, qrcode, pendingVerifyCode)
        consecutiveFailures = 0
      } catch (err) {
        consecutiveFailures++
        logError("pollQrStatus", err)
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          emit({ event: "loginFailed", message: "无法连接微信服务器，登录已停止。" })
          break
        }
        await sleep(2_000)
        continue
      }

      switch (status.status) {
        case "wait":
          await sleep(1_000)
          continue
        case "scaned":
          // 若携带了配对码且服务端返回 scaned，说明验证码正确，清除暂存。
          if (pendingVerifyCode) pendingVerifyCode = undefined
          emit({ event: "scanned" })
          await sleep(1_000)
          continue
        case "need_verifycode": {
          // 等待主进程回传验证码；总登录时限到期时放弃等待。
          const remaining = deadline - Date.now()
          pendingVerifyCode = await Promise.race([
            requestVerifyCode(),
            sleep(Math.max(remaining, 0)).then(() => "__timeout__"),
          ])
          if (pendingVerifyCode === "__timeout__") {
            pendingVerifyCode = undefined
            break
          }
          continue
        }
        case "verify_code_blocked":
          pendingVerifyCode = undefined
          emit({ event: "verifyBlocked" })
          if (++refreshCount > MAX_QR_REFRESHES) {
            emit({ event: "loginFailed", message: "多次验证失败，登录已停止。" })
            break
          }
          {
            const blockedQr = await fetchQr(baseUrl)
            qrcode = blockedQr.qrcode
            emit({ event: "qr", qrcodeUrl: blockedQr.qrcodeUrl })
          }
          continue
        case "expired":
          if (++refreshCount > MAX_QR_REFRESHES) {
            emit({ event: "loginFailed", message: "二维码多次失效，登录已停止。" })
            break
          }
          {
            const fresh = await fetchQr(baseUrl)
            qrcode = fresh.qrcode
            emit({ event: "qr", qrcodeUrl: fresh.qrcodeUrl })
          }
          continue
        case "scaned_but_redirect":
          if (status.redirect_host) baseUrl = `https://${status.redirect_host}`
          continue
        case "binded_redirect": {
          // 服务端表示该机器人已绑定：若本机仍有凭据则直接恢复，否则失败。
          emit({ event: "scanned" })
          const existing = resumeExistingAccount()
          if (existing) {
            void startMessageLoop(existing)
            return
          }
          emit({ event: "loginFailed", message: "该机器人已绑定，但本机没有可用凭据，请重新扫码或先解绑。" })
          return
        }
        case "confirmed": {
          if (!status.ilink_bot_id) {
            emit({ event: "loginFailed", message: "登录失败：服务器未返回机器人 ID。" })
            return
          }
          account = {
            accountId: normalizeAccountId(status.ilink_bot_id),
            baseUrl: status.baseurl?.trim() || baseUrl,
            token: status.bot_token,
          }
          saveWeixinAccount(account.accountId, {
            token: account.token,
            baseUrl: account.baseUrl,
            userId: status.ilink_user_id,
          })
          registerWeixinAccountId(account.accountId)
          void startMessageLoop(account)
          return
        }
        default:
          await sleep(1_000)
      }
    }

    if (mode === "loggingIn") {
      emit({ event: "loginFailed", message: "登录超时，请重试。" })
    }
  } catch (err) {
    logError("startLogin", err)
    emit({ event: "loginFailed", message: `登录失败：${err instanceof Error ? err.message : String(err)}` })
  } finally {
    if (mode === "loggingIn") setMode("idle")
  }
}

// ---------------------------------------------------------------------------
// 消息循环
// ---------------------------------------------------------------------------
async function startMessageLoop(nextAccount) {
  account = nextAccount
  const acc = account
  loopAbort = new AbortController()
  loopPromise = (async () => {
    setMode("connected")

    try {
      await notifyStart({ accountId: acc.accountId, baseUrl: acc.baseUrl, token: acc.token })
    } catch (err) {
      logError("notifyStart", err)
    }

    const syncBufPath = getSyncBufFilePath(acc.accountId)
    let buf = loadGetUpdatesBuf(syncBufPath) ?? ""

    while (mode === "connected" && !loopAbort.signal.aborted) {
      try {
        const resp = await getUpdates({
          accountId: acc.accountId,
          baseUrl: acc.baseUrl,
          token: acc.token,
          get_updates_buf: buf,
          timeoutMs: 25_000,
          abortSignal: loopAbort.signal,
        })

        if (resp.errcode === STALE_TOKEN_ERRCODE) {
          emit({ event: "sessionExpired", message: resp.errmsg || "会话已过期，请重新扫码登录。" })
          // 清掉失效凭据，避免下次启动时用过期 token 自动恢复。
          try {
            clearWeixinAccount(acc.accountId)
            unregisterWeixinAccountId(acc.accountId)
          } catch (err) {
            logError("clearStaleAccount", err)
          }
          break
        }
        if (resp.errcode != null && resp.errcode !== 0) {
          emit({ event: "error", message: `getUpdates errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}` })
          await sleep(2_000)
          continue
        }

        const nextBuf = resp.get_updates_buf ?? resp.sync_buf
        if (nextBuf && nextBuf !== buf) {
          buf = nextBuf
          try {
            saveGetUpdatesBuf(syncBufPath, buf)
          } catch (err) {
            logError("saveGetUpdatesBuf", err)
          }
        }

        // 服务端对入站消息不做 message_state 过滤（官方 monitor 循环同样
        // 全量处理；文本消息常以 FINISH=2 送达）。这里只跳过自己发出的回声，
        // 并按 message_id 去重（长轮询可能重投）。
        for (const msg of resp.msgs ?? []) {
          if (msg.message_type === MESSAGE_TYPE_BOT) continue
          const key = msg.message_id ?? `${msg.from_user_id}:${msg.create_time_ms}:${msg.seq ?? ''}`
          if (key && seenMsgIds.has(key)) continue
          if (key) {
            seenMsgIds.add(key)
            if (seenMsgIds.size > SEEN_MSG_ID_CAP) {
              const oldest = seenMsgIds.values().next().value
              seenMsgIds.delete(oldest)
            }
          }
          const text = (msg.item_list ?? [])
            .filter((item) => item.type === ITEM_TYPE_TEXT && item.text_item?.text != null)
            .map((item) => String(item.text_item.text))
            .join("")
          if (!text) continue
          emit({
            event: "inbound",
            msgId: msg.message_id,
            from: msg.from_user_id,
            replyTo: msg.group_id || msg.from_user_id,
            isGroup: Boolean(msg.group_id),
            text,
            ts: msg.create_time_ms,
            contextToken: msg.context_token,
          })
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") break
        logError("getUpdates", err)
        await sleep(2_000)
      }
    }

    try {
      await notifyStop({ accountId: acc.accountId, baseUrl: acc.baseUrl, token: acc.token })
    } catch (err) {
      logError("notifyStop", err)
    }
    loopAbort = null
    if (mode === "connected") setMode("disconnected")
  })()
  return loopPromise
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------
async function sendText(to, text, clientMsgId) {
  if (!account || mode !== "connected") {
    emit({ event: "sent", clientMsgId, ok: false, error: "通道未连接" })
    return
  }
  try {
    const resp = await sendMessage({
      accountId: account.accountId,
      baseUrl: account.baseUrl,
      token: account.token,
      body: {
        msg: {
          to_user_id: to,
          client_id: clientMsgId || randomUUID(),
          message_type: MESSAGE_TYPE_BOT,
          item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }],
        },
      },
    })
    emit({ event: "sent", clientMsgId, ok: true, messageId: resp.message_id })
  } catch (err) {
    emit({ event: "sent", clientMsgId, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function logout() {
  const acc = account
  if (loopAbort) loopAbort.abort()
  if (loopPromise) await loopPromise.catch(() => {})
  if (acc) {
    try {
      clearWeixinAccount(acc.accountId)
      unregisterWeixinAccountId(acc.accountId)
    } catch (err) {
      logError("logout", err)
    }
    account = null
  }
  if (mode !== "stopped") setMode("idle")
}

async function shutdown() {
  mode = "stopped"
  if (loopAbort) loopAbort.abort()
  if (loopPromise) await loopPromise.catch(() => {})
  emit({ event: "status", state: "stopped" })
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------
function handleCommand(raw) {
  let cmd
  try {
    cmd = JSON.parse(raw)
  } catch {
    return
  }
  switch (cmd.cmd) {
    case "startLogin":
      void startLogin().catch((err) => logError("startLogin", err))
      break
    case "submitVerifyCode":
      if (verifyCodeResolve) {
        const resolve = verifyCodeResolve
        verifyCodeResolve = null
        resolve(String(cmd.code ?? "").trim())
      }
      break
    case "sendText":
      void sendText(String(cmd.to ?? ""), String(cmd.text ?? ""), cmd.clientMsgId)
      break
    case "logout":
      void logout().catch((err) => logError("logout", err))
      break
    case "shutdown":
      void shutdown()
      break
    default:
      emit({ event: "error", message: `未知命令：${cmd.cmd}` })
  }
}

function boot() {
  const existing = resumeExistingAccount()
  if (existing) {
    void startMessageLoop(existing).catch((err) => logError("resume", err))
  } else {
    setMode("idle")
  }
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on("line", handleCommand)
process.stdin.on("error", () => {})
process.on("uncaughtException", (err) => logError("uncaughtException", err))
process.on("unhandledRejection", (err) => logError("unhandledRejection", err))
boot()
