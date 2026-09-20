import { describe, it, expect } from 'vitest'
import {
  acceptChangeEdit,
  findChangeIndex,
  normalizeChanges,
  rejectChangeEdit,
  LineChangeLike,
  NormalizedChange,
  SpliceEdit,
} from '@/utils/diffReview'

/**
 * Reference implementation of Monaco's `applyEdits` for a single whole-line
 * range: columns are 1-based and clamp to the end of their line. Every case
 * below asserts the returned range+text really produces `nextLines`, which is
 * what keeps the newline/EOF math honest.
 */
function apply(lines: string[], edit: SpliceEdit, eol: string): string[] {
  const offsetOf = (line: number, column: number) => {
    let offset = 0
    for (let i = 0; i < line - 1; i++) offset += lines[i].length + eol.length
    const content = lines[line - 1] ?? ''
    return offset + Math.min(column - 1, content.length)
  }
  const start = offsetOf(edit.range.startLineNumber, edit.range.startColumn)
  const end = offsetOf(edit.range.endLineNumber, edit.range.endColumn)
  const text = lines.join(eol)
  return (text.slice(0, start) + edit.text + text.slice(end)).split(eol)
}

/** A change whose spans are already resolved (nothing on either side is zero). */
function change(partial: Partial<NormalizedChange>): NormalizedChange {
  return {
    originalStart: 1,
    originalEnd: 1,
    modifiedStart: 1,
    modifiedEnd: 1,
    ...partial,
  }
}

function raw(partial: Partial<LineChangeLike>): LineChangeLike {
  return {
    originalStartLineNumber: 0,
    originalEndLineNumber: 0,
    modifiedStartLineNumber: 0,
    modifiedEndLineNumber: 0,
    ...partial,
  }
}

/** Reject, asserting the resulting lines AND that range+text reproduces them. */
function expectReject(
  c: NormalizedChange,
  original: string[],
  modified: string[],
  expected: string[],
  eol = '\n'
): SpliceEdit {
  const edit = rejectChangeEdit(c, original, modified, eol)
  expect(edit).not.toBeNull()
  expect(edit!.nextLines).toEqual(expected)
  expect(apply(modified, edit!, eol)).toEqual(expected)
  return edit!
}

function expectAccept(
  c: NormalizedChange,
  original: string[],
  modified: string[],
  expected: string[],
  eol = '\n'
): SpliceEdit {
  const edit = acceptChangeEdit(c, original, modified, eol)
  expect(edit).not.toBeNull()
  expect(edit!.nextLines).toEqual(expected)
  expect(apply(original, edit!, eol)).toEqual(expected)
  return edit!
}

describe('findChangeIndex', () => {
  it('matches a captured change against a freshly computed list', () => {
    const captured = raw({ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 })
    const fresh = [
      raw({ originalStartLineNumber: 6, originalEndLineNumber: 6, modifiedStartLineNumber: 6, modifiedEndLineNumber: 6 }),
      raw({ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 }),
    ]
    expect(findChangeIndex(fresh, captured)).toBe(1)
  })

  it('reports a block that no longer exists', () => {
    expect(findChangeIndex([raw({ originalStartLineNumber: 2, originalEndLineNumber: 2 })], raw({ originalStartLineNumber: 5, originalEndLineNumber: 5 }))).toBe(-1)
  })
})

describe('normalizeChanges', () => {
  it('passes a change with both sides through unchanged', () => {
    expect(normalizeChanges([raw({ originalStartLineNumber: 2, originalEndLineNumber: 3, modifiedStartLineNumber: 2, modifiedEndLineNumber: 4 })], 5, 6)).toEqual([
      change({ originalStart: 2, originalEnd: 3, modifiedStart: 2, modifiedEnd: 4 }),
    ])
  })

  it('anchors a pure insertion on the snapshot side', () => {
    // 'X' added after 'a' in a|b|c
    expect(normalizeChanges([raw({ modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 })], 3, 4)).toEqual([
      change({ originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 2 }),
    ])
  })

  it('anchors a pure deletion on the current-document side', () => {
    // 'b' removed from a|b|c
    expect(normalizeChanges([raw({ originalStartLineNumber: 2, originalEndLineNumber: 2 })], 3, 2)).toEqual([
      change({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 1 }),
    ])
  })

  it('shifts later anchors by the lines earlier changes added or removed', () => {
    const original = ['a', 'b', 'c', 'd']
    const modified = ['a', 'X', 'b', 'c', 'Y', 'Z', 'd']
    const [first, second] = normalizeChanges(
      [
        raw({ modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 }),
        raw({ modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 }),
      ],
      original.length,
      modified.length
    )
    expect(first).toEqual(change({ originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 2 }))
    // +1 line consumed by the first change: 'Y','Z' sit after original line 3.
    expect(second).toEqual(change({ originalStart: 4, originalEnd: 3, modifiedStart: 5, modifiedEnd: 6 }))
  })

  it('keeps deletions anchored at the end of a shortened document', () => {
    const original = ['a', 'b', 'c', 'd', 'e']
    const modified = ['a', 'c', 'd']
    const [first, second] = normalizeChanges(
      [
        raw({ originalStartLineNumber: 2, originalEndLineNumber: 2 }),
        raw({ originalStartLineNumber: 5, originalEndLineNumber: 5 }),
      ],
      original.length,
      modified.length
    )
    expect(first).toEqual(change({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 1 }))
    expect(second).toEqual(change({ originalStart: 5, originalEnd: 5, modifiedStart: 4, modifiedEnd: 3 }))
  })
})

