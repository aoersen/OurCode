/**
 * The agent browser session.
 *
 * One hidden, fully sandboxed webContents (no preload — a browsed page gets no
 * bridge into the app) that the assistant drives through tools. This is what
 * closes the loop the integrated terminal never could: after a frontend change
 * the model can load the page, read its console, and look at a screenshot.
 *
 * Navigation is deliberately unrestricted to http(s) (see navigation-guard's
 * arbitrary mode) but never to file:// or ourcode-file://, so a remote page
 * cannot read the workspace through the app's own preview protocol.
 */
import { BrowserWindow, type WebContents } from 'electron'
import { allowArbitraryNavigation, revokeArbitraryNavigation } from './navigation-guard'
import {
  buildActScript,
  buildScrollProbeScript,
  buildScrollSettleScript,
  formatAxTree,
  formatConsoleForModel,
  normalizeBrowserUrl,
  pageTextScript,
  parseKeyChord,
  trimConsoleBuffer,
  truncatePageText,
  BROWSER_CONSOLE_LIMIT,
  BROWSER_PAGE_TEXT_LIMIT,
  type AxInputNode,
  type KeyChord,
} from '../../shared/browser'
import type {
  BrowserAction,
  BrowserActOptions,
  BrowserActResult,
  BrowserActStrategy,
  BrowserConsoleEntry,
  BrowserMouseButton,
  BrowserPoint,
  BrowserScreenshotResult,
  BrowserSessionState,
  BrowserSnapshotResult,
  BrowserViewport,
} from '../../shared/types'

/** How long a navigation may take before the tool gives up and reports what it
 *  got — a hung dev server must not hang the agent loop. */
const NAVIGATE_TIMEOUT_MS = 20_000
const EVAL_TIMEOUT_MS = 10_000

/** Isolated, persistent partition: a dev server that needs a login cookie keeps
 *  it across navigations without touching the app's own session. */
const BROWSER_PARTITION = 'persist:ourcode-browser'

export interface BrowserSessionHooks {
  /** Push a state/console change to the renderer. */
  broadcast: (payload: { type: 'state'; state: BrowserSessionState } | { type: 'console'; entry: BrowserConsoleEntry }) => void
}

let win: BrowserWindow | null = null
let hooks: BrowserSessionHooks | null = null
let consoleBuffer: BrowserConsoleEntry[] = []
let lastError: string | undefined
/** ref table of the last snapshot (ref → backend DOM node id). A navigation
 *  invalidates it: the ids belong to the document that produced them. */
let lastRefs = new Map<string, number>()
let lastSnapshotId = ''
let snapshotSeq = 0
const state: BrowserSessionState = {
  url: '',
  title: '',
  loading: false,
  visible: false,
  canGoBack: false,
  canGoForward: false,
}

function snapshot(): BrowserSessionState {
  const wc = currentContents()
  return {
    ...state,
    canGoBack: !!wc?.canGoBack(),
    canGoForward: !!wc?.canGoForward(),
    lastError,
  }
}

function pushState(): void {
  hooks?.broadcast({ type: 'state', state: snapshot() })
}

function record(entry: BrowserConsoleEntry): void {
  consoleBuffer = trimConsoleBuffer([...consoleBuffer, entry], BROWSER_CONSOLE_LIMIT)
  hooks?.broadcast({ type: 'console', entry })
}

function currentContents(): WebContents | null {
  if (!win || win.isDestroyed()) return null
  return win.webContents
}

/** Map Electron's 0..3 console levels onto the shared union. */
function levelName(level: number): BrowserConsoleEntry['level'] {
  switch (level) {
    case 0: return 'verbose'
    case 1: return 'info'
    case 2: return 'warning'
    default: return 'error'
  }
}

function attachContentsEvents(wc: WebContents): void {
  // console-message carries page JS errors too — an uncaught exception arrives
  // here as level 3, which is exactly what the agent needs to see.
  wc.on('console-message', (_event, level, message, line, sourceId) => {
    record({
      level: levelName(level),
      text: String(message).slice(0, 2000),
      source: sourceId ? `${sourceId}:${line}` : undefined,
      at: Date.now(),
    })
  })
  wc.on('did-start-loading', () => {
    state.loading = true
    pushState()
  })
  wc.on('did-navigate', (_event, url) => {
    state.url = url
    lastError = undefined
    lastRefs = new Map()
    lastSnapshotId = ''
    pushState()
  })
  wc.on('did-navigate-in-page', (_event, url) => {
    state.url = url
    pushState()
  })
  wc.on('page-title-updated', (_event, title) => {
    state.title = title
    pushState()
  })
  wc.on('did-stop-loading', () => {
    state.loading = false
    pushState()
  })
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 /* ABORTED, i.e. a redirect */) return
    lastError = `${errorDescription} (${validatedURL})`
    record({ level: 'error', text: `页面加载失败：${errorDescription}`, source: validatedURL, at: Date.now() })
    state.loading = false
    pushState()
  })
  allowArbitraryNavigation(wc.id)
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    // A hidden window still has to produce frames, or capturePage() returns a
    // blank image and browser_screenshot is useless.
    paintWhenInitiallyHidden: true,
    title: 'OurCode 浏览器',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // No preload: whatever page the agent opens must not see the app's IPC.
      partition: BROWSER_PARTITION,
      // Hidden windows get background-throttled, which stalls page timers (a dev
      // server's HMR ping, a setTimeout-driven render) and can leave capturePage
      // with a stale frame after the window was shown once and hidden again.
      backgroundThrottling: false,
    },
  })
  const wc = win.webContents
  attachContentsEvents(wc)
  // will-navigate only covers the main frame. A page the agent loads could
  // otherwise embed <iframe src="ourcode-file://…"> and read workspace files
  // through the app's preview protocol — so refuse every non-http(s) request in
  // this partition explicitly, instead of relying on the protocol handler being
  // registered only on the default session. ws/wss stay allowed: a dev server's
  // HMR socket is how the page under test behaves normally.
  wc.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(details.url)?.[0]?.toLowerCase()
    const ok = scheme === 'http:' || scheme === 'https:' || scheme === 'ws:' || scheme === 'wss:'
    callback(ok ? { cancel: false } : { cancel: true })
  })
  // Capture the id now: `win.webContents` throws after 'closed' (the same trap
  // main.ts documents for its own windows).
  win.on('closed', () => {
    revokeArbitraryNavigation(wc.id)
    win = null
    state.visible = false
    state.url = ''
    state.title = ''
    state.loading = false
    pushState()
  })
  win.on('hide', () => { state.visible = false; pushState() })
  win.on('show', () => { state.visible = true; pushState() })
  return win
}

