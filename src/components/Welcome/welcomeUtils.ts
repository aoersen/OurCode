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

/** Token formatting lives in the context-usage service (single formatter). */
