import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ConfirmDialog from '@/components/Common/ConfirmDialog'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore, type ContextMenuItem } from '@/stores/uiStore'
import CollapsedRail, { type CollapsedRailIntent } from './rail/CollapsedRail'
import FileTreeRail from './rail/FileTreeRail'
import ProjectRow from './rail/ProjectRow'
import SessionRow from './rail/SessionRow'
import { PlusIcon, SearchIcon } from './rail/railIcons'
import {
  readRailMode,
  readRailStateFilter,
  writeRailMode,
  writeRailStateFilter,
  type RailMode,
  type RailStateFilterId,
} from './rail/railMode'
import {
  RAIL_STATE_FILTERS,
  attentionSessionIds,
  buildRailGroups,
  countStates,
  railSignature,
  type RailGroup,
  type RailSessionRow,
} from './rail/railModel'
import { useRailMenu } from './rail/useRailMenu'

function WaveMark({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2 14c2.5 0 3.5-6 6-6s3.5 6 6 6 3.5-6 6-6" />
      <path d="M2 19c2.5 0 3.5-3 6-3s3.5 3 6 3 3.5-3 6-3" opacity="0.45" />
    </svg>
  )
}

/**
 * 会话栏（项目树）：项目 → 对话两级，而不是按时间平铺。
 *
 * 设计契约（`.stitch/designs`「项目树」一节的实现落点）：
 *  - 项目行 = 文件夹图标 + 14px 名称 + 灰色对话数 + 折叠 chevron；
 *  - 对话行 = 缩进 20px、13px、单行；激活 = 浅灰填充；运行中 6px 点；等用户处理 = 红点（无文字）；
 *  - 「新对话」行与项目行同一套缩进；
 *  - 行内没有时间戳，也没有别的装饰。
 *
 * 性能：整栏只订阅一份「展示签名」（railSignature），流式 token / 队列 / trace
 * 这类不改展示字段的 store 通知不会让它重渲染（见 railSignature 的注释）。
 */
