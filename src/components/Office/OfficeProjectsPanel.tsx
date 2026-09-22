import { useMemo, useRef, useState } from 'react'
import { useChatStore, isGhostSession, sessionLastUserActivity } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { summarizeTask, roleLabel } from '@/services/office/mapping'
import { listPhaseCheckpoints, rollbackToPhase } from '@/services/targetMode/phaseCheckpoint'
import { MONO, GRADIENT, roleAvatar } from './officeTheme'
import FileTree from '../Sidebar/FileTree'
import { useThrottledValue } from '@/utils/useThrottledValue'
import { IS_OFFICE } from '@/utils/windowMode'
import type { ChatSession, SubAgentProgress } from '@shared/types'

/** 项目行前导图标：发丝线描边文件夹（Monolith 极简，替代原渐变瓷砖）。 */
function FolderIcon({ color = MONO.t3 }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" className="shrink-0">
      <path d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3L7 5h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
    </svg>
  )
}

/** 历史对话的紧凑相对时间：今天 HH:MM / 昨天 / N 天前 / M月D日。 */
function fmtRelative(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (dayDiff === 0) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (dayDiff === 1) return '昨天'
  if (dayDiff < 7) return `${dayDiff}天前`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

interface TaskItem {
  id: string // 父 run_subagent 的 toolCallId（subagentProgress 的键）
  p: SubAgentProgress
  session: ChatSession
}

/**
 * 「一人公司」左侧「项目/任务」栏（版本 K 落地）：
 * - 项目列表复用 agent 侧项目列表的归组逻辑（recentProjects + 会话 projectPath）。
 * - 每个项目下只列出该项目下**目标模式子任务**（subagentProgress，会话 targetMode 为真），
 *   不含 agent 侧任务（agentRuns），也不含历史会话分区——项目下的子项都是任务。
 * - 任务行带 K 版状态指示：运行中 = conic 彩虹环旋转；完成 = 绿勾；失败 = 红叉，
 *   行尾角色小头像 + 等宽状态词（RUNNING / DONE / FAILED）。
 * - **双击项目卡片 → 就在本栏内就地打开该项目的文件树**（不退出办公室、不跳工作区）；
 *   单击任务 → 切到对应对话。文件树里双击文件 → 进工作区编辑器编辑。
 */
export default function OfficeProjectsPanel() {
  const t = useI18n()
  const recentProjects = useUIStore((s) => s.recentProjects)
  const recentProjectTimes = useUIStore((s) => s.recentProjectTimes)
  const removedProjects = useUIStore((s) => s.removedProjects)
  const projectOrder = useUIStore((s) => s.projectOrder)
  const sessions = useChatStore((s) => s.sessions)
  // 任务行只需 ~1Hz 的进展刷新；进度表逐次推送换引用会让整棵项目树每秒重渲多次
  const subagentProgress = useThrottledValue(useChatStore((s) => s.subagentProgress), 800)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const rollActiveSessionAwayFrom = useChatStore((s) => s.rollActiveSessionAwayFrom)
  const removeProject = useUIStore((s) => s.removeProject)
  const showContextMenu = useUIStore((s) => s.showContextMenu)
  const currentProjectPath = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.projectPath ?? null)

  // 左侧栏内部视图：'projects'（项目/任务列表）| 'tree'（项目文件树，就地打开）。
  // 双击项目/打开项目都在本栏内切换，不退出办公室视图。
  const [view, setView] = useState<'projects' | 'tree'>('projects')
  const [treePath, setTreePath] = useState<string | null>(null)
  const [treeRefresh, setTreeRefresh] = useState(0)
  // 用户手动折叠的项目（任务不展开显示）
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set())

  // 任务行「单击 = 切到该任务会话 / 双击 = 打开项目」的区分计时器：
  // 单击延时 250ms 再切换，双击到达时取消切换并交给卡片打开项目——
  // 否则双击任务行会先 setActiveSession 切到长对话（重渲染卡顿），项目反而打不开。
  const taskClickTimer = useRef<number | null>(null)
  const cancelPendingTaskClick = () => {
    if (taskClickTimer.current != null) {
      window.clearTimeout(taskClickTimer.current)
      taskClickTimer.current = null
    }
  }

  // 项目归组（复制 agent 侧 ProjectListPanel 的稳定排序逻辑）
  const projects = useMemo(() => {
    const map = new Map<string, { name: string; path: string; lastOpened: number }>()
    recentProjects.forEach((rp) => {
      map.set(rp, { name: rp.split(/[/\\]/).pop() || rp, path: rp, lastOpened: recentProjectTimes[rp] || 0 })
    })
    const sessionOnly: Array<{ name: string; path: string; lastOpened: number; firstAdded: number }> = []
    const byPath = new Map<string, { name: string; path: string; lastOpened: number; firstAdded: number }>()
    for (const s of sessions) {
      if (isGhostSession(s)) continue
      if (!s.projectPath) continue
      if (map.has(s.projectPath)) {
        const entry = map.get(s.projectPath)!
        if (entry.lastOpened === 0 && sessionLastUserActivity(s) > entry.lastOpened) entry.lastOpened = sessionLastUserActivity(s)
        continue
      }
      let entry = byPath.get(s.projectPath)
      if (!entry) {
        entry = {
          name: s.projectPath.split(/[/\\]/).pop() || s.projectPath,
          path: s.projectPath,
          lastOpened: 0,
          firstAdded: Number.MAX_SAFE_INTEGER,
        }
        byPath.set(s.projectPath, entry)
        sessionOnly.push(entry)
      }
      if (s.createdAt < entry.firstAdded) entry.firstAdded = s.createdAt
      if (sessionLastUserActivity(s) > entry.lastOpened) entry.lastOpened = sessionLastUserActivity(s)
    }
    sessionOnly.sort((a, b) => b.firstAdded - a.firstAdded)
    const removed = new Set(removedProjects)
    return [
      ...Array.from(map.entries()).map(([path, info]) => ({ ...info, path })),
      ...sessionOnly,
    ].filter((p) => !removed.has(p.path))
  }, [recentProjects, recentProjectTimes, sessions, removedProjects])

  // 用户拖拽固定的顺序优先；新项目排最前
  const displayedProjects = useMemo(() => {
    if (!projectOrder || projectOrder.length === 0) return projects
    const byPath = new Map(projects.map((p) => [p.path, p]))
    const pinned = new Set(projectOrder)
    const ordered: typeof projects = []
    for (const p of projects) if (!pinned.has(p.path)) { ordered.push(p); byPath.delete(p.path) }
    for (const path of projectOrder) {
      const p = byPath.get(path)
      if (p) { ordered.push(p); byPath.delete(path) }
    }
    return ordered
  }, [projects, projectOrder])

  // 一人公司任务：目标模式会话的子 Agent 进度，按项目归组（运行中在前，按启动时间倒序）
  const tasksByProject = useMemo(() => {
    const map = new Map<string, TaskItem[]>()
    for (const [toolCallId, p] of Object.entries(subagentProgress)) {
      const session = sessions.find((s) => s.id === p.sessionId)
      if (!session?.targetMode) continue
      const key = session.projectPath || ''
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push({ id: toolCallId, p, session })
    }
    const rank = (s: SubAgentProgress['status']) => (s === 'running' ? 0 : s === 'done' ? 1 : 2)
    for (const arr of map.values()) {
      arr.sort((a, b) => (rank(a.p.status) - rank(b.p.status)) || (b.p.startedAt - a.p.startedAt))
    }
    return map
  }, [subagentProgress, sessions])

  // 历史对话：该项目下非 ghost 的 office 会话（按最近用户活跃降序）。任务区的
  // 条目是运行时子 Agent 进度（瞬态，重启即清空）；历史区是会话本体（SQLite 持久
  // 化），发布过的任务/对话在这里回看。正在任务区展示的会话不重复出现。
  const historyByProject = useMemo(() => {
    const activeSessionIds = new Set<string>()
    for (const arr of tasksByProject.values()) for (const { session } of arr) activeSessionIds.add(session.id)
    const map = new Map<string, ChatSession[]>()
    for (const s of sessions) {
      if (isGhostSession(s) || !s.projectPath) continue
      if (activeSessionIds.has(s.id)) continue
      const arr = map.get(s.projectPath)
      if (arr) arr.push(s)
      else map.set(s.projectPath, [s])
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => sessionLastUserActivity(b) - sessionLastUserActivity(a))
    }
    return map
  }, [sessions, tasksByProject])

  // 项目下历史对话默认展开条数；「展开更多对话」后显示全部
  const [showMoreSessions, setShowMoreSessions] = useState<Set<string>>(new Set())
  const HISTORY_VISIBLE_DEFAULT = 5

  const handleEnterProject = (path: string) => {
    const latest = sessions
      .filter((s) => s.projectPath === path && !isGhostSession(s))
      .sort((a, b) => sessionLastUserActivity(b) - sessionLastUserActivity(a))[0]
    if (latest) {
      useChatStore.getState().setActiveSession(latest.id)
    } else if (IS_OFFICE) {
      // 办公室窗口没有「对话面板」的新建会话入口——双击一个还没有会话的项目时
      // 自动创建一个，让目标模式输入框立即可用。
      const configId = useConfigStore.getState().activeConfigGroupId
      if (configId) useChatStore.getState().createSession(configId, path)
    }
    // 同步工作区根（会话已绑定 projectPath，这里让工作区/目标模式与项目一致），
    // 但**不退出办公室视图**——文件树就在本栏内就地打开。
    useUIStore.getState().enterProject(path)
    setTreePath(path)
    setView('tree')
  }

  const handleSelectTask = (sessionId: string) => {
    useChatStore.getState().setActiveSession(sessionId)
  }

  // V12 审查 #5：阶段级 checkpoint 回滚（SPEC 第十章）。查找该角色的最近一个
  // checkpoint tag → 确认 → git switch 新建分支（非破坏，原分支保留）。
  const doRollback = (label: string, session: ChatSession) => {
    const root = session.projectPath
    if (!root) return
    void (async () => {
      const tags = await listPhaseCheckpoints(root)
      const mine = tags.find((c) => c.label === label) ?? tags[0]
      if (!mine) {
        useUIStore.getState().showNotification(t('office.rbNone'), 'warning')
        return
      }
      const when = mine.createdAt ? `\n${mine.createdAt}` : ''
      if (!window.confirm(`${t('office.rbConfirm', { label: mine.label })}${when}\n\n${t('office.rbWarn')}`)) return
      const res = await rollbackToPhase(root, mine.tag)
      if (res.ok) {
        useUIStore.getState().showNotification(t('office.rbDone', { branch: res.branch ?? '' }), 'success')
      } else {
        useUIStore.getState().showNotification(res.error ?? t('office.rbFail'), 'error')
      }
    })()
  }

  // 办公室窗口没有左侧「对话面板」，项目需要从这里添加：选择任意文件夹作为
  // 项目，文件树同样在本栏内就地打开（不跳到工作区）。
  const handleOpenFolder = async () => {
    const path = await window.electronAPI.openFolder()
    if (!path) return
    useUIStore.getState().enterProject(path)
    // 新项目绑定一个 office 会话，方便立即启动目标模式（有会话时输入框才可见）。
    if (IS_OFFICE) {
      const configId = useConfigStore.getState().activeConfigGroupId
      if (configId && !useChatStore.getState().sessions.some((s) => s.projectPath === path)) {
        useChatStore.getState().createSession(configId, path)
      }
    }
    setTreePath(path)
    setView('tree')
  }

  // 办公室内文件树里点文件 = 打开编辑器编辑 → 进入工作区（文件树已在侧栏，编辑器立即可见）。
  const handleOpenFileFromTree = () => {
    useUIStore.getState().setActiveSidebarTab('files')
  }

  // 文件树头部「新建对话」：为当前项目建一个 office 会话，输入框立即可用。
  const handleNewSessionForTree = () => {
    if (!treePath) return
    const configId = useConfigStore.getState().activeConfigGroupId
    if (configId) useChatStore.getState().createSession(configId, treePath)
  }

  /** 「新建任务对话」：为项目创建一个 office 会话并立即激活（输入框可直接派活）。 */
  const handleNewSessionForProject = (projectPath: string) => {
    const configId = useConfigStore.getState().activeConfigGroupId
    if (configId) useChatStore.getState().createSession(configId, projectPath)
    else useUIStore.getState().openSettings()
  }

  /** 移除项目：只从办公室项目列表隐藏（会话仍绑定、重开项目即回来）；
   *  若当前激活会话正属于该项目，把激活会话让给最近活跃的其它会话。 */
  const handleRemoveProject = (projectPath: string) => {
    removeProject(projectPath)
    rollActiveSessionAwayFrom(projectPath)
    // 正在树视图里看这个项目的话，一并退回列表
    if (treePath === projectPath) {
      setTreePath(null)
      setView('projects')
    }
  }

  /** 项目行右键 / 悬停 ⋯ 菜单：打开项目 / 新建任务对话 / 从列表中移除。 */
  const handleProjectMenu = (e: React.MouseEvent, projectPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    showContextMenu(e.clientX, e.clientY, [
      { label: t('project.open'), icon: '📂', action: () => handleEnterProject(projectPath) },
      { label: t('office.newTaskChat'), icon: '💬', action: () => handleNewSessionForProject(projectPath) },
      { separator: true, label: '' },
      { label: t('project.removeFromList'), icon: '🗑️', action: () => handleRemoveProject(projectPath) },
    ])
  }

  /** 项目行展开/折叠任务列表（点击箭头，不触发行的双击打开）。 */
  const toggleCollapse = (e: React.MouseEvent, projectPath: string) => {
    e.stopPropagation()
    setCollapsedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(projectPath)) next.delete(projectPath)
      else next.add(projectPath)
      return next
    })
  }

  // ── 文件树视图：双击项目 / 打开项目后，就在本栏内就地展示项目文件树，
  //    不退出办公室视图、不跳到工作区的「任务面板」。点文件 = 进工作区编辑器编辑。
  if (view === 'tree' && treePath) {
    return (
      <aside
        data-testid="office-projects-panel"
        className="shrink-0 flex flex-col min-h-0"
        style={{
          width: 232,
          background: MONO.bg,
          borderRight: `1px solid ${MONO.hairline}`,
        }}
      >
        <div className="p-2 border-b shrink-0 flex items-center justify-between" style={{ borderColor: MONO.hairline }}>
          <div className="flex items-center gap-1 min-w-0">
            <button
              onClick={() => setView('projects')}
              title={t('office.backToProjects')}
              className="flex items-center justify-center w-6 h-6 rounded-md shrink-0 transition-colors hover:bg-[#F4F4F5]"
              style={{ color: MONO.t2, background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <span className="text-xs font-medium truncate min-w-0" style={{ color: MONO.t1 }} title={treePath}>
              {treePath.split(/[/\\]/).pop() || treePath}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setTreeRefresh((n) => n + 1)}
              title={t('office.refreshTree')}
              className="flex items-center justify-center w-6 h-6 rounded-md transition-colors hover:bg-[#F4F4F5]"
              style={{ color: MONO.t2, background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            <button
              onClick={handleNewSessionForTree}
              title={t('office.newTaskChat')}
              className="flex items-center justify-center w-6 h-6 rounded-md transition-colors hover:bg-[#F4F4F5]"
              style={{ color: MONO.t2, background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden min-h-0">
          <FileTree rootPath={treePath} refreshSignal={treeRefresh} onOpenFile={handleOpenFileFromTree} />
        </div>
      </aside>
    )
  }

  return (
    <aside
      data-testid="office-projects-panel"
      className="shrink-0 flex flex-col overflow-y-auto"
      style={{
        width: 232,
        background: MONO.bg,
        borderRight: `1px solid ${MONO.hairline}`,
      }}
    >
      {/* PROJECTS 分区头（label-caps）+ K 版渐变「打开项目」按钮 */}
      <div className="p-3 pb-2.5 border-b shrink-0 flex flex-col gap-2" style={{ borderColor: MONO.hairline }}>
        <div className="flex items-center justify-between gap-2">
          <span
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
              fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', color: MONO.t3,
            }}
          >
            {t('office.projectsPanelTitle').toUpperCase()}
            <span className="ml-1.5">{displayedProjects.length}</span>
          </span>
          <button
            onClick={handleOpenFolder}
            title={t('office.openProject')}
            className="w-5 h-5 flex items-center justify-center rounded transition-colors hover:bg-[#F4F4F5]"
            style={{ color: MONO.t2, background: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <button
          onClick={handleOpenFolder}
          className="w-full flex items-center justify-center gap-1.5 rounded-md transition-opacity hover:opacity-90"
          style={{
            padding: '7px 12px', fontSize: 12, fontWeight: 500, color: '#fff',
            background: 'linear-gradient(90deg, #0058BC, #3B82F6)',
            boxShadow: '0 1px 2px rgba(0,88,188,0.25)', border: 'none', cursor: 'pointer',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          {t('office.openProject')}
        </button>
      </div>

      <div className="flex-1 pt-1 pb-3 flex flex-col">
        {displayedProjects.length === 0 && (
          <div className="text-xs text-center py-8" style={{ color: MONO.t3 }}>{t('office.noProjects')}</div>
        )}
        {displayedProjects.map((project) => {
          const isCurrent = currentProjectPath === project.path
          const tasks = tasksByProject.get(project.path) || []
          const history = historyByProject.get(project.path) || []
          // 项目有子内容（运行时任务或历史对话）才显示展开箭头
          const hasChildren = tasks.length > 0 || history.length > 0
          const collapsed = collapsedPaths.has(project.path)
          const runningCount = tasks.filter(({ p }) => p.status === 'running').length
          const doneCount = tasks.filter(({ p }) => p.status === 'done').length
          const countColor = runningCount > 0 ? '#0058BC' : doneCount === tasks.length ? '#16A34A' : MONO.t3
          return (
            <div
              key={project.path}
              className="group"
              onDoubleClick={() => {
                // 双击 = 打开项目。先取消挂起的任务行单击切换（否则双击任务行会先
                // 切到长对话再开项目，中间那次重渲染就是「巨卡」的来源）。
                cancelPendingTaskClick()
                handleEnterProject(project.path)
              }}
              onContextMenu={(e) => handleProjectMenu(e, project.path)}
              title={`${project.path} · ${t('office.doubleClickHint')}`}
            >
              {/* 项目行：折叠箭头 + 文件夹 + 名称 + 任务计数 + 悬停操作（新建任务对话 / ⋯）
                  右键 = 项目菜单（打开项目 / 新建任务对话 / 从列表中移除） */}
              <div
                className="flex items-center gap-1 cursor-pointer select-none transition-colors"
                style={{
                  padding: '7px 10px',
                  background: isCurrent ? MONO.hover : 'transparent',
                  borderLeft: `2px solid ${isCurrent ? MONO.ink : 'transparent'}`,
                }}
              >
                {/* 折叠/展开任务列表 */}
                <button
                  onClick={(e) => toggleCollapse(e, project.path)}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={collapsed ? t('office.expandProject') : t('office.collapseProject')}
                  className="shrink-0 flex items-center justify-center rounded transition-colors hover:bg-black/5"
                  style={{ width: 16, height: 16, color: MONO.t3, background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  <svg
                    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .15s' }}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                <span className="shrink-0 flex" style={{ color: isCurrent ? '#0058BC' : MONO.t3 }}>
                  <FolderIcon color={isCurrent ? '#0058BC' : MONO.t3} />
                </span>
                <span
                  className="truncate flex-1 min-w-0"
                  style={{ fontSize: 13, fontWeight: isCurrent ? 500 : 400, color: isCurrent ? MONO.t1 : MONO.t2 }}
                >
                  {project.name}
                </span>
                {tasks.length > 0 && (
                  <span
                    className="shrink-0 flex items-center gap-1"
                    style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", fontSize: 9.5, color: countColor }}
                    title={`${tasks.length} ${t('office.taskCount')}`}
                  >
                    {runningCount > 0 && (
                      <span className="inline-block rounded-full animate-pulse" style={{ width: 5, height: 5, background: '#0058BC' }} />
                    )}
                    {tasks.length}
                  </span>
                )}
                {/* 悬停：新建任务对话 */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleNewSessionForProject(project.path) }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={t('office.newTaskChat')}
                  className="shrink-0 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[#F4F4F5]"
                  style={{ width: 18, height: 18, color: MONO.t2, background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                {/* 悬停：⋯ 项目菜单 */}
                <button
                  onClick={(e) => handleProjectMenu(e, project.path)}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={t('chat.moreActions')}
                  className="shrink-0 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[#F4F4F5]"
                  style={{ width: 18, height: 18, color: MONO.t2, background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="12" cy="19" r="1.8" />
                  </svg>
                </button>
              </div>

              {/* 项目子内容：活动任务（运行时子 Agent 进度） + 历史对话（持久化会话） */}
              {hasChildren && !collapsed && (
                <div className="ml-5 pl-2 flex flex-col pb-1" style={{ borderLeft: `1px solid ${MONO.hairline}` }}>
                  {/* ── 活动任务 ── */}
                  {tasks.length > 0 && (
                    <>
                      <div className="flex items-center gap-1.5 pt-1.5 pb-0.5 px-1">
                        <span
                          style={{
                            fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
                            fontSize: 9.5, fontWeight: 500, letterSpacing: '0.08em', color: MONO.t3,
                          }}
                        >
                          {t('office.tasksSection').toUpperCase()}
                        </span>
                        <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", fontSize: 9, color: MONO.t3 }}>
                          {tasks.length}
                        </span>
                      </div>
                      {tasks.map(({ id, p, session }) => {
                    const label = roleLabel(p.task, p.name)
                    const avatar = roleAvatar(label)
                    const running = p.status === 'running'
                    const done = p.status === 'done'
                    // V12 5 态收敛：等待输入（该会话有挂起的询问）琥珀 ⏸
                    const waiting = running && pendingQuestion?.sessionId === session.id
                    const statusText = waiting ? 'WAITING' : running ? 'RUNNING' : done ? 'DONE' : 'FAILED'
                    const statusColor = waiting ? '#D97706' : running ? '#0058BC' : done ? '#16A34A' : '#DC2626'
                    return (
                      <button
                        key={id}
                        onClick={() => {
                          // V12：点任务行 → 工作台切到该角色（立即生效，不等会话切换）
                          useUIStore.getState().setOfficeSelectedRole(label)
                          // 单击 = 切到该任务会话（延时 250ms 区分双击）；
                          // 双击由卡片 onDoubleClick 取消本次切换并打开项目。
                          if (taskClickTimer.current != null) window.clearTimeout(taskClickTimer.current)
                          taskClickTimer.current = window.setTimeout(() => {
                            taskClickTimer.current = null
                            handleSelectTask(session.id)
                          }, 250)
                        }}
                        title={`${session.title || t('chat.untitled')} · ${summarizeTask(p.task, 120)}`}
                        className="w-full flex items-start gap-2 py-1.5 px-1 text-left transition-colors hover:bg-[#F4F4F5]"
                      >
                        {/* K 版状态指示：运行中 = conic 彩虹环旋转 / 等待输入 = 琥珀半环 / 完成 = 绿勾 / 失败 = 红叉 */}
                        {waiting ? (
                          <span
                            className="shrink-0 rounded-full flex items-center justify-center"
                            style={{
                              width: 15, height: 15, marginTop: 4,
                              border: '1.5px solid #D97706', color: '#D97706', fontSize: 9, fontWeight: 700,
                              background: 'rgba(217,119,6,0.1)',
                            }}
                          >
                            ⏸
                          </span>
                        ) : running ? (
                          <span
                            className="shrink-0 rounded-full animate-spin"
                            style={{ width: 15, height: 15, padding: 2, marginTop: 4, background: GRADIENT.rainbow, animationDuration: '2s' }}
                          >
                            <span className="block w-full h-full rounded-full" style={{ background: '#fff' }} />
                          </span>
                        ) : done ? (
                          <span
                            className="shrink-0 rounded-full flex items-center justify-center"
                            style={{
                              width: 15, height: 15, marginTop: 4,
                              border: '1.5px solid #16A34A', color: '#16A34A', fontSize: 9, fontWeight: 700,
                              background: 'rgba(22,163,74,0.08)',
                            }}
                          >
                            ✓
                          </span>
                        ) : (
                          <span
                            className="shrink-0 rounded-full flex items-center justify-center"
                            style={{
                              width: 15, height: 15, marginTop: 4,
                              border: '1.5px solid #DC2626', color: '#DC2626', fontSize: 9, fontWeight: 700,
                              background: 'rgba(220,38,38,0.06)',
                            }}
                          >
                            ✕
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span
                              className="truncate font-medium"
                              style={{
                                fontSize: 11.5,
                                color: running ? '#0058BC' : MONO.t1,
                                textDecoration: done ? 'line-through' : undefined,
                                opacity: done ? 0.55 : 1,
                              }}
                            >
                              {label}
                            </span>
                            <span
                              className="shrink-0 uppercase"
                              style={{
                                fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
                                fontSize: 9, letterSpacing: '0.05em', color: statusColor,
                              }}
                            >
                              {statusText}
                            </span>
                            {/* V12 审查 #5：已完成任务行 → 回滚到此 checkpoint */}
                            {done && (
                              <span
                                role="button"
                                title={t('office.rbTitle')}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  doRollback(label, session)
                                }}
                                className="shrink-0 transition-colors rounded"
                                style={{ fontSize: 12, color: MONO.t3, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                              >
                                ↺
                              </span>
                            )}
                          </span>
                          <span className="flex items-center gap-1.5 mt-0.5 min-w-0">
                            {/* 角色小头像（渐变底 + 首字） */}
                            <span
                              className="shrink-0 rounded-full flex items-center justify-center"
                              style={{
                                width: 13, height: 13,
                                background: avatar.bg, color: '#fff', fontSize: 8, fontWeight: 700,
                              }}
                            >
                              {avatar.char}
                            </span>
                            <span className="block truncate" style={{ fontSize: 10, color: MONO.t3 }}>
                              {summarizeTask(p.task, 34)}
                            </span>
                          </span>
                        </span>
                      </button>
                    )
                  })}
                    </>
                  )}

                  {/* ── 历史对话（该项目的持久化会话；重启后任务区清空，这里回看） ── */}
                  {history.length > 0 && (
                    <>
                      <div className="flex items-center gap-1.5 pt-1.5 pb-0.5 px-1">
                        <span
                          style={{
                            fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
                            fontSize: 9.5, fontWeight: 500, letterSpacing: '0.08em', color: MONO.t3,
                          }}
                        >
                          {t('office.historySection').toUpperCase()}
                        </span>
                        <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", fontSize: 9, color: MONO.t3 }}>
                          {history.length}
                        </span>
                      </div>
                      {history
                        .slice(0, showMoreSessions.has(project.path) ? undefined : HISTORY_VISIBLE_DEFAULT)
                        .map((s) => (
                          <button
                            key={s.id}
                            onClick={() => {
                              // 单击 = 切到该历史会话（延时 250ms 区分双击，与任务行同机制）
                              if (taskClickTimer.current != null) window.clearTimeout(taskClickTimer.current)
                              taskClickTimer.current = window.setTimeout(() => {
                                taskClickTimer.current = null
                                handleSelectTask(s.id)
                              }, 250)
                            }}
                            title={`${s.title || t('chat.untitled')} · ${s.messages.length} ${t('office.messagesCount')}`}
                            className="w-full flex items-center gap-2 py-1.5 px-1 text-left transition-colors hover:bg-[#F4F4F5]"
                          >
                            <span className="shrink-0 flex" style={{ color: MONO.t3 }}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                              </svg>
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate" style={{ fontSize: 11.5, color: MONO.t1 }}>
                                {s.title || t('chat.untitled')}
                              </span>
                              <span className="block truncate" style={{ fontSize: 10, color: MONO.t3 }}>
                                {fmtRelative(sessionLastUserActivity(s))} · {s.messages.length} {t('office.messagesCount')}
                              </span>
                            </span>
                          </button>
                        ))}
                      {history.length > HISTORY_VISIBLE_DEFAULT && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setShowMoreSessions((prev) => {
                              const next = new Set(prev)
                              if (next.has(project.path)) next.delete(project.path)
                              else next.add(project.path)
                              return next
                            })
                          }}
                          className="flex items-center gap-1 pt-1.5 pl-1 pb-0.5 transition-colors hover:text-[#111827]"
                          style={{ fontSize: 10, color: MONO.t3, background: 'transparent', border: 'none', cursor: 'pointer' }}
                        >
                          {showMoreSessions.has(project.path)
                            ? t('office.collapseSessions')
                            : t('office.showMoreSessions', { count: history.length - HISTORY_VISIBLE_DEFAULT })}
                          <svg
                            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                            style={{ transform: showMoreSessions.has(project.path) ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
