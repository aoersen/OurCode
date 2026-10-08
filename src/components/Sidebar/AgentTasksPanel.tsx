import { useMemo } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import type { AgentRun } from '@/types'
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'

/**
 * Agent tasks panel (sidebar tab): lists the current run (across sessions) and
 * recent agent runs, with quick actions (open session / stop / delete). Also
 * hosts the per-project "always allow" tool allowlist manager.
 */

const STATUS_KEY: Record<AgentRun['status'], TranslationKey> = {
  running: 'agent.runStatus.running',
  creating_plan: 'agent.runStatus.creatingPlan',
  waiting_plan: 'agent.runStatus.waitingPlan',
  approved_running: 'agent.runStatus.approvedRunning',
  done: 'agent.runStatus.done',
  stopped: 'agent.runStatus.stopped',
  error: 'agent.runStatus.error',
  rejected: 'agent.runStatus.rejected',
}

/** Status pill styles — map each run status to the Stitch glass-light palette */
const STATUS_PILL: Record<AgentRun['status'], string> = {
  running: 'bg-accent-10 text-nova-accent',
  creating_plan: 'bg-accent-10 text-nova-accent',
  waiting_plan: 'bg-warning-10 text-warning',
  approved_running: 'bg-accent-10 text-nova-accent',
  done: 'bg-green-100 text-success dark:bg-green-500/10',
  stopped: 'bg-gray-200 text-nova-text-muted dark:bg-white/10',
  error: 'bg-error-container text-error dark:bg-red-500/10',
  rejected: 'bg-gray-200 text-nova-text-muted dark:bg-white/10',
}

const isRunningStatus = (s: AgentRun['status']) =>
  s === 'running' || s === 'creating_plan' || s === 'approved_running'

function formatElapsed(run: AgentRun, t: (key: TranslationKey, vars?: Record<string, string | number>) => string) {
  const secs = Math.max(0, Math.floor(((run.finishedAt || Date.now()) - run.startedAt) / 1000))
  return t('agent.elapsed', { seconds: secs })
}

