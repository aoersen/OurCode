/**
 * Computer Use — service: the semantic layer between tools and a backend.
 *
 * Responsibilities (the parts a helper process must not know about):
 *  - observation store + delta modes (`stateId`, `baseStateId`)
 *  - element index lifetime, screenshot frame deadlines
 *  - settle + effect_evidence (never report "done" before the UI repainted)
 *  - action receipts (`actionSent` / `retry`) so nothing gets replayed blindly
 *  - controller lease, stop latch, audit trail
 *
 * No Electron imports: the wiring (paths, prefs, IPC) lives in `index.ts` so
 * this module is unit-testable against `FakeCuaBackend`.
 */
import { createHash } from 'crypto'
import {
  CUA_MAX_NODES,
  CUA_POST_ACTION_MS,
  CUA_SETTLE_MAX_MS,
  CUA_SETTLE_POLL_MS,
  cuaError,
  diffElements,
  healElement,
  isFrameActionable,
  type AppRef,
  type CuaActionResult,
  type CuaActionKind,
  type CuaActionRequest,
  type CuaAppInfo,
  type CuaBackendId,
  type CuaEffectEvidence,
  type CuaElementInfo,
  type CuaErrorCode,
  type CuaErrorInfo,
  type CuaGetStateRequest,
  type CuaPermissionStatus,
  type CuaRunStepsRequest,
  type CuaRunStepsResult,
  type CuaScreenshotRequest,
  type CuaScreenshotResult,
  type CuaState,
  type CuaStatus,
  type CuaStepResult,
} from '../../../shared/computer'
import { analyzeActionDanger, checkAppAllowed, type PolicyPrefs } from './policy'
import type { CuaBackend } from './backend'
import { isBackendFailure } from './client'
import type { CuaCaptureResponse } from './fakeBackend'
import { StateStore, stateKey } from './states'
import { FrameStore } from './frames'
import { createAuditLogger, type AuditLogger } from './audit'

export interface CuaPrefs extends PolicyPrefs {
  computerUseEnabled?: boolean
  computerUseMaxNodes?: number
  computerUsePostActionMs?: number
}

export interface BackendStatus {
  running: boolean
  backend: CuaBackendId
  protocol?: string
  capabilities: string[]
  permission?: CuaPermissionStatus
  lastError?: string
}

export interface CuaServiceOptions {
  /** Lazily started backend (helper host in production, fake in tests). */
  getBackend: () => Promise<CuaBackend>
  getBackendStatus: () => BackendStatus
  getPrefs: () => CuaPrefs
  frameDir: string
  auditFile?: string | null
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  audit?: AuditLogger
  platform?: string
  /** Called right before a write action is delivered (drives the overlay/UI). */
  onActionStart?: (info: { app: string; kind: CuaActionKind; bounds?: [number, number, number, number] }) => void
  /** Called when the action (including settle) is finished, whatever the outcome. */
  onActionEnd?: () => void
}

/** A refusal or backend failure carrying the protocol error shape. */
export class CuaServiceError extends Error {
  readonly info: CuaErrorInfo
  constructor(info: CuaErrorInfo) {
    super(info.message)
    this.name = 'CuaServiceError'
    this.info = info
  }
}

const ERROR_CODES = new Set<CuaErrorCode>([
  'RUNTIME_NOT_READY', 'PERMISSION_DENIED', 'INTERACTIVE_SESSION_REQUIRED', 'DPI_UNAWARE',
  'WINDOW_NOT_FOUND', 'WINDOW_NOT_VISIBLE', 'TARGET_STALE', 'ELEMENT_UNAVAILABLE',
  'NOT_SETTABLE', 'NOT_SELECTABLE', 'ACTION_UNAVAILABLE', 'FOREGROUND_REQUIRED',
  'CONTROLLER_BUSY', 'CONTROL_STOPPED', 'DISABLED', 'UNSUPPORTED', 'TIMEOUT', 'INTERNAL',
])

function fingerprint(elements: CuaElementInfo[]): string {
  const hash = createHash('sha1')
  for (const el of elements) {
    hash.update(`${el.index}\u0001${el.role}\u0001${el.name ?? ''}\u0001${el.value ?? ''}\u0001${el.actions.join(',')}\u0002`)
  }
  return hash.digest('hex')
}