/** Resolve once the main frame finishes (or fails) loading, capped so a hung
 *  page can't stall the agent loop. */
function waitForLoad(wc: WebContents, timeoutMs = NAVIGATE_TIMEOUT_MS): Promise<{ timedOut: boolean }> {
  if (!wc.isLoading()) return Promise.resolve({ timedOut: false })
  return new Promise((resolve) => {
    let done = false
    const finish = (timedOut: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      wc.off('did-stop-loading', onStop)
      wc.off('did-fail-load', onFail)
      resolve({ timedOut })
    }
    const onStop = (): void => finish(false)
    const onFail = (): void => finish(false)
    const timer = setTimeout(() => finish(true), timeoutMs)
    wc.on('did-stop-loading', onStop)
    wc.on('did-fail-load', onFail)
  })
}

/** evaluate + timeout guard. A page that overrides built-ins or hangs in a
 *  getter must not hang the main process's caller. */
async function evaluate<T>(wc: WebContents, script: string): Promise<T> {
  // The raced promise keeps running after the timeout; without a catch of its
  // own its later rejection (page gone, window closed) surfaces as an
  // unhandledRejection in the main process.
  const evalPromise = wc.executeJavaScript(script, true) as Promise<T>
  evalPromise.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), EVAL_TIMEOUT_MS)
  })
  const guarded = await Promise.race([evalPromise, timeout])
  if (timer) clearTimeout(timer)
  if (guarded === null) throw new Error('页面脚本执行超时')
  return guarded
}

// ── Real input via CDP Input.* ──────────────────────────────────────────────
//
// browser_act used to be DOM-only (el.click() + synthetic KeyboardEvent). That
// cannot exercise pointerdown/mousedown ordering, hover, drag or trusted keys —
// exactly what a UI self-test needs. These helpers drive Chromium's own input
// pipeline instead. Coordinates are CSS pixels in the viewport (the same space
// as getBoundingClientRect); the hidden window does not need OS focus.

const MOUSE_BUTTON_MASK: Record<BrowserMouseButton, number> = { left: 1, middle: 4, right: 2 }

type TargetResult = { ok: true; objectId: string } | { ok: false; error: string }
type MeasureResult = { ok: true; x: number; y: number; covered?: string } | { ok: false; error: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

function pointFrom(opts: BrowserActOptions): BrowserPoint | null {
  const x = num(opts.x)
  const y = num(opts.y)
  if (x === undefined || y === undefined) return null
  return { x: Math.round(x), y: Math.round(y) }
}

function normalizeButton(button: unknown): BrowserMouseButton {
  return button === 'right' || button === 'middle' ? button : 'left'
}

function normalizeClickCount(count: unknown): number {
  const n = Math.round(Number(count) || 1)
  return Math.max(1, Math.min(3, n))
}

function normalizeDelta(delta: unknown): number {
  const n = Number(delta)
  if (!Number.isFinite(n)) return 0
  return Math.max(-10_000, Math.min(10_000, Math.round(n)))
}

function parseJsonObject(raw: unknown): any | null {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) } catch { return null }
}

/** scrollIntoView + measure the element's centre in viewport CSS pixels.
 *  For a node inside a same-origin iframe, `window.frameElement` is walked up
 *  and the frame origins are added in the page itself — CDP's DOM node has no
 *  containing-frame field. `covered` means a click will land on another element
 *  (an overlay, a sticky header), exactly like a human click would. */
const TARGET_MEASURE_FN = `function () {
  try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (e) {
    try { this.scrollIntoView() } catch (e2) {}
  }
  const r = this.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return JSON.stringify({ ok: false, error: '元素尺寸为 0（不可见或尚未布局）' });
  const localX = r.left + r.width / 2, localY = r.top + r.height / 2;
  let covered = '';
  try {
    const root = this.getRootNode ? this.getRootNode() : document;
    const hit = root.elementFromPoint ? root.elementFromPoint(localX, localY) : document.elementFromPoint(localX, localY);
    if (hit && hit !== this && !this.contains(hit) && !hit.contains(this)) {
      covered = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '');
    }
  } catch (e) {}
  let x = localX, y = localY;
  let w = window;
  for (let depth = 0; depth < 8; depth += 1) {
    let fe = null;
    try { fe = w.frameElement } catch (e) { fe = null; }
    if (!fe) {
      let isTop = false;
      try { isTop = w.parent === w } catch (e) { isTop = false; }
      if (!isTop) return JSON.stringify({ ok: false, error: '跨域 iframe：无法换算到主视口坐标' });
      break;
    }
    const cs = getComputedStyle(fe);
    if (cs.transform && cs.transform !== 'none') {
      return JSON.stringify({ ok: false, error: 'iframe 应用了 CSS transform，坐标不可信' });
    }
    const fr = fe.getBoundingClientRect();
    const ow = fe.offsetWidth || fr.width || 1;
    const oh = fe.offsetHeight || fr.height || 1;
    if (Math.abs(fr.width / ow - 1) > 0.01 || Math.abs(fr.height / oh - 1) > 0.01) {
      return JSON.stringify({ ok: false, error: 'iframe 被缩放，坐标不可信' });
    }
    x += fr.left + (fe.clientLeft || 0) + (parseFloat(cs.paddingLeft) || 0);
    y += fr.top + (fe.clientTop || 0) + (parseFloat(cs.paddingTop) || 0);
    const next = fe.ownerDocument && fe.ownerDocument.defaultView;
    if (!next) break;
    w = next;
  }
  return JSON.stringify({ ok: true, x: x, y: y, width: r.width, height: r.height, covered: covered });
}`

