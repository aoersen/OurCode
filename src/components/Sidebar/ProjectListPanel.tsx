import { useState, useMemo } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore, sessionLastUserActivity, isGhostSession } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import FileTree from './FileTree'
import { useI18n } from '@/i18n/useI18n'
import { useSessionMenu } from '@/components/ChatPanel/sessionMenu'
import { IS_OFFICE } from '@/utils/windowMode'

/** Project icon tiles — gradient backgrounds cycling per project (Stitch:
 *  brand blue-violet / sunset orange / green), each with a symbol. */
const PROJECT_TILES = [
  { bg: 'linear-gradient(135deg, #0ea5e9, #6366f1, #a855f7)', icon: 'bolt' },
  { bg: 'linear-gradient(135deg, #f97316, #fb7185)', icon: 'terminal' },
  { bg: 'linear-gradient(135deg, #10b981, #34d399)', icon: 'language' },
]

/** Material-symbol-like inline SVG icons used across the panel */
function TileIcon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    bolt: <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />,
    terminal: <path d="M4 6h16M4 6l5 5-5 5M9 16h11" strokeLinecap="round" strokeLinejoin="round" />,
    language: <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2c2.5 2.5 4 6.2 4 10s-1.5 7.5-4 10c-2.5-2.5-4-6.2-4-10s1.5-7.5 4-10z" />,
    chat: <path d="M4 5h16v11H8l-4 4V5z" strokeLinecap="round" strokeLinejoin="round" />,
    robot: <path d="M12 8V4M9 4h6M6 9h.01M18 9h.01M6 13h.01M18 13h.01M7 17c1 1 3 1.5 5 1.5s4-.5 5-1.5" strokeLinecap="round" strokeLinejoin="round" />,
    forum: <path d="M4 6h13v9H8l-4 3V6z" strokeLinecap="round" strokeLinejoin="round" />,
    pin: <path d="M16 3 21 8l-4.5 1.5L13 13l1.5 6.5L8 13l-4 4 3-8L3 8l6-4L12 8l1.5-4.5L16 3z" strokeLinecap="round" strokeLinejoin="round" />,
    expandMore: <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />,
    spinner: <path d="M12 3a9 9 0 1 1-9 9" strokeLinecap="round" />,
    search: <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3" strokeLinecap="round" strokeLinejoin="round" />,
    pending: <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />,
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

/** Simple time formatting */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays}天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

/** Leading status indicator for a session row (Stitch: spinner while running,
 *  primary dot when attention needed, red dot on error, slate dot otherwise). */
