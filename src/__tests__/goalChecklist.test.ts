import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  parseGoalChecklist,
  parseComparisonStates,
  computeCoverage,
  mergeChecklist,
  humanBadge,
  readGoalChecklist,
} from '@/services/targetMode/goalChecklist'
import type { TargetModeStatus } from '@/services/targetMode/targetModeService'

describe('goalChecklist.parseGoalChecklist', () => {
  it('extracts checked / unchecked checklist lines', () => {
    const md = `# 目标
- [x] 需求文档已确认
- [ ] 登录接口联调（auto）
- 普通段落
- [X] 大写勾选
`
    const items = parseGoalChecklist(md)
    expect(items).toEqual([
      { text: '需求文档已确认', checked: true },
      { text: '登录接口联调（auto）', checked: false },
      { text: '大写勾选', checked: true },
    ])
  })

  it('returns empty for no checklist', () => {
    expect(parseGoalChecklist('# 无清单')).toEqual([])
  })
})

describe('goalChecklist.parseComparisonStates', () => {
  it('maps ✅/⚠️/❌ cells to done/waiting/todo', () => {
    const md = `| 检查项 | 状态 | 差距说明 |
|---|---|---|
| 需求文档已确认 | ✅ 已实现 | — |
| 登录接口联调 | ⚠️ 部分 | 401 |
| 验收测试 | ❌ 未实现 | 打回 |
`
    const states = parseComparisonStates(md)
    expect(states).toEqual([
      { text: '需求文档已确认', state: 'done' },
      { text: '登录接口联调', state: 'waiting' },
      { text: '验收测试', state: 'todo' },
    ])
  })

  it('skips non-table / non-status lines', () => {
    expect(parseComparisonStates('达成率：41%\n- 普通行')).toEqual([])
  })
})

describe('goalChecklist.computeCoverage', () => {
  it('weights done=1 waiting=0.5 todo=0, floors the percent', () => {
    // 1 + 1 + 0.5 + 0 = 2.5 / 4 = 62.5 → 62
    const items = [
      { state: 'done' },
      { state: 'done' },
      { state: 'waiting' },
      { state: 'todo' },
    ]
    expect(computeCoverage(items)).toBe(62)
  })

  it('returns 0 for empty', () => {
    expect(computeCoverage([])).toBe(0)
  })
})

describe('goalChecklist.mergeChecklist', () => {
  it('comparison state wins over finalGoal checked state', () => {
    const goals = [
      { text: '需求文档已确认', checked: true },
      { text: '登录接口联调', checked: true },
      { text: '验收测试', checked: false },
    ]
    const comp = [
      { text: '登录接口联调', state: 'waiting' },
    ]
    expect(mergeChecklist(goals, comp)).toEqual([
      { text: '需求文档已确认', state: 'done' },
      { text: '登录接口联调', state: 'waiting' },
      { text: '验收测试', state: 'todo' },
    ])
  })

  it('ignores whitespace / markdown noise when matching', () => {
    const goals = [{ text: '登录 接口 联调', checked: false }]
    const comp = [{ text: '登录接口联调', state: 'done' }]
    expect(mergeChecklist(goals, comp)).toEqual([{ text: '登录 接口 联调', state: 'done' }])
  })
})

describe('goalChecklist.humanBadge', () => {
  const status: TargetModeStatus = {
    round: 2,
    percent: 62.5,
    progressText: '阶段 3/5',
    stageCurrent: 3,
    stageTotal: 5,
  }

  it('renders round + stage + coverage (V12 human badge)', () => {
    expect(humanBadge(status, 62)).toBe('第 2 轮 · 阶段 3/5 · 清单通过率 62%')
  })

  it('omits missing pieces', () => {
    expect(humanBadge({ ...status, stageCurrent: null, stageTotal: null }, null)).toBe('第 2 轮')
    expect(humanBadge(null, 40)).toBe('清单通过率 40%')
    expect(humanBadge(null, null)).toBe('')
  })
})

describe('goalChecklist.readGoalChecklist (fs layer)', () => {
  const root = 'C:/workspace'
  let fs: Record<string, { content?: string; isDirectory?: boolean; name?: string }>

  beforeEach(() => {
    fs = {}
    vi.stubGlobal('window', {
      electronAPI: {
        readFile: vi.fn(async (path: string) => ({ content: fs[path]?.content ?? '' })),
        listDir: vi.fn(async (path: string) =>
          Object.entries(fs)
            .filter(([p]) => p.startsWith(path))
            .map(([p, v]) => ({ name: p.split('/').pop() ?? '', isDirectory: v.isDirectory ?? false, path: p })),
        ),
      },
    })
  })

  it('returns null when finalGoal.md is missing', async () => {
    expect(await readGoalChecklist(root)).toBeNull()
  })

  it('returns checklist + coverage from finalGoal + latest comparison', async () => {
    fs['C:/workspace/.ourcode/targemode/finalGoal.md'] = {
      content: '- [x] 需求文档已确认\n- [ ] 登录接口联调\n- [ ] 验收测试通过\n',
    }
    fs['C:/workspace/.ourcode/targemode/loop1'] = { isDirectory: true, name: 'loop1' }
    fs['C:/workspace/.ourcode/targemode/loop2'] = { isDirectory: true, name: 'loop2' }
    fs['C:/workspace/.ourcode/targemode/loop2/comparison.md'] = {
      content: '| 检查项 | 状态 |\n|---|---|\n| 需求文档已确认 | ✅ 已实现 |\n| 登录接口联调 | ⚠️ 部分 |\n| 验收测试通过 | ❌ 未实现 |\n',
    }
    fs['C:/workspace/.ourcode/targemode/loop1/comparison.md'] = {
      content: '| 检查项 | 状态 |\n|---|---|\n| 需求文档已确认 | ✅ 已实现 |\n| 登录接口联调 | ❌ 未实现 |\n| 验收测试通过 | ❌ 未实现 |\n',
    }

    const s = await readGoalChecklist(root)
    expect(s).not.toBeNull()
    expect(s!.items).toEqual([
      { text: '需求文档已确认', state: 'done' },
      { text: '登录接口联调', state: 'waiting' },
      { text: '验收测试通过', state: 'todo' },
    ])
    // done(1) + waiting(0.5) + todo(0) = 1.5/3 = 50%
    expect(s!.coverage).toBe(50)
    // 上一轮：1 + 0 + 0 = 33
    expect(s!.previousCoverage).toBe(33)
  })
})
