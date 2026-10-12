/**
 * Claw 渠道网关宿主：一个实例 = 一个渠道子进程。
 *
 * 负责拉起捆绑的网关（out/claw-gateway/claw-gateway.mjs）并桥接其 stdio
 * NDJSON 协议：子进程事件经 'gatewayEvent' 转发（带 channel 字段），命令以单行
 * JSON 写入子进程 stdin。**渠道协议本身完全在网关进程内**（微信扫码/长轮询、
 * 企业微信/QQ/飞书回调、Telegram 轮询），主进程只做进程生命周期与配置投递。
 *
 * 配置投递方式：启动前把该渠道的凭据写入 <stateDir>/config.json，再通过
 * CLAW_CONFIG 把路径交给网关——凭据不进命令行（避免出现在进程列表里），
 * 也不进日志。改配置 = 写文件 + 重启进程（渠道连接本来就需要重连）。
 *
 * 生命周期范式与 MCPManager 一致：EventEmitter 上报、幂等 stop、进程退出时
 * 清空待确认的发送队列、崩溃有限次自动重启。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { ClawChannelId, ClawChannelState, ClawGatewayEvent, ClawSentEvent } from '../../shared/types'
import { scrubEnv } from './env-scrub'

export interface ClawChannelHostOptions {
  channel: ClawChannelId
  /** 网关打包产物的绝对路径（开发: out/…，打包后: resources/claw-gateway/…）。 */
  gatewayPath: string
  /** 渠道状态目录（凭据 / 同步缓冲 / 配置），指向 <userData>/claw/<channel>。 */
  stateDir: string
}

/** 渠道配置（写到磁盘的那份：只有凭据——长连接不需要回调地址）。 */
export interface ClawChannelRuntimeConfig {
  values: Record<string, string>
}

/** 联合类型上的 Omit 必须分发到每个成员，否则只剩公共字段。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** sendText 等待网关 `sent` 回执的超时。 */
const SEND_ACK_TIMEOUT_MS = 30_000
/** 网关非主动退出后的自动重启：最多次数与重试间隔。 */
const MAX_RESTARTS = 3
const RESTART_DELAY_MS = 3_000

export class ClawChannelHost extends EventEmitter {
  private child: ChildProcess | null = null
  private state: ClawChannelState = 'stopped'
  private accountId: string | undefined
  private lastError: string | undefined
  private readonly pendingSends = new Map<string, (ev: ClawSentEvent) => void>()
  private readonly pendingSendTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = false
  private config: ClawChannelRuntimeConfig = { values: {} }
  private readonly configPath: string

  constructor(private readonly opts: ClawChannelHostOptions) {
    super()
    this.configPath = join(opts.stateDir, 'config.json')
  }

  get channel(): ClawChannelId {
    return this.opts.channel
  }

  getStatus(): { state: ClawChannelState; accountId?: string; lastError?: string } {
    return { state: this.state, accountId: this.accountId, lastError: this.lastError }
  }

  /** 更新凭据配置：写盘；若进程在跑则重启（渠道连接必须重连才生效）。 */
  setConfig(config: ClawChannelRuntimeConfig): void {
    this.config = { values: { ...config.values } }
    const wasRunning = this.isRunning()
    if (wasRunning) {
      void this.restart()
    }
  }

  private writeConfigFile(): void {
    try {
      mkdirSync(this.opts.stateDir, { recursive: true })
      writeFileSync(
        this.configPath,
        JSON.stringify({ ...this.config, stateDir: this.opts.stateDir }, null, 2),
        { mode: 0o600 },
      )
    } catch (err) {
      this.emitEvent({ event: 'error', message: `渠道配置写入失败：${err instanceof Error ? err.message : String(err)}` })
    }
  }

  private isRunning(): boolean {
    return Boolean(this.child)
  }

