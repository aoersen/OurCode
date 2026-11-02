/**
 * Computer Use — shared contract.
 *
 * Everything in this file is dependency-free (no Electron, no Node built-ins) so
 * the main process, the renderer tool layer and the unit tests all see one copy:
 *
 *   helper (platform backend)  →  main's CUA service  →  renderer tool helpers
 *
 * The wire format between helper and main is CAMELCASE JSON lines (NDJSON), the
 * same shape as the TS types below — one vocabulary on both sides, no mapping
 * table to get out of sync.
 *
 * Design notes worth keeping in mind when editing:
 *  - Element indexes are only valid for the LATEST observation of that app.
 *  - Coordinates are only valid inside the frame that came with the observation
 *    that produced them (`frameId`), never derived from element bounds.
 *  - The accessibility tree text is UNTRUSTED input (it comes from other apps);
 *    it may be shown to the model but never interpreted as instructions.
 */

/** Protocol version spoken by helper binaries. Bump on breaking changes. */
export const CUA_PROTOCOL = 'cua-ips/1'

/** Element tree caps: nodes per observation and characters in the rendered text. */
export const CUA_MAX_NODES = 300
export const CUA_MAX_TREE_CHARS = 8_000

/** How many observations the service keeps for delta/base lookups. */
export const CUA_STATE_LRU = 8
/** Screenshot frames kept in memory / on disk, and how long they stay actionable. */
export const CUA_FRAME_LRU = 16
export const CUA_FRAME_TTL_MS = 10 * 60_000

/** Delta observation falls back to a full tree when more than this share changed. */
export const CUA_DELTA_RATIO = 0.4

/** Self-healing: max distance an element may travel and still be considered the same. */
export const CUA_HEAL_MAX_PX = 400

/** Settle window after a write action (UI needs a moment to repaint). */
export const CUA_POST_ACTION_MS = 300
export const CUA_SETTLE_MAX_MS = 5_000
export const CUA_SETTLE_POLL_MS = 250

/** Bounded batch execution. */
export const CUA_MAX_STEPS = 20

/** How long a helper request may hang before the service reports TIMEOUT. */
export const CUA_READ_TIMEOUT_MS = 15_000

/** Which action classes exist (drives approval + helper method routing). */
export const CUA_ACTION_KINDS = [
  'click',
  'type',
  'key',
  'setValue',
  'scroll',
  'drag',
  'paste',
  'performAction',
  'selectText',
  'launch',
] as const
export type CuaActionKind = (typeof CUA_ACTION_KINDS)[number]

/** Window/app identity used everywhere. Resolve order: pid → windowId → name → aumid. */
export interface AppRef {
  name?: string
  pid?: number
  aumid?: string
  windowId?: number
}

export type CuaBounds = [number, number, number, number]

export interface CuaAppInfo {
  pid: number
  name: string
  aumid?: string
  windowId?: number
  title?: string
  visible?: boolean
  minimized?: boolean
  bounds?: CuaBounds
}

export interface CuaWindowInfo {
  windowId: number
  title: string
  className?: string
  main: boolean
  focused: boolean
  visible: boolean
  minimized: boolean
  bounds: CuaBounds
}

export interface CuaElementInfo {
  index: number
  role: string
  name?: string
  value?: string
  automationId?: string
  enabled: boolean
  actions: string[]
  bounds?: CuaBounds
}

export interface CuaImageRef {
  frameId: string
  width: number
  height: number
  /** Windows: physical pixels; macOS: points; Linux: X11 root pixels. */
  unit: 'physical_pixel' | 'point' | 'x11_root_pixel'
  scale: number
  capturedAt: number
}

export type CuaStateMode = 'full' | 'delta' | 'no_change'

export interface CuaState {
  stateId: string
  mode: CuaStateMode
  baseStateId?: string
  app: { pid: number; name: string; aumid?: string }
  window: CuaWindowInfo
  /** Always the full (current) element table — `mode` only compresses the text. */
  elements: CuaElementInfo[]
  imageRef?: CuaImageRef
  capturedAt: number
  nodeCount: number
  truncated: boolean
}

