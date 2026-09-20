/**
 * The agent browser session.
 *
 * One hidden, fully sandboxed webContents (no preload — a browsed page gets no
 * bridge into the app) that the assistant drives through tools while the user
 * watches the same thing in the Browser panel. This is what closes the loop the
 * integrated terminal never could: after a frontend change the model can load
 * the page, read its console, and look at a screenshot.
 *
 * Navigation is deliberately unrestricted to http(s) (see navigation-guard's
 * arbitrary mode) but never to file:// or ourcode-file://, so a remote page
 * cannot read the workspace through the app's own preview protocol.
 */
import { BrowserWindow, type WebContents } from 'electron'
import { allowArbitraryNavigation, revokeArbitraryNavigation } from './navigation-guard'
import {
  buildActScript,
  formatConsoleForModel,
  normalizeBrowserUrl,
  pageTextScript,
  trimConsoleBuffer,
  truncatePageText,
  BROWSER_CONSOLE_LIMIT,
  BROWSER_PAGE_TEXT_LIMIT,
} from '../../shared/browser'
import type {
  BrowserAction,
  BrowserActOptions,
  BrowserActResult,
  BrowserConsoleEntry,
  BrowserSessionState,
} from '../../shared/types'

/** How long a navigation may take before the tool gives up and reports what it
 *  got — a hung dev server must not hang the agent loop. */
const NAVIGATE_TIMEOUT_MS = 20_000
const EVAL_TIMEOUT_MS = 10_000

/** Isolated, persistent partition: a dev server that needs a login cookie keeps
 *  it across navigations without touching the app's own session. */
const BROWSER_PARTITION = 'persist:ourcode-browser'

export interface BrowserSessionHooks {
  /** Push a state/console change to the renderer (BrowserPanel). */
  broadcast: (payload: { type: 'state'; state: BrowserSessionState } | { type: 'console'; entry: BrowserConsoleEntry }) => void
}

let win: BrowserWindow | null = null
let hooks: BrowserSessionHooks | null = null
let consoleBuffer: BrowserConsoleEntry[] = []
let lastError: string | undefined
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

export async function browserScreenshot(): Promise<{ ok: boolean; error?: string; url?: string; dataUrl?: string; mimeType?: string }> {
  const wc = currentContents()
  if (!wc || !state.url) return { ok: false, error: '浏览器会话还没有打开任何页面' }
  try {
    const image = await wc.capturePage()
    const dataUrl = image.toDataURL()
    if (!dataUrl || dataUrl.length < 64) return { ok: false, error: '截图为空（页面可能尚未绘制）' }
    return { ok: true, url: state.url, dataUrl, mimeType: 'image/png' }
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) }
  }
}

export async function browserAct(
  action: BrowserAction,
  opts: BrowserActOptions = {},
): Promise<BrowserActResult & { state: BrowserSessionState }> {
  const wc = currentContents()
  if (!wc || !state.url) return { ok: false, error: '浏览器会话还没有打开任何页面', state: snapshot() }
  const script = buildActScript(action, opts)
  if (!script) return { ok: false, error: `不支持的操作：${action}`, state: snapshot() }
  try {
    const raw = await evaluate<string>(wc, script)
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const ok = parsed?.ok !== false
    // A click can navigate; give the new document a moment before snapshotting.
    if (action === 'click') await waitForNavigation(wc, 5_000)
    return {
      ok,
      error: ok ? undefined : String(parsed?.error ?? '操作失败'),
      detail: typeof parsed?.detail === 'string' ? parsed.detail : undefined,
      state: snapshot(),
    }
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error), state: snapshot() }
  }
}

export function browserSetVisible(visible: boolean): BrowserSessionState {
  const browserWindow = ensureWindow()
  if (visible) {
    browserWindow.show()
    browserWindow.focus()
  } else {
    browserWindow.hide()
  }
  state.visible = visible
  pushState()
  return snapshot()
}

/** Drop everything the browser session collected — called when the last app
 *  window closes, so a background dev-server tab keeps running only while the
 *  app is open. */
export function browserClose(): void {
  consoleBuffer = []
  lastError = undefined
  if (win && !win.isDestroyed()) win.close()
  win = null
  pushState()
}
