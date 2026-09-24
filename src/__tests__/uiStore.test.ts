import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useUIStore } from '@/stores/uiStore'

// Capture the pristine initial state so each test starts clean
const initialState = useUIStore.getState()

beforeEach(() => {
  useUIStore.setState(initialState)
  // Reset to the setup-file default (getItem → null); the restoreLastProject
  // tests re-stub localStorage/window per case.
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  })
})

describe('notifications', () => {
  it('showNotification appends a toast with info type by default', () => {
    useUIStore.getState().showNotification('hello')
    const notifications = useUIStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0].message).toBe('hello')
    expect(notifications[0].type).toBe('info')
  })

  it('respects the explicit type', () => {
    useUIStore.getState().showNotification('boom', 'error')
    expect(useUIStore.getState().notifications[0].type).toBe('error')
  })

  it('assigns monotonic ids', () => {
    useUIStore.getState().showNotification('a')
    useUIStore.getState().showNotification('b', 'warning')
    const [a, b] = useUIStore.getState().notifications
    expect(a.id).not.toBe(b.id)
  })

  it('ignores blank messages', () => {
    useUIStore.getState().showNotification('   ')
    expect(useUIStore.getState().notifications).toHaveLength(0)
  })

  it('caps the stack at 5, dropping the oldest', () => {
    for (let i = 1; i <= 6; i++) useUIStore.getState().showNotification(`m${i}`)
    const notifications = useUIStore.getState().notifications
    expect(notifications).toHaveLength(5)
    expect(notifications[0].message).toBe('m2')
    expect(notifications[4].message).toBe('m6')
  })

  it('dismissNotification removes by id', () => {
    useUIStore.getState().showNotification('a')
    useUIStore.getState().showNotification('b')
    const [first] = useUIStore.getState().notifications
    useUIStore.getState().dismissNotification(first.id)
    const notifications = useUIStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0].message).toBe('b')
  })
})

describe('restoreLastProject', () => {
  const saved = JSON.stringify({ path: 'C:/proj/restored', view: 'tree' })
  const existingStat = { size: 0, isFile: false, isDirectory: true, createdAt: 0, modifiedAt: 0 }

  // Persisted state says the last project was C:/proj/restored
  const stubSavedProject = () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'lastProjectState' ? saved : null),
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    })
  }

  it('opens (trusts) the project before probing it, then restores it', async () => {
    stubSavedProject()
    useUIStore.setState({ recentProjects: ['C:/proj/restored'] })
    const openProject = vi.fn(async () => {})
    const stat = vi.fn(async () => existingStat)
    vi.stubGlobal('window', { electronAPI: { openProject, stat } })

    await useUIStore.getState().restoreLastProject()

    // 打开即信任：恢复上次项目 = 再次打开它，openProject 先于 stat 探测
    expect(openProject).toHaveBeenCalledWith('C:/proj/restored')
    expect(stat).toHaveBeenCalledWith('C:/proj/restored')
    expect(useUIStore.getState().activeProjectPath).toBe('C:/proj/restored')
    expect(useUIStore.getState().projectListView).toBe('tree')
  })

  it('does not restore when the folder no longer exists on disk', async () => {
    stubSavedProject()
    useUIStore.setState({ recentProjects: ['C:/proj/restored'] })
    const openProject = vi.fn(async () => {})
    const stat = vi.fn(async () => { throw new Error('ENOENT') })
    vi.stubGlobal('window', { electronAPI: { openProject, stat } })

    await useUIStore.getState().restoreLastProject()

    expect(stat).toHaveBeenCalled()
    expect(useUIStore.getState().activeProjectPath).toBeNull()
    expect(useUIStore.getState().projectListView).toBe('list')
  })

  it('does not open paths that were never opened before', async () => {
    stubSavedProject()
    // recentProjects is empty → the restore is skipped entirely
    const openProject = vi.fn(async () => {})
    vi.stubGlobal('window', { electronAPI: { openProject } })

    await useUIStore.getState().restoreLastProject()

    expect(openProject).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeProjectPath).toBeNull()
  })

  it('does nothing when no project was saved', async () => {
    useUIStore.setState({ recentProjects: ['C:/proj/restored'] })
    const openProject = vi.fn(async () => {})
    vi.stubGlobal('window', { electronAPI: { openProject } })

    await useUIStore.getState().restoreLastProject()

    expect(openProject).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeProjectPath).toBeNull()
  })
})

