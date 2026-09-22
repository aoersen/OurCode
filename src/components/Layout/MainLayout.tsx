import { useEffect, useRef, useState, useCallback } from 'react'
import TitleBar from './TitleBar'
import StatusBar from './StatusBar'
import ActivityBar from './ActivityBar'
import Sidebar from '../Sidebar/Sidebar'
import EditorContainer from '../Editor/EditorContainer'
import TabBar from '../Editor/TabBar'
import ChatPanel from '../ChatPanel/ChatPanel'
import MemoryModal from '../ChatPanel/MemoryModal'
import TerminalPanel from '../Terminal/TerminalPanel'
import SettingsModal from '../Settings/SettingsModal'
import CommandPalette from '../CommandPalette/CommandPalette'
import QuickOpen from '../Sidebar/QuickOpen'
import ContextMenu from '../Common/ContextMenu'
import NotificationToasts from '../Common/NotificationToasts'
import UnsavedDialog from '../Common/UnsavedDialog'
import SkillRegistryModal from '../Skills/SkillRegistryModal'
import ProblemsPanel from '../Editor/ProblemsPanel'
import RecentFilesModal from '../Editor/RecentFilesModal'
import DebugPanel from '../Editor/DebugPanel'
import OfficeView from '../Office/OfficeView'
import { useProblemsStore } from '@/stores/problemsStore'
import { useRecentFilesStore } from '@/stores/recentFilesStore'
import { useDebugStore } from '@/stores/debugStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useShortcutStore, matchesShortcut } from '@/stores/shortcutStore'
import { executeCommand } from '@/services/commands/commandRegistry'
import { IS_OFFICE } from '@/utils/windowMode'

const COMPACT_BREAKPOINT = 1024
const NARROW_BREAKPOINT = 768