const FOCUS_FN = `function () {
  try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (e) {}
  try { this.focus({ preventScroll: true }) } catch (e) { try { this.focus() } catch (e2) {} }
  return document.activeElement === this || this.isContentEditable ? 'focused' : 'not-focused';
}`

const FOCUS_SELECT_FN = `function () {
  try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (e) {}
  try { this.focus({ preventScroll: true }) } catch (e) { try { this.focus() } catch (e2) {} }
  try {
    if (this.select) this.select();
    else if (this.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(this);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch (e) {}
  return document.activeElement === this || this.isContentEditable ? 'selected' : 'not-focused';
}`

const CHANGE_EVENT_FN = `function () {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return 'changed';
  }
  return 'n/a';
}`

const NORMALIZE_ELEMENT_FN = `function () {
  if (this.nodeType === 1) return this;
  let node = this.parentElement || this.parentNode;
  while (node && node.nodeType !== 1) node = node.parentNode;
  return node || this;
}`

/** AX refs can point at a text node (a button's label is its own AX node).
 *  Normalise to the owning Element so click/type/focus have a real target. */
async function elementObjectId(wc: WebContents, objectId: string): Promise<string> {
  try {
    const normalized = await cdp<{ result?: { objectId?: string } }>(wc, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: NORMALIZE_ELEMENT_FN,
      returnByValue: false,
    })
    return normalized?.result?.objectId || objectId
  } catch {
    return objectId
  }
}

async function resolveTarget(wc: WebContents, opts: BrowserActOptions): Promise<TargetResult> {
  try {
    ensureDebugger(wc)
    await cdp(wc, 'DOM.enable')
    const ref = String(opts.ref ?? '').trim()
    if (ref) {
      const backendNodeId = lastRefs.get(ref)
      if (!backendNodeId) {
        return { ok: false, error: `ref ${ref} 不属于最近一次 browser_snapshot（快照可能已过期，重新调用一次）` }
      }
      const resolved = await cdp<{ object?: { objectId?: string } }>(wc, 'DOM.resolveNode', { backendNodeId })
      const rawObjectId = resolved?.object?.objectId
      if (!rawObjectId) return { ok: false, error: `ref ${ref} 解析不到 DOM 节点（页面可能已更新）` }
      return { ok: true, objectId: await elementObjectId(wc, rawObjectId) }
    }

    const selector = String(opts.selector ?? '').trim()
    if (!selector) return { ok: false, error: '需要 ref、selector 或 x/y 坐标' }
    const evaluated = await cdp<{ result?: { objectId?: string }; exceptionDetails?: { text?: string } }>(wc, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    })
    if (evaluated?.exceptionDetails) return { ok: false, error: `选择器不合法：${selector}` }
    const rawObjectId = evaluated?.result?.objectId
    if (!rawObjectId) return { ok: false, error: `选择器没有匹配到元素：${selector}` }
    return { ok: true, objectId: await elementObjectId(wc, rawObjectId) }
  } catch (error: any) {
    return { ok: false, error: `定位目标失败：${error?.message ?? error}` }
  }
}

const pageEnabled = new WeakSet<WebContents>()

async function enablePage(wc: WebContents): Promise<void> {
  if (pageEnabled.has(wc)) return
  try {
    await cdp(wc, 'Page.enable')
    pageEnabled.add(wc)
  } catch { /* viewport metrics still work on most builds */ }
}

async function measureTarget(wc: WebContents, objectId: string): Promise<MeasureResult> {
  try {
    const measured = await cdp<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(wc, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: TARGET_MEASURE_FN,
      returnByValue: true,
    })
    if (measured?.exceptionDetails) {
      return {
        ok: false,
        error: `测量元素失败：${measured.exceptionDetails.exception?.description || measured.exceptionDetails.text || '脚本异常'}`,
      }
    }
    const parsed = parseJsonObject(measured?.result?.value)
    if (!parsed?.ok) return { ok: false, error: String(parsed?.error ?? '测量元素失败') }
    const x = Number(parsed.x)
    const y = Number(parsed.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '测量元素失败' }
    const covered = typeof parsed.covered === 'string' && parsed.covered ? parsed.covered : undefined
    return { ok: true, x, y, covered }
  } catch (error: any) {
    return { ok: false, error: `测量元素失败：${error?.message ?? error}` }
  }
}

interface PointTarget { ok: true; point: BrowserPoint; label: string; covered?: string }

async function targetPoint(wc: WebContents, opts: BrowserActOptions): Promise<PointTarget | { ok: false; error: string }> {
  const hasRef = !!String(opts.ref ?? '').trim()
  const hasSelector = !!String(opts.selector ?? '').trim()
  if (hasRef || hasSelector) {
    const target = await resolveTarget(wc, opts)
    if (!target.ok) return target
    const measured = await measureTarget(wc, target.objectId)
    if (!measured.ok) return measured
    return {
      ok: true,
      point: { x: measured.x, y: measured.y },
      label: hasRef ? `ref ${opts.ref}` : `selector ${opts.selector}`,
      covered: measured.covered,
    }
  }
  const point = pointFrom(opts)
  if (!point) return { ok: false, error: '需要 ref、selector 或 x/y 坐标' }
  return { ok: true, point, label: `(${point.x}, ${point.y})` }
}

async function focusElement(wc: WebContents, objectId: string, select: boolean): Promise<boolean> {
  try {
    const focused = await cdp<{ result?: { value?: unknown } }>(wc, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: select ? FOCUS_SELECT_FN : FOCUS_FN,
      returnByValue: true,
    })
    return String(focused?.result?.value ?? '').startsWith('focused') || String(focused?.result?.value ?? '') === 'selected'
  } catch {
    return false
  }
}