/**
 * PowerShell 5.1's ConvertTo-Json collapses one-element arrays into scalars, so
 * anything crossing the helper boundary may arrive as a single object. Normalize
 * once here instead of sprinkling Array.isArray checks through the service.
 */
function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value === null || value === undefined) return []
  return [value as T]
}

function normalizeBounds(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined
  const nums = value.slice(0, 4).map((n) => Number(n))
  return nums.every((n) => Number.isFinite(n)) ? (nums as [number, number, number, number]) : undefined
}

function normalizeElement(raw: CuaElementInfo): CuaElementInfo {
  return {
    ...raw,
    index: Number(raw.index) || 0,
    role: String(raw.role ?? 'unknown'),
    name: raw.name ? String(raw.name) : undefined,
    value: raw.value ? String(raw.value) : undefined,
    automationId: raw.automationId ? String(raw.automationId) : undefined,
    enabled: raw.enabled !== false,
    actions: asArray<string>(raw.actions),
    bounds: normalizeBounds(raw.bounds),
  }
}

export class CuaService {
  private readonly states = new StateStore()
  private readonly frames: FrameStore
  private readonly audit: AuditLogger
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly platform: string
  private latched = new Set<string>()
  private controller: string | null = null
  private actionTail: Promise<unknown> = Promise.resolve()
  private appsCache: { at: number; apps: CuaAppInfo[] } | null = null

  constructor(private readonly opts: CuaServiceOptions) {
    this.frames = new FrameStore()
    this.audit = opts.audit ?? createAuditLogger(opts.auditFile ?? null)
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.platform = opts.platform ?? process.platform
  }

  // ── status / lifecycle ────────────────────────────────────────────────────

  status(): CuaStatus {
    const backend = this.opts.getBackendStatus()
    const prefs = this.opts.getPrefs()
    return {
      enabled: prefs.computerUseEnabled === true,
      available: backend.running,
      backend: backend.backend,
      platform: this.platform,
      protocol: backend.protocol,
      capabilities: backend.capabilities,
      permission: backend.permission,
      lastError: backend.lastError,
      stopped: this.latched.size > 0,
      controller: this.controller ?? undefined,
    }
  }

  /** Clear the stop latch for an owner (user sent a new instruction). */
  reset(owner: string): void {
    this.latched.delete(owner)
    // `'*'` is the global latch set by the physical Esc escape hatch.
    this.latched.delete('*')
    this.appsCache = null
  }

  /** Emergency stop: latch writes, release the lease, cancel held input. */
  async stop(owner: string): Promise<void> {
    this.latched.add(owner)
    if (this.controller === owner) this.controller = null
    try {
      const backend = await this.opts.getBackend()
      await backend.call('controller_stop', {})
    } catch {
      // The helper may be wedged — the latch is local and already effective.
    }
  }

  // ── observation ───────────────────────────────────────────────────────────

  async listApps(owner: string): Promise<{ ok: boolean; apps: CuaAppInfo[]; blocked: number; error?: CuaErrorInfo }> {
    void owner
    try {
      this.assertEnabled()
      const backend = await this.backend()
      const res = await backend.call<{ apps: CuaAppInfo[] | CuaAppInfo }>('list_apps', {})
      const prefs = this.opts.getPrefs()
      const apps: CuaAppInfo[] = []
      let blocked = 0
      for (const app of asArray<CuaAppInfo>(res?.apps)) {
        const identity = `${app.name} ${app.title ?? ''}`
        if (checkAppAllowed(identity, prefs).allowed) apps.push(app)
        else blocked += 1
      }
      this.appsCache = { at: this.now(), apps }
      return { ok: true, apps, blocked }
    } catch (error) {
      return { ok: false, apps: [], blocked: 0, error: this.errorInfo(error) }
    }
  }

  async getState(request: CuaGetStateRequest): Promise<CuaState> {
    this.assertEnabled()
    const owner = this.ownerOf(request.owner)
    this.assertNotStopped(owner)
    const { state } = await this.capture(owner, request.app, {
      includeScreenshot: request.includeScreenshot === true,
      maxNodes: request.maxNodes,
      disableDiffing: request.disableDiffing === true,
    })
    return state
  }

