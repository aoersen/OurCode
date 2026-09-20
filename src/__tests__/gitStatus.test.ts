import { describe, it, expect } from 'vitest'
import { parseGitStatusPorcelain, committableFiles, conflictedFiles } from '../utils/gitStatus'

describe('parseGitStatusPorcelain', () => {
  it('parses modified / added / deleted / untracked entries', () => {
    const output = [
      ' M src/a.ts', // unstaged modified
      'M  src/b.ts', // staged modified
      'A  src/c.ts', // staged added
      ' D src/d.ts', // unstaged deleted
      '?? src/new.ts', // untracked
    ].join('\n')
    expect(parseGitStatusPorcelain(output)).toEqual([
      { file: 'src/a.ts', status: 'modified', staged: false },
      { file: 'src/b.ts', status: 'modified', staged: true },
      { file: 'src/c.ts', status: 'added', staged: true },
      { file: 'src/d.ts', status: 'deleted', staged: false },
      { file: 'src/new.ts', status: 'untracked', staged: false },
    ])
  })

  it('parses rename entries (R  old -> new) and keeps the new path', () => {
    const entries = parseGitStatusPorcelain('R  src/old.ts -> src/new.ts\n')
    expect(entries).toEqual([
      { file: 'src/new.ts', status: 'renamed', staged: true, oldFile: 'src/old.ts' },
    ])
  })

  it('handles quoted rename paths with spaces', () => {
    const entries = parseGitStatusPorcelain('R  "src/my old.ts" -> "src/my new.ts"\n')
    expect(entries[0].file).toBe('src/my new.ts')
    expect(entries[0].oldFile).toBe('src/my old.ts')
  })

  it('skips untracked directory entries (?? dir/)', () => {
    const entries = parseGitStatusPorcelain('?? dist/\n?? src/file.ts\n')
    expect(entries).toEqual([{ file: 'src/file.ts', status: 'untracked', staged: false }])
  })

  it('splits partially staged files (MM) into staged + unstaged entries', () => {
    const entries = parseGitStatusPorcelain('MM src/partial.ts\n')
    expect(entries).toEqual([
      { file: 'src/partial.ts', status: 'modified', staged: true },
      { file: 'src/partial.ts', status: 'modified', staged: false },
    ])
  })

  it('splits AM (staged add + worktree modify) correctly', () => {
    const entries = parseGitStatusPorcelain('AM src/am.ts\n')
    expect(entries).toEqual([
      { file: 'src/am.ts', status: 'added', staged: true },
      { file: 'src/am.ts', status: 'modified', staged: false },
    ])
  })

  it('ignores empty lines and CRLF', () => {
    const entries = parseGitStatusPorcelain(' M a.ts\r\n\r\n M b.ts\r\n')
    expect(entries.map((e) => e.file)).toEqual(['a.ts', 'b.ts'])
  })

  it('returns [] for empty output', () => {
    expect(parseGitStatusPorcelain('')).toEqual([])
  })

  it('marks conflicted entries once, not as a staged + unstaged pair', () => {
    for (const pair of ['UU', 'AA', 'DD', 'AU', 'UA']) {
      const entries = parseGitStatusPorcelain(`${pair} src/conflict.ts`)
      expect(entries, pair).toHaveLength(1)
      expect(entries[0]).toMatchObject({ file: 'src/conflict.ts', conflict: true, staged: false })
    }
  })

  it('keeps non-conflicted entries unmarked', () => {
    expect(parseGitStatusPorcelain('MM src/partial.ts\n')[0].conflict).toBeUndefined()
  })
})

describe('committableFiles', () => {
  it('is the staged set only — untracked work is never implicit', () => {
    const entries = parseGitStatusPorcelain(['M  src/staged.ts', ' M src/other.ts', '?? src/new.ts'].join('\n'))
    expect(committableFiles(entries)).toEqual(['src/staged.ts'])
  })

  it('excludes conflicted files (git would refuse the commit anyway)', () => {
    const entries = parseGitStatusPorcelain(['M  src/ok.ts', 'UU src/bad.ts'].join('\n'))
    expect(committableFiles(entries)).toEqual(['src/ok.ts'])
  })

  it('counts a partially staged file once', () => {
    const entries = parseGitStatusPorcelain('MM src/partial.ts')
    expect(committableFiles(entries)).toEqual(['src/partial.ts'])
  })
})

describe('conflictedFiles', () => {
  it('lists only the conflicted paths', () => {
    const entries = parseGitStatusPorcelain(['M  a.ts', 'UU b.ts', '?? c.ts'].join('\n'))
    expect(conflictedFiles(entries)).toEqual(['b.ts'])
  })
})