async function dispatchMouse(
  wc: WebContents,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel',
  point: BrowserPoint,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await cdp(wc, 'Input.dispatchMouseEvent', {
    type,
    x: Math.round(point.x),
    y: Math.round(point.y),
    ...extra,
  })
}

async function clickAt(wc: WebContents, point: BrowserPoint, button: BrowserMouseButton, count: number): Promise<void> {
  const buttons = MOUSE_BUTTON_MASK[button]
  await dispatchMouse(wc, 'mouseMoved', point, { button: 'none', buttons: 0 })
  for (let i = 1; i <= count; i += 1) {
    await dispatchMouse(wc, 'mousePressed', point, { button, buttons, clickCount: i })
    await dispatchMouse(wc, 'mouseReleased', point, { button, buttons: 0, clickCount: i })
    if (i < count) await sleep(25)
  }
}

async function hoverAt(wc: WebContents, point: BrowserPoint): Promise<void> {
  // Approach from a few pixels away so mouseover/mouseenter fire even when the
  // pointer was already inside the element.
  await dispatchMouse(wc, 'mouseMoved', { x: Math.max(0, point.x - 3), y: Math.max(0, point.y - 3) }, { button: 'none', buttons: 0 })
  await sleep(10)
  await dispatchMouse(wc, 'mouseMoved', point, { button: 'none', buttons: 0 })
}

async function dragBetween(wc: WebContents, from: BrowserPoint, to: BrowserPoint, button: BrowserMouseButton): Promise<void> {
  const buttons = MOUSE_BUTTON_MASK[button]
  await dispatchMouse(wc, 'mouseMoved', from, { button: 'none', buttons: 0 })
  await dispatchMouse(wc, 'mousePressed', from, { button, buttons, clickCount: 1 })
  await sleep(50)
  for (let i = 1; i <= 10; i += 1) {
    await dispatchMouse(wc, 'mouseMoved', {
      x: from.x + (to.x - from.x) * i / 10,
      y: from.y + (to.y - from.y) * i / 10,
    }, { button, buttons })
    await sleep(16)
  }
  await dispatchMouse(wc, 'mouseReleased', to, { button, buttons: 0, clickCount: 1 })
}

async function viewportSize(wc: WebContents): Promise<{ width: number; height: number }> {
  try {
    await enablePage(wc)
    const metrics = await cdp<any>(wc, 'Page.getLayoutMetrics')
    const viewport = metrics?.cssLayoutViewport ?? metrics?.cssVisualViewport
    const width = Number(viewport?.clientWidth)
    const height = Number(viewport?.clientHeight)
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return { width, height }
  } catch { /* fall through */ }
  return { width: 1280, height: 900 }
}

function scrollDeltas(opts: BrowserActOptions, viewport: { width: number; height: number }): { dx: number; dy: number } {
  let dx = normalizeDelta(opts.deltaX)
  let dy = normalizeDelta(opts.deltaY)
  if (!dx && !dy) {
    const direction = opts.direction === 'up' || opts.direction === 'left' || opts.direction === 'right'
      ? opts.direction
      : 'down'
    if (direction === 'up') dy = -Math.round(viewport.height * 0.8)
    else if (direction === 'left') dx = -Math.round(viewport.width * 0.8)
    else if (direction === 'right') dx = Math.round(viewport.width * 0.8)
    else dy = Math.round(viewport.height * 0.8)
  }
  return { dx, dy }
}

async function dispatchChord(wc: WebContents, chord: KeyChord): Promise<void> {
  const base = {
    modifiers: chord.modifiers,
    key: chord.key,
    code: chord.code,
    windowsVirtualKeyCode: chord.keyCode,
    nativeVirtualKeyCode: chord.keyCode,
  }
  await cdp(wc, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  if (chord.text) {
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'char', ...base, text: chord.text, unmodifiedText: chord.text })
  }
  await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

type RealOutcome = BrowserActResult | null

async function realClickOrHover(wc: WebContents, action: 'click' | 'hover', opts: BrowserActOptions): Promise<RealOutcome> {
  const target = await targetPoint(wc, opts)
  if (!target.ok) return { ok: false, error: target.error }
  const covered = target.covered ? `；注意：该点被 ${target.covered} 覆盖` : ''
  if (action === 'click') {
    const button = normalizeButton(opts.button)
    const count = normalizeClickCount(opts.clickCount)
    await clickAt(wc, target.point, button, count)
    return {
      ok: true,
      strategy: 'cdp',
      point: target.point,
      detail: `${target.label} 已点击（真实鼠标事件${count > 1 ? ` ×${count}` : ''}）${covered}`,
    }
  }
  await hoverAt(wc, target.point)
  return { ok: true, strategy: 'cdp', point: target.point, detail: `${target.label} 已悬停${covered}` }
}

async function realType(wc: WebContents, opts: BrowserActOptions): Promise<RealOutcome> {
  const target = await resolveTarget(wc, opts)
  if (!target.ok) return { ok: false, error: target.error }
  if (!(await focusElement(wc, target.objectId, true))) {
    return { ok: false, error: '无法聚焦目标元素（可能被禁用或不可编辑）' }
  }
  const text = String(opts.text ?? '')
  await cdp(wc, 'Input.insertText', { text })
  await cdp(wc, 'Runtime.callFunctionOn', {
    objectId: target.objectId,
    functionDeclaration: CHANGE_EVENT_FN,
    returnByValue: true,
  }).catch(() => undefined)
  return { ok: true, strategy: 'cdp', detail: `已输入 ${text.length} 个字符（真实输入事件）` }
}

async function realPress(wc: WebContents, opts: BrowserActOptions): Promise<RealOutcome> {
  const parsed = parseKeyChord(String(opts.key ?? ''))
  if (!parsed.ok) return { ok: false, error: parsed.error }
  let label = '当前焦点'
  if (String(opts.ref ?? '').trim() || String(opts.selector ?? '').trim()) {
    const target = await resolveTarget(wc, opts)
    if (!target.ok) return { ok: false, error: target.error }
    if (!(await focusElement(wc, target.objectId, false))) {
      return { ok: false, error: '无法聚焦目标元素（可能被禁用）' }
    }
    label = opts.ref ? `ref ${opts.ref}` : `selector ${opts.selector}`
  }
  await dispatchChord(wc, parsed.chord)
  return { ok: true, strategy: 'cdp', detail: `${label} 已按下 ${parsed.chord.key}（真实键盘事件）` }
}

