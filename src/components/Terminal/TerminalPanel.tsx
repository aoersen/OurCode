import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useUIStore } from '@/stores/uiStore'
import { listAgentRuns, onAgentRunsChanged } from '@/services/terminalRuns'
import type { AgentTerminalRun } from '@shared/types'
import { useI18n } from '@/i18n/useI18n'
import { t as moduleT } from '@/i18n'

interface TerminalTab {
  id: string
  title: string
  isReady: boolean
  isActive: boolean
}

/** Sessions the assistant started (`agent-*` ids, see services/terminalRuns).
 *  Their process lives in the main process, so this view only attaches to it. */
const isAgentSessionId = (id: string): boolean => id.startsWith('agent-')

/** xterm.js ANSI palettes — follow the app's light/dark theme instead of a
 *  hardcoded dark block (which glared against the light editor surface). */
const TERM_THEME_DARK = {
  background: '#18181b',
  foreground: '#D4D4D8',
  cursor: '#D4D4D8',
  selectionBackground: '#3B82F680',
  black: '#18181b',
  red: '#F48771',
  green: '#73C991',
  yellow: '#E5BA7D',
  blue: '#4F8FDD',
  magenta: '#C184C6',
  cyan: '#48C9C4',
  white: '#BBBEBF',
  brightBlack: '#838485',
  brightRed: '#F48771',
  brightGreen: '#73C991',
  brightYellow: '#E5BA7D',
  brightBlue: '#3B82F6',
  brightMagenta: '#C184C6',
  brightCyan: '#48C9C4',
  brightWhite: '#EDEDED',
}

const TERM_THEME_LIGHT = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#24292f',
  selectionBackground: '#2563eb40',
  black: '#24292f',
  red: '#c42b1c',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#005cc5',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#cf222e',
  brightGreen: '#1a7f37',
  brightYellow: '#9a6700',
  brightBlue: '#0969da',
  brightMagenta: '#8250df',
  brightCyan: '#1b7c83',
  brightWhite: '#24292f',
}

const CloseIcon = ({ size = 10 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
    <path d="M2 2l6 6M8 2l-6 6" />
  </svg>
)

const TerminalGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 7l5 5-5 5" />
    <path d="M13 17h6" />
  </svg>
)

const PlusIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

interface TerminalPanelProps {
  rootPath?: string | null
}

