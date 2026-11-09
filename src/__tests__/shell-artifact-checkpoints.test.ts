import { describe, it, expect } from 'vitest'
import type { AgentRun, Checkpoint } from '@/types'
import {
  checkpointKindLabel,
  checkpointToolName,
  computeCheckpointStats,
  formatClock,
  formatDuration,
  lineDiffCounts,
  orderCheckpoints,
  runDurationMs,
  splitLines,
  summaryLine,
} from '@/shell/agent/artifact/checkpointStats'

function checkpoint(
  id: string,
  createdAt: number,
  label: string,
  files: Array<{ path: string; content: string; existed: boolean; snapshotFailed?: boolean }>
): Checkpoint {
  return { id, sessionId: 's1', createdAt, label, files }
}

function run(startedAt: number, finishedAt?: number): AgentRun {
  return {
    id: `run-${startedAt}`,
    task: 'refactor',
    status: finishedAt ? 'done' : 'running',
    startedAt,
    finishedAt,
    toolCallCount: 0,
    fileChangeCount: 0,
    stepCount: 0,
  }
}

describe('checkpointStats · splitLines', () => {
  it('treats a trailing newline as a terminator', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
  })

  it('normalizes CRLF and keeps inner blank lines', () => {
    expect(splitLines('a\r\n\r\nb\r\n')).toEqual(['a', '', 'b'])
  })

  it('returns nothing for empty text', () => {
    expect(splitLines('')).toEqual([])
  })
})