async function realScroll(wc: WebContents, opts: BrowserActOptions): Promise<RealOutcome> {
  const viewport = await viewportSize(wc)
  let point: BrowserPoint
  let label: string
  if (String(opts.ref ?? '').trim() || String(opts.selector ?? '').trim()) {
    const target = await targetPoint(wc, opts)
    if (!target.ok) return { ok: false, error: target.error }
    point = target.point
    label = target.label
  } else {
    const explicit = pointFrom(opts)
    point = explicit ?? { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) }
    label = explicit ? `(${point.x}, ${point.y})` : '视口中心'
  }
  const { dx, dy } = scrollDeltas(opts, viewport)
  // Probe first: a hidden Chromium window can drop the first wheel after a
  // click (the event reaches the page, the compositor never scrolls). The
  // settle step detects that and applies the same delta natively, unless the
  // page called preventDefault() — in which case it handled the gesture itself.
  let probe: any = null
  try {
    probe = parseJsonObject(await evaluate<string>(wc, buildScrollProbeScript(point.x, point.y)))
  } catch { /* wheel still fires; no verification */ }
  // A hidden Chromium window can swallow the first wheel after a click because
  // its compositor has no fresh frame/hit-test data. A cheap 1px capture forces
  // that frame; without it the wheel is queued and may apply later, which makes
  // the fallback below double-scroll.
  try { await wc.capturePage({ x: 0, y: 0, width: 1, height: 1 }) } catch { /* best effort */ }
  await dispatchMouse(wc, 'mouseWheel', point, { button: 'none', buttons: 0, deltaX: dx, deltaY: dy })
  let settle: any = null
  if (probe) {
    await sleep(120)
    try {
      settle = parseJsonObject(await evaluate<string>(wc, buildScrollSettleScript(dx, dy)))
    } catch { /* best effort */ }
  }
  const fallbackNote = settle?.fallback ? '（隐藏窗口首次滚轮被合成器丢弃，已补原生滚动）' : ''
  if (settle?.fallback) {
    // The wheel was genuinely swallowed (the pre-wheel frame did not help), so
    // the fallback changed scrollTop without a compositor scroll. Force one
    // more frame so the page's own `scroll` handlers run too.
    try { await wc.capturePage({ x: 0, y: 0, width: 1, height: 1 }) } catch { /* best effort */ }
    await sleep(40)
  }
  return { ok: true, strategy: 'cdp', point, detail: `${label} 已滚动 (${dx}, ${dy})${fallbackNote}` }
}

async function realDrag(wc: WebContents, opts: BrowserActOptions): Promise<RealOutcome> {
  const toX = num(opts.toX)
  const toY = num(opts.toY)
  if (toX === undefined || toY === undefined) return { ok: false, error: '拖拽需要终点 toX/toY' }
  let start: BrowserPoint | null = null
  let label = ''
  if (String(opts.ref ?? '').trim() || String(opts.selector ?? '').trim()) {
    const target = await targetPoint(wc, opts)
    if (target.ok) {
      start = target.point
      label = target.label
    }
  }
  if (!start) start = pointFrom(opts)
  if (!start) return { ok: false, error: '拖拽需要 ref/selector 或起点 x/y' }
  const end = { x: Math.round(toX), y: Math.round(toY) }
  await dragBetween(wc, start, end, normalizeButton(opts.button))
  return {
    ok: true,
    strategy: 'cdp',
    point: start,
    detail: `已拖拽 ${label || `${start.x},${start.y}`} → ${end.x},${end.y}`,
  }
}

async function realAction(wc: WebContents, action: BrowserAction, opts: BrowserActOptions): Promise<RealOutcome> {
  switch (action) {
    case 'click':
    case 'hover':
      return realClickOrHover(wc, action, opts)
    case 'type':
      return realType(wc, opts)
    case 'press':
      return realPress(wc, opts)
    case 'scroll':
      return realScroll(wc, opts)
    case 'drag':
      return realDrag(wc, opts)
    default:
      return null
  }
}

// ── CDP helpers: ARIA snapshot + ref-addressed actions ──────────────────────
//
// The selector path (buildActScript) stays for plain pages; refs add what it
// cannot do: address nodes inside shadow DOM and survive re-renders because the
// ref table is rebuilt per snapshot. The snapshot is top-frame only.

function ensureDebugger(wc: WebContents): void {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
}

async function cdp<T = any>(wc: WebContents, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return (await wc.debugger.sendCommand(method, params)) as T
}

function axString(value: any): string {
  return value && typeof value === 'object' && typeof value.value === 'string' ? value.value : ''
}

/** Rebuild CDP's flat AX node list into the tree `formatAxTree` walks. */
function buildAxTree(nodes: any[]): AxInputNode[] {
  const byId = new Map<string, any>()
  for (const node of nodes ?? []) byId.set(String(node.nodeId), node)
  const convert = (node: any): AxInputNode => ({
    role: axString(node.role) || undefined,
    name: axString(node.name) || undefined,
    value: axString(node.value) || undefined,
    backendDOMNodeId: typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined,
    ignored: node.ignored === true,
    children: (node.childIds ?? [])
      .map((id: string) => byId.get(String(id)))
      .filter(Boolean)
      .map(convert),
  })
  const roots = (nodes ?? []).filter((n) => !n.parentId || !byId.has(String(n.parentId)))
  return (roots.length ? roots : (nodes ?? []).slice(0, 1)).map(convert)
}

