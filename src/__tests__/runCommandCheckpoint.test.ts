import { describe, it, expect } from 'vitest'
import { parsePorcelainZ, classifyCandidates, type RunFileState } from '@/services/runCommandCheckpoint'

function fileState(overrides: Partial<RunFileState> = {}): RunFileState {
  return { existed: true, content: 'x', tracked: true, ...overrides }
}

describe('parsePorcelainZ', () => {
  it('parses plain modified / untracked entries', () => {
    const entries = parsePorcelainZ(' M src/a.ts\0?? new.txt\0A  added.ts\0')
    expect(entries).toEqual([
      { code: ' M', path: 'src/a.ts' },
      { code: '??', path: 'new.txt' },
      { code: 'A ', path: 'added.ts' },
    ])
  })

  it('keeps spaces inside paths intact (-z form)', () => {
    const entries = parsePorcelainZ(' M my dir/file one.ts\0')
    expect(entries).toEqual([{ code: ' M', path: 'my dir/file one.ts' }])
  })

  it('rename entries carry their trailing old-path item in renameFrom', () => {
    const entries = parsePorcelainZ('R  new.ts\0old.ts\0 M after.ts\0')
    expect(entries).toEqual([
      { code: 'R ', path: 'new.ts', renameFrom: 'old.ts' },
      { code: ' M', path: 'after.ts' },
    ])
  })

  it('rename entries without an old-path item do not crash', () => {
    const entries = parsePorcelainZ('R  new.ts\0')
    expect(entries).toEqual([{ code: 'R ', path: 'new.ts', renameFrom: undefined }])
  })

  it('survives empty and garbage output', () => {
    expect(parsePorcelainZ('')).toEqual([])
    expect(parsePorcelainZ('ab\0')).toEqual([])
  })
})

describe('classifyCandidates', () => {
  it('files dirty before the run come from the capture', () => {
    const pre = new Map([['a.ts', fileState()]])
    const post = new Map([['a.ts', ' M']])
    expect(classifyCandidates(pre, post)).toEqual([{ rel: 'a.ts', source: 'captured' }])
  })

  it('a dirty file the command cleaned back to HEAD is still captured', () => {
    const pre = new Map([['a.ts', fileState()]])
    expect(classifyCandidates(pre, new Map())).toEqual([{ rel: 'a.ts', source: 'captured' }])
  })

  it('files clean before the run come from HEAD (modified or deleted)', () => {
    const post = new Map([['a.ts', ' M'], ['b.ts', ' D']])
    expect(classifyCandidates(new Map(), post)).toEqual([
      { rel: 'a.ts', source: 'head' },
      { rel: 'b.ts', source: 'head' },
    ])
  })

  it('untracked files the command created are marked as new', () => {
    const post = new Map([['gen.txt', '??']])
    expect(classifyCandidates(new Map(), post)).toEqual([{ rel: 'gen.txt', source: 'new' }])
  })

  it('oversized captures are skipped (revert would write empty content)', () => {
    const pre = new Map([['big.bin', fileState({ oversized: true })]])
    const post = new Map([['big.bin', ' M']])
    expect(classifyCandidates(pre, post)).toEqual([{ rel: 'big.bin', source: 'skip' }])
  })

  it('an untracked file deleted by the command is captured (restore-able)', () => {
    const pre = new Map([['gone.txt', fileState({ tracked: false })]])
    expect(classifyCandidates(pre, new Map())).toEqual([{ rel: 'gone.txt', source: 'captured' }])
  })
})
