import { describe, it, expect } from 'vitest'
import { formatRelativeTime, pickResumeSession, projectName } from '@/components/Welcome/welcomeUtils'
import type { ChatSession } from '@shared/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('formatRelativeTime', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0).getTime() // 2026-11-05 12:00 local

  it('collapses anything under a minute to justNow', () => {
    expect(formatRelativeTime(now - 15_000, now)).toEqual({ unit: 'justNow' })
  })

  it('counts minutes and hours', () => {
    expect(formatRelativeTime(now - 8 * MINUTE, now)).toEqual({ unit: 'minutes', count: 8 })
    expect(formatRelativeTime(now - 3 * HOUR, now)).toEqual({ unit: 'hours', count: 3 })
  })

  it('reports yesterday only inside the previous calendar day', () => {
    const yesterdayMorning = new Date(2026, 10, 4, 9, 0, 0).getTime()
    expect(formatRelativeTime(yesterdayMorning, now)).toEqual({ unit: 'yesterday' })
  })

  it('counts days for the rest of the week, then falls back to a date', () => {
    const threeDaysAgo = new Date(2026, 10, 2, 12, 0, 0).getTime()
    expect(formatRelativeTime(threeDaysAgo, now)).toEqual({ unit: 'days', count: 3 })

    const lastMonth = new Date(2026, 9, 20, 12, 0, 0).getTime()
    expect(formatRelativeTime(lastMonth, now)).toEqual({ unit: 'date', month: 10, day: 20 })
  })

  it('never reports a negative age for clock skew', () => {
    expect(formatRelativeTime(now + 5 * MINUTE, now)).toEqual({ unit: 'justNow' })
  })
})

describe('projectName', () => {
  it('handles Windows, POSIX and trailing separators', () => {
    expect(projectName('C:\\work\\ourcode-desktop')).toBe('ourcode-desktop')
    expect(projectName('/home/yg/repo/api-gw')).toBe('api-gw')
    expect(projectName('C:\\work\\ourcode-desktop\\')).toBe('ourcode-desktop')
  })

  it('returns an empty string for missing paths', () => {
    expect(projectName(null)).toBe('')
    expect(projectName(undefined)).toBe('')
  })
})

/** Minimal session factory 鈥?only the fields the picker reads. */
function session(patch: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    title: patch.id,
    configGroupId: 'cfg-1',
    model: 'deepseek-chat',
    modelParams: {
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      thinking: false,
      reasoningEffort: 'medium',
    },
    messages: [{ id: 'm1' } as never],
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

describe('pickResumeSession', () => {
  const activity = (s: ChatSession) => s.lastUserMessageAt ?? 0

  it('returns null when nothing is resumable', () => {
    expect(pickResumeSession([], activity)).toBeNull()
    expect(
      pickResumeSession([session({ id: 'empty', messages: [] })], activity),
    ).toBeNull()
    expect(
      pickResumeSession([session({ id: 'no-project', projectPath: undefined })], activity),
    ).toBeNull()
  })

  it('skips archived sessions', () => {
    const archived = session({ id: 'archived', projectPath: '/p/a', archivedAt: 1, lastUserMessageAt: 99 })
    expect(pickResumeSession([archived], activity)).toBeNull()
  })

  it('picks the most recent user activity, not the most recently created', () => {
    const older = session({ id: 'older', projectPath: '/p/a', lastUserMessageAt: 10 })
    const newer = session({ id: 'newer', projectPath: '/p/b', lastUserMessageAt: 90 })
    const staleButRecentCreation = session({ id: 'stale', projectPath: '/p/c', lastUserMessageAt: 5, createdAt: 999 })
    expect(pickResumeSession([older, newer, staleButRecentCreation], activity)?.id).toBe('newer')
  })
})