/** Accessibility snapshot of the current page, as a ref-addressable ARIA tree. */
export async function browserSnapshot(maxNodes = 500): Promise<BrowserSnapshotResult> {
  const wc = currentContents()
  if (!wc || !state.url) return { ok: false, error: '浏览器会话还没有打开任何页面' }
  try {
    ensureDebugger(wc)
    await cdp(wc, 'Accessibility.enable')
    const result = await cdp<{ nodes: any[] }>(wc, 'Accessibility.getFullAXTree')
    const formatted = formatAxTree(buildAxTree(result.nodes ?? []), { maxNodes })
    snapshotSeq += 1
    lastSnapshotId = `snap-${snapshotSeq}`
    lastRefs = new Map(Object.entries(formatted.refs))
    return {
      ok: true,
      url: state.url,
      title: state.title,
      text: formatted.text,
      nodes: formatted.nodes,
      snapshotId: lastSnapshotId,
    }
  } catch (error: any) {
    return { ok: false, error: `可访问性快照失败：${error?.message ?? error}` }
  }
}

const CLICK_FN = `function (button, count) {
  try { if (this.scrollIntoView) this.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e) {}
  if (this.disabled) return 'disabled';
  try { this.focus({ preventScroll: true }) } catch (e) {}
  const r = this.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const buttonIndex = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: buttonIndex, buttons, detail: count };
  try { this.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true })) } catch (e) {}
  this.dispatchEvent(new MouseEvent('mousedown', base));
  try { this.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 })) } catch (e) {}
  this.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
  if (button === 'right') {
    this.dispatchEvent(new MouseEvent('contextmenu', { ...base, buttons: 0 }));
  } else if (button === 'middle') {
    this.dispatchEvent(new MouseEvent('auxclick', { ...base, buttons: 0 }));
  } else {
    this.click();
    if (count > 1) {
      this.click();
      this.dispatchEvent(new MouseEvent('dblclick', { ...base, buttons: 0 }));
    }
    if (count > 2) this.click();
  }
  return 'clicked';
}`

const HOVER_FN = `function () {
  try { if (this.scrollIntoView) this.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e) {}
  const r = this.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 0 };
  try { this.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true })) } catch (e) {}
  this.dispatchEvent(new MouseEvent('mouseover', base));
  try { this.dispatchEvent(new PointerEvent('pointerenter', { ...base, bubbles: false })) } catch (e) {}
  this.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
  this.dispatchEvent(new MouseEvent('mousemove', base));
  return 'hovered';
}`

const PRESS_FN = `function (chord) {
  try { if (this.focus) this.focus({ preventScroll: true }) } catch (e) {}
  const init = {
    bubbles: true, cancelable: true,
    key: chord.key, code: chord.code,
    keyCode: chord.keyCode, which: chord.keyCode,
    altKey: (chord.modifiers & 1) !== 0,
    ctrlKey: (chord.modifiers & 2) !== 0,
    metaKey: (chord.modifiers & 4) !== 0,
    shiftKey: (chord.modifiers & 8) !== 0,
  };
  for (const type of ['keydown', 'keypress', 'keyup']) this.dispatchEvent(new KeyboardEvent(type, init));
  return 'pressed';
}`

const SCROLL_NODE_FN = `function (dx, dy) {
  let node = this;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) {
      node.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      return 'scrolled';
    }
    node = node.parentElement;
  }
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return 'scrolled-page';
}`

const TYPE_FN = `function (text) {
  const el = this;
  el.scrollIntoView && el.scrollIntoView({ block: 'center' });
  if (el.isContentEditable) {
    el.focus();
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return 'typed';
  }
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return 'not-editable';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
  if (setter && setter.set) setter.call(el, text); else el.value = text;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed';
}`

/** Act on a node by the ref from the latest browser_snapshot. This is the
 *   synthetic fallback: real input is preferred and this path exists for
 *   cross-origin iframes / strategy="dom" where CDP coordinates are not usable. */
async function actByRef(
  wc: WebContents,
  action: 'click' | 'type' | 'hover' | 'press' | 'scroll',
  opts: BrowserActOptions,
): Promise<BrowserActResult> {
  const ref = String(opts.ref ?? '')
  const backendNodeId = lastRefs.get(ref)
  if (!backendNodeId) {
    return { ok: false, error: `ref ${ref || '(空)'} 不属于最近一次 browser_snapshot（快照可能已过期，重新调用一次）` }
  }
  if (action === 'type' && opts.text === undefined) return { ok: false, error: 'type 需要 text' }
  const parsedKey = action === 'press' ? parseKeyChord(String(opts.key ?? '')) : null
  if (parsedKey && !parsedKey.ok) return { ok: false, error: parsedKey.error }
  try {
    ensureDebugger(wc)
    await cdp(wc, 'DOM.enable')
    const resolved = await cdp<{ object?: { objectId?: string } }>(wc, 'DOM.resolveNode', { backendNodeId })
    const rawObjectId = resolved.object?.objectId
    if (!rawObjectId) return { ok: false, error: `ref ${ref} 解析不到 DOM 节点（页面可能已更新）` }
    const objectId = await elementObjectId(wc, rawObjectId)

    let functionDeclaration = CLICK_FN
    let args: Array<{ value: unknown }> = []
    let detail = ''
    if (action === 'click') {
      functionDeclaration = CLICK_FN
      args = [{ value: normalizeButton(opts.button) }, { value: normalizeClickCount(opts.clickCount) }]
      detail = `已点击${normalizeClickCount(opts.clickCount) > 1 ? ` ×${normalizeClickCount(opts.clickCount)}` : ''}`
    } else if (action === 'type') {
      functionDeclaration = TYPE_FN
      args = [{ value: String(opts.text ?? '') }]
      detail = `已输入 ${String(opts.text ?? '').length} 个字符`
    } else if (action === 'hover') {
      functionDeclaration = HOVER_FN
      detail = '已悬停'
    } else if (action === 'press') {
      functionDeclaration = PRESS_FN
      args = [{ value: parsedKey && parsedKey.ok ? parsedKey.chord : {} }]
      detail = `已按下 ${parsedKey && parsedKey.ok ? parsedKey.chord.key : String(opts.key ?? '')}`
    } else {
      const viewport = await viewportSize(wc)
      const { dx, dy } = scrollDeltas(opts, viewport)
      functionDeclaration = SCROLL_NODE_FN
      args = [{ value: dx }, { value: dy }]
      detail = `已滚动 (${dx}, ${dy})`
    }

    const result = await cdp<{ result?: { value?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(wc, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: args,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      return {
        ok: false,
        error: `动作执行失败：${result.exceptionDetails.exception?.description || result.exceptionDetails.text || '未知异常'}`,
        strategy: 'dom',
      }
    }
    const outcome = String(result.result?.value ?? '')
    if (outcome === 'disabled') return { ok: false, error: '目标元素处于 disabled 状态' }
    if (outcome === 'not-editable') return { ok: false, error: '目标元素不能输入文字（不是 input/textarea/contenteditable）' }
    return {
      ok: true,
      strategy: 'dom',
      detail: `${ref} ${detail}${lastSnapshotId ? `（快照 ${lastSnapshotId}）` : ''}`,
    }
  } catch (error: any) {
    return { ok: false, error: `按 ref 操作失败：${error?.message ?? error}`, strategy: 'dom' }
  }
}

/** Wait until the page settles after an action that starts a navigation.
 *  `goBack()`/`goForward()` return before Chromium flips the loading flag, so
 *  checking `isLoading()` immediately answers with the PREVIOUS page's url —
 *  hence the grace tick first. The panel also receives the authoritative state
 *  through events, so this only gates what the tool returns. */
async function waitForNavigation(wc: WebContents, timeoutMs = NAVIGATE_TIMEOUT_MS): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80))
  await waitForLoad(wc, timeoutMs)
}

