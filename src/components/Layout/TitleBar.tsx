import { useState, useRef, useEffect, useCallback } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useI18n } from '@/i18n/useI18n'

interface MenuItem {
  label: string
  shortcut?: string
  action?: () => void
  separator?: boolean
  disabled?: boolean
}

interface MenuGroup {
  label: string
  items: MenuItem[]
}

/** Trigger a Monaco command on the focused editor (e.g. F12 goto definition). */
function runEditorCommand(command: string): void {
  const editor = (window as unknown as { __monacoEditor?: { trigger: (source: string, cmd: string, payload: unknown) => void } }).__monacoEditor
  editor?.trigger('menu', command, null)
}

export default function TitleBar() {
  // All actions (stable refs) — a whole-store subscription would re-render the
  // title bar on every uiStore change (notifications, drag-resize, ...).
  const openSettings = useUIStore((s) => s.openSettings)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const toggleTerminal = useUIStore((s) => s.toggleTerminal)
  const toggleChat = useUIStore((s) => s.toggleChat)
  const openCommandPalette = useUIStore((s) => s.openCommandPalette)
  const openMcpCenter = useUIStore((s) => s.openMcpCenter)
  const isMaximized = useUIStore((s) => s.isMaximized)
  const rootPath = useUIStore((s) => s.rootPath)
  const isChatVisible = useUIStore((s) => s.isChatVisible)
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  // The command center shows the CURRENT project (the active session's bound
  // project) — opening/entering another folder in the file tree only browses
  // it, it doesn't change which project this is.
  const currentProjectPath = useChatStore((s) => s.getActiveSession()?.projectPath ?? null)
  const displayPath = currentProjectPath || rootPath
  const t = useI18n()

  const [activeMenu, setActiveMenu] = useState<string | null>(null)
  const [menuItemIndex, setMenuItemIndex] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)

  // Track this window's own maximize state (per-window events from main)
  useEffect(() => {
    window.electronAPI.isMaximized().then((v) => useUIStore.getState().setMaximized(v))
    return window.electronAPI.onMaximized((v) => useUIStore.getState().setMaximized(v))
  }, [])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleMinimize = useCallback(() => window.electronAPI.minimize(), [])
  const handleMaximize = useCallback(() => window.electronAPI.maximize(), [])
  const handleClose = useCallback(() => window.electronAPI.close(), [])

  const menus: MenuGroup[] = [
    {
      label: t('menu.file'),
      items: [
        { label: t('menu.file.new'), shortcut: 'Ctrl+N', action: () => {
          useEditorStore.getState().newFile()
        }},
        { separator: true, label: '' },
        { label: t('menu.file.openFolder'), shortcut: 'Ctrl+O', action: async () => {
          const path = await window.electronAPI.openFolder()
          if (path) {
            useUIStore.getState().setRootPath(path)
            useUIStore.getState().setActiveSidebarTab('files')
            if (!useUIStore.getState().isSidebarVisible) {
              useUIStore.getState().toggleSidebar()
            }
          }
        }},
        { separator: true, label: '' },
        { label: t('menu.file.save'), shortcut: 'Ctrl+S', action: () => {
          const afp = useEditorStore.getState().activeFilePath
          if (afp) useEditorStore.getState().saveFile(afp)
        }},
        { label: t('menu.file.saveAll'), shortcut: 'Ctrl+Shift+S', action: () => useEditorStore.getState().saveAll() },
        { separator: true, label: '' },
        { label: t('menu.file.newWindow'), action: () => window.electronAPI.openNewWindow() },
        { label: t('menu.file.preferences'), action: openSettings },
      ],
    },
    {
      label: t('menu.edit'),
      items: [
        { label: t('menu.edit.undo'), shortcut: 'Ctrl+Z', action: () => document.execCommand('undo') },
        { label: t('menu.edit.redo'), shortcut: 'Ctrl+Y', action: () => document.execCommand('redo') },
        { separator: true, label: '' },
        { label: t('menu.edit.cut'), shortcut: 'Ctrl+X', action: () => document.execCommand('cut') },
        { label: t('menu.edit.copy'), shortcut: 'Ctrl+C', action: () => document.execCommand('copy') },
        { label: t('menu.edit.paste'), shortcut: 'Ctrl+V', action: () => document.execCommand('paste') },
        { separator: true, label: '' },
        { label: t('menu.edit.find'), shortcut: 'Ctrl+F', action: () => {
          const editor = (window as any).__monacoEditor
          if (editor) editor.trigger('keyboard', 'actions.find', null)
        }},
        { label: t('menu.edit.replace'), shortcut: 'Ctrl+H', action: () => {
          const editor = (window as any).__monacoEditor
          if (editor) editor.trigger('keyboard', 'editor.action.startFindReplaceAction', null)
        }},
        { separator: true, label: '' },
        { label: t('menu.edit.commandPalette'), shortcut: 'Ctrl+Shift+P', action: openCommandPalette },
      ],
    },
    {
      label: t('menu.selection'),
      items: [
        { label: t('menu.selection.selectAll'), shortcut: 'Ctrl+A', action: () => document.execCommand('selectAll') },
        { label: t('menu.selection.expand'), shortcut: 'Shift+Alt+→', action: () => runEditorCommand('editor.action.smartSelect.expand') },
        { label: t('menu.selection.shrink'), shortcut: 'Shift+Alt+←', action: () => runEditorCommand('editor.action.smartSelect.shrink') },
      ],
    },
    {
      label: t('menu.view'),
      items: [
        { label: t('menu.edit.commandPalette'), shortcut: 'Ctrl+Shift+P', action: openCommandPalette },
        { separator: true, label: '' },
        { label: t('menu.view.toggleSidebar'), shortcut: 'Ctrl+B', action: toggleSidebar },
        { label: t('menu.view.toggleTerminal'), shortcut: 'Ctrl+J', action: toggleTerminal },
        { label: t('menu.view.toggleChat'), shortcut: 'Ctrl+L', action: toggleChat },
      ],
    },
    {
      label: t('menu.go'),
      items: [
        { label: t('menu.go.gotoFile'), shortcut: 'Ctrl+P', action: () => useUIStore.getState().openQuickOpen() },
        { separator: true, label: '' },
        { label: t('menu.go.gotoSymbol'), shortcut: 'Ctrl+Shift+O', action: () => runEditorCommand('editor.action.quickOutline') },
        { label: t('menu.go.gotoLine'), shortcut: 'Ctrl+G', action: () => runEditorCommand('editor.action.gotoLine') },
        { separator: true, label: '' },
        { label: t('menu.go.gotoDefinition'), shortcut: 'F12', action: () => runEditorCommand('editor.action.revealDefinition') },
        { label: t('menu.go.gotoReferences'), shortcut: 'Shift+F12', action: () => runEditorCommand('editor.action.referencesAction') },
      ],
    },
    {
      label: t('menu.run'),
      items: [
        { label: t('menu.run.debug'), shortcut: 'F5', disabled: true },
        { label: t('menu.run.noDebug'), shortcut: 'Ctrl+F5', disabled: true },
        { separator: true, label: '' },
        { label: t('menu.run.stop'), shortcut: 'Shift+F5', disabled: true },
        { label: t('menu.run.restart'), shortcut: 'Ctrl+Shift+F5', disabled: true },
      ],
    },
    {
      label: t('menu.agent'),
      items: [
        { label: t('menu.agent.newChat'), action: () => {
          const configStore = useConfigStore.getState()
          if (configStore.activeConfigGroupId) {
            useChatStore.getState().createSession(configStore.activeConfigGroupId)
          } else {
            openSettings()
          }
        }},
        { label: t('menu.agent.clearChat'), action: () => {
          const session = useChatStore.getState().getActiveSession()
          if (session) useChatStore.getState().clearMessages(session.id)
        }},
        { separator: true, label: '' },
        { label: t('menu.agent.exportMd'), action: () => {
          const session = useChatStore.getState().getActiveSession()
          if (session) {
            const md = useChatStore.getState().exportSession(session.id, 'markdown')
            const blob = new Blob([md], { type: 'text/markdown' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${t('layout.chatFilePrefix')}-${Date.now()}.md`
            a.click()
            URL.revokeObjectURL(url)
          }
        }},
        { label: t('menu.agent.exportJson'), action: () => {
          const session = useChatStore.getState().getActiveSession()
          if (session) {
            const json = useChatStore.getState().exportSession(session.id, 'json')
            const blob = new Blob([json], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${t('layout.chatFilePrefix')}-${Date.now()}.json`
            a.click()
            URL.revokeObjectURL(url)
          }
        }},
      ],
    },
    {
      label: t('menu.terminal'),
      items: [
        { label: t('menu.terminal.new'), shortcut: 'Ctrl+`', action: toggleTerminal },
        { separator: true, label: '' },
        { label: t('menu.terminal.panel'), shortcut: 'Ctrl+J', action: toggleTerminal },
      ],
    },
    {
      label: t('menu.extensions'),
      items: [
        { label: t('menu.extensions.mcp'), shortcut: 'Ctrl+Shift+X', action: openMcpCenter },
      ],
    },
    {
      label: t('menu.help'),
      items: [
        { label: t('menu.help.reportIssue'), action: () => {
          window.open('https://github.com/16fengzhiyong/OurCode/issues', '_blank')
        }},
        { label: t('menu.help.featureRequest'), action: () => {
          window.open('https://github.com/16fengzhiyong/OurCode/issues', '_blank')
        }},
        { separator: true, label: '' },
        { label: t('menu.help.exportData'), action: async () => {
          try {
            const sessions = await window.electronAPI.getSessions()
            const configs = await window.electronAPI.getConfigGroups()
            const data = JSON.stringify({ sessions, configs: configs.map((c: any) => ({ ...c, apiKey: '***' })) }, null, 2)
            const blob = new Blob([data], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `ourcode-backup-${Date.now()}.json`
            a.click()
            URL.revokeObjectURL(url)
          } catch (e) { console.error(e) }
        }},
        { label: t('menu.help.clearData'), action: () => {
          if (confirm(t('layout.clearDataConfirm'))) {
            localStorage.clear()
            window.location.reload()
          }
        }},
        { separator: true, label: '' },
        { label: t('menu.help.devtools'), action: () => {
          window.electronAPI.openDevTools?.()
        }},
      ],
    },
  ]

  const handleMenuClick = (menuLabel: string) => {
    setActiveMenu(activeMenu === menuLabel ? null : menuLabel)
    setMenuItemIndex(0)
  }

  const handleItemClick = (item: MenuItem) => {
    if (!item.disabled && item.action) {
      item.action()
    }
    setActiveMenu(null)
  }

  // Keyboard navigation for the menu bar (VS Code-style): ←/→ move between
  // menus, ↓/↑ move within the open menu, Enter activates, Esc closes.
  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setActiveMenu(null)
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const dir = e.key === 'ArrowRight' ? 1 : -1
      const idx = menus.findIndex((m) => m.label === activeMenu)
      if (idx >= 0) {
        const next = (idx + dir + menus.length) % menus.length
        setActiveMenu(menus[next].label)
        setMenuItemIndex(0)
      }
      return
    }
    if (!activeMenu) return
    const menu = menus.find((m) => m.label === activeMenu)
    if (!menu) return
    const items = menu.items
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      // Skip separators; wrap around
      let next = menuItemIndex
      for (let i = 0; i < items.length; i++) {
        next = (next + dir + items.length) % items.length
        if (!items[next].separator) break
      }
      setMenuItemIndex(next)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[menuItemIndex]
      if (item && !item.separator) handleItemClick(item)
      return
    }
  }

  return (
    <div className="h-12 flex items-center drag-region select-none shrink-0 rounded-xl glass-flat px-1">
      {/* Logo */}
      <div className="flex items-center pl-3 pr-2 gap-2 no-drag">
        <div
          className="w-3.5 h-3.5 rounded-full animate-logo-pulse shrink-0"
          style={{ background: 'linear-gradient(135deg, #0EA5E9 0%, #6366F1 55%, #A855F7 100%)', boxShadow: '0 0 8px rgba(99,102,241,0.45)' }}
        />
        <span className="text-xs font-bold text-nova-text-primary tracking-tight">
          OurCode&nbsp;<span className="font-extrabold bg-gradient-to-r from-sky-500 via-indigo-500 to-purple-500 bg-clip-text text-transparent">一人公司</span>
        </span>
      </div>

      {/* Menu bar */}
      <div
        className="flex items-center h-full no-drag"
        ref={menuRef}
        role="menubar"
        aria-label={t('layout.menubar')}
        onKeyDown={handleMenuKeyDown}
      >
        {menus.map((menu) => (
          <div key={menu.label} className="relative">
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={activeMenu === menu.label}
              className={`my-2 h-7 px-2.5 rounded-full text-xs transition-colors ${
                activeMenu === menu.label
                  ? 'bg-nova-accent/15 text-nova-text-primary'
                  : 'text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover'
              }`}
              onClick={() => handleMenuClick(menu.label)}
              onMouseEnter={() => activeMenu && setActiveMenu(menu.label)}
            >
              {menu.label}
            </button>

            {activeMenu === menu.label && (
              <div className="absolute top-full left-0 glass-panel rounded-lg py-1 min-w-[200px] z-[100] animate-fade-in" role="menu">
                {menu.items.map((item, index) =>
                  item.separator ? (
                    <div key={index} className="h-px bg-nova-border my-1" role="separator" />
                  ) : (
                    <button
                      key={item.label}
                      role="menuitem"
                      className={`w-full text-left px-4 py-1.5 text-xs flex items-center justify-between gap-4 ${
                        item.disabled
                          ? 'text-nova-text-muted cursor-default'
                          : index === menuItemIndex
                            ? 'bg-nova-accent/15 text-nova-text-primary'
                            : 'text-nova-text-secondary hover:bg-nova-accent/15 hover:text-white'
                      }`}
                      onClick={() => handleItemClick(item)}
                      onMouseEnter={() => setMenuItemIndex(index)}
                      disabled={item.disabled}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && (
                        <span className="text-nova-text-muted text-[11px]">{item.shortcut}</span>
                      )}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Command center (centered pill) — the surrounding title-bar area is a
          window drag handle; only the pill itself stays clickable (no-drag). */}
      <div className="flex-1 flex justify-center min-w-0 px-4">
        <button
          onClick={() => (displayPath ? useUIStore.getState().toggleSidebar() : openCommandPalette())}
          className="hidden md:flex items-center gap-2 px-3 h-7 rounded-full text-xs transition-colors min-w-0 max-w-[420px] no-drag"
          style={{
            background: 'color-mix(in srgb, var(--card, #ffffff) 55%, transparent)',
            border: `1px solid ${activeConfigGroupId ? 'color-mix(in srgb, var(--accent, #0058bc) 35%, transparent)' : 'var(--border)'}`,
            boxShadow: activeConfigGroupId ? '0 0 0 3px color-mix(in srgb, var(--accent, #0058bc) 12%, transparent)' : 'none',
            backdropFilter: 'var(--backdrop-blur)',
            WebkitBackdropFilter: 'var(--backdrop-blur)',
          }}
          title={displayPath || t('layout.openFolder')}
        >
          <svg className="w-3.5 h-3.5 text-nova-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a5 5 0 11-14 0 5 5 0 0114 0z" />
          </svg>
          <span className="truncate text-nova-text-secondary">
            {displayPath ? displayPath.split(/[/\\]/).pop() || displayPath : t('layout.openFolder')}
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${activeConfigGroupId ? 'bg-green-400 animate-pulse-dot' : 'bg-nova-text-muted'}`}
          />
          <span className="text-nova-text-muted text-[11px] shrink-0">
            {activeConfigGroupId ? (isChatVisible ? 'OurCode AI' : 'AI') : t('layout.notConfigured')}
          </span>
        </button>
      </div>

      {/* Right controls */}
      <div className="flex items-center gap-1 pr-2 no-drag">
        {/* Window controls */}
        <button
          onClick={handleMinimize}
          className="p-2 rounded-full text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
          aria-label={t('layout.minimize')} title={t('layout.minimize')}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth={2} d="M5 12h14" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="p-2 rounded-full text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
          aria-label={isMaximized ? t('layout.restore') : t('layout.maximize')} title={isMaximized ? t('layout.restore') : t('layout.maximize')}
        >
          {isMaximized ? (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="5" y="8" width="11" height="11" rx="1" strokeWidth={2} />
              <path strokeLinecap="round" strokeWidth={2} d="M8 5v1h7a2 2 0 0 1 2 2v7h1" />
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="5" y="5" width="14" height="14" rx="1" strokeWidth={2} />
            </svg>
          )}
        </button>
        <button
          onClick={handleClose}
          className="p-2 rounded-full text-nova-text-muted hover:text-white transition-colors"
          aria-label={t('layout.close')} title={t('layout.close')}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#e81123' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth={2} d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
