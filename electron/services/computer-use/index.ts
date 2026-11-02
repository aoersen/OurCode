/**
 * Computer Use — Electron wiring.
 *
 * Everything platform- and Electron-specific lives here; the service below stays
 * testable. Responsibilities:
 *   - pick a backend (PowerShell helper on Windows, fake when explicitly asked)
 *   - own the helper host + service singletons
 *   - register the `computer:*` IPC surface
 *   - physical Esc → emergency stop while an action is in flight
 *   - shut the helper down when the app quits (never leave an orphan)
 */
import { app, globalShortcut, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS } from '../../../shared/constants'
import type { CuaActionRequest, CuaGetStateRequest, CuaRunStepsRequest, CuaScreenshotRequest } from '../../../shared/computer'
import { CuaService, CuaServiceError, type BackendStatus } from './service'
import { CuaHelperHost, type HelperLaunchSpec } from './host'
import { FakeCuaBackend } from './fakeBackend'
import type { CuaBackend, CuaProbeResult } from './backend'
import type { UserPreferences } from '../../../shared/types'

export interface ComputerUseInit {
  broadcast: (channel: string, payload: unknown) => void
  getPreferences: () => UserPreferences | undefined
}

let host: CuaHelperHost | null = null
let fake: FakeCuaBackend | null = null
let service: CuaService | null = null
let init: ComputerUseInit | null = null
let escRegistered = false
let activeWrites = 0
let lastBackendError: string | undefined

function dataDir(...parts: string[]): string {
  return join(app.getPath('userData'), 'cua', ...parts)
}

function windowsPowerShell(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(exe) ? exe : 'powershell.exe'
}

