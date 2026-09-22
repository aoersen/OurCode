import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  sanitizeLabel,
  isGitRepo,
  createPhaseCheckpoint,
  listPhaseCheckpoints,
  rollbackToPhase,
} from '@/services/targetMode/phaseCheckpoint'

describe('phaseCheckpoint.sanitizeLabel', () => {
  it('keeps Chinese chars, replaces separators', () => {
    expect(sanitizeLabel('研发')).toBe('研发')
    expect(sanitizeLabel('UI 开发')).toBe('UI-开发')
    expect(sanitizeLabel('a/b*c')).toBe('a-b-c')
  })

  it('falls back to phase for empty label, trims to 24 chars', () => {
    expect(sanitizeLabel('')).toBe('phase')
    expect(sanitizeLabel('x'.repeat(60)).length).toBeLessThanOrEqual(24)
  })
})

describe('phaseCheckpoint git layer', () => {
  const root = 'C:/workspace'
  let git: ReturnType<typeof vi.fn>

  beforeEach(() => {
    git = vi.fn()
    vi.stubGlobal('window', { electronAPI: { gitExec: git } })
  })

  it('isGitRepo true when rev-parse says so', async () => {
    git.mockResolvedValue({ success: true, output: 'true' })
    expect(await isGitRepo(root)).toBe(true)
    expect(git).toHaveBeenCalledWith(root, ['rev-parse', '--is-inside-work-tree'])
  })

  it('isGitRepo false on failure or exception', async () => {
    git.mockResolvedValue({ success: false, output: '', error: 'not a repo' })
    expect(await isGitRepo(root)).toBe(false)
    git.mockRejectedValue(new Error('boom'))
    expect(await isGitRepo(root)).toBe(false)
    expect(await isGitRepo('')).toBe(false)
  })

  it('createPhaseCheckpoint tags HEAD and returns the tag name', async () => {
    git.mockResolvedValue({ success: true, output: '' })
    const tag = await createPhaseCheckpoint(root, '研发')
    expect(tag).toMatch(/^ourcode\/tm-研发-[\w]+$/)
    expect(git).toHaveBeenCalledWith(root, ['tag', tag, '-m', '研发'])
  })

  it('createPhaseCheckpoint returns null when git fails', async () => {
    git.mockResolvedValue({ success: false, output: '', error: 'x' })
    expect(await createPhaseCheckpoint(root, '研发')).toBeNull()
    expect(await createPhaseCheckpoint('', '研发')).toBeNull()
  })

  it('listPhaseCheckpoints parses tags + created dates (newest first via git sort)', async () => {
    git
      .mockResolvedValueOnce({ success: true, output: 'ourcode/tm-测试-abc\nourcode/tm-研发-def' })
      .mockResolvedValueOnce({ success: true, output: '2026-08-28T10:00:00+08:00' })
      .mockResolvedValueOnce({ success: true, output: '2026-08-27T09:00:00+08:00' })
    const items = await listPhaseCheckpoints(root)
    expect(items).toEqual([
      { tag: 'ourcode/tm-测试-abc', label: '测试', createdAt: '2026-08-28T10:00:00+08:00' },
      { tag: 'ourcode/tm-研发-def', label: '研发', createdAt: '2026-08-27T09:00:00+08:00' },
    ])
  })

  it('listPhaseCheckpoints returns [] when no tags or failure', async () => {
    git.mockResolvedValue({ success: true, output: '' })
    expect(await listPhaseCheckpoints(root)).toEqual([])
    git.mockResolvedValue({ success: false, output: '', error: 'x' })
    expect(await listPhaseCheckpoints(root)).toEqual([])
  })

  it('rollbackToPhase creates a branch at the tag (non-destructive)', async () => {
    git.mockResolvedValue({ success: true, output: '' })
    const res = await rollbackToPhase(root, 'ourcode/tm-研发-abc')
    expect(res.ok).toBe(true)
    expect(res.branch).toMatch(/^ourcode\/rb-[\w]+$/)
    expect(git).toHaveBeenCalledWith(root, ['switch', '-c', res.branch, 'ourcode/tm-研发-abc'])
  })

  it('rollbackToPhase reports failure with guidance', async () => {
    git.mockResolvedValue({ success: false, output: '', error: 'conflict' })
    const res = await rollbackToPhase(root, 'ourcode/tm-研发-abc')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('git switch')
  })
})