export default function TerminalPanel({ rootPath }: TerminalPanelProps) {
  // Individual selectors — a whole-store subscription would re-render the
  // terminal on every uiStore change (notifications, sidebar drag, ...).
  const terminalHeight = useUIStore((s) => s.terminalHeight)
  const setTerminalHeight = useUIStore((s) => s.setTerminalHeight)
  const isTerminalVisible = useUIStore((s) => s.isTerminalVisible)
  const t = useI18n()

  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const terminalsRef = useRef<Map<string, {
    term: Terminal
    fit: FitAddon
    container: HTMLDivElement
    cleanup: (() => void)[]
    disposed: boolean
  }>>(new Map())
  const hostsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const initTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const seenAgentRunsRef = useRef<Set<string>>(new Set())
  const dismissedAgentRunsRef = useRef<Set<string>>(new Set())
  const pendingFocusRef = useRef<string | null>(null)
  const activeDragRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  // Debounced fit + rAF coalescing for drag resizes. mousemove fires at 60–120 Hz
  // while dragging the panel height; without coalescing every move schedules its
  // own fit() (which is never cancelled) — a drag stacks dozens of concurrent
  // xterm layout passes + IPC resizes. Height updates are merged into one store
  // write per animation frame, and all fits collapse into a single debounced
  // pass once dragging pauses.
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heightRafRef = useRef<number | null>(null)
  const pendingHeightRef = useRef(0)

  /** Fit only panes that are actually laid out — fitting a `display:none` pane
   *  yields a 0×0 measurement and resizes its pty to a single column. */
  const fitVisible = useCallback(() => {
    terminalsRef.current.forEach((entry) => {
      if (entry.disposed) return
      const el = entry.container
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return
      try { entry.fit.fit() } catch { /* terminal disposed */ }
    })
  }, [])

  const scheduleFit = useCallback(() => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current)
    fitTimerRef.current = setTimeout(() => {
      fitTimerRef.current = null
      fitVisible()
    }, 30)
  }, [fitVisible])

  // Drag to resize (vertical - panel height)
  const dragStartY = useRef(0)
  const dragStartHeight = useRef(0)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartY.current = e.clientY
    dragStartHeight.current = terminalHeight
    pendingHeightRef.current = terminalHeight
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'

    const handleDragMove = (ev: MouseEvent) => {
      const delta = dragStartY.current - ev.clientY
      pendingHeightRef.current = Math.max(100, Math.min(600, dragStartHeight.current + delta))
      if (heightRafRef.current === null) {
        heightRafRef.current = requestAnimationFrame(() => {
          heightRafRef.current = null
          setTerminalHeight(pendingHeightRef.current)
          scheduleFit()
        })
      }
    }

    const handleDragEnd = () => {
      if (heightRafRef.current !== null) {
        cancelAnimationFrame(heightRafRef.current)
        heightRafRef.current = null
      }
      setTerminalHeight(pendingHeightRef.current)
      scheduleFit()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleDragMove)
      document.removeEventListener('mouseup', handleDragEnd)
      activeDragRef.current = null
    }

    activeDragRef.current = { move: handleDragMove, up: handleDragEnd }
    document.addEventListener('mousemove', handleDragMove)
    document.addEventListener('mouseup', handleDragEnd)
  }, [terminalHeight, setTerminalHeight, scheduleFit])

  const focusTerminal = useCallback((tabId: string) => {
    const entry = terminalsRef.current.get(tabId)
    if (entry && !entry.disposed) {
      try { entry.term.focus() } catch { /* disposed */ }
      return
    }
    // The xterm instance may still be initializing (100 ms debounce); remember
    // the request and honour it once the pty is attached.
    pendingFocusRef.current = tabId
  }, [])

  const selectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId)
    focusTerminal(tabId)
  }, [focusTerminal])

  const createTab = useCallback(() => {
    const tabId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    pendingFocusRef.current = tabId
    setTabs((prev) => [...prev, {
      id: tabId,
      title: t('terminal.tabTitle', { count: prev.length + 1 }),
      isReady: false,
      isActive: true,
    }])
    setActiveTabId(tabId)
    focusTerminal(tabId)
    return tabId
  }, [focusTerminal, t])

  /** A tab per process the assistant started in this pty layer */
  const openAgentTab = useCallback((run: AgentTerminalRun) => {
    const command = run.command.split('\n')[0].slice(0, 28)
    setTabs((prev) => {
      if (prev.some((tab) => tab.id === run.id)) return prev
      return [...prev, {
        id: run.id,
        title: moduleT('terminal.agentTabTitle', { command }),
        isReady: false,
        isActive: prev.length === 0,
      }]
    })
    setActiveTabId((current) => (current === null ? run.id : current))
  }, [])

  const hidePanel = useCallback(() => {
    useUIStore.setState({ isTerminalVisible: false })
  }, [])

  const disposeTerminal = useCallback((tabId: string) => {
    const entry = terminalsRef.current.get(tabId)
    if (!entry) return
    entry.disposed = true
    entry.cleanup.forEach((fn) => fn())
    window.electronAPI.termDispose(tabId)
    entry.term.dispose()
    // The pane host is React-owned: React removes it when the tab leaves state.
    // Removing it here as well would yank the node out from under reconciliation.
    terminalsRef.current.delete(tabId)
  }, [])

  const closeTab = useCallback((tabId: string) => {
    const tab = tabs.find((x) => x.id === tabId)
    if (!tab) return
    // Closing an agent tab only detaches the view — the process keeps running in
    // the main process for the assistant to read. Remember it was dismissed so
    // the sync effect below doesn't hand it back on the next store change.
    if (isAgentSessionId(tabId)) dismissedAgentRunsRef.current.add(tabId)

    disposeTerminal(tabId)

    const remaining = tabs.filter((x) => x.id !== tabId)
    setTabs(remaining)

    if (activeTabId === tabId) {
      setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null)
    }
    if (remaining.length === 0) hidePanel()
  }, [tabs, activeTabId, disposeTerminal, hidePanel])

  // Start renaming a tab
  const startRename = useCallback((tabId: string) => {
    const tab = tabs.find((x) => x.id === tabId)
    if (!tab) return
    setRenamingTabId(tabId)
    setRenameValue(tab.title)
  }, [tabs])

  const commitRename = useCallback(() => {
    if (!renamingTabId) return
    setTabs((prev) =>
      prev.map((x) => (x.id === renamingTabId ? { ...x, title: renameValue || x.title } : x))
    )
    setRenamingTabId(null)
  }, [renamingTabId, renameValue])

  // Initialize first tab on mount
  useEffect(() => {
    if (!isTerminalVisible) return
    if (tabs.length === 0) {
      createTab()
    }
  }, [isTerminalVisible, tabs.length, createTab])

  // The assistant's background commands outlive this view (hiding the panel
  // unmounts it), so re-open a tab for every run that is still registered.
  useEffect(() => {
    let cancelled = false
    const sync = () => {
      void listAgentRuns().then((runs) => {
        if (cancelled) return
        for (const run of runs) {
          if (seenAgentRunsRef.current.has(run.id) || dismissedAgentRunsRef.current.has(run.id)) continue
          seenAgentRunsRef.current.add(run.id)
          openAgentTab(run)
        }
      })
    }
    sync()
    const unsubscribe = onAgentRunsChanged(sync)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [openAgentTab])

  // Re-theme live terminals when the app switches light/dark (the theme is
  // applied as a .dark class on <html>, so watch the class attribute).
  useEffect(() => {
    const applyTheme = () => {
      const isDark = document.documentElement.classList.contains('dark')
      const palette = isDark ? TERM_THEME_DARK : TERM_THEME_LIGHT
      terminalsRef.current.forEach(({ term }) => {
        try { term.options.theme = palette } catch { /* terminal disposed */ }
      })
    }
    applyTheme()
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((m) => m.attributeName === 'class')) applyTheme()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // Initialize terminal for a tab
  const initTerminal = useCallback((tabId: string, container: HTMLDivElement) => {
    if (terminalsRef.current.has(tabId)) return

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      theme: document.documentElement.classList.contains('dark') ? TERM_THEME_DARK : TERM_THEME_LIGHT,
      cursorBlink: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(container)

    const initTimeout = setTimeout(() => {
      initTimeoutsRef.current.delete(initTimeout)
      const entry = terminalsRef.current.get(tabId)
      if (!entry || entry.disposed) return
      const host = entry.container // may have been re-attached since init
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try { fitAddon.fit() } catch { /* disposed */ }
      }
      if (isAgent) {
        // Attach to a process the assistant started: replay what it has already
        // produced, then let the live stream through.
        void window.electronAPI.termAttach(tabId).then((attached) => {
          const current = terminalsRef.current.get(tabId)
          if (!current || current.disposed) return
          replayed = true
          const heldOutput = held.join('')
          held.length = 0
          term.write(
            (attached?.output ?? '') + heldOutput +
            (attached && !attached.running ? '\r\n' + moduleT('terminal.processExited') : '')
          )
          setTabs((prev) => prev.map((x) => (x.id === tabId ? { ...x, isReady: true } : x)))
          if (pendingFocusRef.current === tabId) {
            pendingFocusRef.current = null
            try { term.focus() } catch { /* disposed */ }
          }
        })
        return
      }
      window.electronAPI.termCreate(tabId, rootPath || undefined).then(() => {
        if (!entry.disposed) {
          setTabs((prev) => prev.map((x) => (x.id === tabId ? { ...x, isReady: true } : x)))
          if (pendingFocusRef.current === tabId) {
            pendingFocusRef.current = null
            try { term.focus() } catch { /* disposed */ }
          }
        }
      })
    }, 100)
    initTimeoutsRef.current.add(initTimeout)

    const cleanup: (() => void)[] = []
    let localDisposed = false
    const isAgent = isAgentSessionId(tabId)
    // An agent tab joins a stream that was already running: hold live chunks
    // until the replay is written, otherwise history and live output interleave.
    let replayed = !isAgent
    const held: string[] = []

    // Batch high-frequency pty output (build logs, recursive listings) into a
    // single term.write per ~30 ms instead of one write per IPC chunk — the main
    // process pushes one message per chunk, which floods xterm's parser and the
    // renderer's event loop during heavy output.
    let pendingWrite = ''
    let writeTimer: ReturnType<typeof setTimeout> | null = null
    const flushWrite = () => {
      writeTimer = null
      const data = pendingWrite
      pendingWrite = ''
      if (!localDisposed && data) term.write(data)
    }

    cleanup.push(() => {
      localDisposed = true
      if (writeTimer !== null) clearTimeout(writeTimer)
    })
    cleanup.push(window.electronAPI.onTermData(tabId, (data) => {
      if (localDisposed) return
      if (!replayed) {
        held.push(data)
        return
      }
      pendingWrite += data
      if (writeTimer === null) writeTimer = setTimeout(flushWrite, 30)
    }))

    cleanup.push(window.electronAPI.onTermExit(tabId, () => {
      if (localDisposed) return
      // An agent tab that has not replayed yet would put this banner *above* the
      // output it belongs to — the attach response renders it in order instead.
      if (!replayed) return
      // Flush any buffered output before the exit banner so ordering is preserved
      flushWrite()
      term.write('\r\n' + moduleT('terminal.processExited'))
    }))

    term.onData((data) => {
      window.electronAPI.termWrite(tabId, data)
    })

    term.onResize(({ cols, rows }) => {
      window.electronAPI.termResize(tabId, cols, rows)
    })

    terminalsRef.current.set(tabId, { term, fit: fitAddon, container, cleanup, disposed: false })
  }, [rootPath])

  /** Attach a React pane host to its xterm instance. Panes keep a stable key per
   *  tab, but if a host is ever remounted (StrictMode remount, future layout
   *  change) the live `.xterm` element has to move with it — otherwise the
   *  terminal stays inside the detached node and the pane renders blank. */
  const attachPane = useCallback((tabId: string, el: HTMLDivElement | null) => {
    if (!el) return
    hostsRef.current.set(tabId, el)
    const entry = terminalsRef.current.get(tabId)
    if (!entry) {
      // A hidden host measures 0×0 and xterm would cache a zero character size,
      // so defer opening it until the pane is actually laid out. The visibility
      // effect below retries as soon as the tab is shown.
      if (el.clientWidth > 0 && el.clientHeight > 0) initTerminal(tabId, el)
      return
    }
    if (entry.container !== el) {
      if (entry.term.element) el.appendChild(entry.term.element)
      entry.container = el
      scheduleFit()
    }
  }, [initTerminal, scheduleFit])

  /** Open the terminal that became visible after being created in the background. */
  const ensureVisibleTerminals = useCallback(() => {
    if (activeTabId && !terminalsRef.current.has(activeTabId)) {
      const host = hostsRef.current.get(activeTabId)
      if (host && host.clientWidth > 0 && host.clientHeight > 0) initTerminal(activeTabId, host)
    }
    fitVisible()
  }, [activeTabId, initTerminal, fitVisible])

  // Fit the visible terminal after a tab switch / height change.
  useEffect(() => {
    if (!activeTabId || !isTerminalVisible) return
    const timer = setTimeout(ensureVisibleTerminals, 50)
    return () => clearTimeout(timer)
  }, [activeTabId, terminalHeight, isTerminalVisible, tabs, ensureVisibleTerminals])

  // The stage also changes width when the sidebar / chat panels are dragged.
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => scheduleFit())
    observer.observe(el)
    return () => observer.disconnect()
  }, [scheduleFit])

  // Cleanup all on unmount
  useEffect(() => {
    // Copy ref containers into locals — refs are stable objects created once, so
    // this snapshot is equivalent to reading them in the cleanup below.
    const initTimeouts = initTimeoutsRef.current
    const terminals = terminalsRef.current
    return () => {
      // Clear pending init timeouts
      initTimeouts.forEach((timeoutId) => clearTimeout(timeoutId))
      initTimeouts.clear()
      // Clear pending fit debounce + drag rAF coalescing timers
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current)
      if (heightRafRef.current) cancelAnimationFrame(heightRafRef.current)
      // Remove any active drag listeners
      if (activeDragRef.current) {
        document.removeEventListener('mousemove', activeDragRef.current.move)
        document.removeEventListener('mouseup', activeDragRef.current.up)
        activeDragRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      // Dispose all terminals
      terminals.forEach((entry, id) => {
        entry.disposed = true
        entry.cleanup.forEach((fn) => fn())
        window.electronAPI.termDispose(id)
        entry.term.dispose()
      })
      terminals.clear()
    }
  }, [])

  if (!isTerminalVisible) return null

  const iconButton = 'w-6 h-6 flex items-center justify-center rounded-md text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors shrink-0'

  return (
    <div className="h-full flex flex-col">
      {/* Drag handle (resize panel height) */}
      <div
        className="group relative h-2 cursor-ns-resize flex-shrink-0"
        onMouseDown={handleDragStart}
        title={t('terminal.resizeHint')}
      >
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-1 w-10 rounded-full bg-nova-text-muted/25 group-hover:bg-nova-accent/50 transition-colors" />
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 h-9 px-2 shrink-0 border-b border-nova-border/70">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto terminal-tabbar-scroll" role="tablist">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                className={`group flex items-center gap-1.5 h-[26px] pl-2 pr-1 rounded-full border text-[11px] cursor-pointer shrink-0 select-none transition-colors ${
                  isActive
                    ? 'bg-nova-surface text-nova-text-primary border-nova-border shadow-sm'
                    : 'border-transparent text-nova-text-muted hover:text-nova-text-secondary hover:bg-nova-hover'
                }`}
                onClick={() => selectTab(tab.id)}
                onDoubleClick={() => startRename(tab.id)}
                title={tab.title}
              >
                <span className="shrink-0 opacity-60"><TerminalGlyph /></span>
                {renamingTabId === tab.id ? (
                  <input
                    className="bg-nova-input-bg text-nova-text-primary text-[11px] px-1 py-0 outline-none border border-nova-accent rounded w-[90px]"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setRenamingTabId(null)
                    }}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="truncate max-w-[120px]">{tab.title}</span>
                )}
                <button
                  className="w-4 h-4 flex items-center justify-center rounded-full text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-border/60 transition-colors"
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                  title={t('terminal.closeTab')}
                  aria-label={t('terminal.closeTab')}
                >
                  <CloseIcon />
                </button>
              </div>
            )
          })}
          <button
            className={`${iconButton} ml-0.5`}
            onClick={() => createTab()}
            title={t('terminal.new')}
            aria-label={t('terminal.new')}
          >
            <PlusIcon size={13} />
          </button>
        </div>

        {/* Bar actions: close panel */}
        {activeTabId && (
          <div className="flex items-center gap-0.5 shrink-0 pl-1">
            <button
              className={iconButton}
              onClick={hidePanel}
              title={t('terminal.closePanel')}
              aria-label={t('terminal.closePanel')}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Pane stage. Every tab keeps one host element for its whole life; only
          the active one is displayed, so switching tabs never orphans xterm
          inside a detached node (which rendered the pane blank). */}
      <div ref={stageRef} className="relative flex-1 min-h-0 mx-1.5 mb-1.5 mt-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-pane absolute inset-0 overflow-hidden rounded-lg border transition-colors ${
              tab.id === activeTabId ? 'border-nova-accent/40' : 'border-nova-border/60'
            }`}
            style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
          >
            {/* xterm lives in its own host: React never reconciles the host's children. */}
            <div ref={(el) => attachPane(tab.id, el)} className="absolute inset-0" />
          </div>
        ))}
      </div>
    </div>
  )
}
