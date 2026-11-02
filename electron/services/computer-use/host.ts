/**
 * Computer Use — helper lifecycle.
 *
 * Owns the platform backend process: spawn on first use, handshake, health
 * probe, restart on crash (bounded), idle stop, and a status snapshot the
 * settings panel can render. The service above it never sees process details.
 */
import { randomBytes } from 'crypto'
import type { CuaBackendId, CuaPermissionStatus } from '../../../shared/computer'
import type { CuaBackend, CuaProbeResult } from './backend'
import { StdioCuaClient, isBackendFailure } from './client'

export interface HelperLaunchSpec {
  command: string
  args: string[]
  cwd?: string
}

export interface HelperHostOptions {
  /** Absolute launch spec, or null when this platform has no helper yet. */
  resolveLaunch: () => HelperLaunchSpec | null
  backendId?: CuaBackendId
  readTimeoutMs?: number
  onLog?: (line: string, level: 'info' | 'error') => void
}

export interface HelperHostStatus {
  running: boolean
  backend: CuaBackendId
  protocol?: string
  capabilities: string[]
  permission?: CuaPermissionStatus
  lastError?: string
  restarts: number
}

const MAX_RESTARTS = 3

export class CuaHelperHost {
  private client: StdioCuaClient | null = null
  private starting: Promise<CuaBackend> | null = null
  private probeResult: CuaProbeResult | null = null
  private lastError?: string
  private restarts = 0
  private readonly token = randomBytes(32).toString('hex')

  constructor(private readonly opts: HelperHostOptions) {}

  /** Start (or reuse) the helper. Throws `{code:'RUNTIME_NOT_READY'}` shaped failures. */
  async ensure(): Promise<CuaBackend> {
    if (this.client) return this.client
    if (this.starting) return this.starting
    this.starting = this.startOnce().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startOnce(): Promise<CuaBackend> {
    const launch = this.opts.resolveLaunch()
    if (!launch) {
      this.lastError = '当前平台/安装包未提供电脑操控运行时'
      throw { code: 'UNSUPPORTED', message: this.lastError }
    }
    if (this.restarts > MAX_RESTARTS) {
      this.lastError = `运行时连续重启失败 ${this.restarts} 次，已停止尝试`
      throw { code: 'RUNTIME_NOT_READY', message: this.lastError }
    }
    const client = new StdioCuaClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      token: this.token,
      backendId: this.opts.backendId,
      readTimeoutMs: this.opts.readTimeoutMs,
      onLog: this.opts.onLog,
      onExit: () => {
        if (this.client === client) {
          this.client = null
          this.probeResult = null
          this.restarts += 1
        }
      },
    })
    try {
      this.probeResult = await client.start()
      this.client = client
      this.lastError = undefined
      return client
    } catch (error: unknown) {
      const failure = isBackendFailure(error) ? error : { code: 'RUNTIME_NOT_READY', message: String((error as any)?.message ?? error) }
      this.lastError = failure.message
      this.restarts += 1
      await client.shutdown().catch(() => undefined)
      throw failure
    }
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const backend = await this.ensure()
    try {
      return await backend.call<T>(method, params)
    } catch (error: unknown) {
      // A dead helper must not poison later calls: drop it so the next call
      // starts a fresh one (bounded by MAX_RESTARTS).
      if (isBackendFailure(error) && error.code === 'RUNTIME_NOT_READY' && this.client === backend) {
        this.client = null
      }
      throw error
    }
  }

  status(): HelperHostStatus {
    return {
      running: !!this.client,
      backend: this.client?.id ?? this.opts.backendId ?? 'none',
      protocol: this.probeResult?.protocol,
      capabilities: this.probeResult?.capabilities ?? [],
      permission: this.probeResult?.permission,
      lastError: this.lastError,
      restarts: this.restarts,
    }
  }

  /** Reset the restart budget after a successful user-visible recovery. */
  resetBudget(): void {
    this.restarts = 0
    this.lastError = undefined
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = null
    this.probeResult = null
    if (client) await client.shutdown().catch(() => undefined)
  }
}