export type CuaErrorCode =
  | 'RUNTIME_NOT_READY'
  | 'PERMISSION_DENIED'
  | 'INTERACTIVE_SESSION_REQUIRED'
  | 'DPI_UNAWARE'
  | 'WINDOW_NOT_FOUND'
  | 'WINDOW_NOT_VISIBLE'
  | 'TARGET_STALE'
  | 'ELEMENT_UNAVAILABLE'
  | 'NOT_SETTABLE'
  | 'NOT_SELECTABLE'
  | 'ACTION_UNAVAILABLE'
  | 'FOREGROUND_REQUIRED'
  | 'CONTROLLER_BUSY'
  | 'CONTROL_STOPPED'
  | 'DISABLED'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'INTERNAL'

export type CuaRetry = 'retry' | 'reobserve' | 'never'

export interface CuaErrorInfo {
  code: CuaErrorCode
  message: string
  /** True when the action MAY already have been delivered — never replay blindly. */
  actionSent: boolean
  retry: CuaRetry
  details?: Record<string, unknown>
}

export type CuaEffectEvidence = 'changed' | 'unchanged' | 'unknown'

export interface CuaActionRequest {
  owner: string
  app: AppRef
  kind: CuaActionKind
  /** Click / coordinate target. */
  elementIndex?: number
  x?: number
  y?: number
  screenshotId?: string
  button?: 'left' | 'right' | 'middle'
  count?: 1 | 2 | 3
  strategy?: 'auto' | 'a11y' | 'event'
  /** Keyboard / value payloads. */
  text?: string
  keys?: string
  value?: string
  action?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  from?: { x: number; y: number }
  to?: { x: number; y: number }
  /** launch */
  path?: string
  target?: string
  /** Set only after the USER confirmed a dangerous action (see policy). */
  confirm?: boolean
}

/** Observation request (IPC + service). */
export interface CuaGetStateRequest {
  owner: string
  app: AppRef
  includeScreenshot?: boolean
  maxNodes?: number
  disableDiffing?: boolean
}

/** Screenshot request (IPC + service). */
export interface CuaScreenshotRequest {
  owner: string
  app?: AppRef
  screen?: boolean
  windowId?: number
}

export interface CuaActionResult {
  ok: boolean
  kind: CuaActionKind
  actionSent: boolean
  effectEvidence: CuaEffectEvidence
  error?: CuaErrorInfo
  /** Fresh observation after the action (summary mode), when available. */
  state?: CuaState
  /** Human/model readable one-liner, e.g. `element [4] button "保存"`. */
  target?: string
  elapsedMs?: number
}

export interface CuaRunStep {
  kind: CuaActionKind
  args: Omit<CuaActionRequest, 'owner' | 'kind'>
}

export interface CuaRunStepsRequest {
  owner: string
  steps: CuaRunStep[]
  postActionSleepMs?: number
  finalState?: boolean
}

export interface CuaStepResult extends CuaActionResult {
  step: number
}

export interface CuaRunStepsResult {
  ok: boolean
  completed: number
  total: number
  failedStep?: number
  steps: CuaStepResult[]
  error?: CuaErrorInfo
  state?: CuaState
}

export interface CuaPermissionStatus {
  interactiveSession: boolean
  dpiAware: boolean
  screenCapture: boolean
  /** macOS TCC prompts; Windows/Linux report `not_required`. */
  accessibility: 'granted' | 'denied' | 'not_required' | 'unknown'
  screenRecording: 'granted' | 'denied' | 'not_required' | 'unknown'
}

export type CuaBackendId = 'powershell' | 'native' | 'fake' | 'none'

export interface CuaStatus {
  /** The user preference is on. */
  enabled: boolean
  /** The helper answered a health probe. */
  available: boolean
  backend: CuaBackendId
  platform: string
  protocol?: string
  capabilities: string[]
  permission?: CuaPermissionStatus
  /** Set when the last start/probe failed — shown verbatim in the settings panel. */
  lastError?: string
  /** A stop was latched; writes are refused until the user continues. */
  stopped: boolean
  /** A session currently holds the controller lease. */
  controller?: string
}

/** Frames are referenced by id so coordinates cannot silently outlive the raster. */
export interface CuaFrameInfo {
  frameId: string
  width: number
  height: number
  unit: CuaImageRef['unit']
  scale: number
  capturedAt: number
}

export interface CuaScreenshotResult {
  ok: boolean
  dataUrl?: string
  mimeType?: string
  frame?: CuaFrameInfo
  error?: CuaErrorInfo
}

export interface CuaListAppsResult {
  ok: boolean
  apps: CuaAppInfo[]
  error?: CuaErrorInfo
}

