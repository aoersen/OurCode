import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parseStatus, ensureInitialized } from '@/services/targetMode/targetModeService'
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
