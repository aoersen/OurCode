/**
 * OurCode Claw 渠道网关（子进程入口）。
 *
 * 一个渠道一个进程：主进程以 ELECTRON_RUN_AS_NODE=1 拉起本文件，并通过
 * `CLAW_CHANNEL`（渠道 id）与 `CLAW_CONFIG`（渠道配置 JSON 文件路径）指定
 * 「接入哪个渠道、用什么凭据」。协议统一为 stdio NDJSON：
 *
 *   stdin  ← {"cmd":"start"|"sendText"|"startLogin"|"submitVerifyCode"|"logout"|"shutdown", ...}
 *   stdout → {"event":"status"|"qr"|"inbound"|"sent"|"webhook"|"error"|…, "channel":"<id>", ...}
 *   stderr → 诊断日志（主进程只在 dev 下打印）
 *
 * 事件契约见 shared/types.ts 的 ClawGatewayEvent；渠道差异全部关在 adapters/
 * 里，本文件只做「读配置 → 建适配器 → 分发命令 → 注入 channel 字段」。
 * 凭据只存在于配置文件与进程内存，不写日志、不回传渲染层。
 */
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const CHANNEL_ADAPTERS = {
  wechat: () => import('./adapters/wechat.mjs'),
  wecom: () => import('./adapters/wecom.mjs'),
  qq: () => import('./adapters/qq.mjs'),
  feishu: () => import('./adapters/feishu.mjs'),
  telegram: () => import('./adapters/telegram.mjs'),
}

const channel = String(process.env.CLAW_CHANNEL ?? '').trim()
const configPath = String(process.env.CLAW_CONFIG ?? '').trim()

function log(message) {
  process.stderr.write(`[claw-gateway:${channel || '?'}] ${message}\n`)
}

function emit(event) {
  process.stdout.write(`${JSON.stringify({ channel, ...event })}\n`)
}

function readConfig() {
  if (!configPath) return { values: {} }
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { values: {} }
    return {
      values: parsed.values && typeof parsed.values === 'object' ? parsed.values : {},
      stateDir: String(parsed.stateDir ?? ''),
    }
  } catch (err) {
    log(`配置读取失败：${err instanceof Error ? err.message : String(err)}`)
    return { values: {} }
  }
}

let adapter = null
let stopping = false

async function boot() {
  const loader = CHANNEL_ADAPTERS[channel]
  if (!loader) {
    emit({ event: 'error', message: `未知渠道：${channel || '(未指定 CLAW_CHANNEL)'}` })
    process.exit(1)
    return
  }
  const config = readConfig()
  const ctx = {
    channel,
    config,
    stateDir: config.stateDir || process.env.OPENCLAW_STATE_DIR || '',
    emit,
    log: (message) => log(message),
  }
  try {
    const mod = await loader()
    adapter = mod.createAdapter(ctx)
    await adapter.start()
    emit({ event: 'ready' })
  } catch (err) {
    log(`适配器启动失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    emit({ event: 'loginFailed', message: `渠道启动失败：${err instanceof Error ? err.message : String(err)}` })
  }
}

async function handleCommand(raw) {
  let cmd
  try {
    cmd = JSON.parse(raw)
  } catch {
    return
  }
  switch (cmd?.cmd) {
    case 'start':
      await boot()
      break
    case 'sendText': {
      const clientMsgId = cmd.clientMsgId
      if (!adapter) {
        emit({ event: 'sent', clientMsgId, ok: false, error: '适配器未就绪' })
        return
      }
      try {
        const result = await adapter.sendText({
          to: String(cmd.to ?? ''),
          text: String(cmd.text ?? ''),
          clientMsgId,
          contextToken: cmd.contextToken ? String(cmd.contextToken) : undefined,
          // 本轮输出的最后一片：支持流式回复的渠道（企业微信）用它收尾。
          final: Boolean(cmd.final),
        })
        emit({ event: 'sent', clientMsgId, ...result })
      } catch (err) {
        emit({ event: 'sent', clientMsgId, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      break
    }
    case 'startLogin':
      if (adapter?.startLogin) await adapter.startLogin().catch((err) => log(`startLogin: ${err?.message ?? err}`))
      break
    case 'submitVerifyCode':
      if (adapter?.submitVerifyCode) adapter.submitVerifyCode(String(cmd.code ?? ''))
      break
    case 'logout':
      if (adapter?.logout) await adapter.logout().catch((err) => log(`logout: ${err?.message ?? err}`))
      break
    case 'shutdown':
      stopping = true
      try {
        if (adapter) await adapter.stop()
      } catch (err) {
        log(`stop: ${err instanceof Error ? err.message : String(err)}`)
      }
      emit({ event: 'status', state: 'stopped' })
      process.exit(0)
      break
    default:
      emit({ event: 'error', message: `未知命令：${cmd?.cmd}` })
  }
}

// 主进程在 spawn 之后写第一行命令（start），因此这里只接线、不自动启动。
// 命令**串行**处理：start 里要加载适配器并建立连接（异步），若让后续命令并发
// 执行，shutdown / sendText 就会抢在 start 之前——顺序语义是协议的一部分。
const rl = createInterface({ input: process.stdin, terminal: false })
let chain = Promise.resolve()
rl.on('line', (line) => {
  if (!line.trim()) return
  chain = chain
    .then(() => handleCommand(line))
    .catch((err) => log(`handleCommand: ${err instanceof Error ? err.message : String(err)}`))
})
process.stdin.on('error', () => {})
process.on('uncaughtException', (err) => log(`uncaughtException: ${err?.stack ?? err}`))
process.on('unhandledRejection', (err) => log(`unhandledRejection: ${err?.stack ?? err}`))
// 父进程消失（Electron 崩溃）时不要留孤儿进程：stdin 关闭即退出。
process.stdin.on('end', () => {
  if (!stopping) log('stdin 已关闭，网关退出')
  process.exit(0)
})
