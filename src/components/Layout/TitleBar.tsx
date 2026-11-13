import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useUIStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useI18n } from '@/i18n/useI18n'
import BrandBadge from './BrandBadge'
import { IS_OFFICE } from '@/utils/windowMode'

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
  /** 隐藏该菜单：不渲染，也不参与键盘左右切换。保留定义便于按需恢复。 */
  hidden?: boolean
}

/** Trigger a Monaco command on the focused editor (e.g. F12 goto definition). */
function runEditorCommand(command: string): void {
  const editor = (window as unknown as { __monacoEditor?: { trigger: (source: string, cmd: string, payload: unknown) => void } }).__monacoEditor
  editor?.trigger('menu', command, null)
}

/** Dropdown geometry: keep the panel inside the viewport, never clipped. */
const MENU_MIN_WIDTH = 200
const MENU_GAP = 4
const MENU_EDGE_PADDING = 8
/**
 * The dropdown is portalled to <body> and positioned fixed, so it must sit
 * above every in-window layer. Content panels top out at z-10 (office
 * overlay) / z-6 (terminal, problems); modals use z-[100]–z-[300].
 */
const MENU_Z_INDEX = 1000

interface MenuBox {
  left: number
  top: number
  minWidth: number
  maxHeight: number
}

export default function TitleBar() {
  // All actions (stable refs) — a whole-store subscription would re-render the
  // title bar on every uiStore change (notifications, drag-resize, ...).
  const openSettings = useUIStore((s) => s.openSettings)
  const toggleTerminal = useUIStore((s) => s.toggleTerminal)
  const toggleChat = useUIStore((s) => s.toggleChat)
  const openCommandPalette = useUIStore((s) => s.openCommandPalette)
  const openMcpCenter = useUIStore((s) => s.openMcpCenter)
  const isMaximized = useUIStore((s) => s.isMaximized)
  const rootPath = useUIStore((s) => s.rootPath)
  const isChatVisible = useUIStore((s) => s.isChatVisible)
  // 办公室窗口：侧栏在 'office' 时整窗展示办公室视图；从办公室文件树打开文件
  // 会切到 'files' 进入工作区，左上角需要保留一个「返回一人公司」入口。
  const activeSidebarTab = useUIStore((s) => s.activeSidebarTab)
  const officeEntryVisible = !IS_OFFICE || activeSidebarTab !== 'office'
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  // The command center shows the CURRENT project (the active session's bound
  // project) — opening/entering another folder in the file tree only browses
  // it, it doesn't change which project this is.
  const currentProjectPath = useChatStore((s) => s.getActiveSession()?.projectPath ?? null)
  const displayPath = currentProjectPath || rootPath
  const t = useI18n()

  const [activeMenu, setActiveMenu] = useState<string | null>(null)
  const [menuItemIndex, setMenuItemIndex] = useState(0)
  const [menuBox, setMenuBox] = useState<MenuBox | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // The dropdown lives in a portal (see the render below), so the outside-click
  // check needs the panel's own node as well as the menu bar's.
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const menuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  // Track this window's own maximize state (per-window events from main)
  useEffect(() => {
    window.electronAPI.isMaximized().then((v) => useUIStore.getState().setMaximized(v))
    return window.electronAPI.onMaximized((v) => useUIStore.getState().setMaximized(v))
  }, [])

  /** Anchor the fixed dropdown under its button, clamped to the viewport. */
  const positionMenu = useCallback((label: string) => {
    const button = menuButtonRefs.current[label]
    if (!button) return
    const rect = button.getBoundingClientRect()
    const top = rect.bottom + MENU_GAP
    const maxLeft = window.innerWidth - MENU_MIN_WIDTH - MENU_EDGE_PADDING
    setMenuBox({
      left: Math.max(MENU_EDGE_PADDING, Math.min(rect.left, Math.max(MENU_EDGE_PADDING, maxLeft))),
      top,
      minWidth: MENU_MIN_WIDTH,
      // Short windows scroll inside the panel instead of having the tail of the
      // menu (保存/偏好设置…) fall outside the window and read as "cut off".
      maxHeight: Math.max(160, window.innerHeight - top - MENU_EDGE_PADDING),
    })
  }, [])

  const openMenu = useCallback((label: string) => {
    positionMenu(label)
    setActiveMenu(label)
    setMenuItemIndex(0)
  }, [positionMenu])

  // Close on any mousedown outside the menu bar AND outside the portalled panel.
  useEffect(() => {
    if (!activeMenu) return
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (menuRef.current?.contains(target)) return
      if (menuPanelRef.current?.contains(target)) return
      setActiveMenu(null)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [activeMenu])

  // Keep the fixed panel glued to its button when the window resizes/zooms or
  // anything scrolls underneath it.
  useEffect(() => {
    if (!activeMenu) return
    const reposition = () => positionMenu(activeMenu)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [activeMenu, positionMenu])

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
      hidden: true,
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
      hidden: true,
      items: [
        { label: t('menu.selection.selectAll'), shortcut: 'Ctrl+A', action: () => document.execCommand('selectAll') },
        { label: t('menu.selection.expand'), shortcut: 'Shift+Alt+→', action: () => runEditorCommand('editor.action.smartSelect.expand') },
        { label: t('menu.selection.shrink'), shortcut: 'Shift+Alt+←', action: () => runEditorCommand('editor.action.smartSelect.shrink') },
      ],
    },
    {
      label: t('menu.view'),
      hidden: true,
      items: [
        { label: t('menu.edit.commandPalette'), shortcut: 'Ctrl+Shift+P', action: openCommandPalette },
        { separator: true, label: '' },
        { label: t('menu.view.toggleTerminal'), shortcut: 'Ctrl+J', action: toggleTerminal },
        { label: t('menu.view.toggleChat'), shortcut: 'Ctrl+L', action: toggleChat },
      ],
    },
    {
      label: t('menu.go'),
      hidden: true,
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
      hidden: true,
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
      hidden: true,
      items: [
        { label: t('menu.agent.newChat'), action: () => {
          const configStore = useConfigStore.getState()
          if (configStore.activeConfigGroupId) {
            useChatStore.getState().createSession(configStore.activeConfigGroupId)
            // 新会话落在欢迎对话页 —— 对话面板收起时先调出来。
            if (!useUIStore.getState().isChatVisible) useUIStore.getState().toggleChat()
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

  // 只渲染未隐藏的菜单；键盘左右切换也必须按可见集合走，
  // 否则会跳到看不见的菜单上导致“按了没反应”。
  const visibleMenus = menus.filter((m) => !m.hidden)

  const handleMenuClick = (menuLabel: string) => {
    if (activeMenu === menuLabel) {
      setActiveMenu(null)
      return
    }
    openMenu(menuLabel)
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
      const idx = visibleMenus.findIndex((m) => m.label === activeMenu)
      if (idx >= 0) {
        const next = (idx + dir + visibleMenus.length) % visibleMenus.length
        setActiveMenu(visibleMenus[next].label)
        setMenuItemIndex(0)
      }
      return
    }
    if (!activeMenu) return
    const menu = visibleMenus.find((m) => m.label === activeMenu)
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
      {/* Logo —— 模式相关：普通对话窗口 / 一人公司窗口是两套标识 */}
      <BrandBadge />

      {/* Menu bar */}
      <div
        className="flex items-center h-full no-drag"
        ref={menuRef}
        role="menubar"
        aria-label={t('layout.menubar')}
        onKeyDown={handleMenuKeyDown}
      >
        {visibleMenus.map((menu) => (
          <div key={menu.label} className="relative">
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={activeMenu === menu.label}
              ref={(node) => { menuButtonRefs.current[menu.label] = node }}
              className={`my-2 h-7 px-2.5 rounded-full text-xs transition-colors ${
                activeMenu === menu.label
                  ? 'bg-nova-accent/15 text-nova-text-primary'
                  : 'text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover'
              }`}
              onClick={() => handleMenuClick(menu.label)}
              onMouseEnter={() => {
                if (activeMenu && activeMenu !== menu.label) openMenu(menu.label)
              }}
            >
              {menu.label}
            </button>

            {/*
              The dropdown is portalled to <body> and positioned `fixed`.
              Rendered inline it sat inside the title bar's own paint slot, so
              sibling panels that come later in the DOM (sidebar / chat /
              terminal / office overlay) could cover it — and any ancestor with
              `overflow-hidden` or a backdrop-filter stacking context could clip
              it. At the top level it can never be covered or clipped.
            */}
            {activeMenu === menu.label && menuBox && createPortal(
              <div
                ref={menuPanelRef}
                role="menu"
                data-titlebar-menu=""
                className="fixed glass-panel rounded-lg py-1 overflow-y-auto animate-fade-in"
                style={{
                  left: menuBox.left,
                  top: menuBox.top,
                  minWidth: menuBox.minWidth,
                  maxHeight: menuBox.maxHeight,
                  zIndex: MENU_Z_INDEX,
                }}
                onKeyDown={handleMenuKeyDown}
              >
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
                            : 'text-nova-text-secondary hover:bg-nova-accent/15 hover:text-nova-text-primary'
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
              </div>,
              document.body,
            )}
          </div>
        ))}
      </div>

      {/* Command center (centered pill) — the surrounding title-bar area is a
          window drag handle; only the pill itself stays clickable (no-drag). */}
      <div className="flex-1 flex justify-center min-w-0 px-4">
        <button
          onClick={() => openCommandPalette()}
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
        {/* 一人公司 + 设置：统一收到右侧，紧邻窗口控制按钮。
            主窗口点击打开独立办公室窗口；办公室窗口在工作区时点击返回办公室
            视图（已在办公室视图里就不再重复显示）。 */}
        <div className="flex items-center gap-0.5">
          {officeEntryVisible && (
            <button
              onClick={() => {
                if (IS_OFFICE) useUIStore.getState().setActiveSidebarTab('office')
                else window.electronAPI.openOfficeWindow()
              }}
              aria-label={IS_OFFICE ? t('activityBar.backToOffice') : t('activityBar.office')}
              title={IS_OFFICE ? t('activityBar.backToOffice') : t('activityBar.office')}
              className="p-1.5 rounded-full text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 21V8l6-4 6 4v13" />
                <path d="M16 21V5l4 3v13" />
                <path d="M2 21h20" />
                <path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
              </svg>
            </button>
          )}
          <button
            onClick={() => openSettings()}
            aria-label={t('activityBar.settings')}
            title={t('activityBar.settings')}
            className="p-1.5 rounded-full text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>

        <div className="w-px h-4 bg-nova-border mx-1" aria-hidden="true" />

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