export function initBrowserSession(nextHooks: BrowserSessionHooks): void {
  hooks = nextHooks
}

export function browserState(): BrowserSessionState {
  return snapshot()
}

export async function browserNavigate(rawUrl: string): Promise<{ ok: boolean; state: BrowserSessionState; error?: string }> {
  const normalized = normalizeBrowserUrl(rawUrl)
  if (!normalized.ok) return { ok: false, state: snapshot(), error: normalized.error }
  const wc = ensureWindow().webContents
  try {
    await wc.loadURL(normalized.url)
  } catch (error: any) {
    // loadURL rejects on aborted/failed loads; the did-fail-load handler already
    // recorded the reason, so report it rather than treating it as a crash.
    if (!lastError) lastError = String(error?.message || error)
    return { ok: false, state: snapshot(), error: lastError }
  }
  await waitForLoad(wc)
  return { ok: !lastError, state: snapshot(), error: lastError }
}

export async function browserHistory(step: 'back' | 'forward' | 'reload'): Promise<BrowserSessionState> {
  const wc = currentContents()
  if (!wc) return snapshot()
  if (step === 'back' && wc.canGoBack()) wc.goBack()
  else if (step === 'forward' && wc.canGoForward()) wc.goForward()
  else wc.reload()
  await waitForNavigation(wc)
  return snapshot()
}

export function browserConsole(clear = false): { entries: BrowserConsoleEntry[]; text: string } {
  const entries = consoleBuffer
  if (clear) consoleBuffer = []
  return { entries, text: formatConsoleForModel(entries) }
}

export async function browserPageText(maxChars = BROWSER_PAGE_TEXT_LIMIT): Promise<{ ok: boolean; error?: string; title?: string; url?: string; text?: string }> {
  const wc = currentContents()
  if (!wc || !state.url) return { ok: false, error: '浏览器会话还没有打开任何页面' }
  try {
    const raw = await evaluate<string>(wc, pageTextScript())
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      ok: true,
      title: String(parsed?.title ?? state.title),
      url: String(parsed?.url ?? state.url),
      text: truncatePageText(String(parsed?.text ?? ''), maxChars),
    }
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) }
  }
}

export async function browserScreenshot(): Promise<BrowserScreenshotResult> {
  const wc = currentContents()
  if (!wc || !state.url) return { ok: false, error: '浏览器会话还没有打开任何页面' }
  try {
    const image = await wc.capturePage()
    const dataUrl = image.toDataURL()
    if (!dataUrl || dataUrl.length < 64) return { ok: false, error: '截图为空（页面可能尚未绘制）' }
    const size = image.getSize()
    // Viewport metadata is how the model maps screenshot pixels to the CSS-pixel
    // coordinates browser_act expects. Advisory only: a busy page must not turn
    // a successful screenshot into an error.
    let viewport: BrowserViewport | undefined
    try {
      const raw = await evaluate<string>(wc, `JSON.stringify({
        width: window.innerWidth || document.documentElement.clientWidth,
        height: window.innerHeight || document.documentElement.clientHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      })`)
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      const width = Number(parsed?.width)
      const height = Number(parsed?.height)
      const dpr = Number(parsed?.devicePixelRatio)
      if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        viewport = {
          width: Math.round(width),
          height: Math.round(height),
          devicePixelRatio: Number.isFinite(dpr) && dpr > 0 ? dpr : 1,
        }
      }
    } catch { /* screenshot still returns */ }
    return {
      ok: true,
      url: state.url,
      dataUrl,
      mimeType: 'image/png',
      viewport,
      image: { width: size.width, height: size.height },
    }
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/** Execute one synthetic in-page interaction and parse its JSON result. */
async function runDomScript(wc: WebContents, script: string): Promise<BrowserActResult> {
  try {
    const raw = await evaluate<string>(wc, script)
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const ok = parsed?.ok !== false
    return {
      ok,
      error: ok ? undefined : String(parsed?.error ?? '操作失败'),
      detail: typeof parsed?.detail === 'string' ? parsed.detail : undefined,
      strategy: 'dom',
    }
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error), strategy: 'dom' }
  }
}

/** Synthetic fallback. Refs keep their node resolution (shadow DOM);
 *  everything else goes through buildActScript. */
