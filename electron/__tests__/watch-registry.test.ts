import { describe, it, expect, vi } from 'vitest'
import { createWatchRegistry } from '../services/watch-registry'

/**
 * 一个工作区只应有一份 chokidar watcher。渲染侧的文件树组件会随视图反复挂载/
 * 卸载（切侧栏标签、项目列表↔文件树、折叠侧栏、第二个窗口），如果每次挂载都
 * 重新注册，就会在每次交互里重复一遍"主进程全工作区递归扫描"。这里锁死
 * 引用计数的语义：首次 acquire 才 start，最后一个 release 才 stop。
 */
describe('createWatchRegistry', () => {
  const makeRegistry = (keyOf?: (root: string) => string) => {
    const start = vi.fn(async (_root: string) => {})
    const stop = vi.fn((_root: string) => {})
    const registry = createWatchRegistry({ start, stop, keyOf })
    return { registry, start, stop }
  }

  it('starts on the first acquire and stops only on the last release', async () => {
    const { registry, start, stop } = makeRegistry()

    await registry.acquire('E:/repo')
    await registry.acquire('E:/repo')
    expect(start).toHaveBeenCalledTimes(1)
    expect(registry.count('E:/repo')).toBe(2)

    registry.release('E:/repo')
    expect(stop).not.toHaveBeenCalled()
    expect(registry.count('E:/repo')).toBe(1)

    registry.release('E:/repo')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(registry.count('E:/repo')).toBe(0)
  })

  it('joins an in-flight start instead of scanning twice', async () => {
    let finishStart: (() => void) | null = null
    const start = vi.fn(() => new Promise<void>((resolve) => { finishStart = resolve }))
    const stop = vi.fn()
    const registry = createWatchRegistry({ start, stop })

    const first = registry.acquire('E:/repo')
    const second = registry.acquire('E:/repo')
    // `start` is invoked on the next microtask (the count is registered
    // synchronously, so a second acquire in the same tick already joins it).
    await Promise.resolve()
    expect(start).toHaveBeenCalledTimes(1)
    expect(registry.count('E:/repo')).toBe(2)

    finishStart?.()
    await Promise.all([first, second])
    expect(start).toHaveBeenCalledTimes(1)

    registry.release('E:/repo')
    expect(stop).not.toHaveBeenCalled()
    registry.release('E:/repo')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('ignores a release for a root it never held', () => {
    const { registry, stop } = makeRegistry()
    registry.release('E:/never-held')
    expect(stop).not.toHaveBeenCalled()
    expect(registry.count('E:/never-held')).toBe(0)
  })

  it('follows one workspace through different spellings of its path', async () => {
    const { registry, start, stop } = makeRegistry((root) => root.replace(/\/+$/, '').toLowerCase())

    await registry.acquire('E:/Repo/')
    await registry.acquire('e:/repo')
    expect(start).toHaveBeenCalledTimes(1)
    expect(registry.count('E:/repo')).toBe(2)

    registry.release('E:/Repo')
    registry.release('e:/repo/')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed start instead of leaking the reference', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error('EPERM'))
      .mockResolvedValueOnce(undefined)
    const stop = vi.fn()
    const registry = createWatchRegistry({ start, stop })

    await expect(registry.acquire('E:/repo')).rejects.toThrow('EPERM')
    expect(registry.count('E:/repo')).toBe(0)
    expect(stop).not.toHaveBeenCalled()

    await registry.acquire('E:/repo')
    expect(start).toHaveBeenCalledTimes(2)
    expect(registry.count('E:/repo')).toBe(1)
  })

  it('forget() stops a held root immediately so the next acquire restarts it', async () => {
    const { registry, start, stop } = makeRegistry()
    await registry.acquire('E:/repo')

    registry.forget('E:/repo')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(registry.count('E:/repo')).toBe(0)

    await registry.acquire('E:/repo')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('dispose() stops every held root exactly once', async () => {
    const { registry, stop } = makeRegistry()
    await registry.acquire('E:/a')
    await registry.acquire('E:/b')
    registry.release('E:/b')

    expect(registry.roots()).toEqual(['E:/a'])
    registry.dispose()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(registry.roots()).toEqual([])
  })
})
