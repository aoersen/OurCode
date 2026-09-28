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

  it('parses list-format lines and ⏸ deferred status (real-run format)', () => {
    const md = `- A1 工程+typecheck+build：✅ 已实现
- B6 真实 Key 联调：⏸ 延后（已确认）
- C2 请求体构造：部分实现
- D5 mac 实机：❌ 未实现
`
    expect(parseComparisonStates(md)).toEqual([
      { text: 'A1 工程+typecheck+build', state: 'done' },
      { text: 'B6 真实 Key 联调', state: 'waiting' },
      { text: 'C2 请求体构造', state: 'waiting' },
      { text: 'D5 mac 实机', state: 'todo' },
    ])
  })
})

describe('goalChecklist.mergeChecklist (ID matching)', () => {
  it('matches comparison short labels to finalGoal long items by item id', () => {
    // 真实运行证据（AI-Wallpaper-Generator loop1）：comparison 表用短标签
    // 「A1 工程+typecheck+build」，finalGoal 是长描述「A1 `auto` 项目位于…」，
    // 文本无法全等匹配——此前整卡永远停在 finalGoal 勾选态。
    const goals = [
      { text: 'A1 `auto` 项目位于 `aurora-wallpaper/`，typecheck 0 错误', checked: false },
      { text: 'B6 `manual` 真实 Key 联调生成 1+ 张', checked: false },
      { text: 'C2 请求体构造符合文档', checked: false },
    ]
    const comparison = [
      { text: 'A1 工程+typecheck+build', state: 'done' as const },
      { text: 'B6 真实 Key 联调', state: 'waiting' as const },
      { text: 'C2 请求体构造符合文档', state: 'done' as const },
    ]
    expect(mergeChecklist(goals, comparison).map((g) => g.state)).toEqual(['done', 'waiting', 'done'])
  })

  it('falls back to normalized text then finalGoal checkbox when no id', () => {
    const goals = [{ text: '无编号的目标', checked: false }]
    expect(mergeChecklist(goals, [{ text: '无编号的目标', state: 'done' }])[0].state).toBe('done')
    expect(mergeChecklist(goals, [{ text: '另一个目标', state: 'done' }])[0].state).toBe('todo')
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

  it('最新轮尚无 comparison.md → 沿用上一轮比对结果（轮中不回退 finalGoal 勾选态）', async () => {
    fs['C:/workspace/.ourcode/targemode/finalGoal.md'] = {
      content: '- [x] 需求文档已确认\n- [ ] 登录接口联调\n- [ ] 验收测试通过\n',
    }
    fs['C:/workspace/.ourcode/targemode/loop1'] = { isDirectory: true, name: 'loop1' }
    // loop2 目录已建（新一轮进行中）但比对还没写
    fs['C:/workspace/.ourcode/targemode/loop2'] = { isDirectory: true, name: 'loop2' }
    fs['C:/workspace/.ourcode/targemode/loop1/comparison.md'] = {
      content: '| 检查项 | 状态 |\n|---|---|\n| 需求文档已确认 | ✅ 已实现 |\n| 登录接口联调 | ✅ 已实现 |\n| 验收测试通过 | ⚠️ 部分 |\n',
    }

    const s = await readGoalChecklist(root)
    expect(s).not.toBeNull()
    expect(s!.items).toEqual([
      { text: '需求文档已确认', state: 'done' },
      { text: '登录接口联调', state: 'done' },
      { text: '验收测试通过', state: 'waiting' },
    ])
    // done(1) + done(1) + waiting(0.5) = 2.5/3 = 83
    expect(s!.coverage).toBe(83)
    // 再上一份 comparison 不存在 → 无 delta 基数
    expect(s!.previousCoverage).toBeNull()
  })

  it('没有任何 comparison.md → finalGoal 勾选态兜底', async () => {
    fs['C:/workspace/.ourcode/targemode/finalGoal.md'] = {
      content: '- [x] 需求文档已确认\n- [ ] 登录接口联调\n',
    }
    fs['C:/workspace/.ourcode/targemode/loop1'] = { isDirectory: true, name: 'loop1' }

    const s = await readGoalChecklist(root)
    expect(s).not.toBeNull()
    expect(s!.items).toEqual([
      { text: '需求文档已确认', state: 'done' },
      { text: '登录接口联调', state: 'todo' },
    ])
    expect(s!.coverage).toBe(50)
    expect(s!.previousCoverage).toBeNull()
  })

  it('多轮均有 comparison 时，previousCoverage 取最新一份的再上一份', async () => {
    fs['C:/workspace/.ourcode/targemode/finalGoal.md'] = {
      content: '- [x] 需求文档已确认\n- [ ] 登录接口联调\n- [ ] 验收测试通过\n',
    }
    fs['C:/workspace/.ourcode/targemode/loop2'] = { isDirectory: true, name: 'loop2' }
    fs['C:/workspace/.ourcode/targemode/loop3'] = { isDirectory: true, name: 'loop3' }
    fs['C:/workspace/.ourcode/targemode/loop3/comparison.md'] = {
      content: '| 检查项 | 状态 |\n|---|---|\n| 需求文档已确认 | ✅ 已实现 |\n| 登录接口联调 | ✅ 已实现 |\n| 验收测试通过 | ❌ 未实现 |\n',
    }
    fs['C:/workspace/.ourcode/targemode/loop2/comparison.md'] = {
      content: '| 检查项 | 状态 |\n|---|---|\n| 需求文档已确认 | ✅ 已实现 |\n| 登录接口联调 | ❌ 未实现 |\n| 验收测试通过 | ❌ 未实现 |\n',
    }

    const s = await readGoalChecklist(root)
    expect(s).not.toBeNull()
    expect(s!.coverage).toBe(66)
    expect(s!.previousCoverage).toBe(33)
  })
})
