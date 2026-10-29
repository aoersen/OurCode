import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Module-level state is reset via vi.resetModules + dynamic import. */
type Budget = typeof import('@/services/targetMode/budget')

describe('targetMode budget fuse', () => {
  let handler: ((ev: Event) => void) | undefined
  const mockReadFile = vi.fn(async () => ({ content: '总消耗上限（tokens）：1000', encoding: 'utf-8' }))
  const mockWriteFile = vi.fn(async () => {})

  beforeEach(() => {
    handler = undefined
    mockReadFile.mockClear()
    mockWriteFile.mockClear()
    vi.stubGlobal('window', {
      electronAPI: { readFile: mockReadFile, writeFile: mockWriteFile },
      addEventListener: vi.fn((type: string, fn: any) => { if (type === 'ourcode:usage-recorded') handler = fn }),
    })
    vi.resetModules()
  })

  function fire(bySession: Record<string, { tokens: number; projectPath: string }> | undefined): void {
    handler!({ detail: bySession ? { bySession } : undefined } as Event)
  }

  it('accumulates per-session usage and reports exceeded against the budget.md limit', async () => {
    const budget: Budget = await import('@/services/targetMode/budget')
    budget.installBudgetFuse()
    expect(handler).toBeDefined()

    fire({ s1: { tokens: 600, projectPath: 'C:/w' } })
    // limit is loaded from budget.md asynchronously — let it settle
    await new Promise((r) => setTimeout(r, 0))
    expect(budget.budgetExceeded('s1')).toBe(false)

    fire({ s1: { tokens: 500, projectPath: 'C:/w' } })
    expect(budget.budgetExceeded('s1')).toBe(true)
    expect(budget.getBudgetUsage('s1').used).toBe(1100)
    expect(budget.getBudgetUsage('s1').limit).toBe(1000)
  })

  it('falls back to the default limit when budget.md is unreadable', async () => {
    mockReadFile.mockImplementationOnce(async () => { throw new Error('no file') })
    const budget: Budget = await import('@/services/targetMode/budget')
    budget.installBudgetFuse()
    fire({ s1: { tokens: 50, projectPath: 'C:/w' } })
    await new Promise((r) => setTimeout(r, 0))
    // 50 << 2M default → not exceeded
    expect(budget.budgetExceeded('s1')).toBe(false)
    expect(budget.getBudgetUsage('s1').limit).toBe(2_000_000)
  })

  it('ignores events with no payload and sessions never tracked', async () => {
    const budget: Budget = await import('@/services/targetMode/budget')
    budget.installBudgetFuse()
    fire(undefined)
    expect(budget.budgetExceeded('s1')).toBe(false)
    expect(budget.getBudgetUsage('ghost').used).toBe(0)
  })

  it('installs the listener only once', async () => {
    const budget: Budget = await import('@/services/targetMode/budget')
    budget.installBudgetFuse()
    budget.installBudgetFuse()
    const calls = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.filter((c) => c[0] === 'ourcode:usage-recorded')).toHaveLength(1)
  })

  it('refreshBudgetLimit re-reads an updated budget.md limit mid-run', async () => {
    const budget: Budget = await import('@/services/targetMode/budget')
    budget.installBudgetFuse()
    // initial limit from budget.md = 1000; used accumulates to 600
    fire({ s1: { tokens: 600, projectPath: 'C:/w' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(budget.getBudgetUsage('s1').limit).toBe(1000)
    expect(budget.budgetExceeded('s1')).toBe(false)

    // user raises the cap to 5000 in budget.md → refresh takes effect
    mockReadFile.mockImplementationOnce(async () => ({ content: '总消耗上限（tokens）：5000', encoding: 'utf-8' }))
    await budget.refreshBudgetLimit('s1')
    expect(budget.getBudgetUsage('s1').limit).toBe(5000)
    expect(budget.budgetExceeded('s1')).toBe(false)

    // and lowering it trips the fuse on the next resume check
    mockReadFile.mockImplementationOnce(async () => ({ content: '总消耗上限（tokens）：100', encoding: 'utf-8' }))
    await budget.refreshBudgetLimit('s1')
    expect(budget.budgetExceeded('s1')).toBe(true)
  })

  it('persists the running total back to budget.md', async () => {
    vi.useFakeTimers()
    try {
      const budget: Budget = await import('@/services/targetMode/budget')
      budget.installBudgetFuse()
      fire({ s1: { tokens: 600, projectPath: 'C:/w' } })
      await vi.advanceTimersByTimeAsync(0) // let the limit read settle
      fire({ s1: { tokens: 500, projectPath: 'C:/w' } })
      await vi.advanceTimersByTimeAsync(5_100) // debounce window
      expect(mockWriteFile).toHaveBeenCalled()
      const [path, content] = mockWriteFile.mock.calls.at(-1) as unknown as [string, string]
      expect(path).toContain('.ourcode/targemode/budget.md')
      expect(content).toContain('当前累计：1100')
      expect(content).toContain('总消耗上限（tokens）：1000')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes from the persisted total on a fresh module load (restart)', async () => {
    mockReadFile.mockImplementationOnce(async () => ({
      content: '- 总消耗上限（tokens）：1000\n- 当前累计：900',
      encoding: 'utf-8',
    }))
    const budget: Budget = await import('@/services/targetMode/budget')
    budget.installBudgetFuse()
    fire({ s1: { tokens: 200, projectPath: 'C:/w' } })
    await new Promise((r) => setTimeout(r, 0))
    // persisted 900 + 200 accumulated before the read resolved = 1100
    expect(budget.getBudgetUsage('s1').used).toBe(1100)
    expect(budget.budgetExceeded('s1')).toBe(true)
  })

  it('resetProjectBudget zeroes a new task and keeps the cap', async () => {
    const budget: Budget = await import('@/services/targetMode/budget')
    budget.installBudgetFuse()
    fire({ s1: { tokens: 1200, projectPath: 'C:/w' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(budget.budgetExceeded('s1')).toBe(true)

    budget.resetProjectBudget('C:/w')
    expect(budget.getBudgetUsage('s1').used).toBe(0)
    expect(budget.getBudgetUsage('s1').limit).toBe(1000)
    expect(budget.budgetExceeded('s1')).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(mockWriteFile).toHaveBeenCalled()
    const [, content] = mockWriteFile.mock.calls.at(-1) as unknown as [string, string]
    expect(content).toContain('当前累计：0')
  })
})
