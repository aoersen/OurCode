/**
 * Per-change ("hunk") review of an AI edit.
 *
 * The checkpoint diff view compares the pre-edit snapshot (`original`) with the
 * file as it is now (`modified`) — the AI change is ALREADY on disk, so
 * reviewing a block means either keeping it or putting the old lines back:
 *
 *  - reject → splice the original lines into the current document (and persist)
 *  - accept → splice the current lines into the snapshot, i.e. advance the
 *    baseline so the block stops showing up as a difference (view-only)
 *
 * Both directions are the same line splice, which is why they share one core.
 *
 * Ranges come from Monaco's `IStandaloneDiffEditor.getLineChanges()`, whose line
 * numbers are 1-based with `0` meaning "nothing on that side" (a pure insertion
 * has `originalStartLineNumber === 0`, a pure deletion
 * `modifiedStartLineNumber === 0`). `normalizeChanges` resolves those zeros into
 * real, possibly-empty spans on both documents so the two directions stay
 * symmetric; everything else is computed on line arrays, which keeps the
 * newline handling explicit and testable.
 *
 * Invariant used throughout: a Monaco model's text is exactly
 * `model.getLinesContent().join(model.getEOL())` (a file ending in a newline has
 * a final empty line), so the returned `range` + `text` applied to the input
 * lines always yield `nextLines`.
 */

