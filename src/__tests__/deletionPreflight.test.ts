import { describe, it, expect, vi, beforeEach } from 'vitest'

// deletionPreflight 只依赖 window.electronAPI.stat / listDir —— 用桩替代主进程。
const statStub = vi.fn()
const listDirStub = vi.fn()

beforeEach(() => {
  statStub.mockReset()
  listDirStub.mockReset()
  statStub.mockResolvedValue({ size: 10, isFile: true, isDirectory: false, createdAt: 0, modifiedAt: 0 })
  listDirStub.mockResolvedValue([])
  vi.stubGlobal('window', {
    electronAPI: {
      stat: (p: string) => statStub(p),
      listDir: (p: string) => listDirStub(p),
    },
  })
})

const PROJECT = 'E:/work/demo'

describe('classifyNecessity', () => {
  it('treats empty / vague reasons as questionable', async () => {
    const { classifyNecessity } = await import('@/services/company/deletionPreflight')
    for (const reason of ['', '   ', 'cleanup', '清理', '删掉', '不需要了', 'remove']) {
      expect(classifyNecessity(reason), reason).toBe('questionable')
    }
  })

  it('accepts a concrete reason', async () => {
    const { classifyNecessity } = await import('@/services/company/deletionPreflight')
    expect(classifyNecessity('旧实现已被 src/legacy/index.ts 取代，删掉避免重复导出')).toBe('required')
  })
})

describe('preflightDeletion', () => {
  it('allows an in-project file and reports it as revertable', async () => {
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    const r = await preflightDeletion({ path: `${PROJECT}/src/legacy.ts`, projectPath: PROJECT, reason: '被新实现取代，已确认无引用' })
    expect(r.insideWorkspace).toBe(true)
    expect(r.reversible).toBe(true)
    expect(r.risk).toBe('low')
    expect(r.blockReason).toBeUndefined()
    expect(r.summary).toContain('项目内')
  })

  it('does not mistake ordinary project directories named bin/etc/system for system dirs', async () => {
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    for (const p of [`${PROJECT}/src/bin/cli.ts`, `${PROJECT}/config/etc/app.yml`, `${PROJECT}/system/core.ts`]) {
      const r = await preflightDeletion({ path: p, projectPath: PROJECT })
      expect(r.systemPath, p).toBe(false)
      expect(r.blockReason, p).toBeUndefined()
      expect(r.insideWorkspace).toBe(true)
    }
  })

  it('treats generated dirs as rebuildable, not as a risk', async () => {
    statStub.mockResolvedValue({ size: 0, isFile: false, isDirectory: true, createdAt: 0, modifiedAt: 0 })
    listDirStub.mockResolvedValue([{ name: 'a' }, { name: 'b' }])
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    const r = await preflightDeletion({ path: `${PROJECT}/build`, projectPath: PROJECT })
    expect(r.rebuildable).toBe(true)
    expect(r.reversible).toBe(true)
    expect(r.risk).toBe('low')
    expect(r.summary).toContain('可重建')
  })

  it('flags a user-data path outside the workspace as high risk and non-revertable', async () => {
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    const r = await preflightDeletion({
      path: 'C:/Users/29486/Documents/报表.xlsx',
      projectPath: PROJECT,
      reason: '客户要求清理旧报表，已确认是过期版本',
    })
    expect(r.insideWorkspace).toBe(false)
    expect(r.looksLikeUserData).toBe(true)
    expect(r.reversible).toBe(false)
    expect(r.risk).toBe('high')
    expect(r.blockReason).toBeUndefined() // 提示但不拦（无人值守的目录才拦）
  })

  it('blocks drive roots, system dirs, home root, AppData root, workspace root and .git', async () => {
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    for (const target of [
      'C:/', 'D:\\', 'C:/Windows', 'C:/Program Files', '/etc',
      'C:/Users/29486', '%USERPROFILE%', '%APPDATA%',
      PROJECT, `${PROJECT}/.git`,
    ]) {
      const r = await preflightDeletion({ path: target, projectPath: PROJECT })
      expect(r.blockReason, target).toBeTruthy()
      expect(r.risk).toBe('high')
    }
  })

  it('never claims an outside path is revertable just because it looks rebuildable', async () => {
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    const r = await preflightDeletion({ path: 'D:/build/important.txt', projectPath: PROJECT })
    expect(r.insideWorkspace).toBe(false)
    expect(r.rebuildable).toBe(true)
    expect(r.reversible).toBe(false)
    expect(r.summary).toContain('可重建')
    expect(r.summary).toContain('不在快照内')
  })

  it('resolves .. escapes instead of treating them as inside the workspace', async () => {
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    const r = await preflightDeletion({ path: `${PROJECT}/../outside.txt`, projectPath: PROJECT })
    expect(r.insideWorkspace).toBe(false)
    expect(r.reversible).toBe(false)
  })

  it('blocks outside directories in unattended mode unless rebuildable/temp', async () => {
    statStub.mockResolvedValue({ size: 0, isFile: false, isDirectory: true, createdAt: 0, modifiedAt: 0 })
    listDirStub.mockResolvedValue([{ name: 'a' }])
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    const blocked = await preflightDeletion({ path: 'D:/other-project', projectPath: PROJECT, unattended: true })
    expect(blocked.blockReason).toBeTruthy()
    const rebuildable = await preflightDeletion({ path: 'D:/other-project/dist', projectPath: PROJECT, unattended: true })
    expect(rebuildable.blockReason).toBeUndefined()
    const temp = await preflightDeletion({ path: 'C:/Users/29486/AppData/Local/Temp/x', projectPath: PROJECT, unattended: true })
    expect(temp.blockReason).toBeUndefined()
  })

  it('blocks a directory that contains a nested .git', async () => {
    statStub.mockResolvedValue({ size: 0, isFile: false, isDirectory: true, createdAt: 0, modifiedAt: 0 })
    listDirStub.mockResolvedValue([{ name: '.git' }, { name: 'src' }])
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    const r = await preflightDeletion({ path: `${PROJECT}/vendor/lib`, projectPath: PROJECT })
    expect(r.containsGitDir).toBe(true)
    expect(r.blockReason).toBeTruthy()
  })

  it('degrades gracefully when stat fails', async () => {
    statStub.mockRejectedValue(new Error('EPERM'))
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    const r = await preflightDeletion({ path: `${PROJECT}/locked.txt`, projectPath: PROJECT })
    expect(r.isDirectory).toBe(false)
    expect(r.blockReason).toBeUndefined()
  })

  it('raises risk for a large directory inside the workspace', async () => {
    statStub.mockResolvedValue({ size: 0, isFile: false, isDirectory: true, createdAt: 0, modifiedAt: 0 })
    listDirStub.mockResolvedValue(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}` })))
    const { preflightDeletion } = await import('@/services/company/deletionPreflight')
    const r = await preflightDeletion({ path: `${PROJECT}/src`, projectPath: PROJECT })
    expect(r.isDirectory).toBe(true)
    expect(r.entryCount).toBe(60)
    expect(r.risk).toBe('medium')
  })
})
