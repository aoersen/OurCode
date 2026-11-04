import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { captureCheckpoint } from '@/services/checkpointService'

const readFileStub = vi.fn()
const createStub = vi.fn()

beforeEach(() => {
  readFileStub.mockReset()
  createStub.mockReset()
  createStub.mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    electronAPI: {
      readFile: (p: string) => readFileStub(p),
      checkpointCreate: (cp: unknown) => createStub(cp),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('captureCheckpoint read-failure semantics', () => {
  it('records a normal pre-image for an existing file', async () => {
    readFileStub.mockResolvedValue({ content: 'old', encoding: 'utf-8', hasBom: false })
    const cp = await captureCheckpoint('s1', { name: 'edit_file', arguments: { path: 'E:/p/a.ts' } })
    expect(cp?.files).toEqual([{ path: 'E:/p/a.ts', content: 'old', existed: true }])
  })

  it('treats ENOENT as a genuinely new file (revert should delete it)', async () => {
    readFileStub.mockRejectedValue(new Error("Error: ENOENT: no such file or directory, open 'E:/p/new.ts'"))
    const cp = await captureCheckpoint('s1', { name: 'write_file', arguments: { path: 'E:/p/new.ts' } })
    expect(cp?.files[0]).toEqual({ path: 'E:/p/new.ts', content: '', existed: false })
    expect(cp?.files[0].snapshotFailed).toBeUndefined()
  })

  it('marks an unreadable existing file instead of recording a destructive "absent"', async () => {
    readFileStub.mockRejectedValue(new Error('EBUSY: resource busy or locked'))
    const cp = await captureCheckpoint('s1', { name: 'edit_file', arguments: { path: 'E:/p/locked.ts' } })
    expect(cp?.files[0].path).toBe('E:/p/locked.ts')
    expect(cp?.files[0].existed).toBe(false)
    expect(cp?.files[0].snapshotFailed).toBe(true)
  })

  it('skips create_directory (no file pre-image)', async () => {
    const cp = await captureCheckpoint('s1', { name: 'create_directory', arguments: { path: 'E:/p/new-dir' } })
    expect(cp).toBeNull()
  })
})
