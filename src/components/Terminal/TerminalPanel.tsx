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
  splitDirection: 'none' | 'horizontal'
  splitTabId: string | null
  splitRatio: number
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
  const [splitDragActive, setSplitDragActive] = useState(false)
  const terminalsRef = useRef<Map<string, {
    term: Terminal
    fit: FitAddon
    container: HTMLDivElement
    cleanup: (() => void)[]
    disposed: boolean
  }>>(new Map())
  const initTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const seenAgentRunsRef = useRef<Set<string>>(new Set())
  const dismissedAgentRunsRef = useRef<Set<string>>(new Set())
  const activeDragRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)

  // Debounced fit + rAF coalescing for drag resizes. mousemove fires at 60–120 Hz
  // while dragging the panel height or split ratio; without coalescing every move
  // schedules its own 10 ms fit() (which is never cancelled) — a drag stacks
  // dozens of concurrent xterm layout passes + IPC resizes. Now height / ratio
  // updates are merged into one store write per animation frame, and all fits
  // collapse into a single debounced pass once dragging pauses.
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heightRafRef = useRef<number | null>(null)
  const pendingHeightRef = useRef(0)
  const splitRafRef = useRef<number | null>(null)
  const pendingRatioRef = useRef(0)

  const scheduleFit = useCallback(() => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current)
    fitTimerRef.current = setTimeout(() => {
      fitTimerRef.current = null
      terminalsRef.current.forEach((entry) => {
        if (!entry.disposed) {
          try { entry.fit.fit() } catch { /* terminal disposed */ }
        }
      })
    }, 30)
  }, [])

  // Drag to resize (vertical - panel height)
  const dragStartY = useRef(0)
  const dragStartHeight = useRef(0)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartY.current = e.clientY
    dragStartHeight.current = terminalHeight
    pendingHeightRef.current = terminalHeight

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
      document.removeEventListener('mousemove', handleDragMove)
      document.removeEventListener('mouseup', handleDragEnd)
      activeDragRef.current = null
    }

    activeDragRef.current = { move: handleDragMove, up: handleDragEnd }
    document.addEventListener('mousemove', handleDragMove)
    document.addEventListener('mouseup', handleDragEnd)
  }, [terminalHeight, setTerminalHeight, scheduleFit])

  const createTab = useCallback(() => {
    const tabId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setTabs((prev) => [...prev, {
      id: tabId,
      title: t('terminal.tabTitle', { count: prev.length + 1 }),
      isReady: false,
      isActive: true,
      splitDirection: 'none',
      splitTabId: null,
      splitRatio: 0.5,
    }])
    setActiveTabId(tabId)
    return tabId
  }, [t])

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
        splitDirection: 'none',
        splitTabId: null,
        splitRatio: 0.5,
      }]
    })
    setActiveTabId((current) => (current === null ? run.id : current))
  }, [])

  const disposeTerminal = useCallback((tabId: string) => {
    const entry = terminalsRef.current.get(tabId)
    if (entry) {
      entry.disposed = true
      entry.cleanup.forEach((fn) => fn())
      window.electronAPI.termDispose(tabId)
      entry.term.dispose()
      entry.container.remove()
      terminalsRef.current.delete(tabId)
    }
  }, [])

  const closeTab = useCallback((tabId: string) => {
    // Closing an agent tab only detaches the view — the process keeps running in
    // the main process for the assistant to read. Remember it was dismissed so
    // the sync effect below doesn't hand it back on the next store change.
    if (isAgentSessionId(tabId)) dismissedAgentRunsRef.current.add(tabId)
    const tab = tabs.find((t) => t.id === tabId)
    // If this tab is part of a split pair, unsplit instead of closing
    if (tab && tab.splitDirection !== 'none' && tab.splitTabId) {
      const otherId = tab.splitTabId
      disposeTerminal(otherId)
      setTabs((prev) => {
        const next = prev
          .filter((t) => t.id !== otherId)
          .map((t) =>
            t.id === tabId
              ? { ...t, splitDirection: 'none' as const, splitTabId: null, splitRatio: 0.5 }
              : t
          )
        if (activeTabId === otherId) {
          setActiveTabId(tabId)
        }
        return next
      })
      return
    }

    disposeTerminal(tabId)
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId)
      if (activeTabId === tabId && next.length > 0) {
        setActiveTabId(next[next.length - 1].id)
      } else if (next.length === 0) {
        setActiveTabId(null)
        useUIStore.getState().toggleTerminal()
      }
      return next
    })
  }, [activeTabId, tabs, disposeTerminal])

  // Split the active terminal into left/right panes
  const splitTerminal = useCallback(() => {
    if (!activeTabId) return
    const currentTab = tabs.find((t) => t.id === activeTabId)
    if (!currentTab || currentTab.splitDirection !== 'none') return

    const newTabId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const newTitle = t('terminal.tabTitle', { count: tabs.length + 1 })

    setTabs((prev) => [
      ...prev.map((t) =>
        t.id === activeTabId
          ? { ...t, splitDirection: 'horizontal' as const, splitTabId: newTabId, splitRatio: 0.5 }
          : t
      ),
      {
        id: newTabId,
        title: newTitle,
        isReady: false,
        isActive: true,
        splitDirection: 'horizontal' as const,
        splitTabId: activeTabId,
        splitRatio: 0.5,
      },
    ])
    setActiveTabId(newTabId)
  }, [activeTabId, tabs, t])

  // Split ratio drag handler (horizontal)
  const handleSplitDragStart = useCallback((primaryTabId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setSplitDragActive(true)

    const container = (e.target as HTMLElement).parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    const primaryTab = tabs.find((t) => t.id === primaryTabId)
    if (!primaryTab) return
    const startRatio = primaryTab.splitRatio
    pendingRatioRef.current = startRatio

    const handleDragMove = (ev: MouseEvent) => {
      const delta = ev.clientX - (rect.left + rect.width * startRatio)
      pendingRatioRef.current = Math.max(0.2, Math.min(0.8, startRatio + delta / rect.width))
      if (splitRafRef.current === null) {
        splitRafRef.current = requestAnimationFrame(() => {
          splitRafRef.current = null
          setTabs((prev) =>
            prev.map((t) => (t.id === primaryTabId ? { ...t, splitRatio: pendingRatioRef.current } : t))
          )
          scheduleFit()
        })
      }
    }

    const handleDragEnd = () => {
      if (splitRafRef.current !== null) {
        cancelAnimationFrame(splitRafRef.current)
        splitRafRef.current = null
      }
      setTabs((prev) =>
        prev.map((t) => (t.id === primaryTabId ? { ...t, splitRatio: pendingRatioRef.current } : t))
      )
      scheduleFit()
      setSplitDragActive(false)
      document.removeEventListener('mousemove', handleDragMove)
      document.removeEventListener('mouseup', handleDragEnd)
      activeDragRef.current = null
    }

    activeDragRef.current = { move: handleDragMove, up: handleDragEnd }
    document.addEventListener('mousemove', handleDragMove)
    document.addEventListener('mouseup', handleDragEnd)
  }, [tabs, scheduleFit])

  // Start renaming a tab
  const startRename = useCallback((tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    setRenamingTabId(tabId)
    setRenameValue(tab.title)
  }, [tabs])

  const commitRename = useCallback(() => {
    if (!renamingTabId) return
    setTabs((prev) =>
      prev.map((t) => (t.id === renamingTabId ? { ...t, title: renameValue || t.title } : t))
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
      fitAddon.fit()
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
          setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, isReady: true } : t)))
        })
        return
      }
      window.electronAPI.termCreate(tabId, rootPath || undefined).then(() => {
        if (!entry.disposed) {
          setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, isReady: true } : t))
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

  // Fit active terminal (and its split partner) when switching tabs or resizing
  useEffect(() => {
    if (!activeTabId || !isTerminalVisible) return
    const fitEntry = (id: string) => {
      const entry = terminalsRef.current.get(id)
      if (entry) setTimeout(() => { try { entry.fit.fit() } catch { /* */ } }, 50)
    }
    fitEntry(activeTabId)
    // Also fit the split partner
    const activeTab = tabs.find((t) => t.id === activeTabId)
    if (activeTab && activeTab.splitTabId) {
      fitEntry(activeTab.splitTabId)
      // If this is the secondary pane, also fit the primary
      if (activeTab.splitDirection !== 'none') {
        const primaryTab = tabs.find((t) => t.id === activeTab.splitTabId)
        if (primaryTab) fitEntry(primaryTab.id)
      }
    }
  }, [activeTabId, terminalHeight, isTerminalVisible, tabs])

  // Window resize handler
  useEffect(() => {
    const handleResize = () => {
      if (!activeTabId || !isTerminalVisible) return
      const fitEntry = (id: string) => {
        const entry = terminalsRef.current.get(id)
        if (entry) setTimeout(() => { try { entry.fit.fit() } catch { /* */ } }, 10)
      }
      fitEntry(activeTabId)
      const activeTab = tabs.find((t) => t.id === activeTabId)
      if (activeTab && activeTab.splitTabId) {
        fitEntry(activeTab.splitTabId)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [activeTabId, isTerminalVisible, tabs])

  // Cleanup all on unmount
  useEffect(() => {
    // Copy ref containers into locals — refs are stable objects created once, so
    // this snapshot is equivalent to reading them in the cleanup below.
    const initTimeouts = initTimeoutsRef.current
    const terminals = terminalsRef.current
    return () => {
      // Clear pending init timeouts
      initTimeouts.forEach((t) => clearTimeout(t))
      initTimeouts.clear()
      // Clear pending fit debounce + drag rAF coalescing timers
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current)
      if (heightRafRef.current) cancelAnimationFrame(heightRafRef.current)
      if (splitRafRef.current) cancelAnimationFrame(splitRafRef.current)
      // Remove any active drag listeners
      if (activeDragRef.current) {
        document.removeEventListener('mousemove', activeDragRef.current.move)
        document.removeEventListener('mouseup', activeDragRef.current.up)
        activeDragRef.current = null
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

  // Helper: determine if a tab should be visible
  const isTabVisible = (tab: TerminalTab): boolean => {
    if (tab.id === activeTabId) return true
    // If active tab's split partner, also visible
    const activeTab = tabs.find((t) => t.id === activeTabId)
    if (activeTab && activeTab.splitTabId === tab.id) return true
    // If this tab's split partner is active, also visible
    if (tab.splitDirection !== 'none' && tab.splitTabId === activeTabId) return true
    return false
  }

  // Get the primary (left) pane for a split pair — the one created first (lower index in tabs array)
  const getPrimaryPane = (tabId: string): TerminalTab | null => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || tab.splitDirection === 'none') return null
    const other = tabs.find((t) => t.id === tab.splitTabId)
    if (!other) return null
    return tabs.indexOf(tab) < tabs.indexOf(other) ? tab : other
  }

  return (
    <div className="h-full flex flex-col">
      {/* Drag handle */}
      <div
        className="h-1.5 cursor-ns-resize hover:bg-nova-accent/40 transition-colors flex-shrink-0"
        onMouseDown={handleDragStart}
      />

      {/* Tab bar */}
      <div className="flex items-center h-7 bg-transparent flex-shrink-0 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`flex items-center gap-1 px-3 h-full text-[11px] cursor-pointer border-r border-nova-border shrink-0 ${
              tab.id === activeTabId
                ? 'bg-nova-tab-active text-nova-text-primary'
                : 'bg-transparent text-nova-text-muted hover:bg-nova-hover'
            }`}
            onClick={() => setActiveTabId(tab.id)}
            onDoubleClick={() => startRename(tab.id)}
          >
            {renamingTabId === tab.id ? (
              <input
                className="bg-nova-input-bg text-nova-text-primary text-[11px] px-1 py-0 outline-none border border-nova-accent rounded w-[80px]"
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
              <span className="truncate max-w-[100px]">{tab.title}</span>
            )}
            <button
              className="ml-1 text-nova-text-muted hover:text-nova-text-primary text-[10px]"
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              title={tab.splitDirection !== 'none' ? t('terminal.unsplit') : t('common.close')}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="px-2 h-full text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover text-sm shrink-0"
          onClick={createTab}
          title={t('terminal.new')}
        >
          +
        </button>
        {/* Split button - only show when active tab is not already split */}
        {activeTabId && tabs.find((t) => t.id === activeTabId)?.splitDirection === 'none' && (
          <button
            className="px-2 h-full text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover text-xs shrink-0"
            onClick={splitTerminal}
            title={t('terminal.split')}
          >
            ⧉
          </button>
        )}
      </div>

      {/* Terminal containers */}
      <div className="flex-1 relative overflow-hidden">
        {tabs.map((tab) => {
          const visible = isTabVisible(tab)
          if (!visible) return null

          // Check if this tab is part of a split pair
          if (tab.splitDirection !== 'none' && tab.splitTabId) {
            const primary = getPrimaryPane(tab.id)
            // Only render the split layout once (from the primary pane's perspective)
            if (primary && tab.id === primary.id) {
              const secondary = tabs.find((t) => t.id === tab.splitTabId)
              if (!secondary) return null
              const ratio = primary.splitRatio

              return (
                <div
                  key={`split-${primary.id}`}
                  className="absolute inset-0 flex"
                  style={{ display: primary.id === activeTabId || secondary.id === activeTabId ? 'flex' : 'none' }}
                >
                  {/* Left pane */}
                  <div
                    ref={(el) => {
                      if (el && !terminalsRef.current.has(primary.id)) {
                        initTerminal(primary.id, el)
                      }
                    }}
                    className="h-full"
                    style={{ width: `${ratio * 100}%` }}
                  />
                  {/* Resizer */}
                  <div
                    className={`terminal-split-resizer ${splitDragActive ? 'active' : ''}`}
                    onMouseDown={(e) => handleSplitDragStart(primary.id, e)}
                  />
                  {/* Right pane */}
                  <div
                    ref={(el) => {
                      if (el && !terminalsRef.current.has(secondary.id)) {
                        initTerminal(secondary.id, el)
                      }
                    }}
                    className="h-full"
                    style={{ width: `${(1 - ratio) * 100}%` }}
                  />
                </div>
              )
            }
            // Secondary pane is rendered as part of primary's layout, skip it
            if (primary && tab.id !== primary.id) return null
          }

          // Non-split tab
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el && !terminalsRef.current.has(tab.id)) {
                  initTerminal(tab.id, el)
                }
              }}
              className="absolute inset-0 px-1 pb-1"
              style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
            />
          )
        })}
      </div>
    </div>
  )
}
