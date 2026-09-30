/**
 * 微信通道网关宿主服务。
 *
 * 负责拉起捆绑的网关子进程（out/wechat-gateway/wechat-gateway.mjs）并桥接其
 * stdio NDJSON 协议：子进程事件经 'gatewayEvent' 原样转发（主进程广播给渲染
 * 层），命令以单行 JSON 写入子进程 stdin。微信协议本身（扫码登录、getUpdates
 * 长轮询、sendMessage）在网关内部实现，见 electron/wechat-gateway/gateway.mjs。
 *
 * 生命周期范式与 MCPManager 一致：EventEmitter 上报、幂等 stop、进程退出时
 * 清空待确认的发送队列。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

import type { WechatChannelState, WechatGatewayEvent, WechatSentEvent } from '../../shared/types'
import { scrubEnv } from './env-scrub'

export interface WechatChannelOptions {
  /** 网关打包产物的绝对路径（开发: out/…，打包后: resources/wechat-gateway/…）。 */
  gatewayPath: string
  /** 网关状态目录（凭据 / 日志 / 同步缓冲），指向 <userData>/wechat-channel。 */
  stateDir: string
}

/** sendText 等待网关 `sent` 回执的超时。 */
const SEND_ACK_TIMEOUT_MS = 30_000

export class WechatChannel extends EventEmitter {
  private child: ChildProcess | null = null
  private state: WechatChannelState = 'stopped'
  private readonly pendingSends = new Map<string, (ev: WechatSentEvent) => void>()
  private stopping = false

  constructor(private readonly opts: WechatChannelOptions) {
    super()
  }

  getStatus(): { state: WechatChannelState } {
    return { state: this.state }
  }

  /** 拉起网关子进程。运行中重复调用无副作用；stop 后可再次 start。 */
  start(): void {
    if (this.child || this.stopping) return
    if (!existsSync(this.opts.gatewayPath)) {
      this.setState('stopped')
      const ev: WechatGatewayEvent = {
        event: 'error',
        message: `微信网关文件缺失：${this.opts.gatewayPath}（请先运行 npm run build:wechat-gateway）`,
      }
      this.emit('gatewayEvent', ev)
      return
    }

    // scrubEnv 会剥掉 ELECTRON_RUN_AS_NODE 前缀与凭证形状变量，显式 env 层再补回
    // 网关所需的两项（参考 MCPManager StdioTransport 的做法）。
    const env = {
      ...scrubEnv(process.env ?? {}),
      ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_STATE_DIR: this.opts.stateDir,
    }
    const child = spawn(process.execPath, [this.opts.gatewayPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

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
      const ev: WechatGatewayEvent = { event: 'error', message: `网关启动失败：${err.message}` }
      this.emit('gatewayEvent', ev)
    })
    child.on('exit', (code) => {
      this.child = null
      for (const resolve of this.pendingSends.values()) {
        const ev: WechatSentEvent = { event: 'sent', ok: false, error: `网关已退出（code=${code}）` }
        resolve(ev)
      }
      this.pendingSends.clear()
      this.emit('exit', code)
      if (!this.stopping) this.setState('stopped')
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let ev: WechatGatewayEvent
    try {
      ev = JSON.parse(line) as WechatGatewayEvent
    } catch {
      return // 非 JSON 行（理论上不会出现）直接忽略
    }
    if (ev.event === 'status') {
      this.state = ev.state
    }
    if (ev.event === 'sent' && ev.clientMsgId) {
      const resolve = this.pendingSends.get(ev.clientMsgId)
      if (resolve) {
        this.pendingSends.delete(ev.clientMsgId)
        resolve(ev)
      }
    }
    this.emit('gatewayEvent', ev)
  }

  private setState(next: WechatChannelState): void {
    if (this.state === next) return
    this.state = next
    const ev: WechatGatewayEvent = { event: 'status', state: next }
    this.emit('gatewayEvent', ev)
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

  /** 向微信联系人/群发文本，网关以 `sent` 事件回执，本方法以 Promise 返回回执。 */
  sendText(to: string, text: string, clientMsgId?: string): Promise<WechatSentEvent> {
    const id = clientMsgId ?? `wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve) => {
      if (!this.send({ cmd: 'sendText', to, text, clientMsgId: id })) {
        const ev: WechatSentEvent = { event: 'sent', clientMsgId: id, ok: false, error: '网关未运行' }
        resolve(ev)
        return
      }
      const timer = setTimeout(() => {
        this.pendingSends.delete(id)
        const ev: WechatSentEvent = { event: 'sent', clientMsgId: id, ok: false, error: '发送确认超时' }
        resolve(ev)
      }, SEND_ACK_TIMEOUT_MS)
      this.pendingSends.set(id, (ev) => {
        clearTimeout(timer)
        resolve(ev)
      })
    })
  }

  /** 优雅停止：先发 shutdown 让网关做 notifyStop 收尾，超时则强杀。 */
  async stop(): Promise<void> {
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
