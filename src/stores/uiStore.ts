import { create } from 'zustand'
import { IS_OFFICE, modeKey } from '@/utils/windowMode'

const DEFAULT_THEME_COLOR = '#0058bc'

/** localStorage key for the last-selected project (re-opened on next launch)。
 *  按窗口模式区分 —— 一人公司窗口的项目/工作区与对话窗口互不干扰。 */
const LAST_PROJECT_KEY = modeKey('lastProjectState')

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function applyThemeColor(color: string) {
  const root = document.documentElement
  root.style.setProperty('--primary-color', color)
  root.style.setProperty('--primary-color-10', hexToRgba(color, 0.1))
  root.style.setProperty('--primary-color-20', hexToRgba(color, 0.2))
  root.style.setProperty('--primary-color-30', hexToRgba(color, 0.3))
  root.style.setProperty('--accent', color)
  root.style.setProperty('--accent-purple', color)
}

/** Sidebar pages, keyed by the activity-bar icon. Owned as one type so the
 *  store, the bar and the panel switch cannot drift apart. */
export type SidebarTab =
  | 'files'
  | 'git'
  | 'changes'
  | 'agent'
  | 'usage'
  | 'skills'
  | 'mcp'
  | 'office'
  | 'browser'

interface UIState {
  // Sidebar
  isSidebarVisible: boolean
  sidebarWidth: number
  activeSidebarTab: SidebarTab
  rootPath: string | null
  recentProjects: string[]
  /** Last time each recent project was opened (ms epoch) — lets the project
   *  list show a real "last opened" time instead of a synthetic one. */
  recentProjectTimes: Record<string, number>
  /** Projects the user removed from the project list ("从列表中移除"). Their
   *  sessions stay bound to them, so without this flag the memo in
   *  ProjectListPanel would resurrect them as session-only entries; re-opening
   *  the project (setRootPath / enterProject) clears the flag and the project
   *  — with all its history — comes back. */
  removedProjects: string[]

  // Chat Panel
  isChatVisible: boolean
  chatWidth: number
  chatPosition: 'right' | 'bottom'
  /** Whether the chat panel's session list (history) is open — lifted here so
   *  the activity-bar "history" icon can open it across components */
  isChatSessionListOpen: boolean

  // Editor area (middle pane) — can be hidden so the chat panel fills the width
  isEditorVisible: boolean

  // Terminal
  isTerminalVisible: boolean
  terminalHeight: number

  // Settings
  isSettingsOpen: boolean

  // Command Palette
  isCommandPaletteOpen: boolean

  // Quick Open
  isQuickOpenOpen: boolean

  // Skill Registry
  isSkillRegistryOpen: boolean,
  /** Bumped by the skill manager whenever skills change (install/import/
   *  uninstall/toggle) — lets other surfaces (e.g. the sidebar skill panel)
   *  refresh even while they stay mounted behind the modal. */
  skillsRevision: number,

  // Memory manager
  isMemoryManagerOpen: boolean,

  // Window state
  isMaximized: boolean

  // Theme
  theme: 'light' | 'dark' | 'system'
  themeColor: string

  // Project navigation (sidebar: list ↔ file-tree)
  projectListView: 'list' | 'tree'
  activeProjectPath: string | null
  enterProject: (path: string) => void
  backToProjectList: () => void
  /** User-pinned order of the project list (null = default add-order). Set by
   *  drag-reordering the project list — the list never re-sorts on its own. */
  projectOrder: string[] | null
  reorderProjects: (orderedPaths: string[]) => void
  /** Re-select the last opened project after a restart (persisted via localStorage) */
  restoreLastProject: () => Promise<void>
  /** Ensure the app-owned default empty project exists and becomes the current
   *  workspace — used on first launch so the user can chat (agent mode) before
   *  opening any real folder. Idempotent. */
  ensureDefaultProject: () => Promise<void>

  // Context Menu
  contextMenu: { x: number; y: number; items: ContextMenuItem[] } | null

  // Notifications (transient toast stack — surfaced by NotificationToasts)
  notifications: AppNotification[]
  showNotification: (message: string, type?: AppNotification['type'], opts?: { position?: AppNotification['position']; sessionId?: string; duration?: number }) => void
  dismissNotification: (id: number) => void

  // Office（一人公司）——V12 信任闭环共享状态
  /** 工作台当前选中的角色（左栏任务行/工位点击驱动；null = 未选择）。 */
  officeSelectedRole: string | null
  setOfficeSelectedRole: (role: string | null) => void
  /** 待决中心待处理项数量（PendingCenterCard 同步；TopBar 铃铛徽章消费）。 */
  officePendingCount: number
  setOfficePendingCount: (count: number) => void
  /** 待决中心聚焦脉冲（TopBar 铃铛点击 +1；PendingCenterCard 侦听后滚动闪烁）。 */
  officePendingPulse: number
  pulseOfficePending: () => void