describe('rejectChangeEdit', () => {
  const original = ['a', 'X', 'b']
  const modified = ['a', 'Y1', 'Y2', 'b']
  const c = change({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 3 })

  it('puts the snapshot lines back in the middle of the file', () => {
    const edit = expectReject(c, original, modified, ['a', 'X', 'b'])
    // One surgical replacement that absorbs the trailing line break.
    expect(edit.range).toEqual({ startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 1 })
    expect(edit.text).toBe('X\n')
  })

  it('drops lines the AI inserted', () => {
    expectReject(
      change({ originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 2 }),
      ['a', 'b'],
      ['a', 'N', 'b'],
      ['a', 'b']
    )
  })

  it('restores lines the AI deleted', () => {
    expectReject(
      change({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 1 }),
      ['a', 'X', 'b'],
      ['a', 'b'],
      ['a', 'X', 'b']
    )
  })

  it('restores lines the AI deleted at the end of the file', () => {
    expectReject(
      change({ originalStart: 2, originalEnd: 3, modifiedStart: 2, modifiedEnd: 1 }),
      ['a', 'X', 'Y'],
      ['a'],
      ['a', 'X', 'Y']
    )
  })

  it('removes lines the AI appended at the end of the file', () => {
    expectReject(
      change({ originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 3 }),
      ['a'],
      ['a', 'X', 'Y'],
      ['a']
    )
  })

  it('rewrites a replacement that reaches the end of the file', () => {
    expectReject(
      change({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 3 }),
      ['a', 'X'],
      ['a', 'Y1', 'Y2'],
      ['a', 'X']
    )
  })

  it('keeps the trailing newline of the document', () => {
    // Monaco represents "a\nb\n" as ['a','b',''].
    expectReject(
      change({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 2 }),
      ['a', 'X', 'b', ''],
      ['a', 'Y', 'b', ''],
      ['a', 'X', 'b', '']
    )
  })

  it('handles CRLF documents', () => {
    expectReject(
      c,
      ['a', 'X', 'b'],
      ['a', 'Y1', 'Y2', 'b'],
      ['a', 'X', 'b'],
      '\r\n'
    )
  })

  it('returns null when the block is already identical', () => {
    expect(rejectChangeEdit(change({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 2 }), ['a', 'X'], ['a', 'X'])).toBeNull()
  })

  it('shrinks the edit to the lines that actually differ', () => {
    const edit = expectReject(
      change({ originalStart: 2, originalEnd: 4, modifiedStart: 2, modifiedEnd: 4 }),
      ['a', '{', 'x', '}'],
      ['a', '{', 'y', '}'],
      ['a', '{', 'x', '}']
    )
    expect(edit.range).toEqual({ startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 1 })
    expect(edit.text).toBe('x\n')
  })
})

describe('acceptChangeEdit', () => {
  it('folds the current lines into the snapshot so the block stops diffing', () => {
    expectAccept(
      change({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 3 }),
      ['a', 'X', 'b'],
      ['a', 'Y1', 'Y2', 'b'],
      ['a', 'Y1', 'Y2', 'b']
    )
  })

  it('adds AI-inserted lines to the snapshot', () => {
    expectAccept(
      change({ originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 2 }),
      ['a', 'b'],
      ['a', 'N', 'b'],
      ['a', 'N', 'b']
    )
  })

  it('adds AI-inserted lines to the end of the snapshot', () => {
    expectAccept(
      change({ originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 3 }),
      ['a'],
      ['a', 'X', 'Y'],
      ['a', 'X', 'Y']
    )
  })

  it('drops AI-deleted lines from the snapshot', () => {
    expectAccept(
      change({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 1 }),
      ['a', 'X', 'b'],
      ['a', 'b'],
      ['a', 'b']
    )
  })

  it('drops AI-deleted lines at the end of the snapshot', () => {
    expectAccept(
      change({ originalStart: 2, originalEnd: 3, modifiedStart: 2, modifiedEnd: 1 }),
      ['a', 'X', 'Y'],
      ['a'],
      ['a']
    )
  })

  it('returns null when the snapshot already matches', () => {
    expect(acceptChangeEdit(change({ originalStart: 1, originalEnd: 1, modifiedStart: 1, modifiedEnd: 1 }), ['a'], ['a'])).toBeNull()
  })

  it('never leaves the snapshot with zero lines', () => {
    const edit = expectAccept(
      change({ originalStart: 1, originalEnd: 2, modifiedStart: 2, modifiedEnd: 1 }),
      ['X', 'Y'],
      [],
      ['']
    )
    expect(edit.text).toBe('')
  })
})