describe('setRootPath', () => {
  it('registers the workspace root via fs:openProject (打开即信任)', () => {
    const openProject = vi.fn(async () => {})
    vi.stubGlobal('window', { electronAPI: { openProject } })

    useUIStore.getState().setRootPath('D:/gitee/pubgg502')

    // The file tree only mounts in tree view — list-view opens never mount it,
    // so the root must be trusted here or fs:* calls get rejected.
    expect(openProject).toHaveBeenCalledWith('D:/gitee/pubgg502')
    expect(useUIStore.getState().rootPath).toBe('D:/gitee/pubgg502')
  })

  it('does not openProject when the root is cleared', () => {
    const openProject = vi.fn(async () => {})
    vi.stubGlobal('window', { electronAPI: { openProject } })

    useUIStore.getState().setRootPath(null)

    expect(openProject).not.toHaveBeenCalled()
  })

  it('keeps the project list stable — re-opening a project never bumps it to the front', () => {
    vi.stubGlobal('window', { electronAPI: { openProject: vi.fn(async () => {}) } })

    useUIStore.getState().setRootPath('A')
    useUIStore.getState().setRootPath('B')
    useUIStore.getState().setRootPath('C')
    // Newly added projects land at the TOP (add order, newest first)
    expect(useUIStore.getState().recentProjects).toEqual(['C', 'B', 'A'])

    // Re-opening an existing project must NOT move it
    useUIStore.getState().setRootPath('A')
    expect(useUIStore.getState().recentProjects).toEqual(['C', 'B', 'A'])

    // A brand-new project goes to the top
    useUIStore.getState().setRootPath('D')
    expect(useUIStore.getState().recentProjects).toEqual(['D', 'C', 'B', 'A'])
  })

  it('persists the user-pinned drag order via reorderProjects', () => {
    useUIStore.getState().reorderProjects(['C', 'A', 'D'])
    expect(useUIStore.getState().projectOrder).toEqual(['C', 'A', 'D'])
  })
})

describe('removeProject', () => {
  const setup = () => {
    vi.stubGlobal('window', { electronAPI: { authorize: vi.fn(async () => {}) } })
    useUIStore.getState().setRootPath('A')
    useUIStore.getState().setRootPath('B')
    useUIStore.getState().reorderProjects(['B', 'A'])
  }

  it('removes the project from recent list, open-times and pinned order', () => {
    setup()
    useUIStore.getState().removeProject('A')

    const s = useUIStore.getState()
    expect(s.recentProjects).toEqual(['B'])
    expect(s.recentProjectTimes['A']).toBeUndefined()
    expect(s.projectOrder).toEqual(['B'])
    expect(s.removedProjects).toContain('A')
  })

  it('re-opening a removed project brings it back to the list', () => {
    setup()
    useUIStore.getState().setRootPath('A')
    useUIStore.getState().removeProject('A')
    expect(useUIStore.getState().recentProjects).not.toContain('A')
    expect(useUIStore.getState().removedProjects).toContain('A')

    // Re-opening the same path re-adds it to recentProjects…
    useUIStore.getState().setRootPath('A')
    // …and clears the removed flag so it shows in the list again.
    expect(useUIStore.getState().recentProjects).toContain('A')
    expect(useUIStore.getState().removedProjects).not.toContain('A')
  })

  it('exits the file-tree view when the viewed project is removed', () => {
    setup()
    useUIStore.getState().enterProject('A')
    expect(useUIStore.getState().projectListView).toBe('tree')
    expect(useUIStore.getState().activeProjectPath).toBe('A')

    useUIStore.getState().removeProject('A')

    const s = useUIStore.getState()
    expect(s.projectListView).toBe('list')
    expect(s.activeProjectPath).toBeNull()
    expect(s.rootPath).toBeNull()
  })

  it('clears the removed flag when the project is re-entered', () => {
    setup()
    useUIStore.getState().removeProject('B')
    expect(useUIStore.getState().removedProjects).toContain('B')

    useUIStore.getState().enterProject('B')

    expect(useUIStore.getState().removedProjects).not.toContain('B')
  })
})

describe('skillsRevision', () => {
  it('bumpSkillsRevision increments monotonically', () => {
    expect(useUIStore.getState().skillsRevision).toBe(0)
    useUIStore.getState().bumpSkillsRevision()
    useUIStore.getState().bumpSkillsRevision()
    expect(useUIStore.getState().skillsRevision).toBe(2)
  })
})
