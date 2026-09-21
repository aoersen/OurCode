import { useState, useMemo } from 'react'
import { useChatStore, sessionLastUserActivity, isGhostSession } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import { getLocale } from '@/i18n'
import { useSessionMenu } from './sessionMenu'

interface ChatSidebarProps {
  onClose: () => void
}

export default function ChatSidebar({ onClose }: ChatSidebarProps) {
  // Individual selectors — a whole-store subscription would re-render the
  // session list on every streaming chunk / queue update of ANY session.
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const runningSessionIds = useChatStore((s) => s.runningSessionIds)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const batchApproval = useChatStore((s) => s.batchApproval)
  const decisionBacklog = useChatStore((s) => s.decisionBacklog)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const importSession = useChatStore((s) => s.importSession)
  const { openSessionMenu } = useSessionMenu()

  const t = useI18n()
  const [searchQuery, setSearchQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  // 从未用过的空会话（新建后没发消息）不进列表——首条消息发出后才出现。
  const visibleSessions = useMemo(
    () => sessions.filter((s) => !isGhostSession(s)),
    [sessions],
  )

  // Sessions waiting on the user (question / tool approval / batch approval /
  // plan approval) — bubble icon next to the title (same signal as the left
  // project list). The backlog matters as much as the slots: a parked prompt is
  // exactly the case where the badge is the only way to find it.
  const attentionSessionIds = useMemo(() => {
    const ids = new Set<string>()
    if (pendingQuestion?.sessionId) ids.add(pendingQuestion.sessionId)
    if (pendingApproval?.sessionId) ids.add(pendingApproval.sessionId)
    if (batchApproval?.sessionId) ids.add(batchApproval.sessionId)
    for (const parked of decisionBacklog) ids.add(parked.sessionId)
    for (const s of sessions) if (s.planStatus === 'pending_approval') ids.add(s.id)
    return ids
  }, [pendingQuestion, pendingApproval, batchApproval, decisionBacklog, sessions])

  // Filter sessions based on search query, archive status, and pin sorting
  const filteredSessions = useMemo(() => {
    let list = visibleSessions

    // Hide archived unless toggle is on
    if (!showArchived) {
      list = list.filter((s) => !s.archivedAt)
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      list = list.filter((session) => {
        if (session.title.toLowerCase().includes(query)) return true
        return session.messages.some((msg) =>
          msg.content.toLowerCase().includes(query)
        )
      })
    }

    // Sort: pinned first (by pinnedAt desc), then by last user message desc
    // (falling back to updatedAt for legacy sessions) — agent activity must
    // not reorder the list mid-run.
    return [...list].sort((a, b) => {
      if (a.pinnedAt && !b.pinnedAt) return -1
      if (!a.pinnedAt && b.pinnedAt) return 1
      if (a.pinnedAt && b.pinnedAt) return b.pinnedAt - a.pinnedAt
      return sessionLastUserActivity(b) - sessionLastUserActivity(a)
    })
  }, [visibleSessions, searchQuery, showArchived])

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return
    openSessionMenu(e, session)
  }

  // Hover "⋯" — opens the same menu anchored at the button.
  const handleMoreMenu = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return
    openSessionMenu(e, session)
  }

  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        const reader = new FileReader()
        reader.onload = (ev) => {
          const content = ev.target?.result as string
          importSession(content)
        }
        reader.readAsText(file)
      }
    }
    input.click()
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    const locale = getLocale()

    if (isToday) {
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  }

  // Find matching message snippet for search results
  const getMatchSnippet = (sessionId: string): string | null => {
    if (!searchQuery.trim()) return null
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return null
    const query = searchQuery.toLowerCase()
    const match = session.messages.find((msg) =>
      msg.content.toLowerCase().includes(query)
    )
    if (!match) return null
    const idx = match.content.toLowerCase().indexOf(query)
    const start = Math.max(0, idx - 20)
    const end = Math.min(match.content.length, idx + query.length + 20)
    const snippet = (start > 0 ? '...' : '') + match.content.slice(start, end) + (end < match.content.length ? '...' : '')
    return snippet
  }

  return (
    <div className="w-[220px] border-r border-nova-border bg-transparent flex flex-col shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-nova-border">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-nova-text-secondary">{t('chat.sessionList')}</span>
          <span className="text-[9px] px-1.5 py-px rounded-full bg-nova-accent/12 text-nova-accent font-medium shrink-0">
            {visibleSessions.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleImport}
            className="p-1 text-nova-text-muted hover:text-nova-accent rounded transition-colors"
            title={t('chat.importSession')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="p-1 text-nova-text-muted hover:text-nova-text-primary rounded transition-colors"
            title={t('common.close')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search input */}
      <div className="px-3 py-2 border-b border-nova-border">
        <div className="relative">
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-nova-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('chat.searchSessions')}
            className="w-full pl-7 pr-2 py-1.5 bg-nova-input-bg border border-nova-border rounded-full text-xs text-nova-text-primary outline-none focus:border-nova-accent/50 placeholder-nova-text-muted"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-nova-text-muted hover:text-nova-text-primary"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        {searchQuery && (
          <div className="text-[10px] text-nova-text-muted mt-1">
            {t('chat.foundSessions', { count: filteredSessions.length })}
          </div>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-1">
        {filteredSessions.length === 0 ? (
          <div className="p-4 text-center text-nova-text-muted text-xs">
            {searchQuery ? t('chat.noMatchingSessions') : t('chat.noSessions')}
          </div>
        ) : (
          filteredSessions.map((session) => {
            const isActive = session.id === activeSessionId
            const messageCount = session.messages.length
            const matchSnippet = getMatchSnippet(session.id)

            return (
              <div
                key={session.id}
                className={`
                  group mx-1.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors border-l-2
                  ${isActive ? 'bg-nova-accent/12 border-l-nova-accent' : 'border-l-transparent hover:bg-nova-hover'}
                  ${session.archivedAt ? 'opacity-60' : ''}
                `}
                onClick={() => setActiveSession(session.id)}
                onContextMenu={(e) => handleContextMenu(e, session.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className={`text-xs truncate flex items-center gap-1 ${isActive ? 'text-nova-accent font-medium' : 'text-nova-text-primary'}`}>
                      {/* Status indicator: labeled pill (needs input) >
                          spinning (running) > red dot (error) */}
                      {attentionSessionIds.has(session.id) ? (
                        <span
                          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[9px] font-medium"
                          style={{ background: 'color-mix(in srgb, var(--accent, #0058bc) 14%, transparent)', color: 'var(--accent)' }}
                        >
                          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                          </svg>
                          待处理
                        </span>
                      ) : runningSessionIds.includes(session.id) ? (
                        <span className="w-2.5 h-2.5 border-2 border-nova-accent/40 border-t-nova-accent rounded-full animate-spin shrink-0" />
                      ) : session.agentRuns?.some((r) => r.status === 'error') ? (
                        <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                      ) : null}
                      {session.pinnedAt && (
                        <svg className="w-3 h-3 shrink-0 text-nova-accent" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                        </svg>
                      )}
                      {session.title}
                    </div>
                    <div className="text-[10px] text-nova-text-muted mt-0.5">
                      {formatDate(sessionLastUserActivity(session))} · {t('chat.messageCount', { count: messageCount })}
                      {session.archivedAt && t('chat.archivedSuffix')}
                    </div>
                    {matchSnippet && (
                      <div className="text-[10px] text-nova-text-muted mt-0.5 truncate italic">
                        ...{matchSnippet}...
                      </div>
                    )}
                  </div>

                  {/* Actions — single ⋯ button opens the full session menu
                      (design: hover shows ⋯, menu carries rename/export/etc.) */}
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={(e) => handleMoreMenu(e, session.id)}
                      className="p-1 text-nova-text-muted hover:text-nova-text-primary rounded-full hover:bg-nova-hover"
                      title={t('chat.moreActions')}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="12" cy="19" r="1.6" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Archive toggle — bottom footer with count (design: 显示已归档 (N)) */}
      {sessions.some((s) => s.archivedAt) && (
        <div className="shrink-0 px-2 py-1.5 border-t border-nova-border">
          <button
            onClick={() => setShowArchived(!showArchived)}
            className={`w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-full text-[10px] transition-colors ${
              showArchived
                ? 'text-nova-accent bg-nova-accent/10'
                : 'text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover'
            }`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {showArchived
              ? t('chat.hideArchive')
              : `${t('chat.showArchive')} (${sessions.filter((s) => s.archivedAt).length})`}
          </button>
        </div>
      )}
    </div>
  )
}
