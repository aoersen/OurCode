/**
 * Pure helpers for the welcome hub.
 *
 * Kept free of React/zustand so they can be unit-tested directly: the welcome
 * screen's value depends on picking the RIGHT resume target and on rendering a
 * time that never lies ("8 分钟前" must not become "0 分钟前").
 */
import type { ChatSession } from '@shared/types'

/** What a relative timestamp resolves to, before translation. */
export type RelativeToken =
  | { unit: 'justNow' }
  | { unit: 'minutes' | 'hours' | 'days'; count: number }
  | { unit: 'yesterday' }
  | { unit: 'date'; month: number; day: number }

/**
 * Bucket a timestamp for display. Deliberately coarse: the welcome screen only
 * needs "is this the thing I was just doing" — minute precision beyond an hour
 * is noise.
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): RelativeToken {
  const diff = Math.max(0, now - ts)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return { unit: 'justNow' }
  if (diff < hour) return { unit: 'minutes', count: Math.floor(diff / minute) }
  if (diff < day) return { unit: 'hours', count: Math.floor(diff / hour) }

  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const yesterdayStart = startOfToday.getTime() - day
  if (ts >= yesterdayStart) return { unit: 'yesterday' }

  if (diff < 7 * day) return { unit: 'days', count: Math.floor(diff / day) }

  const d = new Date(ts)
  return { unit: 'date', month: d.getMonth() + 1, day: d.getDate() }
}

/** Project folder name for display: handles both separators (Windows paths). */
export function projectName(path: string | null | undefined): string {
  if (!path) return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

/**
 * The session the user most plausibly wants to continue.
 *
 * Rules (in order): not archived, bound to a real project folder, has at least
 * one message, newest user activity first. A brand-new empty session is NOT a
 * resume target — "continue" must not land on a blank conversation.
 */
export function pickResumeSession(
  sessions: ChatSession[],
  activityOf: (s: ChatSession) => number,
): ChatSession | null {
  const candidates = sessions.filter(
    (s) =>
      !s.archivedAt &&
      !!s.projectPath &&
      Array.isArray(s.messages) &&
      s.messages.length > 0,
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, cur) =>
    activityOf(cur) > activityOf(best) ? cur : best,
  )
}

/** Same picker, scoped to one project — the welcome hub's resume card must not
 *  offer a conversation from a different project after a project switch. */
export function pickResumeSessionForProject(
  sessions: ChatSession[],
  projectPath: string | null | undefined,
  activityOf: (s: ChatSession) => number,
): ChatSession | null {
  if (!projectPath) return null
  const candidates = sessions.filter(
    (s) =>
      s.projectPath === projectPath &&
      !s.archivedAt &&
      Array.isArray(s.messages) &&
      s.messages.length > 0,
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, cur) =>
    activityOf(cur) > activityOf(best) ? cur : best,
  )
}

/** One row in the welcome hub's project switcher. */
export interface WelcomeProjectSummary {
  path: string
  name: string
  /** Last time the project was opened (ms epoch); falls back to its newest
   *  session activity for installs that predate the open-time bookkeeping. */
  lastOpened: number
  /** Non-archived conversations (at least one message) bound to the project. */
  sessionCount: number
  /** Newest conversation in the project — the resume card's target. */
  lastSession: ChatSession | null
}

/**
 * Projects offered by the welcome hub: recently opened projects first (their
 * stored order — opening a project never re-sorts it), then projects that only
 * exist through their sessions. Removed projects and empty/ghost sessions do
 * not invent a project.
 */
export function buildWelcomeProjects(
  recentProjects: string[],
  recentProjectTimes: Record<string, number>,
  sessions: ChatSession[],
  removedProjects: string[],
  activityOf: (s: ChatSession) => number,
): WelcomeProjectSummary[] {
  const removed = new Set(removedProjects)
  const summaries = new Map<string, WelcomeProjectSummary>()

  const ensure = (path: string): WelcomeProjectSummary => {
    let summary = summaries.get(path)
    if (!summary) {
      summary = {
        path,
        name: projectName(path),
        lastOpened: recentProjectTimes[path] || 0,
        sessionCount: 0,
        lastSession: null,
      }
      summaries.set(path, summary)
    }
    return summary
  }

  const recentOrdered: string[] = []
  const recentSet = new Set<string>()
  for (const path of recentProjects) {
    if (!path || removed.has(path) || recentSet.has(path)) continue
    recentSet.add(path)
    recentOrdered.push(path)
    ensure(path)
  }

  for (const s of sessions) {
    const path = s.projectPath
    if (!path || removed.has(path)) continue
    if (s.archivedAt || s.hidden || s.mode === 'claw') continue
    // A ghost session (never used) is not evidence that a project exists.
    const hasConversation = Array.isArray(s.messages) && s.messages.length > 0
    if (!hasConversation && !summaries.has(path)) continue
    const summary = ensure(path)
    if (!hasConversation) continue
    summary.sessionCount += 1
    const activity = activityOf(s)
    if (!summary.lastSession || activity > activityOf(summary.lastSession)) {
      summary.lastSession = s
    }
    if (summary.lastOpened === 0 && activity > 0) summary.lastOpened = activity
  }

  const ordered = recentOrdered.map((path) => summaries.get(path)!)
  const sessionOnly = Array.from(summaries.values())
    .filter((p) => !recentSet.has(p.path) && p.sessionCount > 0)
    .sort((a, b) => {
      const aAt = a.lastSession ? activityOf(a.lastSession) : a.lastOpened
      const bAt = b.lastSession ? activityOf(b.lastSession) : b.lastOpened
      return bAt - aAt
    })

  return [...ordered, ...sessionOnly]
}

/** Token formatting lives in the context-usage service (single formatter). */
