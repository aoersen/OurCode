import { describe, it, expect, vi } from 'vitest'
import { createGitReadCache } from '../services/git-read-cache'

/**
 * 只读 git 命令的共享缓存：状态栏（10s）、文件树（15s）、源代码管理面板、聊天
 * 上下文各自轮询 `git status`，大仓库一次就要几百 ms 到几秒。同一个 key 在一个
 * TTL 窗口内只应该真的跑一次 git，其余调用共享同一个 Promise。
 */
describe('createGitReadCache', () => {
  it('runs a command once and shares the promise with concurrent callers', async () => {
    const cache = createGitReadCache({ ttlMs: 5_000, now: () => 1_000 })
    const runner = vi.fn(async () => 'M src/a.ts')

    const first = cache.run('repo:status', runner)
    const second = cache.run('repo:status', runner)

    await expect(first).resolves.toBe('M src/a.ts')
    await expect(second).resolves.toBe('M src/a.ts')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(cache.size()).toBe(1)
  })

  it('serves from cache inside the TTL and re-runs after it', async () => {
    let clock = 1_000
    const cache = createGitReadCache({ ttlMs: 5_000, now: () => clock })
    const runner = vi.fn(async () => `run-${runner.mock.calls.length}`)

    await expect(cache.run('k', runner)).resolves.toBe('run-1')

    clock += 4_999
    await expect(cache.run('k', runner)).resolves.toBe('run-1')
    expect(runner).toHaveBeenCalledTimes(1)

    clock += 1
    await expect(cache.run('k', runner)).resolves.toBe('run-2')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('keys by command, so different reads never share a slot', async () => {
    const cache = createGitReadCache({ now: () => 0 })
    const status = vi.fn(async () => 'status')
    const log = vi.fn(async () => 'log')

    await cache.run('repo\u0000status --porcelain=v1', status)
    await cache.run('repo\u0000log --oneline -5', log)
    expect(status).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(cache.size()).toBe(2)
  })

  it('never memoises a failure — the next caller retries', async () => {
    const cache = createGitReadCache({ now: () => 0 })
    const runner = vi.fn()
      .mockRejectedValueOnce(new Error('fatal: not a git repository'))
      .mockResolvedValueOnce('')

    await expect(cache.run('k', runner)).rejects.toThrow('not a git repository')
    await expect(cache.run('k', runner)).resolves.toBe('')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('invalidateAll() forces the next read to hit git again', async () => {
    const cache = createGitReadCache({ now: () => 0 })
    const runner = vi.fn(async () => 'x')

    await cache.run('k', runner)
    cache.invalidateAll()
    expect(cache.size()).toBe(0)
    await cache.run('k', runner)
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest entry past the cap', async () => {
    const cache = createGitReadCache({ now: () => 0, maxEntries: 2 })
    const runner = vi.fn(async () => 'x')

    await cache.run('a', runner)
    await cache.run('b', runner)
    await cache.run('c', runner)
    expect(cache.size()).toBe(2)

    // 'a' was evicted → it runs again, 'c' is still cached.
    await cache.run('a', runner)
    expect(runner).toHaveBeenCalledTimes(4)
  })
})
