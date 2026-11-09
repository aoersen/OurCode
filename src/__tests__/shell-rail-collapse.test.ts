import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * uiStore 的会话栏折叠字段：`collapsedProjects` + toggle/set 两个动作。
 *
 * localStorage 换成一份内存实现（setup 里的默认桩是 no-op，读不到写进去的值），
 * 这样能真的验证「折叠状态持久化」。uiStore 在模块加载时就把 localStorage 读进
 * 初始 state，所以必须先把桩装好，再动态 import。
 */
const disk = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: (key: string) => disk.get(key) ?? null,
  setItem: (key: string, value: string) => { disk.set(key, value) },
  removeItem: (key: string) => { disk.delete(key) },
  clear: () => { disk.clear() },
  key: (index: number) => [...disk.keys()][index] ?? null,
  get length() { return disk.size },
})

const COLLAPSED_KEY = 'collapsedProjects'

let useUIStore: typeof import('@/stores/uiStore').useUIStore

beforeAll(async () => {
  // 上一次运行留下的折叠记录不应影响初始断言
  disk.delete(COLLAPSED_KEY)
  const mod = await import('@/stores/uiStore')
  useUIStore = mod.useUIStore
})

describe('uiStore.collapsedProjects（项目行折叠）', () => {
  it('初始为空数组', () => {
    expect(useUIStore.getState().collapsedProjects).toEqual([])
  })

  it('toggleProjectCollapsed 折叠再展开，并写入 localStorage', () => {
    const path = 'C:\\work\\demo'
    useUIStore.getState().toggleProjectCollapsed(path)
    expect(useUIStore.getState().collapsedProjects).toContain(path)
    expect(JSON.parse(disk.get(COLLAPSED_KEY) ?? '[]')).toContain(path)

    useUIStore.getState().toggleProjectCollapsed(path)
    expect(useUIStore.getState().collapsedProjects).not.toContain(path)
    expect(JSON.parse(disk.get(COLLAPSED_KEY) ?? '[]')).not.toContain(path)
  })

  it('setProjectCollapsed 幂等：重复设置同一状态不会写重复项', () => {
    const path = 'C:\\work\\other'
    useUIStore.getState().setProjectCollapsed(path, true)
    const first = useUIStore.getState().collapsedProjects
    useUIStore.getState().setProjectCollapsed(path, true)
    const second = useUIStore.getState().collapsedProjects

    expect(second.filter((p) => p === path)).toHaveLength(1)
    // 状态没变 → 直接返回 {}，数组引用保持不变（少一次无谓重渲染）
    expect(second).toBe(first)

    useUIStore.getState().setProjectCollapsed(path, false)
    expect(useUIStore.getState().collapsedProjects).not.toContain(path)
  })

  it('多个项目互不影响', () => {
    useUIStore.getState().setProjectCollapsed('C:\\a', true)
    useUIStore.getState().setProjectCollapsed('C:\\b', true)
    expect(useUIStore.getState().collapsedProjects).toEqual(
      expect.arrayContaining(['C:\\a', 'C:\\b']),
    )
    useUIStore.getState().setProjectCollapsed('C:\\a', false)
    expect(useUIStore.getState().collapsedProjects).toContain('C:\\b')
    expect(useUIStore.getState().collapsedProjects).not.toContain('C:\\a')
  })
})
