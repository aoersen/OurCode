/**
 * 目标达成清单读取与计算层。
 *
 * 从 .ourcode/targemode/ 读取 finalGoal.md（检查清单）与各轮 comparison.md
 * （逐项 ✅/⚠️/❌），计算加权达成率与轮间增量，并生成人话徽章文本（V12 审查
 * 发现项 #2/#4：验收闭环可见 + 消灭"R2·62%"式自我解释成本）。
 *
 * 纯函数可单测；文件读取走 window.electronAPI（路径受限项目根目录）。
 */
import type { TargetModeStatus } from './targetModeService'

export type GoalItemState = 'done' | 'waiting' | 'todo'

export interface GoalItem {
  text: string
  state: GoalItemState
}

export interface GoalChecklistSummary {
  items: GoalItem[]
  /** 加权覆盖率 0-100（done=1 / waiting=0.5 / todo=0，向下取整）。 */
  coverage: number
  /** 上一轮覆盖率（loopN-1 的 comparison.md 统计），用于 delta 展示；无则 null。 */
  previousCoverage: number | null
}

const TARGET_MODE_DIR = '.ourcode/targemode'

function join(root: string, ...rel: string[]): string {
  return [root.replace(/[\\/]+$/, ''), TARGET_MODE_DIR, ...rel].join('/')
}

/** 从 finalGoal.md 提取检查清单行：`- [ ] / - [x]`，保留顺序与勾选态。 */
export function parseGoalChecklist(md: string): Array<{ text: string; checked: boolean }> {
  const items: Array<{ text: string; checked: boolean }> = []
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^-\s*\[( |x|X)\]\s*(.+)$/)
    if (!m) continue
    items.push({ text: m[2].trim().replace(/\s+/g, ' '), checked: m[1] !== ' ' })
  }
  return items
}

/** 从一轮 comparison.md 提取 检查项 → 状态（✅/已实现 → done；⚠️/部分 → waiting；❌/未实现 → todo）。 */
export function parseComparisonStates(md: string): Array<{ text: string; state: GoalItemState }> {
  const states: Array<{ text: string; state: GoalItemState }> = []
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    if (cells.length < 2) continue
    const stateCell = cells[1]
    let state: GoalItemState | null = null
    if (/✅|已实现|通过/.test(stateCell)) state = 'done'
    else if (/⚠️|部分/.test(stateCell)) state = 'waiting'
    else if (/❌|未实现|未通过|失败/.test(stateCell)) state = 'todo'
    if (!state) continue
    states.push({ text: cells[0].replace(/[*`]/g, '').trim(), state })
  }
  return states
}

/** 加权覆盖率（done=1 / waiting=0.5 / todo=0），向下取整；空清单返回 0。 */
export function computeCoverage(items: Array<{ state: GoalItemState }>): number {
  if (items.length === 0) return 0
  const w = { done: 1, waiting: 0.5, todo: 0 }
  const total = items.reduce((s, i) => s + w[i.state], 0)
  return Math.floor((total / items.length) * 100)
}

/** 规范化清单文本用于匹配（去空白与 markdown 修饰）。 */
function normalize(text: string): string {
  return text.replace(/[*`\s（()）]/g, '').toLowerCase()
}

/**
 * 合并 finalGoal 勾选态与 comparison 状态：comparison 优先（更贴近本轮验收
 * 结果），finalGoal 勾选态兜底（已勾 → done，未勾 → todo）。
 */
export function mergeChecklist(
  goalItems: Array<{ text: string; checked: boolean }>,
  comparisonStates: Array<{ text: string; state: GoalItemState }>,
): GoalItem[] {
  const map = new Map(comparisonStates.map((s) => [normalize(s.text), s.state]))
  return goalItems.map((g) => {
    const fromComparison = map.get(normalize(g.text))
    const state: GoalItemState = fromComparison ?? (g.checked ? 'done' : 'todo')
    return { text: g.text, state }
  })
}

/** 列出 .ourcode/targemode/ 下的轮次目录（loop1/loop2/…），按轮次倒序。 */
export async function listRounds(root: string): Promise<string[]> {
  if (!root) return []
  try {
    const entries = await window.electronAPI.listDir(join(root))
    return entries
      .filter((e) => e.isDirectory && /^loop\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => parseInt(b.slice(4), 10) - parseInt(a.slice(4), 10))
  } catch {
    return []
  }
}

/** 读取某轮的 comparison.md（不存在返回 null）。 */
async function readComparison(root: string, round: string): Promise<{ states: Array<{ text: string; state: GoalItemState }> } | null> {
  try {
    const { content } = await window.electronAPI.readFile(join(root, round, 'comparison.md'))
    if (!content) return null
    return { states: parseComparisonStates(content) }
  } catch {
    return null
  }
}

/**
 * 读取当前目标达成摘要：finalGoal 清单 + 最近一轮 comparison 覆盖 + 上一轮
 * 覆盖率（delta 基数）。finalGoal.md 缺失/不可读返回 null（UI 显示空态引导）。
 */
export async function readGoalChecklist(root: string): Promise<GoalChecklistSummary | null> {
  if (!root) return null
  try {
    const { content: goalMd } = await window.electronAPI.readFile(join(root, 'finalGoal.md'))
    if (!goalMd) return null
    const parsed = parseGoalChecklist(goalMd)
    if (parsed.length === 0) return { items: [], coverage: 0, previousCoverage: null }

    const rounds = await listRounds(root)
    let previousCoverage: number | null = null
    if (rounds.length > 1) {
      const prev = await readComparison(root, rounds[1])
      if (prev) previousCoverage = computeCoverage(prev.states)
    }
    if (rounds.length > 0) {
      const latest = await readComparison(root, rounds[0])
      if (latest) {
        const items = mergeChecklist(parsed, latest.states)
        return { items, coverage: computeCoverage(items), previousCoverage }
      }
    }
    const items = parsed.map((i) => ({ text: i.text, state: i.checked ? 'done' : 'todo' as GoalItemState }))
    return { items, coverage: computeCoverage(items), previousCoverage }
  } catch {
    return null
  }
}

/** 人话徽章：`第 2 轮 · 阶段 3/5 · 清单通过率 62%`——缺什么省略什么。 */
export function humanBadge(status: TargetModeStatus | null, coverage: number | null): string {
  if (!status && coverage == null) return ''
  const parts: string[] = []
  if (status?.round != null) parts.push(`第 ${status.round} 轮`)
  if (status?.stageCurrent != null && status.stageTotal != null) {
    parts.push(`阶段 ${status.stageCurrent}/${status.stageTotal}`)
  }
  if (coverage != null) parts.push(`清单通过率 ${Math.round(coverage)}%`)
  return parts.join(' · ')
}