export default function SessionRail() {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const filesHostRef = useRef<HTMLDivElement>(null)
  const [focusAfterExpand, setFocusAfterExpand] = useState<'search' | 'sessions' | 'files' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RailSessionRow | null>(null)
  const [trustingPath, setTrustingPath] = useState<string | null>(null)
  /** 会话 / 文件（左上角两项纯文字切换）；按窗口持久化，默认会话。 */
  const [railMode, setRailModeState] = useState<RailMode>(readRailMode)

  const setRailMode = useCallback((next: RailMode) => {
    writeRailMode(next)
    setRailModeState(next)
  }, [])

  /** 状态筛选（全部 / 进行中 / 异常 / 结束）—— 按窗口记住。 */
  const [stateFilter, setStateFilterState] = useState<RailStateFilterId>(readRailStateFilter)
  const setStateFilter = useCallback((next: RailStateFilterId) => {
    writeRailStateFilter(next)
    setStateFilterState(next)
  }, [])

  // 展示签名（不是 sessions 本身 —— 原因见 railSignature）
  const sig = useChatStore((s) => railSignature(s.sessions))
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const runningSessionIds = useChatStore((s) => s.runningSessionIds)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const batchApproval = useChatStore((s) => s.batchApproval)
  const decisionBacklog = useChatStore((s) => s.decisionBacklog)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const createSession = useChatStore((s) => s.createSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)

  const configGroupId = useConfigStore((s) => s.activeConfigGroupId)

  const rootPath = useUIStore((s) => s.rootPath)
  const activeProjectPath = useUIStore((s) => s.activeProjectPath)
  const recentProjects = useUIStore((s) => s.recentProjects)
  const projectOrder = useUIStore((s) => s.projectOrder)
  const removedProjects = useUIStore((s) => s.removedProjects)
  const untrustedProjectPath = useUIStore((s) => s.untrustedProjectPath)
  const requestProjectTrust = useUIStore((s) => s.requestProjectTrust)
  const collapsedProjects = useUIStore((s) => s.collapsedProjects)
  const toggleProjectCollapsed = useUIStore((s) => s.toggleProjectCollapsed)
  const isRailCollapsed = useUIStore((s) => s.isRailCollapsed)
  const setRailCollapsed = useUIStore((s) => s.setRailCollapsed)
  const openSettings = useUIStore((s) => s.openSettings)
  const setOfficeSurfaceOpen = useUIStore((s) => s.setOfficeSurfaceOpen)
  const showNotification = useUIStore((s) => s.showNotification)
  const showContextMenu = useUIStore((s) => s.showContextMenu)
  const enterProject = useUIStore((s) => s.enterProject)
  const removeProject = useUIStore((s) => s.removeProject)

  /** 等用户处理的会话（红点）—— 只认设计稿列的四个来源。 */
  const attention = useMemo(
    () =>
      attentionSessionIds({
        questionSessionId: pendingQuestion?.sessionId,
        approvalSessionId: pendingApproval?.sessionId,
        batchSessionId: batchApproval?.sessionId,
        backlog: decisionBacklog,
      }),
    [pendingQuestion?.sessionId, pendingApproval?.sessionId, batchApproval?.sessionId, decisionBacklog],
  )

  const { groups, totals } = useMemo(() => {
    // 依赖签名而不是 sessions 引用：签名没变就说明「这一栏画出来一模一样」，
    // 不必因为别处的一个流式 chunk 重排整棵树。
    void sig
    const sessions = useChatStore.getState().sessions
    const base = {
      sessions,
      activeSessionId,
      query,
      runningSessionIds,
      attentionIds: attention,
      recentProjects,
      projectOrder,
      removedProjects,
      currentPath: rootPath,
    }
    // 全量（用于筛选行上的计数与项目行摘要），再按当前筛选裁一次
    const all = buildRailGroups({ ...base, stateFilter: 'all' })
    const totals = countStates(all.flatMap((group) => group.sessions))
    const filtered =
      stateFilter === 'all' ? all : buildRailGroups({ ...base, stateFilter })
    return { groups: filtered, totals }
  }, [
    sig,
    query,
    activeSessionId,
    runningSessionIds,
    attention,
    recentProjects,
    projectOrder,
    removedProjects,
    rootPath,
    stateFilter,
  ])

  /** 新建对话：绑定「当前项目」（显式传下去，别让 createSession 自己去猜）。 */
  const handleNewSession = useCallback(() => {
    if (!configGroupId) {
      openSettings()
      return
    }
    // createSession(configGroupId, projectPath) 的解析顺序是
    //   显式参数 → 当前激活会话的项目 → 文件树根 → uiStore.rootPath。
    // 会话栏里的「当前项目」就是当前工作区：显式传 rootPath（退回项目列表的
    // activeProjectPath），新对话才不会挂到上一个会话的老项目上。
    const projectPath = rootPath ?? activeProjectPath ?? undefined
    const id = createSession(configGroupId, projectPath)
    setActiveSession(id)
    // 新对话是会话栏里的东西：从文件模式点「新对话」后要能看见它
    setRailMode('sessions')
  }, [
    configGroupId,
    openSettings,
    rootPath,
    activeProjectPath,
    createSession,
    setActiveSession,
    setRailMode,
  ])

  const handleTrust = useCallback(
    async (path: string) => {
      setTrustingPath(path)
      try {
        // 主进程弹原生确认，答案不在渲染进程手里；true = 已授权（store 会清掉
        // untrustedProjectPath，行内提示随之消失），false = 未授权，提示保留。
        const granted = await requestProjectTrust(path)
        if (!granted) showNotification('未获得授权：这个文件夹的内容仍然不可读', 'warning')
      } finally {
        setTrustingPath(null)
      }
    },
    [requestProjectTrust, showNotification],
  )

  const handleSelect = useCallback((id: string) => setActiveSession(id), [setActiveSession])
  const handleStartRename = useCallback((id: string) => setEditingId(id), [])
  const handleCancelRename = useCallback(() => setEditingId(null), [])
  const handleRename = useCallback(
    (id: string, title: string) => {
      renameSession(id, title)
      setEditingId(null)
    },
    [renameSession],
  )
  const handleToggleCollapse = useCallback(
    (key: string) => toggleProjectCollapsed(key),
    [toggleProjectCollapsed],
  )
  const handleTrustRow = useCallback(
    (path: string) => {
      void handleTrust(path)
    },
    [handleTrust],
  )

  /**
   * 打开项目 = 把工作区切到它 + 左栏进「文件」模式。
   * 这是「项目行」的主语义（旧版点项目只是折叠，用户没法从会话栏进项目文件）。
   */
  const handleOpenProject = useCallback(
    (path: string) => {
      enterProject(path)
      setRailMode('files')
    },
    [enterProject, setRailMode],
  )

  const handleNewSessionInProject = useCallback(
    (path: string) => {
      if (!configGroupId) {
        openSettings()
        return
      }
      const id = createSession(configGroupId, path)
      setActiveSession(id)
      setRailMode('sessions')
    },
    [configGroupId, createSession, openSettings, setActiveSession, setRailMode],
  )

  const handleProjectMenu = useCallback(
    (group: RailGroup, x: number, y: number) => {
      const path = group.path
      const items: ContextMenuItem[] = []
      if (path) {
        items.push(
          { label: '打开项目并浏览文件', action: () => handleOpenProject(path) },
          { label: '在此项目新建对话', action: () => handleNewSessionInProject(path) },
          {
            label: '复制项目路径',
            action: () => {
              void navigator.clipboard
                .writeText(path)
                .then(() => showNotification('已复制路径', 'success'))
                .catch(() => showNotification('复制路径失败', 'warning'))
            },
          },
          { separator: true, label: '' },
          {
            label: '从列表中移除',
            // 破坏性但可逆（重新打开项目即回来）：移除项目时把活动会话挪开，
            // 否则界面会「坐在」一个已经不在列表里的项目上。
            action: () => {
              removeProject(path)
              useChatStore.getState().rollActiveSessionAwayFrom(path)
            },
          },
        )
      } else {
        items.push({ label: '新建对话', action: () => handleNewSession() })
      }
      showContextMenu(x, y, items)
    },
    [
      handleNewSession,
      handleNewSessionInProject,
      handleOpenProject,
      removeProject,
      showContextMenu,
      showNotification,
    ],
  )

  const { openMenu } = useRailMenu({ onRename: handleStartRename, onRequestDelete: setPendingDelete })

  /** 收起态 → 展开：intent 决定模式与焦点落点（文件入口直接展开到文件模式）。 */
  const handleExpand = useCallback(
    (intent: CollapsedRailIntent) => {
      if (intent === 'files') setRailMode('files')
      else if (intent !== 'restore') setRailMode('sessions')
      setFocusAfterExpand(intent === 'search' ? 'search' : intent === 'files' ? 'files' : 'sessions')
      setRailCollapsed(false)
    },
    [setRailCollapsed, setRailMode],
  )

  useEffect(() => {
    if (isRailCollapsed || !focusAfterExpand) return
    if (focusAfterExpand === 'search') {
      searchRef.current?.focus()
    } else if (focusAfterExpand === 'files' || railMode === 'files') {
      // 文件树可能还在读盘：有行就聚焦行；否则落到筛选框（Tab 一下就到树里），
      // 别把焦点放在 tabIndex=-1 的容器上造成键盘死胡同
      const host = filesHostRef.current
      const row = host?.querySelector<HTMLElement>('[data-file-row]')
      const fallback =
        host?.querySelector<HTMLElement>('input') ?? host?.querySelector<HTMLElement>('[data-file-tree]')
      ;(row ?? fallback)?.focus()
    } else {
      treeRef.current?.querySelector<HTMLElement>('[data-rail-row]')?.focus()
    }
    setFocusAfterExpand(null)
  }, [isRailCollapsed, focusAfterExpand, railMode])

  /** ↑↓ / Home / End 在项目树里移动焦点（行自身负责 Enter / F2 / Shift+F10）。 */
  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const key = e.key
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-rail-row]'))
    if (rows.length === 0) return
    const index = rows.indexOf(document.activeElement as HTMLElement)
    let next: HTMLElement | undefined
    if (key === 'Home') next = rows[0]
    else if (key === 'End') next = rows[rows.length - 1]
    else if (index < 0) next = rows[0]
    else next = rows[Math.min(rows.length - 1, Math.max(0, index + (key === 'ArrowDown' ? 1 : -1)))]
    if (!next) return
    e.preventDefault()
    next.focus()
  }, [])

  if (isRailCollapsed) {
    return <CollapsedRail onExpand={handleExpand} onNewSession={handleNewSession} />
  }

  const searching = query.trim().length > 0
  /** 文件模式的根：项目根优先，退回项目列表里正在浏览的那个项目。 */
  const projectRoot = rootPath ?? activeProjectPath

  return (
    <aside className="w-[260px] shrink-0 h-full min-h-0 flex flex-col bg-[var(--pure-rail)] border-r border-[var(--pure-border)]">
      {/* 品牌行 */}
      <div className="shrink-0 px-3 pt-3 pb-1 flex items-center gap-2">
        <WaveMark className="w-[18px] h-[18px] text-[var(--pure-ink)]" />
        <span className="text-[15px] font-medium tracking-[-0.01em]">OurCode</span>
        <button
          type="button"
          onClick={() => setRailCollapsed(true)}
          className="ml-auto w-7 h-7 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:bg-[var(--pure-hover)]"
          title="收起会话栏"
          aria-label="收起会话栏"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>

      {/* 模式切换：两项纯文字（active = ink，inactive = muted；无胶囊、无图标） */}
      <div className="shrink-0 px-3 mt-1 flex items-center gap-3" role="group" aria-label="侧栏模式">
        <button
          type="button"
          aria-pressed={railMode === 'sessions'}
          onClick={() => setRailMode('sessions')}
          className={`pure-focus text-[13px] leading-[18px] transition-colors ${
            railMode === 'sessions'
              ? 'text-[var(--pure-ink)]'
              : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
          }`}
        >
          会话
        </button>
        <button
          type="button"
          aria-pressed={railMode === 'files'}
          onClick={() => setRailMode('files')}
          className={`pure-focus text-[13px] leading-[18px] transition-colors ${
            railMode === 'files'
              ? 'text-[var(--pure-ink)]'
              : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
          }`}
        >
          文件
        </button>
      </div>

      {railMode === 'sessions' ? (
        <>
      {/* 搜索：唯一一条无边框输入（项目名 / 路径 / 会话标题 / 消息正文） */}
      <div className="shrink-0 mx-2 mt-1 h-8 flex items-center gap-2 px-1 text-[var(--pure-muted)]">
        <SearchIcon className="w-[14px] h-[14px]" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation()
              setQuery('')
            }
          }}
          placeholder="搜索项目与会话…"
          aria-label="搜索项目与会话"
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[13px] text-[var(--pure-ink)] placeholder:text-[var(--pure-muted)]"
        />
        {searching && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="shrink-0 w-4 h-4 flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)]"
            title="清除搜索"
            aria-label="清除搜索"
          >
            <svg
              className="w-3 h-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* 状态筛选：进行中 / 异常 / 结束 —— 对话是有状态的，列表要能按状态收敛 */}
      <div className="shrink-0 px-3 h-7 flex items-center gap-3" role="group" aria-label="按状态筛选对话">
        {RAIL_STATE_FILTERS.map((item) => {
          const count =
            item.id === 'all'
              ? totals.running + totals.waiting + totals.error + totals.done + totals.idle
              : item.id === 'active'
                ? totals.running + totals.waiting
                : item.id === 'error'
                  ? totals.error
                  : totals.done
          const isActive = stateFilter === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => setStateFilter(item.id)}
              title={`${item.label}的对话：${count} 条`}
              className={`pure-focus shrink-0 text-[11.5px] leading-[16px] transition-colors ${
                isActive
                  ? 'text-[var(--pure-ink)]'
                  : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
              }`}
            >
              {item.label}
              <span className="ml-1 tabular-nums text-[var(--pure-muted)]">{count}</span>
            </button>
          )
        })}
      </div>

      <div className="shrink-0 mx-3 mt-1.5 mb-1 h-px bg-[var(--pure-border)]" aria-hidden="true" />

      {/* 项目树 */}
      <div className="flex-1 min-h-0 overflow-y-auto pure-scroll pb-2">
        {/* 新对话：与项目行同一套缩进（图标槽 + 名称槽对齐） */}
        <button
          type="button"
          onClick={handleNewSession}
          className="w-full h-8 pl-2 pr-2 flex items-center gap-2 rounded-lg text-[14px] text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
          title="在当前项目里新建对话"
        >
          <span className="w-[15px] h-[15px] shrink-0 flex items-center justify-center text-[var(--pure-secondary)]">
            <PlusIcon className="w-[14px] h-[14px]" />
          </span>
          <span className="min-w-0 flex-1 truncate text-left">新对话</span>
        </button>

        <div ref={treeRef} role="tree" aria-label="项目与会话" onKeyDown={handleTreeKeyDown}>
          {groups.map((group) => {
            const collapsed = collapsedProjects.includes(group.key)
            return (
              <div key={group.key} className="mb-0.5">
                <ProjectRow
                  group={group}
                  collapsed={collapsed}
                  active={!!group.path && group.path === rootPath}
                  untrusted={!!group.path && untrustedProjectPath === group.path}
                  trusting={!!group.path && trustingPath === group.path}
                  onToggleCollapse={handleToggleCollapse}
                  onTrust={handleTrustRow}
                  onOpenProject={handleOpenProject}
                  onOpenMenu={handleProjectMenu}
                />
                {!collapsed && group.sessions.length > 0 && (
                  <div role="group" aria-label={group.label}>
                    {group.sessions.map((row) => (
                      <SessionRow
                        key={row.id}
                        row={row}
                        active={row.id === activeSessionId}
                        editing={editingId === row.id}
                        onSelect={handleSelect}
                        onStartRename={handleStartRename}
                        onRename={handleRename}
                        onCancelRename={handleCancelRename}
                        onOpenMenu={openMenu}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 空态：搜索无命中 / 状态筛选为空 / 还没有任何对话（都是一行灰字） */}
        {groups.length === 0 && (
          <div className="px-3 py-2 text-[12.5px] text-[var(--pure-muted)]">
            {searching
              ? '没有匹配的会话'
              : stateFilter !== 'all'
                ? '没有这个状态的对话'
                : '还没有对话'}
          </div>
        )}
      </div>
        </>
      ) : (
        /* 文件模式：筛选输入、隐藏文件开关与空/错/加载态都在 FileTreeRail 里 */
        <div ref={filesHostRef} className="flex-1 min-h-0 flex flex-col">
          {/* 按根 remount：换项目时筛选 / 展开 / 已加载目录都不串味 */}
          <FileTreeRail key={projectRoot ?? ''} rootPath={projectRoot} />
        </div>
      )}

      {/* 底部账户行 */}
      <div className="shrink-0 px-2 py-2 flex items-center gap-2 border-t border-[var(--pure-border)]">
        <span className="w-7 h-7 rounded-full bg-[var(--pure-ink)] text-[var(--pure-canvas)] text-[11px] font-semibold flex items-center justify-center">
          YG
        </span>
        <span className="min-w-0 truncate text-[12.5px] text-[var(--pure-muted)]">本地工作区</span>
        <button
          type="button"
          onClick={() => setOfficeSurfaceOpen(true)}
          className="ml-auto w-7 h-7 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:bg-[var(--pure-hover)] hover:text-[var(--pure-ink)]"
          title="一人公司"
          aria-label="一人公司"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 21V6a1 1 0 011-1h8a1 1 0 011 1v15" />
            <path d="M14 10h5a1 1 0 011 1v10" />
            <path d="M3 21h18" />
            <path d="M7 9h4M7 13h4M7 17h4" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => openSettings()}
          className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:bg-[var(--pure-hover)]"
          title="设置"
          aria-label="设置"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
          </svg>
        </button>
      </div>

      {/* 删除必须确认（破坏性操作：会话与它的 checkpoint 一起没） */}
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="删除对话"
        message={
          pendingDelete
            ? `「${pendingDelete.title}」和它的全部消息将被删除${
                pendingDelete.running ? '；它正在运行，删除会同时中止这次运行' : ''
              }。`
            : ''
        }
        confirmText="删除"
        cancelText="取消"
        variant="danger"
        onConfirm={() => {
          if (pendingDelete) deleteSession(pendingDelete.id)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </aside>
  )
}