  // Actions
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setActiveSidebarTab: (tab: SidebarTab) => void
  setRootPath: (path: string | null) => void
  /** Set to the current workspace root when main refused to register it (the
   *  folder has never been trusted); null while the workspace is usable. */
  untrustedProjectPath: string | null
  /** Grant trust for a workspace — main opens the native confirmation, so the
   *  answer cannot come from this renderer. Resolves true when access is on. */
  requestProjectTrust: (path: string) => Promise<boolean>
  /** Withdraw trust: main forgets the grant, stops watching, drops the
   *  workspace's MCP servers, and the folder goes back to the untrusted state. */
  revokeProjectTrust: (path: string) => Promise<void>
  /** Remove a project from the list ("从列表中移除") — its sessions stay bound
   *  and reappear when the project is re-opened. Callers must ALSO roll the
   *  active conversation away from it (chatStore.rollActiveSessionAwayFrom) so
   *  the app doesn't keep "sitting in" the removed project. */
  removeProject: (path: string) => void

  toggleChat: () => void
  setChatWidth: (width: number) => void
  setChatPosition: (position: 'right' | 'bottom') => void
  setChatSessionListOpen: (open: boolean) => void
  toggleEditorVisible: () => void
  setEditorVisible: (visible: boolean) => void

  toggleTerminal: () => void
  setTerminalHeight: (height: number) => void

  openSettings: () => void
  closeSettings: () => void

  openCommandPalette: () => void
  closeCommandPalette: () => void

  openQuickOpen: () => void
  closeQuickOpen: () => void

  openMcpCenter: () => void

  openSkillRegistry: () => void
  closeSkillRegistry: () => void
  bumpSkillsRevision: () => void

  openMemoryManager: () => void
  closeMemoryManager: () => void

  setMaximized: (isMaximized: boolean) => void

  setTheme: (theme: 'light' | 'dark' | 'system') => void
  initTheme: (theme?: 'light' | 'dark' | 'system') => void
  setThemeColor: (color: string) => void

  showContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void
  hideContextMenu: () => void
}

export interface ContextMenuItem {
  label: string
  icon?: string
  shortcut?: string
  disabled?: boolean
  separator?: boolean
  action?: () => void
}

/** A transient toast notification (plugin api.ui.showNotification et al.). */
export interface AppNotification {
  id: number
  message: string
  type: 'info' | 'warning' | 'error' | 'success'
  /** Which corner the toast stacks in — session events use the bottom-right
   *  (requirement: task-done / needs-input popups), plugin calls stay top-right. */
  position?: 'top-right' | 'bottom-right'
  /** Session this notification refers to — clicking the toast jumps to it. */
  sessionId?: string
  /** Auto-dismiss delay in ms (defaults per position: 5s top / 8s bottom). */
  duration?: number
}

/** Monotonic id source for notifications (never reused within a session). */
let _nextNotificationId = 1

