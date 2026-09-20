/**
 * Renderer view of the agent browser session (electron/services/browser-session.ts).
 *
 * The main process owns the page; this store mirrors what it pushes so the
 * Browser panel can show the same console the assistant reads, and drive the
 * same window the tools navigate.
 */
import { create } from 'zustand'
import type {
  BrowserAction,
  BrowserActOptions,
  BrowserConsoleEntry,
  BrowserEvent,
  BrowserSessionState,
} from '@shared/types'
import { trimConsoleBuffer, BROWSER_CONSOLE_LIMIT } from '@shared/browser'

interface BrowserStoreState {
  session: BrowserSessionState
  entries: BrowserConsoleEntry[]
  /** Last panel-initiated screenshot (the assistant's own captures go to the model). */
  screenshot: { dataUrl: string; url: string; at: number } | null
  error: string | null

  navigate: (url: string) => Promise<void>
  history: (step: 'back' | 'forward' | 'reload') => Promise<void>
  setVisible: (visible: boolean) => Promise<void>
  capture: () => Promise<void>
  clearConsole: () => void
  close: () => Promise<void>
  act: (action: BrowserAction, opts?: BrowserActOptions) => Promise<string | null>
}

const EMPTY_SESSION: BrowserSessionState = {
  url: '',
  title: '',
  loading: false,
  visible: false,
  canGoBack: false,
  canGoForward: false,
}

export const useBrowserStore = create<BrowserStoreState>((set, get) => ({
  session: EMPTY_SESSION,
  entries: [],
  screenshot: null,
  error: null,

  navigate: async (url) => {
    set({ error: null })
    const res = await window.electronAPI.browserNavigate(url)
    set({ session: res.state, error: res.ok ? null : res.error || '导航失败' })
  },

  history: async (step) => {
    const session = await window.electronAPI.browserHistory(step)
    set({ session })
  },

  setVisible: async (visible) => {
    const session = await window.electronAPI.browserSetVisible(visible)
    set({ session })
  },

  capture: async () => {
    const res = await window.electronAPI.browserScreenshot()
    if (!res.ok || !res.dataUrl) {
      set({ error: res.error || '截图失败' })
      return
    }
    set({ error: null, screenshot: { dataUrl: res.dataUrl, url: res.url || get().session.url, at: Date.now() } })
  },

  clearConsole: () => {
    void window.electronAPI.browserConsole(true)
    set({ entries: [] })
  },

  close: async () => {
    await window.electronAPI.browserClose()
    set({ session: EMPTY_SESSION, entries: [], screenshot: null })
  },

  act: async (action, opts) => {
    const res = await window.electronAPI.browserAct(action, opts)
    set({ session: res.state, error: res.ok ? null : res.error || '操作失败' })
    return res.ok ? res.detail || null : null
  },
}))

/** Pull the current session + buffered console lines into the store. */
export async function syncBrowserStore(): Promise<void> {
  const [session, consoleDump] = await Promise.all([
    window.electronAPI.browserState(),
    window.electronAPI.browserConsole(false),
  ])
  useBrowserStore.setState({ session, entries: consoleDump.entries })
}

let subscribed = false

/** Subscribe once to main-process browser events (called from App on startup). */
export function ensureBrowserSubscription(): void {
  if (subscribed) return
  subscribed = true
  window.electronAPI.onBrowserEvent((payload: BrowserEvent) => {
    if (payload.type === 'state') {
      useBrowserStore.setState({ session: payload.state })
      return
    }
    useBrowserStore.setState((s) => ({
      entries: trimConsoleBuffer([...s.entries, payload.entry], BROWSER_CONSOLE_LIMIT),
    }))
  })
  void syncBrowserStore().catch(() => { /* the session may not have started yet */ })
}