export default function AgentTasksPanel() {
  const sessions = useChatStore((s) => s.sessions).filter((sess) => sess.mode !== 'wechat')
  const activeRuns = useChatStore((s) => s.activeRuns)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const deleteAgentRun = useChatStore((s) => s.deleteAgentRun)
  const toolAllowlist = useChatStore((s) => s.toolAllowlist)
  const clearToolAllowlist = useChatStore((s) => s.clearToolAllowlist)
  const rootPath = useUIStore((s) => s.rootPath)
  const t = useI18n()

  // With parallel conversations several runs can be live at once — list them all
  const currentRuns = useMemo(() => {
    const items: Array<{ session: (typeof sessions)[number]; run: AgentRun }> = []
    for (const active of Object.values(activeRuns)) {
      const session = sessions.find((s) => s.id === active.sessionId)
      const run = session?.agentRuns?.find((r) => r.id === active.runId)
      if (session && run) items.push({ session, run })
    }
    return items
  }, [activeRuns, sessions])

  const activeRunIds = useMemo(() => new Set(Object.values(activeRuns).map((a) => a.runId)), [activeRuns])

  const history = useMemo(() => {
    const items: Array<{ session: (typeof sessions)[number]; run: AgentRun }> = []
    for (const session of sessions) {
      for (const run of session.agentRuns || []) {
        if (activeRunIds.has(run.id)) continue
        items.push({ session, run })
      }
    }
    return items.sort((a, b) => b.run.startedAt - a.run.startedAt).slice(0, 50)
  }, [sessions, activeRunIds])

  const openSession = (sessionId: string) => {
    setActiveSession(sessionId)
    const ui = useUIStore.getState()
    if (!ui.isChatVisible) ui.toggleChat()
  }

  const allowlist = rootPath ? toolAllowlist[rootPath] || [] : []

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <div className="p-4 flex flex-col gap-5">
        {/* Section 1: 当前运行 */}
        <section className="flex flex-col gap-2.5">
          <h3 className="text-[11px] uppercase text-nova-text-muted font-bold tracking-widest pl-1">
            {t('agent.currentRun')}
          </h3>
          {currentRuns.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              {currentRuns.map(({ session, run }) => (
                <TaskCard
                  key={run.id}
                  sessionTitle={session?.title}
                  run={run}
                  isActive
                  onOpen={() => openSession(session!.id)}
                  onStop={() => stopGeneration(session!.id)}
                  onDelete={() => deleteAgentRun(session!.id, run.id)}
                  t={t}
                />
              ))}
            </div>
          ) : (
            <div className="text-xs text-nova-text-muted pl-1">{t('agent.emptyTasks')}</div>
          )}
        </section>

        {/* Section 2: 历史记录 */}
        {history.length > 0 && (
          <section className="flex flex-col gap-2.5">
            <h3 className="text-[11px] uppercase text-nova-text-muted font-bold tracking-widest pl-1">
              {t('agent.history')}
            </h3>
            <div className="flex flex-col gap-2">
              {history.map(({ session, run }) => (
                <TaskCard
                  key={run.id}
                  sessionTitle={session?.title}
                  run={run}
                  onOpen={() => openSession(session!.id)}
                  onStop={() => stopGeneration(session!.id)}
                  onDelete={() => deleteAgentRun(session!.id, run.id)}
                  t={t}
                />
              ))}
            </div>
          </section>
        )}

        {/* Section 3: 工具白名单 */}
        <section className="flex flex-col gap-2.5 pb-2">
          <div className="flex items-center justify-between pl-1">
            <h3 className="text-[11px] uppercase text-nova-text-muted font-bold tracking-widest">
              {t('agent.allowlistTitle')}
            </h3>
            {allowlist.length > 0 && (
              <button
                onClick={() => rootPath && clearToolAllowlist(rootPath)}
                className="text-[10px] text-nova-text-muted border border-glass-border px-2 py-0.5 rounded-full hover:bg-white/50 dark:hover:bg-white/10 transition-colors"
              >
                {t('agent.clearAllowlist')}
              </button>
            )}
          </div>
          {allowlist.length === 0 ? (
            <div className="text-xs text-nova-text-muted pl-1">{t('agent.allowlistEmpty')}</div>
          ) : (
            <div className="flex flex-wrap gap-2 pl-1">
              {allowlist.map((name) => (
                <span
                  key={name}
                  className="font-mono text-[11px] px-2 py-1 bg-green-50 border border-green-200 text-success rounded-md shadow-sm dark:bg-green-500/10 dark:border-green-500/30"
                >
                  {name}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function TaskCard({
  sessionTitle,
  run,
  isActive,
  onOpen,
  onStop,
  onDelete,
  t,
}: {
  sessionTitle?: string
  run: AgentRun
  isActive?: boolean
  onOpen: () => void
  onStop: () => void
  onDelete: () => void
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
}) {
  if (isActive) {
    // ── 当前运行 (Stitch: pulsing dot, running pill, split actions) ──
    return (
      <div className="relative bg-white/90 dark:bg-white/10 border border-accent-20 rounded-md p-3.5 flex flex-col gap-2.5 shadow-sm transition-all duration-300 hover:shadow-md hover:border-accent-40">
        {/* Pulsing dot top-right with glow */}
        <span
          className="absolute top-3.5 right-3.5 w-2 h-2 rounded-full bg-primary animate-pulse-dot shrink-0"
          style={{ boxShadow: '0 0 8px rgba(0,88,188,0.6)' }}
        />
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full font-bold text-[11px] ${STATUS_PILL[run.status]}`}>
            {t(STATUS_KEY[run.status])}
          </span>
          <span className="font-mono text-[10px] text-nova-text-muted">{formatElapsed(run, t)}</span>
        </div>
        <p className="text-xs text-nova-text-primary leading-relaxed line-clamp-2 break-words">{run.task}</p>
        <div className="text-[10px] text-nova-text-muted flex items-center gap-1.5 flex-wrap">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4L15 12l-3-3 2.7-2.7z" />
          </svg>
          <span className="truncate max-w-[140px]">{sessionTitle || '—'}</span>
          <span className="opacity-50">·</span>
          <span>{t('agent.toolCalls', { count: run.toolCallCount })}</span>
          <span className="opacity-50">·</span>
          <span>{t('agent.fileChanges', { count: run.fileChangeCount })}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <button
            onClick={onOpen}
            className="flex-1 py-1.5 rounded-full bg-accent-10 text-nova-accent text-xs font-bold hover:bg-accent-20 transition-colors flex items-center justify-center gap-1"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h16v11H8l-4 4V5z" />
            </svg>
            {t('agent.openSession')}
          </button>
          {isRunningStatus(run.status) && (
            <button
              onClick={onStop}
              className="flex-1 py-1.5 rounded-full bg-red-500/10 text-red-500 text-xs font-bold hover:bg-red-500/20 transition-colors flex items-center justify-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              {t('agent.stop')}
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── 历史记录 (Stitch: status pill + task + hover-revealed actions) ──
  return (
    <div className="bg-white/70 dark:bg-white/5 border border-glass-border rounded-md p-3 flex flex-col gap-2 hover:bg-white/90 dark:hover:bg-white/10 transition-colors cursor-pointer group">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full font-bold text-[11px] ${STATUS_PILL[run.status]}`}>
            {t(STATUS_KEY[run.status])}
          </span>
          <span className="font-mono text-[10px] text-nova-text-muted">{formatElapsed(run, t)}</span>
        </div>
      </div>
      <p className="text-xs text-nova-text-primary line-clamp-2 break-words">{run.task}</p>
      <div className="flex items-center justify-between mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={onOpen} className="text-primary text-xs font-bold hover:underline">
          {t('agent.openSession')}
        </button>
        <button onClick={onDelete} className="text-nova-text-muted text-xs hover:text-error transition-colors">
          {t('agent.deleteRecord')}
        </button>
      </div>
    </div>
  )
}