export const useUIStore = create<UIState>((set, get) => ({
  // Sidebar — starts hidden: on first launch no folder is open, so showing the
  // explorer panel would render a large empty area with nothing to fill it
  // (matches VS Code behavior when no folder/workspace is opened).
  isSidebarVisible: false,
  sidebarWidth: 330,
  activeSidebarTab: 'files',
  rootPath: null,
  untrustedProjectPath: null,
  recentProjects: (() => { try { return JSON.parse(localStorage.getItem(modeKey('recentProjects')) || '[]') } catch { return [] } })(),
  recentProjectTimes: (() => { try { return JSON.parse(localStorage.getItem(modeKey('recentProjectTimes')) || '{}') } catch { return {} } })(),
  removedProjects: (() => { try { return JSON.parse(localStorage.getItem(modeKey('removedProjects')) || '[]') } catch { return [] } })(),

  // Chat Panel — wider default since the AI panel is the primary interface
  isChatVisible: true,
  chatWidth: (() => {
    try {
      const saved = Number(localStorage.getItem(modeKey('chatWidth')))
      if (saved && saved >= 250) return saved
    } catch { /* ignore */ }
    return Math.max(480, typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.38) : 520)
  })(),
  chatPosition: 'right',
  isChatSessionListOpen: false,

  // Editor area — closable so the chat panel can take the whole width. Defaults
  // to HIDDEN: with no open tabs there is nothing to show (the chat panel fills
  // the window instead). It only becomes visible when a file is opened, or when
  // the last session's tabs are restored on launch (see editorStore).
  isEditorVisible: (() => {
    try { return localStorage.getItem(modeKey('isEditorVisible')) === 'true' } catch { return false }
  })(),

  // Terminal
  isTerminalVisible: false,
  terminalHeight: 250,

  // Settings
  isSettingsOpen: false,

  // Command Palette
  isCommandPaletteOpen: false,

  // Quick Open
  isQuickOpenOpen: false,

  // Skill Registry
  isSkillRegistryOpen: false,
  skillsRevision: 0,

  // Memory manager
  isMemoryManagerOpen: false,

  // Window state
  isMaximized: false,

  // Theme — light glassmorphism is the default design direction
  theme: 'light',
  themeColor: localStorage.getItem('themeColor') || DEFAULT_THEME_COLOR,

  // Project navigation
  projectListView: 'list',
  activeProjectPath: null,
  projectOrder: (() => { try { return JSON.parse(localStorage.getItem(modeKey('projectOrder')) || 'null') } catch { return null } })(),

  // Context Menu
  contextMenu: null,

  // Notifications
  notifications: [],

  // Office（一人公司）
  officeSelectedRole: null,
  officePendingCount: 0,
  officePendingPulse: 0,

  // Actions
  toggleSidebar: () => set((s) => ({ isSidebarVisible: !s.isSidebarVisible })),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setActiveSidebarTab: (tab) => set({ activeSidebarTab: tab }),
  setRootPath: (path) => {
    set({ rootPath: path })
    if (path) {
      // Register the workspace root in the main-process allowlist up front.
      // The file tree only mounts in tree view, so opening a project from the
      // list view (new session / saved session / settings picker) never mounts
      // it — without this, every fs:*/search:* call for the workspace would be
      // rejected with "路径不在允许范围内".
      //
      // Main now answers this call: false means the folder is not trusted, so
      // nothing under it is readable until the user grants trust (a native
      // dialog main itself raises). Only an explicit false counts — a stubbed
      // bridge answering nothing is not evidence of distrust.
      void Promise.resolve(window.electronAPI?.authorize?.(path))
        .then((ok) => {
          set((s) =>
            s.rootPath !== path
              ? {}
              : { untrustedProjectPath: ok === false ? path : null }
          )
        })
        .catch(() => { /* bridge failed — FileTree reports it on first read */ })
      set((s) => {
        // The project list keeps a STABLE order — a project is added once and
        // keeps its position (re-opening it never bumps it to the front). NEWLY
        // added projects land at the TOP (add order, newest first). The user
        // can pin a custom order via drag (projectOrder).
        const updated = s.recentProjects.includes(path)
          ? s.recentProjects
          : [path, ...s.recentProjects].slice(0, 20) // keep last 20
        localStorage.setItem(modeKey('recentProjects'), JSON.stringify(updated))
        // Record when this project was (re)opened so the list can show a real
        // "last opened" time.
        const times = { ...s.recentProjectTimes, [path]: Date.now() }
        localStorage.setItem(modeKey('recentProjectTimes'), JSON.stringify(times))
        // (Re)opening a previously removed project brings it — and the sessions
        // still bound to it — back into the project list.
        const removed = s.removedProjects.filter((p) => p !== path)
        if (removed.length !== s.removedProjects.length) {
          localStorage.setItem(modeKey('removedProjects'), JSON.stringify(removed))
        }
        return { recentProjects: updated, recentProjectTimes: times, removedProjects: removed }
      })
    }
  },
  requestProjectTrust: async (path) => {
    let granted = false
    try {
      granted = (await window.electronAPI?.trustRequest?.(path)) === true
    } catch {
      granted = false
    }
    if (granted) set({ untrustedProjectPath: null })
    return granted
  },

  revokeProjectTrust: async (path) => {
    try {
      await window.electronAPI?.trustRevoke?.(path)
    } catch {
      /* main already forgot it — the local state below is what matters */
    }
    // The current workspace just lost its access rights: say so, so the tree
    // stops looking like an empty project.
    set((s) => (s.rootPath === path ? { untrustedProjectPath: path } : {}))
  },

  removeProject: (path) => {
    set((s) => {
      const updated = s.recentProjects.filter((p) => p !== path)
      localStorage.setItem(modeKey('recentProjects'), JSON.stringify(updated))
      // Drop the recorded open-time too so a removed project never resurrects a stale date
      const times = { ...s.recentProjectTimes }
      delete times[path]
      localStorage.setItem(modeKey('recentProjectTimes'), JSON.stringify(times))
      // Drop from the user's drag-pinned order as well
      const order = s.projectOrder ? s.projectOrder.filter((p) => p !== path) : null
      if (order) localStorage.setItem(modeKey('projectOrder'), JSON.stringify(order))
      // Remember the removal — sessions still bound to the project must not
      // resurrect it in the list; re-opening it (setRootPath/enterProject)
      // clears the flag and the history comes back.
      const removed = s.removedProjects.includes(path)
        ? s.removedProjects
        : [...s.removedProjects, path]
      localStorage.setItem(modeKey('removedProjects'), JSON.stringify(removed))
      // If removing the current project, clear rootPath too
      const newRoot = s.rootPath === path ? null : s.rootPath
      return { recentProjects: updated, recentProjectTimes: times, projectOrder: order, removedProjects: removed, rootPath: newRoot }
    })
    // If the removed project was being viewed in the file-tree, exit back to
    // the project list (the tree view would otherwise show a removed folder).
    const st = get()
    if (st.projectListView === 'tree' && st.activeProjectPath === path) {
      st.backToProjectList()
    }
  },
  /** Persist the user's drag-pinned project order. The list never re-sorts on
   *  its own afterwards — only newly opened projects (unknown to the pinned
   *  order) land at the top. */
  reorderProjects: (orderedPaths) => {
    localStorage.setItem(modeKey('projectOrder'), JSON.stringify(orderedPaths))
    set({ projectOrder: orderedPaths })
  },

  toggleChat: () => set((s) => {
    // 办公室窗口没有右侧聊天面板（对话面板由办公室任务输入代替）——聊天开关
    // 直接失效，避免 Ctrl+L 之类的快捷键把聊天面板调出来。
    if (IS_OFFICE) return s
    // Don't allow hiding the last visible main-area panel — that would leave a
    // blank middle area with no obvious way back (same guard as closePanel).
    if (s.isChatVisible && !s.isEditorVisible) return s
    return { isChatVisible: !s.isChatVisible }
  }),
  setChatWidth: (width) => {
    localStorage.setItem(modeKey('chatWidth'), String(Math.round(width)))
    set({ chatWidth: width })
  },
  setChatPosition: (position) => set({ chatPosition: position }),
  setChatSessionListOpen: (open) => set({ isChatSessionListOpen: open }),
  toggleEditorVisible: () => set((s) => {
    // Don't allow hiding the last visible main-area panel (blank screen)
    if (s.isEditorVisible && !s.isChatVisible) return s
    const next = !s.isEditorVisible
    localStorage.setItem(modeKey('isEditorVisible'), String(next))
    return { isEditorVisible: next }
  }),
  setEditorVisible: (visible) => set((s) => {
    if (s.isEditorVisible === visible) return s
    localStorage.setItem(modeKey('isEditorVisible'), String(visible))
    return { isEditorVisible: visible }
  }),

  toggleTerminal: () => set((s) => ({ isTerminalVisible: !s.isTerminalVisible })),
  setTerminalHeight: (height) => set({ terminalHeight: height }),

  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),

  openCommandPalette: () => set({ isCommandPaletteOpen: true }),
  closeCommandPalette: () => set({ isCommandPaletteOpen: false }),

  openQuickOpen: () => set({ isQuickOpenOpen: true }),
  closeQuickOpen: () => set({ isQuickOpenOpen: false }),

  openMcpCenter: () => set({ isSidebarVisible: true, activeSidebarTab: 'mcp' }),

  openSkillRegistry: () => set({ isSkillRegistryOpen: true }),
  closeSkillRegistry: () => set({ isSkillRegistryOpen: false }),
  bumpSkillsRevision: () => set((s) => ({ skillsRevision: s.skillsRevision + 1 })),

  openMemoryManager: () => set({ isMemoryManagerOpen: true }),
  closeMemoryManager: () => set({ isMemoryManagerOpen: false }),

  setMaximized: (isMaximized) => set({ isMaximized }),

  setTheme: (theme) => {
    set({ theme })
    document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches))
  },

  initTheme: (theme?: 'light' | 'dark' | 'system') => {
    // Use the persisted preference when provided (called at startup with preferences.theme),
    // otherwise fall back to the in-memory value.
    const resolved = theme || get().theme
    const { themeColor } = get()
    document.documentElement.classList.toggle('dark', resolved === 'dark' || (resolved === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches))
    applyThemeColor(themeColor)
    // Keep the state in sync with the DOM: initTheme is the ONLY startup path,
    // and Monaco's theme (and the editor's cursor/caret colors) follow this
    // state. Without this a persisted dark preference left the workbench dark
    // while the editor stayed light (white) until the user re-picked a theme.
    if (resolved !== get().theme) set({ theme: resolved })
  },

  setThemeColor: (color) => {
    localStorage.setItem('themeColor', color)
    set({ themeColor: color })
    applyThemeColor(color)
  },

  enterProject: (path) => {
    set((s) => {
      // 打开项目 = 同时把它注册进「最近项目」列表（与 setRootPath 一致）。
      // 否则办公室左侧「项目/任务」栏看不到刚打开的项目——新项目的会话还是
      // 幽灵会话（未发过消息）时会被项目列表过滤掉，项目就“消失”了。
      const updated = s.recentProjects.includes(path)
        ? s.recentProjects
        : [path, ...s.recentProjects].slice(0, 20)
      const times = { ...s.recentProjectTimes, [path]: Date.now() }
      localStorage.setItem(modeKey('recentProjects'), JSON.stringify(updated))
      localStorage.setItem(modeKey('recentProjectTimes'), JSON.stringify(times))
      // Entering a removed project (e.g. from a session in the chat panel)
      // re-adds it to the list together with its history.
      const removed = s.removedProjects.filter((p) => p !== path)
      if (removed.length !== s.removedProjects.length) {
        localStorage.setItem(modeKey('removedProjects'), JSON.stringify(removed))
      }
      return {
        projectListView: 'tree',
        activeProjectPath: path,
        rootPath: path,
        recentProjects: updated,
        recentProjectTimes: times,
        removedProjects: removed,
      }
    })
    localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify({ path, view: 'tree' }))
    // Belt-and-suspenders for the allowlist (see setRootPath).
    window.electronAPI?.authorize?.(path)
  },
  backToProjectList: () => {
    set({ projectListView: 'list', activeProjectPath: null })
    // Going back to the list is an explicit deselection — don't re-open the
    // project on the next launch.
    localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify({ path: null, view: 'list' }))
  },
  restoreLastProject: async () => {
    let saved: { path?: string; view?: 'list' | 'tree' } | null = null
    try { saved = JSON.parse(localStorage.getItem(LAST_PROJECT_KEY) || 'null') } catch { /* ignore */ }
    const path = saved?.path
    if (!path) return
    // Only restore projects that were actually opened before (in recentProjects)
    const recent = get().recentProjects
    if (!recent.includes(path)) return
    // Verify the folder still exists on disk; otherwise fall back to the list.
    // The main process only serves fs: calls for paths the renderer authorized
    // (the allowlist is empty at startup), so authorize first — otherwise this
    // stat is rejected and the last project never restores.
    try {
      const ok = await window.electronAPI.authorize(path)
      if (ok === false) {
        // Restored from an earlier run but never trusted (or trust was
        // withdrawn) — don't open a workspace we can't read; the project list
        // offers the 信任 action instead.
        set({ untrustedProjectPath: path })
        return
      }
      const stat = await window.electronAPI.stat(path)
      if (!stat || !stat.isDirectory) return
    } catch {
      return
    }
    set({ projectListView: 'tree', activeProjectPath: path, rootPath: path })
  },

  ensureDefaultProject: async () => {
    // The main process creates the folder (idempotent) and returns its path.
    // setRootPath registers it in the project list + authorize allowlist, so
    // agent mode has a workspace to operate on right after launch.
    // 按窗口模式取独立默认项目：办公室窗口与对话窗口互不共用同一个默认项目。
    try {
      const path = await window.electronAPI?.ensureDefaultProject?.(IS_OFFICE ? 'office' : 'main')
      if (path) get().setRootPath(path)
    } catch { /* a default project is best-effort — never block startup */ }
  },

  showContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
  hideContextMenu: () => set({ contextMenu: null }),

  showNotification: (message, type = 'info', opts) => {
    const text = (message || '').trim()
    if (!text) return
    // Cap the visible stack at 5 — drop the oldest when exceeded.
    set((s) => ({
      notifications: [
        ...s.notifications,
        { id: _nextNotificationId++, message: text, type, ...(opts || {}) },
      ].slice(-5),
    }))
  },
  dismissNotification: (id) => set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),

  // Office（一人公司）——V12 信任闭环动作
  setOfficeSelectedRole: (role) => set({ officeSelectedRole: role }),
  setOfficePendingCount: (count) => set({ officePendingCount: count }),
  pulseOfficePending: () => set((s) => ({ officePendingPulse: s.officePendingPulse + 1 })),
}))
