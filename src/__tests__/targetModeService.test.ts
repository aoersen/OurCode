import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parseStatus, ensureInitialized, resetTargetModeState } from '@/services/targetMode/targetModeService'
import { TARGET_MODE_STATUS_INIT } from '@/services/targetMode/spec'

describe('targetModeService.parseStatus', () => {
  it('parses the initial status file', () => {
    const s = parseStatus(TARGET_MODE_STATUS_INIT)
    expect(s.round).toBe(0)
    expect(s.percent).toBeNull()
    expect(s.progressText).toContain('未开始')
  })

  it('parses a progressed status (round + percent)', () => {
    const md = `# 目标模式实施状态

- 当前轮次：2
- 已完成阶段数：4
- 总体百分比：62.5%
- 历史记录：
  - R1：完成 3 个阶段
  - R2：进行中
`
    const s = parseStatus(md)
    expect(s.round).toBe(2)
    expect(s.percent).toBe(62.5)
    expect(s.progressText).toBe('')
  })

  it('returns nulls for unknown fields', () => {
    const s = parseStatus('# 空的')
    expect(s.round).toBeNull()
    expect(s.percent).toBeNull()
    expect(s.progressText).toBe('')
  })

  it('tolerates full-width colons', () => {
    const s = parseStatus('当前轮次：3\n总体百分比：50%')
    expect(s.round).toBe(3)
    expect(s.percent).toBe(50)
  })

  it('parses stage from 实施进度 (V12 human badge)', () => {
    const s = parseStatus('当前轮次：2\n总体百分比：62.5%\n实施进度：阶段 3/5')
    expect(s.stageCurrent).toBe(3)
    expect(s.stageTotal).toBe(5)
    expect(s.progressText).toContain('阶段 3/5')
  })

  it('falls back to 达成率 percent and X/Y 阶段 wording (real-run format)', () => {
    // 真实运行证据（AI-Wallpaper-Generator）：监管写的是
    // 「实施进度：**全部完成** —— 5/5 阶段验收通过，比对达成率 100%」——
    // 没有「总体百分比」字段，此前 percent 恒为 null（看板进度条 0%）。
    const s = parseStatus(
      '当前轮次：1（完成）\n实施进度：**全部完成** —— 5/5 阶段验收通过，比对达成率 100%',
    )
    expect(s.round).toBe(1)
    expect(s.percent).toBe(100)
    expect(s.stageCurrent).toBe(5)
    expect(s.stageTotal).toBe(5)
  })

  it('leaves stage null when absent', () => {
    const s = parseStatus('当前轮次：2\n总体百分比：62.5%')
    expect(s.stageCurrent).toBeNull()
    expect(s.stageTotal).toBeNull()
  })
})

describe('targetModeService.ensureInitialized (v2 multi-agent skeleton)', () => {
  const root = 'C:/workspace'
  const written: string[] = []
  let existing: Record<string, string>

  const mockApi = {
    createDir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string) => { written.push(path) }),
    readFile: vi.fn(async (path: string) => ({ content: existing[path] || '', encoding: 'utf-8' })),
  }

  beforeEach(() => {
    written.length = 0
    existing = {}
    vi.stubGlobal('window', { electronAPI: mockApi })
    vi.clearAllMocks()
  })

  it('bootstraps the v2 skeleton: dirs, templates and tm-* role files', async () => {
    await ensureInitialized(root)

    // core + v2 template files under .ourcode/targemode/
    for (const f of ['SPEC.md', 'index.md', 'implementationStatus.md', 'budget.md', 'agents/README.md', 'inbox/README.md', 'agents/supervisor.md']) {
      expect(written).toContain(`${root}/.ourcode/targemode/${f}`)
    }
    // editable role definitions under .ourcode/agents/
    for (const role of ['tm-requirement-analyst', 'tm-developer', 'tm-ui-developer', 'tm-tester']) {
      expect(written).toContain(`${root}/.ourcode/agents/${role}.md`)
    }
    // dirs created
    expect(mockApi.createDir).toHaveBeenCalledWith(`${root}/.ourcode/targemode/agents`)
    expect(mockApi.createDir).toHaveBeenCalledWith(`${root}/.ourcode/targemode/inbox`)
    expect(mockApi.createDir).toHaveBeenCalledWith(`${root}/.ourcode/agents`)
  })

  it('never overwrites an existing role definition', async () => {
    existing[`${root}/.ourcode/agents/tm-developer.md`] = '用户自定义内容'
    await ensureInitialized(root)
    const writes = written.filter((p) => p.endsWith('tm-developer.md'))
    expect(writes).toHaveLength(0)
  })

  it('is a no-op for an empty root', async () => {
    await ensureInitialized('')
    expect(mockApi.createDir).not.toHaveBeenCalled()
  })
})

describe('targetModeService.resetTargetModeState（新任务清零）', () => {
  const root = 'C:/workspace'
  const base = `${root}/.ourcode/targemode`
  const written: Array<[string, string]> = []
  const deleted: string[] = []
  let entries: Array<{ name: string; isDirectory: boolean }>
  let inboxEntries: Array<{ name: string; isDirectory: boolean }>

  const mockApi = {
    writeFile: vi.fn(async (path: string, content: string) => { written.push([path, content]) }),
    listDir: vi.fn(async (path: string) => (path === `${base}/inbox` ? inboxEntries : entries)),
    delete: vi.fn(async (path: string) => { deleted.push(path) }),
  }

  beforeEach(() => {
    written.length = 0
    deleted.length = 0
    vi.clearAllMocks()
    entries = [
      { name: 'loop1', isDirectory: true },
      { name: 'loop2', isDirectory: true },
      { name: 'finalGoal.md', isDirectory: false },
      { name: 'finalGoal_v2.md', isDirectory: false },
      { name: 'budget.md', isDirectory: false },
      { name: 'SPEC.md', isDirectory: false },
    ]
    inboxEntries = [
      { name: 'README.md', isDirectory: false },
      { name: 'envelope-1.md', isDirectory: false },
    ]
    vi.stubGlobal('window', { electronAPI: mockApi })
  })

  it('清掉旧任务的运行态文档，保留公司级配置', async () => {
    await resetTargetModeState(root)
    // 实施状态复位为初始模板；监管决策日志重新初始化
    expect(written).toContainEqual([`${base}/implementationStatus.md`, TARGET_MODE_STATUS_INIT])
    expect(written.some(([p]) => p === `${base}/agents/supervisor.md`)).toBe(true)
    // 轮次目录、目标清单（含修订版）、信封删除；budget/SPEC/README 保留
    expect(deleted).toEqual([
      `${base}/loop1`,
      `${base}/loop2`,
      `${base}/finalGoal.md`,
      `${base}/finalGoal_v2.md`,
      `${base}/inbox/envelope-1.md`,
    ])
  })

  it('失败静默：读目录抛错时不向上抛', async () => {
    mockApi.listDir.mockRejectedValueOnce(new Error('boom'))
    await expect(resetTargetModeState(root)).resolves.toBeUndefined()
  })

  it('空根路径直接返回', async () => {
    await resetTargetModeState('')
    expect(mockApi.writeFile).not.toHaveBeenCalled()
  })
})