async function domAction(wc: WebContents, action: BrowserAction, opts: BrowserActOptions): Promise<BrowserActResult> {
  const ref = String(opts.ref ?? '').trim()
  if (ref && (action === 'click' || action === 'type' || action === 'hover' || action === 'press' || action === 'scroll')) {
    return actByRef(wc, action, opts)
  }
  if (ref && action === 'drag') {
    const target = await targetPoint(wc, opts)
    if (!target.ok) return { ok: false, error: target.error, strategy: 'dom' }
    const script = buildActScript('drag', { ...opts, ref: undefined, selector: '', x: target.point.x, y: target.point.y })
    if (!script) return { ok: false, error: '不支持的操作：drag', strategy: 'dom' }
    return runDomScript(wc, script)
  }
  if (action === 'drag' && String(opts.selector ?? '').trim()) {
    const target = await targetPoint(wc, opts)
    if (!target.ok) return { ok: false, error: target.error, strategy: 'dom' }
    const script = buildActScript('drag', { ...opts, selector: '', x: target.point.x, y: target.point.y })
    if (!script) return { ok: false, error: '不支持的操作：drag', strategy: 'dom' }
    return runDomScript(wc, script)
  }
  const script = buildActScript(action, opts)
  if (!script) return { ok: false, error: `不支持的操作：${action}`, strategy: 'dom' }
  return runDomScript(wc, script)
}

export async function browserAct(
  action: BrowserAction,
  opts: BrowserActOptions = {},
): Promise<BrowserActResult & { state: BrowserSessionState }> {
  const wc = currentContents()
  if (!wc || !state.url) return { ok: false, error: '浏览器会话还没有打开任何页面', state: snapshot() }

  const strategy: BrowserActStrategy = opts.strategy === 'dom' ? 'dom' : opts.strategy === 'real' ? 'real' : 'auto'
  const hasRef = !!String(opts.ref ?? '').trim()
  const hasSelector = !!String(opts.selector ?? '').trim()
  const hasTarget = hasRef || hasSelector
  const x = num(opts.x)
  const y = num(opts.y)
  const hasPoint = x !== undefined && y !== undefined
  if ((x === undefined) !== (y === undefined)) {
    return { ok: false, error: 'x 和 y 必须同时提供', state: snapshot() }
  }
  if (hasPoint && ((x as number) < 0 || (y as number) < 0)) {
    return { ok: false, error: '坐标不能为负（使用视口 CSS 像素）', state: snapshot() }
  }
  const toX = num(opts.toX)
  const toY = num(opts.toY)
  if ((toX === undefined) !== (toY === undefined)) {
    return { ok: false, error: 'toX 和 toY 必须同时提供', state: snapshot() }
  }
  if (toX !== undefined && ((toX as number) < 0 || (toY as number) < 0)) {
    return { ok: false, error: '拖拽终点坐标不能为负（使用视口 CSS 像素）', state: snapshot() }
  }

  if ((action === 'click' || action === 'hover') && !hasTarget && !hasPoint) {
    return { ok: false, error: `${action} 需要 ref、selector 或 x/y 坐标`, state: snapshot() }
  }
  if (action === 'type' && !hasTarget) {
    return { ok: false, error: 'type 需要 ref 或 selector', state: snapshot() }
  }
  if (action === 'type' && opts.text === undefined) {
    return { ok: false, error: 'type 需要 text', state: snapshot() }
  }
  if (action === 'press' && !String(opts.key ?? '').trim()) {
    return { ok: false, error: 'press 需要 key', state: snapshot() }
  }
  if (action === 'drag' && ((!hasTarget && !hasPoint) || toX === undefined)) {
    return { ok: false, error: 'drag 需要起点 ref/selector 或 x/y，以及终点 toX/toY', state: snapshot() }
  }

  let realError: string | undefined
  if (strategy !== 'dom') {
    const real = await realAction(wc, action, opts)
    if (real && real.ok) {
      // Real clicks (and Enter presses that submit a form) can navigate; give
      // the new document a moment before the caller snapshots it.
      if (action === 'click' || (action === 'press' && /enter/i.test(String(opts.key ?? '')))) {
        await waitForNavigation(wc, 5_000)
      }
      return { ...real, state: snapshot() }
    }
    if (real && !real.ok) realError = real.error
    if (strategy === 'real') {
      // `wait` has no real-input implementation; fall through to the page-side
      // timer instead of rejecting a harmless strategy on it.
      if (real) return { ...real, state: snapshot() }
    }
  }

  const dom = await domAction(wc, action, opts)
  if (action === 'click' && dom.ok) await waitForNavigation(wc, 5_000)
  if (!dom.ok && realError && !String(dom.error ?? '').includes(realError)) {
    dom.error = `${dom.error}（真实输入失败：${realError}）`
  }
  return { ...dom, state: snapshot() }
}

export function browserSetVisible(visible: boolean, options: { focus?: boolean } = {}): BrowserSessionState {
  const browserWindow = ensureWindow()
  if (visible) {
    if (browserWindow.isMinimized()) browserWindow.restore()
    // Automation auto-show must not steal focus from the IDE/terminal; the
    // explicit user button keeps the old show()+focus() behavior.
    if (options.focus === false) {
      browserWindow.showInactive()
      // showInactive alone can leave the window behind a maximized IDE. Raise
      // the z-order without taking keyboard focus so it is actually visible.
      try { browserWindow.moveTop() } catch { /* platform quirk */ }
    } else {
      browserWindow.show()
      browserWindow.focus()
    }
  } else {
    browserWindow.hide()
  }
  // Report what the OS actually did: showInactive can fail on some window
  // managers, and the bubble/settings UI must not claim a hidden window is up.
  state.visible = browserWindow.isVisible()
  pushState()
  return snapshot()
}

/** Drop everything the browser session collected — called when the last app
 *  window closes, so a background dev-server tab keeps running only while the
 *  app is open. */
export function browserClose(): void {
  consoleBuffer = []
  lastError = undefined
  lastRefs = new Map()
  lastSnapshotId = ''
  if (win && !win.isDestroyed()) {
    try {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    } catch { /* window already tearing down */ }
    win.close()
  }
  win = null
  pushState()
}