export default function MainLayout() {
  // Individual selectors: the layout must not re-render on every uiStore change
  // (notifications, context menus) or every editorStore keystroke/cursor move.
  const isSidebarVisible = useUIStore((s) => s.isSidebarVisible)
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const activeSidebarTab = useUIStore((s) => s.activeSidebarTab)
  const chatWidth = useUIStore((s) => s.chatWidth)
  const isChatVisible = useUIStore((s) => s.isChatVisible)
  const isTerminalVisible = useUIStore((s) => s.isTerminalVisible)
  const terminalHeight = useUIStore((s) => s.terminalHeight)
  const isCommandPaletteOpen = useUIStore((s) => s.isCommandPaletteOpen)
  const isQuickOpenOpen = useUIStore((s) => s.isQuickOpenOpen)
  const contextMenu = useUIStore((s) => s.contextMenu)
  const rootPath = useUIStore((s) => s.rootPath)
  const isEditorVisible = useUIStore((s) => s.isEditorVisible)
  const panelOrder = useEditorStore((s) => s.panelOrder)
  // 有标签打开时编辑器区域才显示（空 TabBar + 空编辑区不占位）；一旦打开文件
  // 就自动恢复。手动隐藏（toggleEditorVisible）仍优先——isEditorVisible 为
  // false 时无论有没有文件都不显示。
  // 注意判断依据是「各面板 tabOrder 里还有没有标签」，不是 openFiles 长度——
  // closeFile 只把文件移出所在面板的 tabOrder，openFiles 里仍保留（文件可能
  // 还在其它面板开着），用 openFiles 判断会让「关掉最后一个标签」后编辑器
  // 仍显示空框。
  const hasOpenTabs = useEditorStore((s) =>
    s.panelOrder.some((pid) => (s.panels[pid]?.tabOrder?.length ?? 0) > 0),
  )
  // A diff ("Open Changes" / source-control diff) is shown INSTEAD of a tab's
  // content, so the editor area has to mount for it even when nothing is open —
  // otherwise 查看变更 from the 文件变更历史 panel silently does nothing.
  const hasActiveDiff = useEditorStore((s) => !!s.activeDiff)
  const editorShown = isEditorVisible && (hasOpenTabs || hasActiveDiff)
  const splitDirection = useEditorStore((s) => s.splitDirection)
  const splitRatios = useEditorStore((s) => s.splitRatios)
  const isProblemsOpen = useProblemsStore((s) => s.isOpen)
  const isRecentFilesOpen = useRecentFilesStore((s) => s.isOpen)
  const isDebugOpen = useDebugStore((s) => s.isOpen)
  const isMemoryManagerOpen = useUIStore((s) => s.isMemoryManagerOpen)
  const closeMemoryManager = useUIStore((s) => s.closeMemoryManager)
  const isSettingsOpen = useUIStore((s) => s.isSettingsOpen)
  const isSkillRegistryOpen = useUIStore((s) => s.isSkillRegistryOpen)
  // The "current project" follows the ACTIVE SESSION — memory scoping (and the
  // 当前项目 label) uses the active conversation's project, not the folder
  // being browsed in the sidebar file tree.
  const currentProjectPath = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.projectPath ?? null)

  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1400)

  // Use refs for values accessed in the keyboard handler to avoid stale closures
  const isCommandPaletteOpenRef = useRef(isCommandPaletteOpen)
  const isQuickOpenOpenRef = useRef(isQuickOpenOpen)
  const contextMenuRef = useRef(contextMenu)
  const isChatVisibleRef = useRef(isChatVisible)
  useEffect(() => { isCommandPaletteOpenRef.current = isCommandPaletteOpen }, [isCommandPaletteOpen])
  useEffect(() => { isQuickOpenOpenRef.current = isQuickOpenOpen }, [isQuickOpenOpen])
  useEffect(() => { contextMenuRef.current = contextMenu }, [contextMenu])
  useEffect(() => { isChatVisibleRef.current = isChatVisible }, [isChatVisible])

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // While an HTML5 drag (file in the tree, message reorder, ...) is in flight,
  // disable the title bar's -webkit-app-region so the OS can't hijack the drag
  // into a window move — that made the whole interface "slide up" mid-drag.
  useEffect(() => {
    const onDragStart = () => document.body.classList.add('app-dragging')
    const onDragEnd = () => document.body.classList.remove('app-dragging')
    window.addEventListener('dragstart', onDragStart, true)
    window.addEventListener('dragend', onDragEnd, true)
    window.addEventListener('drop', onDragEnd, true)
    return () => {
      window.removeEventListener('dragstart', onDragStart, true)
      window.removeEventListener('dragend', onDragEnd, true)
      window.removeEventListener('drop', onDragEnd, true)
    }
  }, [])

  const isCompact = windowWidth < COMPACT_BREAKPOINT
  const isNarrow = windowWidth < NARROW_BREAKPOINT

  // 「一人公司」：整窗展示。注意这里**不卸载**常规工作区（编辑器/聊天/终端），
  // 而是把工作区隐藏、在其上方盖一层办公室视图 —— 否则切回对话时整个工作区
  // 会重建：长对话全文 markdown 重渲染 + Monaco 实例重建会卡死主线程数秒。
  // 主窗口不再有 office 标签页（入口改为打开独立办公室窗口），因此覆盖逻辑
  // 只在办公室窗口（IS_OFFICE）内启用；办公室视图展示与侧栏折叠无关。
  const isOfficeShown = IS_OFFICE && activeSidebarTab === 'office'

  // Keyboard shortcuts — resolved live from the shortcutStore so the presets /
  // custom bindings configured in Settings actually take effect.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const shortcuts = useShortcutStore.getState()
      // matches an action's configured binding (plus any legacy extra keys)
      const matches = (action: string, extraKeys?: string[]) => {
        if (matchesShortcut(e, shortcuts.getShortcut(action))) return true
        return extraKeys?.some((k) => matchesShortcut(e, k)) ?? false
      }

      // Preset/custom shortcut actions all dispatch through the unified command
      // registry (same IDs the command palette and plugins use)
      const actionCommands: Array<[action: string, command: string, extraKeys?: string[]]> = [
        ['saveFile', 'saveFile'],
        ['saveAll', 'saveAll'],
        ['newFile', 'newFile'],
        ['openFolder', 'openFolder'],
        ['closeTab', 'closeTab'],
        ['find', 'find'],
        ['replace', 'replace'],
        ['toggleSidebar', 'toggleSidebar'],
        ['toggleTerminal', 'toggleTerminal', ['Ctrl+`']],
        ['toggleChat', 'toggleChat'],
        ['toggleProblems', 'toggleProblems'],
        ['toggleDebugPanel', 'toggleDebugPanel'],
        ['commandPalette', 'commandPalette'],
        ['quickOpen', 'quickOpen'],
        ['recentFiles', 'recentFiles'],
        ['zoomIn', 'zoomIn'],
        ['zoomOut', 'zoomOut'],
        ['newChatSession', 'newChatSession'],
        ['sendSelectionToAI', 'sendSelectionToAI'],
      ]
      for (const [action, command, extra] of actionCommands) {
        if (matches(action, extra)) {
          e.preventDefault()
          executeCommand(command)
          return
        }
      }

      // --- Fixed bindings (not part of the shortcut presets) ---
      if (matchesShortcut(e, 'Ctrl+Shift+X')) {
        e.preventDefault()
        executeCommand('openMcpCenter')
        return
      }

      if (matchesShortcut(e, 'Ctrl+\\')) {
        e.preventDefault()
        executeCommand('splitPanelHorizontal')
        return
      }

      if (matchesShortcut(e, 'Ctrl+Shift+\\')) {
        e.preventDefault()
        executeCommand('cyclePanelFocus')
        return
      }

      // --- Escape: close overlays ---
      if (e.key === 'Escape') {
        const ui = useUIStore.getState()
        if (ui.isCommandPaletteOpen) ui.closeCommandPalette()
        if (ui.isQuickOpenOpen) ui.closeQuickOpen()
        if (ui.contextMenu) ui.hideContextMenu()
        // Close the central diff view (file changes history → 查看变更)
        useEditorStore.getState().closeDiff()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, []) // No deps — reads live store state

  const effectiveSidebarWidth = isCompact ? Math.min(sidebarWidth, 200) : sidebarWidth

  // Resizable panel drag handler
  const handlePanelResize = useCallback((panel: 'sidebar' | 'chat', e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panel === 'sidebar'
      ? useUIStore.getState().sidebarWidth
      : useUIStore.getState().chatWidth

    const handleMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      if (panel === 'sidebar') {
        const newWidth = Math.max(150, Math.min(500, startWidth + delta))
        useUIStore.getState().setSidebarWidth(newWidth)
      } else {
        // Chat panel — allow much wider than before (up to ~75% of the window)
        const maxChatWidth = Math.max(560, Math.min(1100, Math.round(window.innerWidth * 0.75)))
        const newWidth = Math.max(250, Math.min(maxChatWidth, startWidth - delta))
        useUIStore.getState().setChatWidth(newWidth)
      }
    }
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [])

  return (
    <div className="h-full min-h-0 flex flex-col bg-nova-bg text-nova-text-primary overflow-hidden p-2 gap-2 isolate">
      <TitleBar />
      <div className="flex-1 h-full min-h-0 flex gap-2 overflow-hidden">
        <ActivityBar />
        <div className="relative flex-1 h-full min-h-0 overflow-hidden">
          {/* 常规工作区（侧栏 + 编辑器 + 聊天 + 终端）：始终挂载。
              办公室展示时仅 visibility:hidden，切回对话/编辑器是纯显示切换，
              不再整体重建（见 isOfficeShown 注释）。 */}
          <div className={`h-full min-h-0 flex gap-2 overflow-hidden ${isOfficeShown ? 'invisible' : ''}`}>
            {isSidebarVisible && !(isNarrow && isChatVisible) && (
              <div style={{ width: effectiveSidebarWidth }} className="shrink-0 relative">
                <div className="h-full rounded-xl overflow-hidden glass-chrome"><Sidebar /></div>
                <div
                  className="resizer absolute right-0 top-0 h-full z-10"
                  onMouseDown={(e) => handlePanelResize('sidebar', e)}
                />
              </div>
            )}
            <div className="flex-1 h-full min-h-0 flex flex-col gap-2 overflow-hidden">
              <div className={`flex-1 h-full min-h-0 flex ${isNarrow ? 'flex-col' : ''} overflow-hidden`}>
                {editorShown && (
                  <>
                    {/* glass-flat (no backdrop-filter) instead of glass-chrome: on
                        some Windows GPUs the OS cursor fails to composite over
                        backdrop-filter regions, leaving the pointer invisible over
                        the editor. The editor's content is opaque, so the blur
                        behind it was invisible anyway. */}
                    <div className={`flex-1 h-full min-w-0 min-h-0 overflow-hidden flex rounded-xl glass-flat ${splitDirection === 'horizontal' ? 'flex-row' : 'flex-col'}`}>
                      {panelOrder.map((pid, index) => (
                        <div key={pid} className="flex-1 h-full min-w-0 min-h-0 overflow-hidden flex flex-col" style={panelOrder.length > 1 && splitRatios[index - 1] ? { flex: `0 0 ${splitRatios[index - 1] * 100}%` } : undefined}>
                          <TabBar panelId={pid} />
                          <div className="flex-1 h-full min-h-0 flex flex-col"><EditorContainer panelId={pid} /></div>
                          {index < panelOrder.length - 1 && (
                            <div
                              className={`${splitDirection === 'horizontal' ? 'w-1 cursor-col-resize hover:bg-nova-accent/30' : 'h-1 cursor-row-resize hover:bg-nova-accent/30'} bg-nova-border shrink-0`}
                              onMouseDown={(e) => {
                                e.preventDefault()
                                const startPos = splitDirection === 'horizontal' ? e.clientX : e.clientY
                                const container = (e.target as HTMLElement).parentElement
                                if (!container) return
                                const startSize = splitDirection === 'horizontal' ? container.offsetWidth : container.offsetHeight
                                const handleMove = (ev: MouseEvent) => {
                                  const currentPos = splitDirection === 'horizontal' ? ev.clientX : ev.clientY
                                  const delta = currentPos - startPos
                                  const newSize = Math.max(200, startSize + delta)
                                  const parent = container.parentElement
                                  if (!parent) return
                                  const parentSize = splitDirection === 'horizontal' ? parent.offsetWidth : parent.offsetHeight
                                  const ratio = newSize / parentSize
                                  useEditorStore.getState().resizeSplit(index, Math.max(0.15, Math.min(0.85, ratio)))
                                }
                                const handleUp = () => {
                                  document.removeEventListener('mousemove', handleMove)
                                  document.removeEventListener('mouseup', handleUp)
                                  document.body.style.cursor = ''
                                  document.body.style.userSelect = ''
                                }
                                document.body.style.cursor = splitDirection === 'horizontal' ? 'col-resize' : 'row-resize'
                                document.body.style.userSelect = 'none'
                                document.addEventListener('mousemove', handleMove)
                                document.addEventListener('mouseup', handleUp)
                              }}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                    {isChatVisible && !isNarrow && (
                      <div
                        className="resizer"
                        onMouseDown={(e) => handlePanelResize('chat', e)}
                      />
                    )}
                  </>
                )}
                {isChatVisible && !IS_OFFICE && (
                  <div
                    style={isNarrow || !editorShown ? undefined : { width: Math.min(chatWidth, Math.max(360, windowWidth - 100)) + 'px' }}
                    className={`h-full rounded-xl overflow-hidden glass-chrome ${editorShown && !isNarrow ? 'shrink-0' : 'flex-1 min-w-0'} ${isNarrow ? 'flex-1 min-w-0' : ''}`}
                  ><ChatPanel /></div>
                )}
              </div>
              {isProblemsOpen && (
                <div className="shrink-0 rounded-xl overflow-hidden glass-chrome relative z-[6]" style={{ height: 160 }}><ProblemsPanel /></div>
              )}
              {isDebugOpen && (
                <div className="shrink-0 rounded-xl overflow-hidden glass-chrome relative z-[6]" style={{ height: 200 }}><DebugPanel /></div>
              )}
              {isTerminalVisible && (
                <div style={{ height: isCompact ? Math.min(terminalHeight, 180) : Math.min(terminalHeight, windowWidth < 800 ? 200 : 500) }} className="rounded-xl overflow-hidden glass-chrome shrink-0 relative z-[6]"><TerminalPanel rootPath={rootPath} /></div>
              )}
            </div>
          </div>

          {/* 「一人公司」整窗覆盖层：盖在工作区上方，工作区保持挂载 */}
          {isOfficeShown && (
            <div className="absolute inset-0 rounded-xl overflow-hidden glass-chrome z-10">
              <OfficeView />
            </div>
          )}
        </div>
      </div>
      <StatusBar />
      {isSettingsOpen && <SettingsModal />}
      {isCommandPaletteOpen && <CommandPalette />}
      {isQuickOpenOpen && rootPath && <QuickOpen rootPath={rootPath} />}
      {isRecentFilesOpen && <RecentFilesModal />}
      {contextMenu && <ContextMenu />}
      {isSkillRegistryOpen && <SkillRegistryModal />}
      {isMemoryManagerOpen && <MemoryModal onClose={closeMemoryManager} currentProjectPath={currentProjectPath} />}
      <NotificationToasts />
      <UnsavedDialog />
    </div>
  )
}