export function cuaError(
  code: CuaErrorCode,
  message: string,
  opts: { actionSent?: boolean; retry?: CuaRetry; details?: Record<string, unknown> } = {},
): CuaErrorInfo {
  const retry: CuaRetry =
    opts.retry ??
    (code === 'TARGET_STALE' || code === 'ELEMENT_UNAVAILABLE' || code === 'WINDOW_NOT_VISIBLE' || code === 'WINDOW_NOT_FOUND'
      ? 'reobserve'
      : code === 'RUNTIME_NOT_READY' || code === 'TIMEOUT'
        ? 'retry'
        : 'never')
  return { code, message, actionSent: opts.actionSent === true, retry, details: opts.details }
}

/** Default retry advice for a code (shared by service and renderer formatting). */
export function retryHint(code: CuaErrorCode): string {
  switch (code) {
    case 'TARGET_STALE':
    case 'ELEMENT_UNAVAILABLE':
      return '先 computer_get_state 重新观察（元素索引只在最新一次观察里有效）。'
    case 'WINDOW_NOT_VISIBLE':
    case 'WINDOW_NOT_FOUND':
      return '先 computer_list_apps 确认窗口存在；最小化窗口需要先 computer_launch_app/激活恢复。'
    case 'RUNTIME_NOT_READY':
    case 'TIMEOUT':
      return '电脑操控运行时未就绪（可在设置里查看原因）；稍后重试或重启 IDE。'
    case 'CONTROLLER_BUSY':
      return '另一个会话正在操作本机，等它结束或先 computer_stop。'
    case 'CONTROL_STOPPED':
      return '已急停。需要用户再发一句话确认继续。'
    case 'FOREGROUND_REQUIRED':
      return '目标窗口不在前台：改用元素动作，或先激活窗口（会抢焦点，需用户同意）。'
    case 'NOT_SETTABLE':
    case 'NOT_SELECTABLE':
    case 'ACTION_UNAVAILABLE':
      return '该元素不支持此操作：改用 computer_type / computer_key 或点击后输入。'
    case 'PERMISSION_DENIED':
      return '目标应用被策略屏蔽（敏感应用黑名单 / 公司会话），需用户手动操作。'
    case 'INTERACTIVE_SESSION_REQUIRED':
      return '当前不是交互式桌面会话（服务/远程无桌面），电脑操控不可用。'
    case 'DPI_UNAWARE':
      return 'helper 的 DPI 感知未生效，坐标不可信；重启 IDE 或重新安装运行时。'
    default:
      return '查看设置页「电脑操控」的状态与最近审计记录。'
  }
}

// ── Pure rendering / diffing helpers (no Node APIs; unit-tested) ─────────────

/** Stable per-element identity used for diffing and self-healing. */
export function elementSignature(el: CuaElementInfo): string {
  return [el.role, el.name ?? '', el.automationId ?? '', el.value ?? '', el.actions.join(',')].join('\u0001')
}

/** One rendered tree line: `[3] document "文本编辑器" actions=[set_value]`. */
export function renderElementLine(el: CuaElementInfo, depth = 0): string {
  const indent = '  '.repeat(Math.max(0, depth))
  const name = el.name ? ` "${el.name.replace(/\s+/g, ' ').slice(0, 120)}"` : ''
  const value = el.value && el.value !== el.name ? ` value="${el.value.replace(/\s+/g, ' ').slice(0, 80)}"` : ''
  const actions = el.actions.length ? ` actions=[${el.actions.join(',')}]` : ''
  return `${indent}[${el.index}] ${el.role}${name}${value}${actions}`
}

export interface DiffResult {
  mode: CuaStateMode
  baseStateId?: string
  /** Element indexes that are new or whose signature differs from the base. */
  changed: number[]
}

/**
 * Compare the current element table with the previous observation of the same
 * window. Element order/index is stable between observations of one window in
 * practice (same walker, same node cap), so positional comparison plus a
 * signature check is enough — and cheap.
 */