function SessionStatusDot({ running, needsAttention, hasError, color }: {
  running: boolean
  needsAttention: boolean
  hasError?: boolean
  color?: string
}) {
  if (running) {
    return (
      <span className="w-4 h-4 shrink-0 flex items-center justify-center text-primary animate-spin-slow" title="运行中">
        <TileIcon name="spinner" size={14} />
      </span>
    )
  }
  if (needsAttention) {
    return (
      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 ml-1" title="该会话需要处理" />
    )
  }
  if (hasError) {
    return <span className="w-1.5 h-1.5 rounded-full bg-error shrink-0 ml-1" title="运行出错" />
  }
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ml-1 ${color ? '' : 'bg-slate-300 dark:bg-white/30'}`}
      style={color ? { background: color } : undefined}
    />
  )
}

export default function ProjectListPanel() {
  // Individual uiStore selectors — the whole-store subscription re-rendered
  // the panel (and, via its child FileTree, the whole tree) on every uiStore
  // change, e.g. each notification or context-menu toggle.
  const setRootPath = useUIStore((s) => s.setRootPath)
  const recentProjects = useUIStore((s) => s.recentProjects)
  const recentProjectTimes = useUIStore((s) => s.recentProjectTimes)
  const removedProjects = useUIStore((s) => s.removedProjects)
  const projectListView = useUIStore((s) => s.projectListView)
  const activeProjectPath = useUIStore((s) => s.activeProjectPath)
  const rootPath = useUIStore((s) => s.rootPath)
  const enterProject = useUIStore((s) => s.enterProject)
  const backToProjectList = useUIStore((s) => s.backToProjectList)
  const setActiveSidebarTab = useUIStore((s) => s.setActiveSidebarTab)
  const projectOrder = useUIStore((s) => s.projectOrder)
  const reorderProjects = useUIStore((s) => s.reorderProjects)
  const removeProject = useUIStore((s) => s.removeProject)
  const showContextMenu = useUIStore((s) => s.showContextMenu)
  const requestProjectTrust = useUIStore((s) => s.requestProjectTrust)
  const revokeProjectTrust = useUIStore((s) => s.revokeProjectTrust)
  const rollActiveSessionAwayFrom = useChatStore((s) => s.rollActiveSessionAwayFrom)
  const sessions = useChatStore((s) => s.sessions)
  const runningSessionIds = useChatStore((s) => s.runningSessionIds)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const batchApproval = useChatStore((s) => s.batchApproval)
  const decisionBacklog = useChatStore((s) => s.decisionBacklog)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const createSession = useChatStore((s) => s.createSession)
  const t = useI18n()
  // Same per-session actions as the chat session sidebar (置顶 / 重命名 /
  // 导出 / 归档 / 删除) — conversations here must be deletable too.
  const { openSessionMenu } = useSessionMenu()

  const [searchQuery, setSearchQuery] = useState('')
  const [showMoreSessions, setShowMoreSessions] = useState<Set<string>>(new Set())
  // Bumped by the tree header's refresh button — FileTree reloads on change.
  const [refreshNonce, setRefreshNonce] = useState(0)

  // The "current project" follows the ACTIVE SESSION — opening a folder or
  // entering a project in the file tree only browses it, it doesn't select it.
  const currentProjectPath = useMemo(
    () => sessions.find((s) => s.id === activeSessionId)?.projectPath ?? null,
    [sessions, activeSessionId],
  )

  // Sessions waiting on the user (question / tool approval / batch approval /
  // plan approval) — shown as an accent "待处理" pill in the list (需求 3).
  // Parked decisions count too: that prompt has no dialog anywhere else until
  // the user opens the conversation that is waiting.
  const attentionSessionIds = useMemo(() => {
    const ids = new Set<string>()
    if (pendingQuestion?.sessionId) ids.add(pendingQuestion.sessionId)
    if (pendingApproval?.sessionId) ids.add(pendingApproval.sessionId)
    if (batchApproval?.sessionId) ids.add(batchApproval.sessionId)
    for (const parked of decisionBacklog) ids.add(parked.sessionId)
    for (const s of sessions) if (s.planStatus === 'pending_approval') ids.add(s.id)
    return ids
  }, [pendingQuestion, pendingApproval, batchApproval, decisionBacklog, sessions])

  // Sessions whose last agent run errored — red dot (design: 对话历史状态).
  const errorSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of sessions) if (s.agentRuns?.some((r) => r.status === 'error')) ids.add(s.id)
    return ids
  }, [sessions])

  // Collect unique projects from recentProjects + sessions' projectPath.
  // The order is STABLE: newly added projects land at the TOP (add order,
  // newest first), and re-opening an existing project never moves it — the
  // list only changes when a genuinely new project appears. Session-only
  // projects sort by when their first session was created. The user can pin
  // a custom order by dragging (projectOrder).
  const projects = useMemo(() => {
    const map = new Map<string, { name: string; path: string; lastOpened: number; sessionCount: number }>()

    // Recently opened projects keep their add-order (newest first) —
    // creating/updating/opening sessions never re-sorts the list.
    // lastOpened is the REAL open time recorded in setRootPath (recentProjectTimes);
    // installs that predate timestamps fall back to session activity below.
    recentProjects.forEach((rp) => {
      const name = rp.split(/[/\\]/).pop() || rp
      map.set(rp, { name, path: rp, lastOpened: recentProjectTimes[rp] || 0, sessionCount: 0 })
    })

    // Projects only known from chat sessions go after the recent ones, ordered
    // by when their FIRST session was created (newest first — never re-sorts
    // when a session is merely updated).
    const sessionOnly: Array<{ name: string; path: string; lastOpened: number; sessionCount: number; firstAdded: number }> = []
    const byPath = new Map<string, { name: string; path: string; lastOpened: number; sessionCount: number; firstAdded: number }>()

    for (const s of sessions) {
      // 从未用过的空会话不进入项目统计，也不会凭空"造"出只含空会话的项目。
      if (isGhostSession(s)) continue
      if (!s.projectPath) continue
      if (map.has(s.projectPath)) {
        const entry = map.get(s.projectPath)!
        entry.sessionCount++
        // Projects opened before open-times were recorded have lastOpened 0 —
        // use the latest session activity as the displayed time.
        if (entry.lastOpened === 0 && sessionLastUserActivity(s) > entry.lastOpened) entry.lastOpened = sessionLastUserActivity(s)
        continue
      }
      let entry = byPath.get(s.projectPath)
      if (!entry) {
        entry = {
          name: s.projectPath.split(/[/\\]/).pop() || s.projectPath,
          path: s.projectPath,
          lastOpened: 0,
          sessionCount: 0,
          firstAdded: Number.MAX_SAFE_INTEGER,
        }
        byPath.set(s.projectPath, entry)
        sessionOnly.push(entry)
      }
      entry.sessionCount++
      if (s.createdAt < entry.firstAdded) entry.firstAdded = s.createdAt
      if (sessionLastUserActivity(s) > entry.lastOpened) entry.lastOpened = sessionLastUserActivity(s)
    }
    sessionOnly.sort((a, b) => b.firstAdded - a.firstAdded)

    // Projects the user explicitly removed ("从列表中移除") stay hidden even
    // though their sessions are still bound to them — those sessions are not
    // orphans, they come back together with the project when it's re-opened.
    const removed = new Set(removedProjects)

    return [
      ...Array.from(map.entries()).map(([path, info]) => ({ ...info, path })),
      ...sessionOnly,
    ].filter((p) => !removed.has(p.path))
  }, [recentProjects, recentProjectTimes, sessions, removedProjects])

  // User-pinned order (drag). When set, the pinned order wins; projects that
  // are new to it (opened after the pin) go to the TOP — newly added projects
  // always land at the top of the list.
  const displayedProjects = useMemo(() => {
    if (!projectOrder || projectOrder.length === 0) return projects
    const byPath = new Map(projects.map((p) => [p.path, p]))
    const pinned = new Set(projectOrder)
    const ordered: typeof projects = []
    // Projects unknown to the pinned order first (newly opened)…
    for (const p of projects) if (!pinned.has(p.path)) { ordered.push(p); byPath.delete(p.path) }
    // …then the pinned order itself.
    for (const path of projectOrder) {
      const p = byPath.get(path)
      if (p) { ordered.push(p); byPath.delete(path) }
    }
    return ordered
  }, [projects, projectOrder])

  // Drag-to-reorder the project list (disabled while searching — the list is
  // filtered then, and dropping into a filtered view would be confusing).
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [overPath, setOverPath] = useState<string | null>(null)
  const handleProjectDrop = (toPath: string) => {
    const from = dragPath
    if (!from || from === toPath) return
    const paths = displayedProjects.map((p) => p.path)
    const fromIdx = paths.indexOf(from)
    const toIdx = paths.indexOf(toPath)
    if (fromIdx < 0 || toIdx < 0) return
    const next = [...paths]
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, from)
    reorderProjects(next)
    setDragPath(null)
    setOverPath(null)
  }

  // Filter by search
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return displayedProjects
    const q = searchQuery.toLowerCase()
    // Also check session titles
    return displayedProjects.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true
      if (p.path.toLowerCase().includes(q)) return true
      // Check session titles matching this project
      const projectSessions = sessions.filter((s) => s.projectPath === p.path)
      return projectSessions.some((s) => s.title.toLowerCase().includes(q))
    })
  }, [displayedProjects, searchQuery, sessions])

  // Sessions for a specific project path (limited to 5, expandable) — ghost
  // sessions (never used) are hidden until their first message arrives.
  const getProjectSessions = (projectPath: string) => {
    return sessions
      .filter((s) => s.projectPath === projectPath && !isGhostSession(s))
      // 按最近用户发消息时间排序（回退 updatedAt 兼容旧数据）——agent 运行
      // 中的工具/进度刷新只改 updatedAt，不会让会话位置一直跳动。
      .sort((a, b) => sessionLastUserActivity(b) - sessionLastUserActivity(a))
  }

  // Sessions created without a project binding (no folder was open at creation
  // time). They used to be invisible here — "conversations got lost" — so they
  // get their own group at the bottom of the list instead.
  const orphanSessions = useMemo(() => {
    let list = sessions.filter((s) => !s.projectPath && !isGhostSession(s))
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter((s) => s.title.toLowerCase().includes(q))
    }
    return list.sort((a, b) => sessionLastUserActivity(b) - sessionLastUserActivity(a))
  }, [sessions, searchQuery])

  const handleOpenFolder = async () => {
    const path = await window.electronAPI.openFolder()
    if (path) {
      setRootPath(path)
      enterProject(path)
    }
  }

  const handleEnterProject = (projectPath: string) => {
    setRootPath(projectPath)
    enterProject(projectPath)
  }

  /** Remove a project from the list, then roll the active conversation away
   *  from it: if the currently open chat was bound to the removed project, the
   *  selection moves to the most recently used conversation of another project
   *  (or the chat clears when no other project has conversations). The removed
   *  project's sessions stay stored and come back when it's re-opened. */
  const handleRemoveProject = (projectPath: string) => {
    removeProject(projectPath)
    rollActiveSessionAwayFrom(projectPath)
  }

  /** Project-card context menu (right-click or hover ⋯): open the project,
   *  start a chat in it, manage whether it is trusted, or remove it from the
   *  list. Removing only hides the project — its sessions stay bound and
   *  reappear when it's re-opened. */
  const handleProjectMenu = async (e: React.MouseEvent, projectPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    const x = e.clientX
    const y = e.clientY
    // Which trust action applies is main's answer, not a renderer-side guess.
    let trusted = true
    try {
      trusted = (await window.electronAPI.trustStatus(projectPath))?.trusted !== false
    } catch {
      /* bridge unavailable — offer the grant path, which is the safe default */
      trusted = false
    }
    showContextMenu(x, y, [
      { label: t('project.open'), icon: '📂', action: () => handleEnterProject(projectPath) },
      { label: t('chat.newChat'), icon: '💬', action: () => handleNewSessionForProject(projectPath) },
      { separator: true, label: '' },
      trusted
        ? { label: t('project.untrustWorkspace'), icon: '🛡️', action: () => void revokeProjectTrust(projectPath) }
        : { label: t('project.trustWorkspace'), icon: '🛡️', action: () => void requestProjectTrust(projectPath) },
      { separator: true, label: '' },
      { label: t('project.removeFromList'), icon: '🗑️', action: () => handleRemoveProject(projectPath) },
    ])
  }

  /** "新建对话" on a project list item: the new conversation is bound to that
   *  project and becomes active, the workspace syncs to it — but the sidebar
   *  STAYS on the project list (the conversation list must not vanish). */
  const handleNewSessionForProject = (projectPath: string) => {
    const configId = useConfigStore.getState().activeConfigGroupId
    if (!configId) {
      useUIStore.getState().openSettings()
      return
    }
    createSession(configId, projectPath)
    setRootPath(projectPath)
    if (!useUIStore.getState().isChatVisible) useUIStore.getState().toggleChat()
  }

  /** Tree-view header "new chat" — the conversation starts in the project the
   *  user is currently VIEWING (activeProjectPath), so it binds to that project
   *  (and, per the current-project-follows-the-session rule, becomes current). */
  const handleNewSession = () => {
    const configId = useConfigStore.getState().activeConfigGroupId
    if (configId) {
      createSession(configId, activeProjectPath || undefined)
    } else {
      useUIStore.getState().openSettings()
    }
  }

  const handleSessionClick = (sessionId: string) => {
    setActiveSession(sessionId)
    // Session rows stopPropagation on click, so the context menu's document
    // click-listener never fires — close an open menu explicitly.
    useUIStore.getState().hideContextMenu()
    // Switch to chat panel
    const ui = useUIStore.getState()
    if (!ui.isChatVisible) ui.toggleChat()
  }

  // ───────────── VIEW: Project-internal file tree ─────────────
  // 办公室窗口没有「对话面板」项目列表视图：只要有工作区根（rootPath）就直接
  // 进文件树，绝不误显示下方「任务面板」空壳（双击项目后侧栏必须稳定是文件树）；
  // 主窗口沿用列表/树视图切换。
  const treeRoot = projectListView === 'tree' && activeProjectPath
    ? activeProjectPath
    : IS_OFFICE
      ? rootPath
      : null
  if (treeRoot) {
    return (
      <div className="h-full flex flex-col">
        {/* Header — back + title + actions in one row (Stitch header pattern, dim off-white) */}
        <header className="px-5 pt-5 pb-4 border-b border-glass-border/50 shrink-0 bg-slate-100/90 dark:bg-white/10">
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                // 办公室窗口：没有「对话面板」项目列表 —— 返回即回到 3D 办公室视图。
                if (IS_OFFICE) {
                  useUIStore.getState().setActiveSidebarTab('office')
                } else {
                  backToProjectList()
                  setActiveSidebarTab('files')
                }
              }}
              className="flex items-center gap-1.5 text-base font-semibold text-nova-text-primary group transition-colors"
            >
              <svg
                width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className="text-nova-text-muted group-hover:text-nova-accent shrink-0"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
              {IS_OFFICE ? '一人公司' : '项目列表'}
            </button>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setRefreshNonce((n) => n + 1)}
                className="w-6 h-6 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
                title="刷新目录"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
              <button
                onClick={handleNewSession}
                className="w-6 h-6 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
                title={t('chat.newChat')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              <button
                onClick={() => useUIStore.getState().toggleSidebar()}
                className="w-6 h-6 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
                title={t('sidebar.collapse')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            </div>
          </div>
        </header>
        {/* File tree */}
        <div className="flex-1 overflow-hidden">
          <FileTree rootPath={treeRoot} refreshSignal={refreshNonce} />
        </div>
      </div>
    )
  }

  // ───────────── 办公室窗口：无活动项目（rootPath 为空）→ 项目打开引导 ─────────────
  // 一人公司窗口的项目文件树在办公室视图左侧栏内就地打开（双击项目卡片即展开），
  // 这里只是没有工作区根时的兜底引导页；有工作区根时上面的文件树视图接管。
  if (IS_OFFICE) {
    return (
      <div className="h-full flex flex-col">
        <header className="px-5 pt-5 pb-4 border-b border-glass-border/50 shrink-0 bg-slate-100/90 dark:bg-white/10">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-nova-text-primary">项目</h2>
            <button
              onClick={() => useUIStore.getState().toggleSidebar()}
              className="w-6 h-6 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
              title={t('sidebar.collapse')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-3 pb-6 bg-white/95 dark:bg-black/40">
          <button
            onClick={handleOpenFolder}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: '#0058bc' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
            打开项目
          </button>
          <p className="text-xs text-nova-text-muted leading-relaxed mt-3">
            在办公室视图左侧的「项目/任务」栏双击项目卡片，文件树会在办公室内就地打开。
          </p>
        </div>
      </div>
    )
  }

  // ───────────── VIEW: Project list ─────────────
  return (
    <div className="h-full flex flex-col">
      {/* Header — in-panel title + collapse in one row, glass search capsule below.
          Dim off-white surface so the bright scrollable well below reads as distinct. */}
      <header className="px-5 pt-5 pb-4 border-b border-glass-border/50 shrink-0 bg-slate-100/90 dark:bg-white/10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-nova-text-primary">项目列表</h2>
          <button
            onClick={() => useUIStore.getState().toggleSidebar()}
            className="w-6 h-6 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
            title={t('sidebar.collapse')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>
        <div className="rounded-full flex items-center px-4 py-2.5 bg-white/60 dark:bg-white/10 border border-glass-border transition-all duration-300 focus-within:border-accent-60 focus-within:ring-2 focus-within:ring-accent-20">
          <svg
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
            className="text-nova-text-muted mr-2 shrink-0"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索项目或对话..."
            className="bg-transparent border-none outline-none text-[11px] w-full text-nova-text-primary placeholder:text-slate-400 dark:placeholder:text-nova-text-muted"
          />
        </div>
      </header>

      {/* Project list — 12px gutters + 16px group gaps (Stitch: p-3 space-y-4 pb-6).
          Slightly tinted well so the scrollable region reads as distinct from the header. */}
      <div className="flex-1 overflow-y-auto p-3 pb-6 space-y-4 bg-white/95 dark:bg-black/40 shadow-inner">
        {filteredProjects.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-nova-text-muted opacity-40 mb-3">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
            <div className="text-nova-text-muted text-xs mb-3">还没有打开项目</div>
            <button
              onClick={handleOpenFolder}
              className="px-4 py-2 bg-nova-accent text-white rounded-full text-sm font-semibold hover:scale-[1.02] hover:brightness-110 transition-all shadow-sm"
            >
              打开文件夹
            </button>
          </div>
        )}

        {filteredProjects.map((project, idx) => {
          // Only a session makes a project "current" (currentProjectPath =
          // the active session's bound project) — the browsed folder does not.
          const isCurrent = !!currentProjectPath && currentProjectPath === project.path
          const projectSessions = getProjectSessions(project.path)
          const showMore = showMoreSessions.has(project.path)
          const visibleSessions = showMore ? projectSessions : projectSessions.slice(0, 5)
          const tile = PROJECT_TILES[idx % PROJECT_TILES.length]

          return (
            <div
              key={project.path}
              className={`space-y-1 ${overPath === project.path && dragPath && dragPath !== project.path ? 'rounded-[24px] ring-1 ring-accent-60' : ''}`}
              onDragOver={(e) => {
                // Only reorder on drag of a project card (dragPath set); the
                // session rows inside a project must not become drop targets.
                if (!dragPath || dragPath === project.path) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setOverPath(project.path)
              }}
              onDrop={(e) => {
                if (!dragPath || dragPath === project.path) return
                e.preventDefault()
                handleProjectDrop(project.path)
              }}
            >
              {/* Project card (Stitch: gradient tile + name + status badge) */}
              <div
                draggable={!searchQuery.trim()}
                onDragStart={(e) => {
                  if (searchQuery.trim()) return
                  setDragPath(project.path)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', project.path)
                }}
                onDragEnd={() => { setDragPath(null); setOverPath(null) }}
                onContextMenu={(e) => handleProjectMenu(e, project.path)}
                className={`group flex items-start gap-3 rounded-[24px] p-3 cursor-pointer transition-all border ${
                  dragPath === project.path
                    ? 'opacity-40'
                    : isCurrent
                      ? 'bg-accent-5 border-accent-40'
                      : 'border-transparent hover:bg-white/50 dark:hover:bg-white/10 hover:border-glass-border'
                }`}
                onDoubleClick={() => handleEnterProject(project.path)}
                title="双击打开项目"
              >
                <div
                  className="w-10 h-10 rounded-[16px] flex items-center justify-center text-white shrink-0 shadow-sm"
                  style={{ background: tile.bg }}
                >
                  <TileIcon name={tile.icon} size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[13px] font-semibold text-nova-text-primary truncate pr-2">
                      {project.name}
                    </span>
                    {isCurrent ? (
                      <span className="bg-nova-accent text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shrink-0">
                        当前
                      </span>
                    ) : (
                      project.lastOpened > 0 && (
                        <span className="bg-slate-200/50 text-slate-500 dark:bg-white/10 dark:text-nova-text-muted text-[9px] font-bold px-2 py-0.5 rounded-full tracking-wider shrink-0">
                          {formatTime(project.lastOpened)}
                        </span>
                      )
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-nova-text-muted truncate">
                    {project.path}
                  </div>
                </div>
                {/* 新建对话 — hover reveals */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleNewSessionForProject(project.path)
                  }}
                  // A double-click on the button would otherwise bubble a
                  // dblclick up to the card and open the project accidentally.
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="p-1 rounded-full text-nova-text-muted hover:text-nova-accent hover:bg-accent-10 transition-colors opacity-0 group-hover:opacity-100 shrink-0 self-center"
                  title={t('chat.newChat')}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                {/* Hover ⋯ — project menu (打开项目 / 新建对话 / 从列表中移除) */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleProjectMenu(e, project.path) }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="p-1 rounded-full text-slate-400 dark:text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors opacity-0 group-hover:opacity-100 shrink-0 self-center"
                  title={t('chat.moreActions')}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="12" cy="19" r="1.6" />
                  </svg>
                </button>
              </div>

              {/* Sessions under this project (Stitch: vertical connector line) */}
              {projectSessions.length > 0 && (
                <div className="pl-5 pr-2 pt-1 space-y-1 relative before:content-[''] before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-glass-border">
                  {visibleSessions.map((session) => {
                    const isActive = session.id === activeSessionId
                    return (
                      <div
                        key={session.id}
                        className={`group flex items-center gap-2 p-2 rounded-[16px] cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-white/40 dark:bg-white/10 border border-accent-20'
                            : 'hover:bg-white/40 dark:hover:bg-white/10'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleSessionClick(session.id)
                        }}
                        // A double-click must not bubble to the project card's
                        // dblclick (which opens the project) — same guard the
                        // card's own "新建对话" button uses.
                        onDoubleClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => openSessionMenu(e, session)}
                        title={`${session.title} · ${session.messages.length} 条消息`}
                      >
                        <SessionStatusDot
                          running={runningSessionIds.includes(session.id)}
                          needsAttention={attentionSessionIds.has(session.id)}
                          hasError={errorSessionIds.has(session.id)}
                        />
                        {session.pinnedAt && (
                          <span className="text-nova-accent shrink-0 flex">
                            <TileIcon name="pin" size={13} />
                          </span>
                        )}
                        <span className={`flex-1 truncate text-[11px] ${
                          isActive ? 'text-nova-accent font-medium' : 'text-nova-text-secondary group-hover:text-nova-text-primary'
                        }`}>
                          {session.title}
                        </span>
                        <span className={`text-[10px] font-mono shrink-0 ${isActive ? 'text-primary/70' : 'text-slate-400 dark:text-nova-text-muted'}`}>
                          {formatTime(sessionLastUserActivity(session))}
                        </span>
                        {/* Hover ⋯ — same session menu as the chat sidebar
                            (rename / export / archive / pin / delete) */}
                        <button
                          onClick={(e) => { e.stopPropagation(); openSessionMenu(e, session) }}
                          onDoubleClick={(e) => e.stopPropagation()}
                          className="p-1 rounded-full text-slate-400 dark:text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          title={t('chat.moreActions')}
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="1.6" />
                            <circle cx="12" cy="12" r="1.6" />
                            <circle cx="12" cy="19" r="1.6" />
                          </svg>
                        </button>
                      </div>
                    )
                  })}

                  {projectSessions.length > 5 && (
                    <button
                      className="flex items-center gap-1 pt-2 pl-14 text-[10px] text-nova-accent hover:text-accent-80 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        setShowMoreSessions((prev) => {
                          const next = new Set(prev)
                          if (next.has(project.path)) next.delete(project.path)
                          else next.add(project.path)
                          return next
                        })
                      }}
                    >
                      {showMore ? '收起' : `展开剩余 ${projectSessions.length - 5} 条`}
                      <span className={`transition-transform ${showMore ? 'rotate-180' : ''}`}>
                        <TileIcon name="expandMore" size={10} />
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* Sessions without a project binding — keep them visible so history
            never "disappears" from the left panel (Stitch: divider + section) */}
        {orphanSessions.length > 0 && (
          <>
            <div className="h-px bg-glass-border w-full my-4" />
            <div className="pt-1">
              <h3 className="text-[11px] font-bold text-slate-400 dark:text-nova-text-muted tracking-wider uppercase mb-3 px-3">
                {t('chat.orphanSessions')} ({orphanSessions.length})
              </h3>
              <div className="space-y-1 px-1">
                {orphanSessions.map((session) => {
                  const isActive = session.id === activeSessionId
                  return (
                    <div
                      key={session.id}
                      className={`group flex items-center gap-3 p-2.5 rounded-[24px] cursor-pointer transition-colors border ${
                        isActive
                          ? 'bg-white/40 dark:bg-white/10 border-accent-20'
                          : 'border-transparent hover:bg-white/50 dark:hover:bg-white/10 hover:border-glass-border'
                      }`}
                      onClick={() => handleSessionClick(session.id)}
                      onContextMenu={(e) => openSessionMenu(e, session)}
                      title={`${session.title} · ${session.messages.length} 条消息`}
                    >
                      <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-white/10 flex items-center justify-center text-nova-text-muted shrink-0">
                        <TileIcon name="forum" size={15} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-[11px] truncate ${isActive ? 'text-nova-accent font-medium' : 'text-nova-text-primary'}`}>
                          {session.title}
                        </div>
                        <div className="text-[10px] font-mono text-slate-400 dark:text-nova-text-muted mt-0.5">
                          {formatTime(sessionLastUserActivity(session))}
                        </div>
                      </div>
                      {session.pinnedAt && (
                        <span className="text-nova-accent shrink-0 flex">
                          <TileIcon name="pin" size={12} />
                        </span>
                      )}
                      {/* Hover ⋯ — same session menu as the chat sidebar
                          (rename / export / archive / pin / delete) */}
                      <button
                        onClick={(e) => { e.stopPropagation(); openSessionMenu(e, session) }}
                        className="p-1 rounded-full text-slate-400 dark:text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        title={t('chat.moreActions')}
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="12" cy="5" r="1.6" />
                          <circle cx="12" cy="12" r="1.6" />
                          <circle cx="12" cy="19" r="1.6" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