describe('checkpointStats · lineDiffCounts', () => {
  it('counts nothing for identical text', () => {
    expect(lineDiffCounts('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 })
  })

  it('counts pure additions and pure deletions', () => {
    expect(lineDiffCounts('', 'a\nb\n')).toEqual({ added: 2, removed: 0 })
    expect(lineDiffCounts('a\nb\n', '')).toEqual({ added: 0, removed: 2 })
  })

  it('ignores unchanged head/tail and only counts the middle edit', () => {
    const original = 'l1\nl2\nl3\nl4\nl5\n'
    const modified = 'l1\nl2\nX\nl4\nl5\n'
    expect(lineDiffCounts(original, modified)).toEqual({ added: 1, removed: 1 })
  })

  it('counts a mid-file insertion as an addition only', () => {
    expect(lineDiffCounts('a\nb\n', 'a\nnew\nb\n')).toEqual({ added: 1, removed: 0 })
  })

  it('falls back to block counts for very large rewrites', () => {
    const before = Array.from({ length: 600 }, (_, i) => `old-${i}`).join('\n')
    const after = Array.from({ length: 700 }, (_, i) => `new-${i}`).join('\n')
    expect(lineDiffCounts(before, after)).toEqual({ added: 700, removed: 600 })
  })
})

describe('checkpointStats · computeCheckpointStats', () => {
  it('measures each write against the next snapshot of the same path', () => {
    const first = checkpoint('cp1', 1000, 'edit_file → a.ts', [
      { path: 'E:/p/a.ts', content: 'l1\nl2\n', existed: true },
    ])
    const second = checkpoint('cp2', 2000, 'edit_file → a.ts', [
      { path: 'E:/p/a.ts', content: 'l1\nl2\nl3\n', existed: true },
    ])
    const current = new Map<string, string | null>([['E:/p/a.ts', 'l1\nl2\nl3\nl4\n']])

    const result = computeCheckpointStats([second, first], current)
    expect(result.byId.get('cp1')).toEqual({ added: 1, removed: 0 })
    expect(result.byId.get('cp2')).toEqual({ added: 1, removed: 0 })
    expect(result.totals).toEqual({ writes: 2, files: 1, added: 2, removed: 0 })
  })

  it('counts a created file as additions and a missing current file as removals', () => {
    const created = checkpoint('cp1', 1000, 'write_file → new.ts', [
      { path: 'E:/p/new.ts', content: '', existed: false },
    ])
    const edited = checkpoint('cp2', 2000, 'edit_file → old.ts', [
      { path: 'E:/p/old.ts', content: 'x\ny\n', existed: true },
    ])
    const deleted = checkpoint('cp3', 3000, 'delete_file → old.ts', [
      { path: 'E:/p/old.ts', content: 'x\ny\n', existed: true },
    ])
    const current = new Map<string, string | null>([
      ['E:/p/new.ts', 'one\ntwo\n'],
      ['E:/p/old.ts', null],
    ])

    const result = computeCheckpointStats([created, edited, deleted], current)
    expect(result.byId.get('cp1')).toEqual({ added: 2, removed: 0 })
    expect(result.byId.get('cp2')).toEqual({ added: 0, removed: 0 })
    expect(result.byId.get('cp3')).toEqual({ added: 0, removed: 2 })
    expect(result.totals.files).toBe(2)
  })

  it('skips paths whose current state is unknown and snapshot failures', () => {
    const cp = checkpoint('cp1', 1000, 'multi_edit_file → 2 个文件', [
      { path: 'E:/p/a.ts', content: 'a\n', existed: true },
      { path: 'E:/p/locked.ts', content: '', existed: false, snapshotFailed: true },
    ])
    const result = computeCheckpointStats([cp], new Map())
    expect(result.byId.get('cp1')).toEqual({ added: 0, removed: 0 })
    expect(result.totals.files).toBe(1)
    expect(result.totals.writes).toBe(1)
  })

  it('returns an empty summary for no checkpoints', () => {
    const result = computeCheckpointStats([], new Map())
    expect(result.totals).toEqual({ writes: 0, files: 0, added: 0, removed: 0 })
    expect(result.byId.size).toBe(0)
  })
})

describe('checkpointStats · ordering', () => {
  it('sorts oldest-first and keeps input order for identical timestamps', () => {
    const a = checkpoint('a', 2000, 'x', [])
    const b = checkpoint('b', 1000, 'y', [])
    const c = checkpoint('c', 2000, 'z', [])
    expect(orderCheckpoints([a, b, c]).map((cp) => cp.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('checkpointStats · formatting', () => {
  it('formats durations like the design (1m42s)', () => {
    expect(formatDuration(102_000)).toBe('1m42s')
    expect(formatDuration(42_000)).toBe('42s')
    expect(formatDuration(480)).toBe('480ms')
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(3_720_000)).toBe('1h2m')
    expect(formatDuration(3_600_000)).toBe('1h')
  })

  it('returns null for unusable durations', () => {
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(undefined)).toBeNull()
    expect(formatDuration(-1)).toBeNull()
    expect(formatDuration(Number.NaN)).toBeNull()
  })

  it('formats clock time as local HH:mm:ss', () => {
    const stamp = new Date(2026, 0, 2, 14, 28, 10).getTime()
    expect(formatClock(stamp)).toBe('14:28:10')
    expect(formatClock(Number.NaN)).toBe('--:--:--')
  })

  it('builds the summary line in design order', () => {
    expect(summaryLine({ writes: 3, files: 2, added: 178, removed: 12 }, '1m42s')).toBe(
      '+178 · −12 · 2 个文件 · 1m42s',
    )
    expect(summaryLine({ writes: 0, files: 0, added: 0, removed: 0 }, null)).toBe('+0 · −0 · 0 个文件')
  })
})

describe('checkpointStats · labels', () => {
  it('extracts the tool name from the checkpoint label', () => {
    expect(checkpointToolName('edit_file → ChatPanel.tsx')).toBe('edit_file')
    expect(checkpointToolName('multi_edit_file → 3 个文件')).toBe('multi_edit_file')
    expect(checkpointToolName('')).toBe('')
  })

  it('derives the second-line kind text', () => {
    expect(
      checkpointKindLabel(
        checkpoint('cp1', 1, 'write_file → AgentShell.tsx', [
          { path: 'E:/p/AgentShell.tsx', content: '', existed: false },
        ])
      )
    ).toBe('新建文件')
    expect(
      checkpointKindLabel(
        checkpoint('cp2', 2, 'edit_file → a.ts', [{ path: 'E:/p/a.ts', content: 'x', existed: true }])
      )
    ).toBe('改写文件')
    expect(
      checkpointKindLabel(
        checkpoint('cp3', 3, 'multi_edit_file → 2 个文件', [
          { path: 'E:/p/a.ts', content: 'x', existed: true },
          { path: 'E:/p/b.ts', content: 'y', existed: true },
        ])
      )
    ).toBe('改写 2 个文件')
    expect(
      checkpointKindLabel(
        checkpoint('cp4', 4, 'delete_file → a.ts', [{ path: 'E:/p/a.ts', content: 'x', existed: true }])
      )
    ).toBe('删除文件')
    expect(checkpointKindLabel(checkpoint('cp5', 5, '', []))).toBe('写入')
  })
})

describe('checkpointStats · runDurationMs', () => {
  it('prefers the latest run window', () => {
    expect(runDurationMs([run(1000, 4000), run(5000, 7000)], [], 9999)).toBe(2000)
  })

  it('uses now() for a run still in flight', () => {
    expect(runDurationMs([run(1000)], [], 4000)).toBe(3000)
  })

  it('falls back to the checkpoint span when there are no runs', () => {
    const cps = [
      checkpoint('a', 1000, 'x', []),
      checkpoint('b', 3000, 'y', []),
      checkpoint('c', 4500, 'z', []),
    ]
    expect(runDurationMs(undefined, cps)).toBe(3500)
  })

  it('returns null when there is nothing to measure', () => {
    expect(runDurationMs([], [])).toBeNull()
    expect(runDurationMs(undefined, [checkpoint('a', 1, 'x', [])])).toBeNull()
  })
})
