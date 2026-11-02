/**
 * Computer Use — NDJSON client for a helper child process.
 *
 * One JSON object per line, requests carrying an integer id. Read methods get a
 * soft timeout (a hung UIA walk must not stall the agent loop); write methods get
 * only a hard kill-guard, because "timed out but the click may still land" is a
 * state the model must never be told is safe to retry blindly.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { CUA_READ_TIMEOUT_MS, type CuaBackendId } from '../../../shared/computer'
import type { CuaBackend, CuaProbeResult } from './backend'
import { isWriteMethod } from './backend'

/** Hard ceiling for a write call before the helper is considered wedged. */
const WRITE_HARD_TIMEOUT_MS = 120_000
/** Max buffered characters from one line before we give up on it. */
const MAX_LINE_CHARS = 8 * 1024 * 1024

export interface BackendFailure {
  code: string
  message: string
  actionSent?: boolean
}

export function isBackendFailure(error: unknown): error is BackendFailure {
  return !!error && typeof error === 'object' && typeof (error as BackendFailure).code === 'string'
}

export interface StdioClientOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  token: string
  /** Which backend this process is ('native' exe vs PowerShell bridge). */
  backendId?: CuaBackendId
  readTimeoutMs?: number
  onLog?: (line: string, level: 'info' | 'error') => void
  onExit?: (code: number | null) => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

export class StdioCuaClient implements CuaBackend {
  readonly id: CuaBackendId
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  private exited = false

  constructor(private readonly opts: StdioClientOptions) {
    this.id = opts.backendId ?? 'powershell'
  }

  /** Spawn the helper and perform the hello handshake. */
  async start(): Promise<CuaProbeResult> {
    this.child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}), OURCODE_CUA_TOKEN: this.opts.token },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      const line = String(chunk).trim()
      if (line) this.opts.onLog?.(line.slice(0, 500), 'error')
    })
    this.child.on('error', (error) => {
      this.failAll({ code: 'RUNTIME_NOT_READY', message: `helper 启动失败：${error.message}` })
    })
    this.child.on('exit', (code) => {
      this.exited = true
      this.failAll({ code: 'RUNTIME_NOT_READY', message: `helper 已退出（code=${code ?? 'null'}）` })
      this.opts.onExit?.(code)
    })

    const hello = await this.request('hello', {
      token: this.opts.token,
      protocol: 'cua-ips/1',
      pid: process.pid,
    })
    const probe = hello as Partial<CuaProbeResult>
    if (!probe || probe.protocol !== 'cua-ips/1') {
      throw { code: 'RUNTIME_NOT_READY', message: `helper 协议不匹配：${String(probe?.protocol ?? '(空)')}` } satisfies BackendFailure
    }
    return {
      protocol: probe.protocol,
      platform: String(probe.platform ?? 'unknown'),
      capabilities: Array.isArray(probe.capabilities) ? probe.capabilities : [],
      permission: probe.permission,
    }
  }

  async probe(): Promise<CuaProbeResult> {
    const res = (await this.request('broker_info', {})) as Partial<CuaProbeResult>
    return {
      protocol: String(res?.protocol ?? 'cua-ips/1'),
      platform: String(res?.platform ?? 'unknown'),
      capabilities: Array.isArray(res?.capabilities) ? res.capabilities : [],
      permission: res?.permission,
    }
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.request(method, params)) as T
  }

  async shutdown(): Promise<void> {
    if (!this.child || this.exited) return
    try {
      await this.request('shutdown', {}, 2000)
    } catch { /* best effort */ }
    this.kill()
  }

  private kill(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try { child.kill() } catch { /* already gone */ }
  }

  private request(method: string, params: Record<string, unknown>, timeoutOverride?: number): Promise<unknown> {
    if (!this.child || this.exited) {
      return Promise.reject({ code: 'RUNTIME_NOT_READY', message: 'helper 未运行' } satisfies BackendFailure)
    }
    const id = this.nextId++
    const timeoutMs =
      timeoutOverride ?? (isWriteMethod(method) ? WRITE_HARD_TIMEOUT_MS : (this.opts.readTimeoutMs ?? CUA_READ_TIMEOUT_MS))
    return new Promise((resolve, reject) => {
      const timer = timeoutOverride === 0 ? null : setTimeout(() => {
        this.pending.delete(id)
        // A write that timed out MAY have landed — say so, so the caller never
        // replays it blindly.
        reject({
          code: 'TIMEOUT',
          message: `${method} 超时（${timeoutMs}ms）`,
          actionSent: isWriteMethod(method),
        } satisfies BackendFailure)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const line = `${JSON.stringify({ id, method, params })}\n`
      try {
        this.child!.stdin.write(line)
      } catch (error: any) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject({ code: 'RUNTIME_NOT_READY', message: `写入 helper 失败：${error?.message ?? error}` } satisfies BackendFailure)
      }
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = ''
      this.failAll({ code: 'INTERNAL', message: 'helper 单行输出超过上限，已重置缓冲' })
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.handleLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      this.opts.onLog?.(`非 JSON 输出：${line.slice(0, 200)}`, 'error')
      return
    }
    if (msg?.event) {
      // Heartbeats / progress notifications carry no request id.
      return
    }
    const id = Number(msg?.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if (msg.ok === false) {
      pending.reject(msg.error ?? { code: 'INTERNAL', message: 'helper 返回失败但没有 error 字段' })
      return
    }
    pending.resolve(msg.result)
  }

  private failAll(failure: BackendFailure): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(failure)
    }
  }
}