/** Helper script location: repo-relative in dev, resources-relative when packaged. */
export function resolveHelperEntry(): string | null {
  const candidates = [
    join(app.getAppPath(), 'tools', 'cua-helper', 'win', 'UiaBridge.ps1'),
    join(process.resourcesPath ?? '', 'cua-helper', 'win', 'UiaBridge.ps1'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

function resolveLaunch(): HelperLaunchSpec | null {
  if (process.env.OURCODE_CUA_FAKE === '1') return null
  if (process.platform !== 'win32') return null
  const entry = resolveHelperEntry()
  if (!entry) return null
  return {
    command: windowsPowerShell(),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', entry],
    cwd: join(entry, '..'),
  }
}

/** The deterministic fake desktop is opt-in only (tests / demos / CI). */
function useFakeBackend(): boolean {
  return process.env.OURCODE_CUA_FAKE === '1'
}

async function getBackend(): Promise<CuaBackend> {
  if (useFakeBackend()) {
    fake = fake ?? new FakeCuaBackend(dataDir('frames'))
    return fake
  }
  if (!host) {
    host = new CuaHelperHost({
      resolveLaunch,
      backendId: 'powershell',
      onLog: (line, level) => {
        if (level === 'error') lastBackendError = line
        init?.broadcast(IPC_CHANNELS.COMPUTER_EVENT, { type: 'log', level, line })
      },
    })
  }
  return host.ensure()
}

function backendStatus(): BackendStatus {
  if (fake) {
    return {
      running: true,
      backend: 'fake',
      protocol: 'cua-ips/1',
      capabilities: ['uia', 'sendinput', 'gdi', 'clipboard', 'fake'],
    }
  }
  const status = host?.status()
  if (status?.running) {
    return {
      running: true,
      backend: status.backend,
      protocol: status.protocol,
      capabilities: status.capabilities,
      permission: status.permission,
      lastError: status.lastError,
    }
  }
  return {
    running: false,
    backend: status?.backend ?? 'none',
    capabilities: status?.capabilities ?? [],
    permission: status?.permission,
    lastError:
      status?.lastError ??
      lastBackendError ??
      (resolveLaunch() ? undefined : '当前平台/安装包没有可用的电脑操控运行时'),
  }
}

function ensureService(): CuaService {
  if (!init) throw new Error('computer-use 未初始化')
  if (!service) {
    service = new CuaService({
      getBackend,
      getBackendStatus: backendStatus,
      getPrefs: () => init?.getPreferences() ?? {},
      frameDir: dataDir('frames'),
      auditFile: dataDir('audit.jsonl'),
      platform: process.platform,
    })
  }
  return service
}

function enableEscStop(): void {
  if (escRegistered) return
  try {
    escRegistered = globalShortcut.register('Escape', () => {
      // Stop synchronously in the main process: a wedged helper must not be
      // able to keep the user from interrupting.
      const svc = service
      if (!svc) return
      void svc.stop('*')
      init?.broadcast(IPC_CHANNELS.COMPUTER_EVENT, { type: 'stopped', reason: 'escape' })
    })
  } catch {
    escRegistered = false
  }
}

function releaseEscStop(): void {
  if (!escRegistered) return
  activeWrites = Math.max(0, activeWrites - 1)
  if (activeWrites > 0) return
  try { globalShortcut.unregister('Escape') } catch { /* app going away */ }
  escRegistered = false
}

/** Wrap one write for Esc bookkeeping + error normalization. */
async function withEsc<T>(job: () => Promise<T>): Promise<T> {
  activeWrites += 1
  enableEscStop()
  try {
    return await job()
  } finally {
    releaseEscStop()
  }
}

export function initComputerUse(options: ComputerUseInit): void {
  init = options
  ensureService()
  // Warm the helper in the background when the user has the feature on; a
  // failure here is surfaced through `computer:status`, never thrown at startup.
  if (options.getPreferences()?.computerUseEnabled === true) {
    void getBackend().catch(() => undefined)
  }
}

export function registerComputerUseIpc(): void {
  ipcMain.handle(IPC_CHANNELS.COMPUTER_STATUS, () => {
    try {
      return { ok: true, status: ensureService().status() }
    } catch (error: any) {
      return { ok: false, error: { code: 'INTERNAL', message: String(error?.message ?? error) } }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMPUTER_LIST_APPS, async (_event, owner?: string) => {
    const svc = ensureService()
    return svc.listApps(String(owner ?? 'default'))
  })

  ipcMain.handle(IPC_CHANNELS.COMPUTER_GET_STATE, async (_event, request: CuaGetStateRequest) => {
    const svc = ensureService()
    try {
      return { ok: true, state: await svc.getState(request) }
    } catch (error) {
      const info = error instanceof CuaServiceError ? error.info : { code: 'INTERNAL', message: String((error as any)?.message ?? error), actionSent: false, retry: 'never' }
      return { ok: false, error: info }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMPUTER_ACTION, async (_event, request: CuaActionRequest) => {
    const svc = ensureService()
    return withEsc(() => svc.act(request))
  })

  ipcMain.handle(IPC_CHANNELS.COMPUTER_SCREENSHOT, async (_event, request: CuaScreenshotRequest) => {
    const svc = ensureService()
    return svc.screenshot(request)
  })

  ipcMain.handle(IPC_CHANNELS.COMPUTER_RUN_STEPS, async (_event, request: CuaRunStepsRequest) => {
    const svc = ensureService()
    return withEsc(() => svc.runSteps(request))
  })

  ipcMain.handle(IPC_CHANNELS.COMPUTER_STOP, async (_event, owner?: string) => {
    const svc = ensureService()
    await svc.stop(String(owner ?? '*'))
    init?.broadcast(IPC_CHANNELS.COMPUTER_EVENT, { type: 'stopped', reason: 'tool' })
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.COMPUTER_RESET, (_event, owner?: string) => {
    const svc = ensureService()
    svc.reset(String(owner ?? 'default'))
    host?.resetBudget()
    return { ok: true }
  })
}

export async function shutdownComputerUse(): Promise<void> {
  try { globalShortcut.unregister('Escape') } catch { /* not registered */ }
  escRegistered = false
  await host?.stop()
  await fake?.shutdown()
  host = null
  fake = null
  service = null
}

/** Test/diagnostics helper: probe the backend without going through IPC. */
export async function probeComputerUseBackend(): Promise<CuaProbeResult | null> {
  try {
    const backend = await getBackend()
    return await backend.probe()
  } catch {
    return null
  }
}