/** The subset of Monaco's ILineChange this module needs. */
export interface LineChangeLike {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

/** A change with Monaco's "0 = nothing on that side" resolved into 1-based
 *  spans on both documents. An empty span has `end === start - 1`. */
export interface NormalizedChange {
  originalStart: number
  originalEnd: number
  modifiedStart: number
  modifiedEnd: number
}

export interface LinePos {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface SpliceEdit {
  /** Whole-line range to replace in the document being edited. */
  range: LinePos
  /** Replacement text (may be empty). */
  text: string
  /** The document after the edit, split into lines. */
  nextLines: string[]
}

const EOF_COLUMN = Number.MAX_SAFE_INTEGER

/**
 * Locate a change captured earlier in a freshly computed list. Monaco returns new
 * `ILineChange` objects on every `getLineChanges()` call, so identity can't be
 * used; the four line numbers are what identifies a block between recomputes.
 * Returns -1 when the block is gone (the document moved under the review).
 */
export function findChangeIndex(changes: readonly LineChangeLike[], target: LineChangeLike): number {
  return changes.findIndex(
    (c) =>
      c.originalStartLineNumber === target.originalStartLineNumber &&
      c.originalEndLineNumber === target.originalEndLineNumber &&
      c.modifiedStartLineNumber === target.modifiedStartLineNumber &&
      c.modifiedEndLineNumber === target.modifiedEndLineNumber
  )
}

/**
 * Resolve Monaco's zero line numbers into anchors on the other document by
 * walking the changes in order (Monaco reports them sorted, non-overlapping) and
 * tracking how many lines each side has consumed.
 */
export function normalizeChanges(
  changes: readonly LineChangeLike[],
  originalLineCount: number,
  modifiedLineCount: number
): NormalizedChange[] {
  const out: NormalizedChange[] = []
  // (modified lines consumed) - (original lines consumed) so far.
  let delta = 0
  for (const change of changes) {
    const oStart = change.originalStartLineNumber
    const oEnd = Math.max(change.originalEndLineNumber, oStart)
    const mStart = change.modifiedStartLineNumber
    const mEnd = Math.max(change.modifiedEndLineNumber, mStart)

    let originalStart: number
    let originalEnd: number
    let modifiedStart: number
    let modifiedEnd: number

    if (oStart < 1) {
      // Pure insertion: anchor it after this many original lines.
      const after = clamp(mStart - 1 - delta, 0, originalLineCount)
      originalStart = after + 1
      originalEnd = after
      modifiedStart = mStart
      modifiedEnd = mEnd
    } else if (mStart < 1) {
      // Pure deletion: anchor it after this many current-document lines.
      const after = clamp(oStart - 1 + delta, 0, modifiedLineCount)
      modifiedStart = after + 1
      modifiedEnd = after
      originalStart = oStart
      originalEnd = oEnd
    } else {
      originalStart = oStart
      originalEnd = oEnd
      modifiedStart = mStart
      modifiedEnd = mEnd
    }

    delta += (modifiedEnd - modifiedStart + 1) - (originalEnd - originalStart + 1)
    out.push({ originalStart, originalEnd, modifiedStart, modifiedEnd })
  }
  return out
}

/** The current document with this block reverted to the snapshot's lines. */
export function rejectChangeEdit(
  change: NormalizedChange,
  originalLines: string[],
  modifiedLines: string[],
  eol = '\n'
): SpliceEdit | null {
  return spliceLines(
    modifiedLines,
    change.modifiedStart,
    change.modifiedEnd,
    blockOf(originalLines, change.originalStart, change.originalEnd),
    eol
  )
}

/** The snapshot with this block folded in — the change is accepted, so it stops
 *  being a difference. The file on disk is untouched. */
export function acceptChangeEdit(
  change: NormalizedChange,
  originalLines: string[],
  modifiedLines: string[],
  eol = '\n'
): SpliceEdit | null {
  return spliceLines(
    originalLines,
    change.originalStart,
    change.originalEnd,
    blockOf(modifiedLines, change.modifiedStart, change.modifiedEnd),
    eol
  )
}

function blockOf(lines: string[], start: number, end: number): string[] {
  return end >= start ? lines.slice(start - 1, end) : []
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Replace `start..end` (1-based, inclusive; empty when `end === start - 1`) of
 * `target` with `block`, then re-derive the minimal differing whole-line span so
 * unrelated lines keep their identity and the result is one surgical, undoable
 * edit. Returns null when nothing changes.
 */
function spliceLines(
  target: string[],
  start: number,
  end: number,
  block: string[],
  eol: string
): SpliceEdit | null {
  const nextLines = target.slice()
  const from = clamp(start - 1, 0, nextLines.length)
  const to = end >= start ? clamp(end, 0, nextLines.length) : from
  nextLines.splice(from, to - from, ...block)
  // A Monaco model always has at least one line.
  if (nextLines.length === 0) nextLines.push('')
  if (sameLines(nextLines, target)) return null

  let first = 0
  while (first < target.length && first < nextLines.length && target[first] === nextLines[first]) first++
  let lastOld = target.length - 1
  let lastNew = nextLines.length - 1
  while (lastOld >= first && lastNew >= first && target[lastOld] === nextLines[lastNew]) {
    lastOld--
    lastNew--
  }
  const inserted = nextLines.slice(first, lastNew + 1)
  const reachesEnd = lastOld >= target.length - 1
  const pureInsert = lastOld < first

  if (!reachesEnd) {
    // Absorb the following line break so whole lines are replaced.
    return {
      range: { startLineNumber: first + 1, startColumn: 1, endLineNumber: lastOld + 2, endColumn: 1 },
      text: inserted.length ? inserted.join(eol) + eol : '',
      nextLines,
    }
  }
  if (pureInsert && inserted.length) {
    return {
      range: { startLineNumber: lastOld + 1, startColumn: EOF_COLUMN, endLineNumber: lastOld + 1, endColumn: EOF_COLUMN },
      text: eol + inserted.join(eol),
      nextLines,
    }
  }
  if (inserted.length) {
    return {
      range: { startLineNumber: first + 1, startColumn: 1, endLineNumber: lastOld + 1, endColumn: EOF_COLUMN },
      text: inserted.join(eol),
      nextLines,
    }
  }
  // Deleting through the last line takes the line break before the block too.
  return {
    range: {
      startLineNumber: first > 0 ? first : 1,
      startColumn: first > 0 ? EOF_COLUMN : 1,
      endLineNumber: lastOld + 1,
      endColumn: EOF_COLUMN,
    },
    text: '',
    nextLines,
  }
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}
