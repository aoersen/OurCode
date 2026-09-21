import { useEffect, useRef } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore, AppNotification } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'

/**
 * Debounce before a "task done" toast: when a session's agent loop ends it may
 * be immediately relaunched by the type-ahead queue drain / inbound message
 * delivery (~50ms later). Without the grace period those relaunches would show
 * a false "已完成" toast, then another one on the real completion.
 */
const COMPLETE_DEBOUNCE_MS = 1200

/** Session ids that currently need user input (question / approval / plan). */
function collectNeedsInputIds(state: ReturnType<typeof useChatStore.getState>): Set<string> {
  const ids = new Set<string>()
  if (state.pendingQuestion?.sessionId) ids.add(state.pendingQuestion.sessionId)
  if (state.pendingApproval?.sessionId) ids.add(state.pendingApproval.sessionId)
  if (state.batchApproval?.sessionId) ids.add(state.batchApproval.sessionId)
  // Parked ones matter most: a background session's prompt has no dialog to show
  // itself, so this transition is what tells the user something is waiting.
  for (const parked of state.decisionBacklog) ids.add(parked.sessionId)
  for (const sess of state.sessions) {
    if (sess.planStatus === 'pending_approval') ids.add(sess.id)
  }
  return ids
}

/**
 * Toast kind for a completed session. Covers both agent runs (run status) and
 * plain chat mode (no run record — the last assistant message carries the
 * error card instead). Exported for unit tests.
 */
export function completionToastType(session: {
  agentRuns?: Array<{ status: string }>
  messages: Array<{ role: string; error?: unknown }>
}): 'success' | 'error' | 'info' {
  const lastRun = (session.agentRuns || [])[0]
  const lastMsg = session.messages[session.messages.length - 1]
  const failed = lastRun?.status === 'error' || (lastMsg?.role === 'assistant' && Boolean(lastMsg?.error))
  return failed ? 'error' : lastRun?.status === 'stopped' ? 'info' : 'success'
}

/**
 * Session-event notifications (requirement: bottom-right popups):
 *  1. a background session's task completed while the user is elsewhere;
 *  2. a background session needs the user's input (question / approval / plan).
 * Each event also fires an OS-level notification when the window is not
 * focused (the in-app toast covers the focused case).
 * Renders nothing; mounted once in App.
 */
export default function SessionEventNotifier() {
  const t = useI18n()
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    // Copy the ref target into a local so the cleanup closes over a stable map
    const pendingTimers = timers.current

    const notify = (message: string, type: AppNotification['type'], sessionId: string) => {
      useUIStore.getState().showNotification(message, type, { position: 'bottom-right', sessionId })
      if (!document.hasFocus()) {
        window.electronAPI?.showSystemNotification?.('OurCode AI', message)
      }
    }

    const titleOf = (sessionId: string): string =>
      useChatStore.getState().sessions.find((s) => s.id === sessionId)?.title || ''

    const unsub = useChatStore.subscribe((state, prevState) => {
      // ── 1) Task completed: a session left runningSessionIds ──
      const prevRunning = new Set(prevState.runningSessionIds)
      for (const id of prevRunning) {
        if (state.runningSessionIds.includes(id)) continue
        clearTimeout(pendingTimers.get(id))
        pendingTimers.delete(id)
        const timer = setTimeout(() => {
          pendingTimers.delete(id)
          const now = useChatStore.getState()
          if (now.runningSessionIds.includes(id)) return // relaunched meanwhile
          if (id === now.activeSessionId) return // user is viewing it — no toast
          const session = now.sessions.find((s) => s.id === id)
          if (!session) return
          // Loop paused for plan approval — that's a "needs input" event, not
          // a completion; the needs-input toast below covers it.
          if (session.planStatus === 'pending_approval') return
          const type = completionToastType(session)
          notify(
            type === 'error'
              ? t('chat.sessionTaskFailed', { title: session.title })
              : t('chat.sessionTaskDone', { title: session.title }),
            type,
            id,
          )
        }, COMPLETE_DEBOUNCE_MS)
        pendingTimers.set(id, timer)
      }

      // ── 2) Needs user input: new pending question / approval / plan ──
      const prevNeeds = collectNeedsInputIds(prevState)
      const nextNeeds = collectNeedsInputIds(state)
      for (const id of nextNeeds) {
        if (prevNeeds.has(id)) continue // not new
        // Startup: loadSessions restores the active session right after
        // populating sessions — activeSessionId is momentarily null, so any
        // restored pending state would be announced while the session is about
        // to become active (dialog already visible). Skip until a session is
        // actually selected; the in-session dialog + list bubble still cover it.
        if (state.activeSessionId === null) continue
        if (id === state.activeSessionId) continue // user is on it — dialog shows
        const title = titleOf(id)
        notify(t('chat.sessionNeedsInput', { title }), 'warning', id)
      }
    })

    return () => {
      unsub()
      for (const timer of pendingTimers.values()) clearTimeout(timer)
      pendingTimers.clear()
    }
  }, [t])

  return null
}