  /** 拉起渠道网关子进程。运行中重复调用无副作用；stop 后可再次 start。 */
  start(): void {
    if (this.child || this.stopping) return
    if (!existsSync(this.opts.gatewayPath)) {
      this.setState('stopped')
      this.lastError = `网关文件缺失：${this.opts.gatewayPath}`
      this.emitEvent({
        event: 'error',
        message: `Claw 网关文件缺失：${this.opts.gatewayPath}（请先运行 npm run build:claw-gateway）`,
      })
      return
    }

    this.writeConfigFile()
    this.lastError = undefined
    // scrubEnv 会剥掉 ELECTRON_RUN_AS_NODE 前缀与凭证形状变量，显式 env 层补回
    // 网关所需项（参考 MCPManager StdioTransport 的做法）。
    const env = {
      ...scrubEnv(process.env ?? {}),
      ELECTRON_RUN_AS_NODE: '1',
      CLAW_CHANNEL: this.opts.channel,
      CLAW_CONFIG: this.configPath,
      // 微信适配器依赖官方插件的状态目录约定（凭据、同步缓冲）。
      OPENCLAW_STATE_DIR: this.opts.stateDir,
    }
    const child = spawn(process.execPath, [this.opts.gatewayPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    // 网关不会自己起来：主进程发第一条命令让它按配置启动适配器。
    this.send({ cmd: 'start' })

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, terminal: false })
      rl.on('line', (line) => this.handleLine(line))
    }
    if (child.stderr) {
      let buf = ''
      child.stderr.setEncoding('utf-8')
      child.stderr.on('data', (chunk: string) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          this.emit('gatewayLog', buf.slice(0, idx).trimEnd())
          buf = buf.slice(idx + 1)
        }
      })
    }
    child.on('error', (err) => {
      this.lastError = err.message
      this.emitEvent({ event: 'error', message: `网关启动失败：${err.message}` })
    })
    child.on('exit', (code) => {
      this.child = null
      // 待确认的发送全部以失败收尾，并清掉各自的超时定时器。
      for (const [id, resolve] of this.pendingSends) {
        resolve({ event: 'sent', channel: this.opts.channel, clientMsgId: id, ok: false, error: `网关已退出（code=${code}）` })
      }
      this.pendingSends.clear()
      for (const timer of this.pendingSendTimers.values()) clearTimeout(timer)
      this.pendingSendTimers.clear()
      this.emit('exit', code)
      if (this.stopping) {
        this.setState('stopped')
        return
      }
      // 非主动停止：自动重启（有限次数），无人值守时渠道也能自愈。
      if (this.restartAttempts < MAX_RESTARTS) {
        this.restartAttempts++
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          this.start()
        }, RESTART_DELAY_MS)
      } else {
        this.setState('stopped')
        this.lastError = `网关多次崩溃，已停止自动重启（code=${code}）`
        this.emitEvent({ event: 'error', message: `${this.opts.channel} 渠道网关多次崩溃，已停止自动重启（code=${code}）` })
      }
    })
  }

  /** 重启（配置变更 / 手动重连）：先停再起，不消耗崩溃重试预算。 */
  async restart(): Promise<void> {
    await this.stop()
    this.restartAttempts = 0
    this.start()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let ev: ClawGatewayEvent
    try {
      ev = JSON.parse(line) as ClawGatewayEvent
    } catch {
      return // 非 JSON 行（理论上不会出现）直接忽略
    }
    // 网关自己也会带 channel，但以宿主为准：处理器是按渠道实例化的。
    const tagged = { ...ev, channel: this.opts.channel } as ClawGatewayEvent
    if (tagged.event === 'status') {
      this.state = tagged.state
      this.accountId = tagged.accountId
      // 网关成功重连后清零崩溃计数，允许未来的崩溃再次触发完整重试周期。
      if (tagged.state === 'connected') {
        this.restartAttempts = 0
        this.lastError = undefined
      }
    }
    if ((tagged.event === 'error' || tagged.event === 'loginFailed') && 'message' in tagged) {
      this.lastError = tagged.message
    }
    if (tagged.event === 'sent' && tagged.clientMsgId) {
      const resolve = this.pendingSends.get(tagged.clientMsgId)
      if (resolve) {
        this.pendingSends.delete(tagged.clientMsgId)
        resolve(tagged)
      }
    }
    this.emit('gatewayEvent', tagged)
  }

  private setState(next: ClawChannelState): void {
    if (this.state === next) return
    this.state = next
    this.emitEvent({ event: 'status', state: next, ...(this.accountId ? { accountId: this.accountId } : {}) })
  }

  private emitEvent(ev: DistributiveOmit<ClawGatewayEvent, 'channel'>): void {
    this.emit('gatewayEvent', { ...ev, channel: this.opts.channel } as ClawGatewayEvent)
  }

  private send(cmd: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin
    if (!this.child || !stdin || !stdin.writable) return false
    stdin.write(JSON.stringify(cmd) + '\n')
    return true
  }

  startLogin(): boolean {
    return this.send({ cmd: 'startLogin' })
  }

  submitVerifyCode(code: string): boolean {
    return this.send({ cmd: 'submitVerifyCode', code: String(code ?? '') })
  }

  logout(): boolean {
    return this.send({ cmd: 'logout' })
  }

  /**
   * 向该渠道的联系人/群发文本，网关以 `sent` 事件回执，本方法以 Promise 返回回执。
   *
   * `final` 标记本轮输出的最后一片：企业微信这类支持**流式回复**的渠道用它收尾
   * （把整段内容标成完成态），其余渠道忽略它。
   */
  sendText(to: string, text: string, clientMsgId?: string, contextToken?: string, final = false): Promise<ClawSentEvent> {
    const id = clientMsgId ?? `${this.opts.channel}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve) => {
      if (!this.send({ cmd: 'sendText', to, text, clientMsgId: id, contextToken, final })) {
        resolve({ event: 'sent', channel: this.opts.channel, clientMsgId: id, ok: false, error: '网关未运行' })
        return
      }
      const timer = setTimeout(() => {
        this.pendingSends.delete(id)
        this.pendingSendTimers.delete(id)
        resolve({ event: 'sent', channel: this.opts.channel, clientMsgId: id, ok: false, error: '发送确认超时' })
      }, SEND_ACK_TIMEOUT_MS)
      this.pendingSendTimers.set(id, timer)
      this.pendingSends.set(id, (ev) => {
        clearTimeout(timer)
        this.pendingSendTimers.delete(id)
        resolve(ev)
      })
    })
  }

  /** 优雅停止：先发 shutdown 让网关收尾（回调服务器关闭、长轮询中止），超时强杀。 */
  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (!this.child) {
      this.setState('stopped')
      return
    }
    this.stopping = true
    this.send({ cmd: 'shutdown' })
    const child = this.child
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ])
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        // 已退出
      }
      this.child = null
    }
    this.stopping = false
    this.setState('stopped')
  }

  /** 应用退出兜底：同步发 shutdown 并立即杀死子进程，防止孤儿进程残留。 */
  shutdownNow(): void {
    if (!this.child) return
    this.send({ cmd: 'shutdown' })
    try {
      this.child.kill()
    } catch {
      // 已退出
    }
    this.child = null
  }
}
