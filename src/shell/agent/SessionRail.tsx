import { useMemo, useState } from 'react'
import type { ChatSession } from '@/types'
import { isGhostSession, useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'

const UNGROUPED = '__ungrouped__'

function projectName(path?: string | null): string {
  if (!path) return '未归类'
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

function activityAt(s: ChatSession): number {
  return s.lastUserMessageAt ?? s.updatedAt ?? s.createdAt ?? 0
}

function shortTime(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

function WaveMark({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M2 14c2.5 0 3.5-6 6-6s3.5 6 6 6 3.5-6 6-6" />
      <path d="M2 19c2.5 0 3.5-3 6-3s3.5 3 6 3 3.5-3 6-3" opacity="0.45" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg className="w-[15px] h-[15px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  )
}

/**
 * 会话栏（项目树）：项目 → 对话两级，而不是按时间平铺。
 * 折叠状态按项目记忆；运行中的会话带 6px 点。
 */
export default function SessionRail() {
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const runningSessionIds = useChatStore((s) => s.runningSessionIds)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const createSession = useChatStore((s) => s.createSession)
  const configGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const rootPath = useUIStore((s) => s.rootPath)
  const openSettings = useUIStore((s) => s.openSettings)
  const isRailCollapsed = useUIStore((s) => s.isRailCollapsed)
  const setRailCollapsed = useUIStore((s) => s.setRailCollapsed)

  const [query, setQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const visible = sessions.filter(
      (s) => s.mode !== 'claw' && !s.archivedAt && (!isGhostSession(s) || s.id === activeSessionId),
    )
    const q = query.trim().toLowerCase()
    const filtered = q
      ? visible.filter(
          (s) => s.title.toLowerCase().includes(q) || (s.projectPath ?? '').toLowerCase().includes(q),
        )
      : visible

    const byProject = new Map<string, ChatSession[]>()
    for (const s of filtered) {
      const key = s.projectPath || UNGROUPED
      const list = byProject.get(key)
      if (list) list.push(s)
      else byProject.set(key, [s])
    }

    return [...byProject.entries()]
      .map(([key, list]) => ({
        key,
        label: key === UNGROUPED ? '未归类' : projectName(key),
        sessions: [...list].sort((a, b) => activityAt(b) - activityAt(a)),
      }))
      .sort((a, b) => activityAt(b.sessions[0]) - activityAt(a.sessions[0]))
  }, [sessions, query, activeSessionId])

  const handleNewSession = () => {
    if (!configGroupId) {
      openSettings()
      return
    }
    const id = createSession(configGroupId, rootPath ?? undefined)
    setActiveSession(id)
  }

  if (isRailCollapsed) {
    return (
      <aside className="w-12 shrink-0 h-full flex flex-col items-center gap-1 py-3 bg-[var(--pure-rail)]">
        <button
          type="button"
          onClick={() => setRailCollapsed(false)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]"
          title="展开会话栏"
          aria-label="展开会话栏"
        >
          <WaveMark className="w-[18px] h-[18px]" />
        </button>
        <button
          type="button"
          onClick={handleNewSession}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--pure-secondary)] hover:bg-[var(--pure-hover)] text-lg leading-none"
          title="新建对话"
          aria-label="新建对话"
        >
          +
        </button>
      </aside>
    )
  }

  return (
    <aside className="w-[260px] shrink-0 h-full min-h-0 flex flex-col bg-[var(--pure-rail)]">
      {/* 品牌行 */}
      <div className="px-3 pt-3 pb-1 flex items-center gap-2">
        <WaveMark className="w-[18px] h-[18px] text-[var(--pure-ink)]" />
        <span className="text-[15px] font-medium tracking-[-0.01em]">OurCode</span>
        <button
          type="button"
          onClick={() => setRailCollapsed(true)}
          className="ml-auto w-7 h-7 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:bg-[var(--pure-hover)]"
          title="收起会话栏"
          aria-label="收起会话栏"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>

      {/* 新建对话 */}
      <button
        type="button"
        onClick={handleNewSession}
        className="mx-2 mt-1 h-9 px-2 rounded-lg flex items-center gap-2 text-[14px] text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
      >
        <span className="text-[17px] leading-none text-[var(--pure-secondary)]">+</span>
        新对话
      </button>

      {/* 搜索 */}
      <div className="mx-2 mt-1 h-9 px-2 rounded-lg flex items-center gap-2 text-[13px] text-[var(--pure-muted)]">
        <svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索项目与会话…"
          className="flex-1 min-w-0 bg-transparent outline-none border-0 text-[13px] text-[var(--pure-ink)] placeholder:text-[var(--pure-muted)]"
        />
      </div>

      {/* 项目树 */}
      <div className="flex-1 min-h-0 overflow-y-auto pure-scroll mt-2 pb-2">
        {groups.length === 0 && (
          <div className="px-3 py-2 text-[12.5px] text-[var(--pure-muted)]">
            {query ? '没有匹配的会话' : '还没有对话'}
          </div>
        )}

        {groups.map((group) => {
          const isCollapsed = collapsedGroups[group.key] === true
          return (
            <div key={group.key} className="mb-1">
              <button
                type="button"
                onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.key]: !isCollapsed }))}
                className="w-full h-8 px-2 flex items-center gap-2 text-[14px] text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
                title={group.key}
              >
                <FolderIcon />
                <span className="min-w-0 truncate">{group.label}</span>
                <span className="ml-auto text-[12px] text-[var(--pure-muted)] tabular-nums">
                  {group.sessions.length}
                </span>
                <svg
                  className={`w-3.5 h-3.5 shrink-0 text-[var(--pure-muted)] transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {!isCollapsed &&
                group.sessions.map((session) => {
                  const isActive = session.id === activeSessionId
                  const isRunning = runningSessionIds.includes(session.id)
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => setActiveSession(session.id)}
                      className={`w-full h-8 pl-[30px] pr-2 rounded-lg flex items-center gap-2 text-[13px] transition-colors ${
                        isActive
                          ? 'bg-[var(--pure-active)] text-[var(--pure-ink)]'
                          : 'text-[var(--pure-secondary)] hover:bg-[var(--pure-hover)]'
                      }`}
                      title={`${session.title}${session.projectPath ? `\n${session.projectPath}` : ''}`}
                    >
                      <span className="min-w-0 truncate">{session.title || '未命名对话'}</span>
                      {isRunning ? (
                        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--pure-ink)] animate-pulse" />
                      ) : (
                        <span className="ml-auto text-[11px] text-[var(--pure-muted)] tabular-nums opacity-0 group-hover:opacity-100">
                          {shortTime(activityAt(session))}
                        </span>
                      )}
                    </button>
                  )
                })}
            </div>
          )
        })}
      </div>

      {/* 底部账户行 */}
      <div className="shrink-0 px-2 py-2 flex items-center gap-2">
        <span className="w-7 h-7 rounded-full bg-[var(--pure-ink)] text-white text-[11px] font-semibold flex items-center justify-center">
          YG
        </span>
        <span className="min-w-0 truncate text-[13px] text-[var(--pure-ink)]">YG</span>
        <button
          type="button"
          onClick={() => openSettings()}
          className="ml-auto w-7 h-7 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:bg-[var(--pure-hover)]"
          title="设置"
          aria-label="设置"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
          </svg>
        </button>
      </div>
    </aside>
  )
}