export function diffElements(prev: CuaElementInfo[] | undefined, next: CuaElementInfo[] | undefined, baseStateId?: string): DiffResult {
  const current = next ?? []
  if (!prev || !prev.length) return { mode: 'full', changed: current.map((e) => e.index) }
  const prevByIndex = new Map(prev.map((e) => [e.index, elementSignature(e)]))
  const changed = current.filter((e) => prevByIndex.get(e.index) !== elementSignature(e)).map((e) => e.index)
  if (!changed.length) return { mode: 'no_change', baseStateId, changed: [] }
  const ratio = current.length ? changed.length / current.length : 1
  return { mode: ratio > CUA_DELTA_RATIO ? 'full' : 'delta', baseStateId, changed }
}

/** Render a state for the model. `mode` compresses delta/no_change output. */
export function renderStateText(state: CuaState, opts: { maxChars?: number; header?: string } = {}): string {
  const maxChars = opts.maxChars ?? CUA_MAX_TREE_CHARS
  const win = state.window
  const flags = [win.main ? 'main' : '', win.focused ? 'focused' : '', `${win.bounds[2]}x${win.bounds[3]}`]
    .filter(Boolean)
    .join(', ')
  const head = [
    opts.header || `app: ${state.app.name} (pid ${state.app.pid})`,
    `window: "${win.title}" [window_id=${win.windowId}, ${flags}]`,
  ]
  if (state.mode === 'no_change') {
    head.push(`state: ${state.stateId} (no_change, base ${state.baseStateId || '—'}) — 界面与上次观察一致`)
    return head.join('\n')
  }
  const changed = new Set<number>()
  if (state.mode === 'delta') {
    // Delta only shows changed nodes plus their immediate neighbours, which is
    // enough to re-orient without re-reading the whole tree.
    const prevHeader = state.baseStateId ? ` base ${state.baseStateId}` : ''
    head.push(`state: ${state.stateId} (delta${prevHeader}) — 只显示变化节点`)
  } else {
    head.push(`state: ${state.stateId} (full, ${state.nodeCount} nodes)`)
  }
  const lines: string[] = []
  for (const el of state.elements) {
    if (state.mode === 'delta' && !changed.has(el.index)) {
      // keep unnamed containers that lead to changed nodes (depth cues)
      continue
    }
    lines.push(renderElementLine(el))
  }
  if (state.truncated) lines.push(`…（树被截断，共 ${state.nodeCount} 节点；可提高 max_nodes 或指定 window_id）`)
  let body = lines.join('\n')
  if (body.length > maxChars) {
    body = `${body.slice(0, Math.floor(maxChars * 0.6))}\n…（省略中间部分）\n${body.slice(-Math.floor(maxChars * 0.35))}`
  }
  return [...head, body].filter(Boolean).join('\n')
}

/**
 * Self-healing lookup for an element index that no longer maps to a live native
 * handle: match `role + name (+ automationId / value)`, preferring the candidate
 * closest to the old bounds and refusing moves beyond CUA_HEAL_MAX_PX.
 */
export function healElement(
  previous: CuaElementInfo,
  current: CuaElementInfo[],
  maxDisplacement = CUA_HEAL_MAX_PX,
): { element: CuaElementInfo; displacement: number } | null {
  const sameRoleName = current.filter(
    (e) => e.role === previous.role && (e.name ?? '') === (previous.name ?? '') && (e.automationId ?? '') === (previous.automationId ?? ''),
  )
  const candidates = sameRoleName.length
    ? sameRoleName
    : current.filter((e) => e.role === previous.role && (e.name ?? '') === (previous.name ?? ''))
  if (!candidates.length) return null
  const dist = (e: CuaElementInfo): number => {
    if (!previous.bounds || !e.bounds) return Number.POSITIVE_INFINITY
    const dx = e.bounds[0] + e.bounds[2] / 2 - (previous.bounds[0] + previous.bounds[2] / 2)
    const dy = e.bounds[1] + e.bounds[3] / 2 - (previous.bounds[1] + previous.bounds[3] / 2)
    return Math.round(Math.hypot(dx, dy))
  }
  const ranked = candidates
    .map((e) => ({ element: e, displacement: dist(e) }))
    .sort((a, b) => a.displacement - b.displacement)
  const best = ranked[0]
  if (!Number.isFinite(best.displacement)) return { element: best.element, displacement: -1 }
  return best.displacement <= maxDisplacement ? best : null
}

/** Frame liveness check shared by service and tests. */
export function isFrameActionable(frame: CuaFrameInfo | undefined, now: number, ttl = CUA_FRAME_TTL_MS): boolean {
  return !!frame && now - frame.capturedAt <= ttl
}