  async screenshot(request: CuaScreenshotRequest): Promise<CuaScreenshotResult> {
    try {
      this.assertEnabled()
      const owner = this.ownerOf(request.owner)
      const backend = await this.backend()
      const raw = await backend.call<{ path: string; width: number; height: number; scale?: number; unit?: any }>(
        'screenshot',
        request.screen
          ? { target: 'screen' }
          : { target: 'window', app: this.wireApp(request.app ?? {}), windowId: request.windowId },
      )
      const frame = this.frames.register(owner, raw, this.now())
      const dataUrl = this.frames.dataUrl(frame)
      if (!dataUrl) return { ok: false, error: cuaError('INTERNAL', '截图文件读不回来') }
      return {
        ok: true,
        dataUrl,
        mimeType: 'image/png',
        frame: {
          frameId: frame.frameId,
          width: frame.width,
          height: frame.height,
          unit: frame.unit,
          scale: frame.scale,
          capturedAt: frame.capturedAt,
        },
      }
    } catch (error) {
      return { ok: false, error: this.errorInfo(error) }
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  async act(request: CuaActionRequest): Promise<CuaActionResult> {
    const startedAt = this.now()
    const owner = this.ownerOf(request.owner)
    const kind = request.kind
    let targetLabel: string | undefined
    try {
      this.assertEnabled()
      this.assertNotStopped(owner)
      const isLaunch = kind === 'launch'
      // Launching has no target app yet: resolve one only for in-app actions.
      const info = isLaunch ? null : await this.resolveApp(request.app)
      const prefs = this.opts.getPrefs()
      const identity = info ? `${info.name} ${info.title ?? ''}` : String(request.target ?? request.path ?? '')
      const verdict = checkAppAllowed(identity, prefs)
      if (!verdict.allowed) throw new CuaServiceError(cuaError('PERMISSION_DENIED', verdict.reason))

      const previous = info ? this.previousState(owner, info) : undefined
      targetLabel = this.labelFor(previous, request.elementIndex)
      const danger = analyzeActionDanger({
        kind,
        appIdentity: identity,
        targetLabel,
        text: request.text ?? request.value,
        path: request.path ?? request.target,
      })
      if (danger.danger && request.confirm !== true) {
        throw new CuaServiceError(
          cuaError('PERMISSION_DENIED', `该动作被判定为高危：${danger.danger.reason}`, {
            details: { requiresConfirm: true, reason: danger.danger.reason, danger: true },
          }),
        )
      }

      // Coordinates need a live frame from the raster the model actually saw.
      if (kind === 'click' && (request.x !== undefined || request.y !== undefined)) {
        if (!this.frames.isActionable(owner, request.screenshotId, this.now())) {
          throw new CuaServiceError(
            cuaError('TARGET_STALE', '坐标点击必须带上最新 computer_screenshot 的 screenshot_id（frame 已过期或不存在）'),
          )
        }
      }

      this.assertLease(owner)
      const before = info ? (previous ? fingerprint(previous.elements) : await this.fingerprintOf(info)) : ''

      const backend = await this.backend()
      const method = this.methodOf(kind)
      const params = this.wireAction(kind, request)
      this.opts.onActionStart?.({ app: identity, kind, bounds: info?.bounds })
      try {
        await this.enqueue(() => backend.call(method, params))
      } finally {
        this.opts.onActionEnd?.()
      }

      const settled = info
        ? await this.settle(owner, info, before)
        : { evidence: 'unknown' as const, state: undefined }
      const result: CuaActionResult = {
        ok: true,
        kind,
        actionSent: true,
        effectEvidence: settled.evidence,
        state: settled.state,
        target: targetLabel ?? (request.elementIndex !== undefined ? `element [${request.elementIndex}]` : undefined),
        elapsedMs: this.now() - startedAt,
      }
      this.writeAudit({ owner, kind, app: identity, target: result.target, request, result })
      return result
    } catch (error) {
      const info = this.errorInfo(error)
      this.releaseLeaseIfIdle(owner)
      this.writeAudit({ owner, kind, app: request.app?.name, target: targetLabel, request, error: info })
      return {
        ok: false,
        kind,
        actionSent: info.actionSent,
        effectEvidence: 'unknown',
        error: info,
        elapsedMs: this.now() - startedAt,
      }
    }
  }

  async runSteps(request: CuaRunStepsRequest): Promise<CuaRunStepsResult> {
    const owner = this.ownerOf(request.owner)
    const steps = Array.isArray(request.steps) ? request.steps.slice(0, 20) : []
    const results: CuaStepResult[] = []
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const res = await this.act({ ...step.args, owner, kind: step.kind })
      results.push({ ...res, step: i })
      if (!res.ok) {
        return {
          ok: false,
          completed: i,
          total: steps.length,
          failedStep: i,
          steps: results,
          error: res.error,
          state: request.finalState ? await this.safeState(owner) : undefined,
        }
      }
      if (request.postActionSleepMs && request.postActionSleepMs > 0) {
        await this.sleep(Math.min(2000, request.postActionSleepMs))
      }
    }
    return {
      ok: true,
      completed: steps.length,
      total: steps.length,
      steps: results,
      state: request.finalState ? await this.safeState(owner) : undefined,
    }
  }

  /** Heal an index whose native handle died, using the newest observation. */
  async healIndex(owner: string, app: AppRef, index: number): Promise<CuaElementInfo | null> {
    const previous = this.previousState(owner, await this.resolveApp(app))
    if (!previous) return null
    const target = previous.elements.find((e) => e.index === index)
    if (!target) return null
    const { state } = await this.capture(owner, app, { disableDiffing: true })
    const found = healElement(target, state.elements)
    return found ? found.element : null
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private ownerOf(owner: string | undefined): string {
    const value = String(owner ?? '').trim()
    return value || 'default'
  }

  private async backend(): Promise<CuaBackend> {
    try {
      return await this.opts.getBackend()
    } catch (error) {
      throw new CuaServiceError(this.errorInfo(error))
    }
  }

  private assertEnabled(): void {
    if (this.opts.getPrefs().computerUseEnabled !== true) {
      throw new CuaServiceError(cuaError('DISABLED', '电脑操控未开启（设置 → 编辑器 → 电脑操控）'))
    }
  }

  private assertNotStopped(owner: string): void {
    if (this.latched.has(owner) || this.latched.has('*')) {
      throw new CuaServiceError(cuaError('CONTROL_STOPPED', '已急停：需要用户再次确认后才能继续。'))
    }
  }

  private assertLease(owner: string): void {
    if (this.controller && this.controller !== owner) {
      throw new CuaServiceError(cuaError('CONTROLLER_BUSY', `另一个会话（${this.controller}）正在操作本机`))
    }
    this.controller = owner
  }

  private releaseLeaseIfIdle(owner: string): void {
    if (this.controller === owner) this.controller = null
  }

  private methodOf(kind: CuaActionKind): string {
    switch (kind) {
      case 'click': return 'click'
      case 'type': return 'type_text'
      case 'key': return 'press_key'
      case 'setValue': return 'set_value'
      case 'scroll': return 'scroll'
      case 'drag': return 'drag'
      case 'paste': return 'paste'
      case 'performAction': return 'element_perform_action'
      case 'selectText': return 'select_text'
      case 'launch': return 'launch_app'
    }
  }

  private wireApp(app: AppRef): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (app?.name) out.name = app.name
    if (app?.pid) out.pid = app.pid
    if (app?.aumid) out.aumid = app.aumid
    if (app?.windowId) out.windowId = app.windowId
    return out
  }

  private wireAction(kind: CuaActionKind, request: CuaActionRequest): Record<string, unknown> {
    const base: Record<string, unknown> = { app: this.wireApp(request.app) }
    const coords = request.x !== undefined && request.y !== undefined ? { x: request.x, y: request.y } : {}
    switch (kind) {
      case 'click':
        return {
          ...base,
          ...(request.elementIndex !== undefined ? { elementIndex: request.elementIndex } : coords),
          button: request.button ?? 'left',
          count: request.count ?? 1,
          strategy: request.strategy ?? 'auto',
          screenshotId: request.screenshotId,
        }
      case 'type':
        return { ...base, text: String(request.text ?? '') }
      case 'key':
        return { ...base, keys: String(request.keys ?? '') }
      case 'setValue':
        return { ...base, elementIndex: request.elementIndex, value: String(request.value ?? '') }
      case 'scroll':
        return {
          ...base,
          ...(request.elementIndex !== undefined ? { elementIndex: request.elementIndex } : coords),
          direction: request.direction ?? 'down',
          amount: request.amount ?? 1,
        }
      case 'drag':
        return { ...base, from: request.from, to: request.to }
      case 'paste':
        return { ...base, text: String(request.text ?? '') }
      case 'performAction':
        return { ...base, elementIndex: request.elementIndex, action: String(request.action ?? 'press') }
      case 'selectText':
        return { ...base, elementIndex: request.elementIndex }
      case 'launch':
        return { target: request.target ?? '', path: request.path ?? '' }
    }
  }

  private labelFor(state: CuaState | undefined, index: number | undefined): string | undefined {
    if (!state || index === undefined) return undefined
    const el = state.elements.find((e) => e.index === index)
    return el ? `${el.role} "${el.name ?? ''}"`.trim() : undefined
  }

  private async resolveApp(ref: AppRef): Promise<CuaAppInfo> {
    if (!this.appsCache || this.now() - this.appsCache.at > 3000) {
      const backend = await this.backend()
      const res = await backend.call<{ apps: CuaAppInfo[] | CuaAppInfo }>('list_apps', {})
      this.appsCache = { at: this.now(), apps: asArray<CuaAppInfo>(res?.apps) }
    }
    const apps = this.appsCache.apps
    const pid = Number(ref?.pid ?? 0)
    const windowId = Number(ref?.windowId ?? 0)
    const name = String(ref?.name ?? '').trim()
    const found = apps.find(
      (a) =>
        (pid && a.pid === pid) ||
        (windowId && a.windowId === windowId) ||
        (name && (`${a.name} ${a.title ?? ''}`).toLowerCase().includes(name.toLowerCase())),
    )
    if (!found) {
      throw new CuaServiceError(
        cuaError('WINDOW_NOT_FOUND', `找不到应用/窗口：${name || pid || windowId || '(未指定)'}。先用 computer_list_apps 看看有哪些窗口。`),
      )
    }
    return found
  }

  private previousState(owner: string, info: CuaAppInfo): CuaState | undefined {
    const windowId = info.windowId ?? 0
    return this.states.previous(owner, stateKey({ pid: info.pid }, { windowId }))
  }

  private async fingerprintOf(info: CuaAppInfo): Promise<string> {
    const backend = await this.backend()
    const res = await backend.call<CuaCaptureResponse>('capture_app', {
      app: this.wireApp({ pid: info.pid, windowId: info.windowId }),
      includeScreenshot: false,
    })
    const elements = asArray<CuaElementInfo>((res as any)?.elements).map(normalizeElement)
    return fingerprint(elements)
  }

  private async capture(
    owner: string,
    app: AppRef,
    opts: { includeScreenshot?: boolean; maxNodes?: number; disableDiffing?: boolean },
  ): Promise<{ state: CuaState; response: CuaCaptureResponse }> {
    const backend = await this.backend()
    const prefs = this.opts.getPrefs()
    const maxNodes = Math.max(20, Math.min(Number(opts.maxNodes ?? prefs.computerUseMaxNodes ?? CUA_MAX_NODES) || CUA_MAX_NODES, 2000))
    const response = await backend.call<CuaCaptureResponse>('capture_app', {
      app: this.wireApp(app),
      includeScreenshot: opts.includeScreenshot === true,
      maxNodes,
      disableDiffing: opts.disableDiffing === true,
    })
    const identity = `${response.app?.name ?? ''} ${response.window?.title ?? ''}`
    const verdict = checkAppAllowed(identity, prefs)
    if (!verdict.allowed) throw new CuaServiceError(cuaError('PERMISSION_DENIED', verdict.reason))

    const elements = asArray<CuaElementInfo>((response as any)?.elements).map(normalizeElement)
    const window = {
      ...(response.window ?? {}),
      windowId: Number(response.window?.windowId ?? 0),
      title: String(response.window?.title ?? ''),
      bounds: normalizeBounds(response.window?.bounds) ?? ([0, 0, 0, 0] as [number, number, number, number]),
      visible: response.window?.visible !== false,
      minimized: response.window?.minimized === true,
    } as CuaState['window']
    const appInfo = { pid: Number(response.app?.pid ?? 0), name: String(response.app?.name ?? ''), aumid: response.app?.aumid }

    const key = stateKey(appInfo, window)
    const previous = this.states.previous(owner, key)
    const diff = opts.disableDiffing
      ? { mode: 'full' as const, changed: [], baseStateId: undefined as string | undefined }
      : diffElements(previous?.elements, elements, previous?.stateId)

    const stateId = this.states.nextId()
    let imageRef: CuaState['imageRef']
    if (response.image?.path) {
      const frame = this.frames.register(owner, response.image, this.now())
      imageRef = {
        frameId: frame.frameId,
        width: frame.width,
        height: frame.height,
        unit: frame.unit,
        scale: frame.scale,
        capturedAt: frame.capturedAt,
      }
    }
    const state: CuaState = {
      stateId,
      mode: diff.mode,
      baseStateId: diff.baseStateId,
      app: appInfo,
      window,
      elements,
      imageRef,
      capturedAt: this.now(),
      nodeCount: Number(response.nodeCount ?? elements.length),
      truncated: response.truncated === true,
    }
    this.states.remember(owner, key, state)
    return { state, response }
  }

  private async settle(
    owner: string,
    info: CuaAppInfo,
    before: string,
  ): Promise<{ evidence: CuaEffectEvidence; state?: CuaState }> {
    const prefs = this.opts.getPrefs()
    const post = Math.max(0, Math.min(Number(prefs.computerUsePostActionMs ?? CUA_POST_ACTION_MS) || CUA_POST_ACTION_MS, 3000))
    await this.sleep(post)
    let waited = 0
    while (waited <= CUA_SETTLE_MAX_MS) {
      try {
        const { state } = await this.capture(owner, { pid: info.pid, windowId: info.windowId }, {})
        if (fingerprint(state.elements) !== before) return { evidence: 'changed', state }
        if (waited >= CUA_SETTLE_MAX_MS) return { evidence: 'unchanged', state }
      } catch {
        return { evidence: 'unknown' }
      }
      await this.sleep(CUA_SETTLE_POLL_MS)
      waited += CUA_SETTLE_POLL_MS
    }
    return { evidence: 'unknown' }
  }

  private async safeState(owner: string): Promise<CuaState | undefined> {
    try {
      const backend = await this.backend()
      const apps = await backend.call<{ apps: CuaAppInfo[] }>('list_apps', {})
      const first = apps.apps?.[0]
      if (!first) return undefined
      const { state } = await this.capture(owner, { pid: first.pid, windowId: first.windowId }, {})
      return state
    } catch {
      return undefined
    }
  }

  private async enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.actionTail.then(job, job)
    // Keep the tail alive even when the job rejects.
    this.actionTail = run.then(() => undefined, () => undefined)
    return run
  }

  private errorInfo(error: unknown): CuaErrorInfo {
    if (error instanceof CuaServiceError) return error.info
    if (isBackendFailure(error)) {
      const code = (ERROR_CODES.has(error.code as CuaErrorCode) ? error.code : 'INTERNAL') as CuaErrorCode
      return cuaError(code, error.message, { actionSent: error.actionSent === true })
    }
    return cuaError('INTERNAL', String((error as any)?.message ?? error))
  }

  private writeAudit(opts: {
    owner: string
    kind: CuaActionKind
    app?: string
    target?: string
    request: CuaActionRequest
    result?: CuaActionResult
    error?: CuaErrorInfo
  }): void {
    const text = String(opts.request.text ?? opts.request.value ?? '')
    this.audit.write({
      ts: this.now(),
      owner: opts.owner,
      kind: opts.kind,
      app: opts.app,
      target: opts.target,
      textLen: text ? text.length : undefined,
      textPrefix: text ? text.slice(0, 2) : undefined,
      keys: opts.request.keys,
      ok: !opts.error,
      code: opts.error?.code,
      effect: opts.result?.effectEvidence,
      elapsedMs: opts.result?.elapsedMs,
    })
  }
}

export { isFrameActionable }
