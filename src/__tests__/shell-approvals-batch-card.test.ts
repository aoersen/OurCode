import { describe, expect, it } from 'vitest'
import {
  BATCH_ACTION,
  batchApplyPlan,
  batchItems,
  batchTitle,
  batchView,
  type BatchToolLike,
} from '@/shell/agent/approvals/approvalModel'

const tools: BatchToolLike[] = [
  { id: 't1', name: 'run_command', arguments: { command: 'npm run typecheck' } },
  { id: 't2', name: 'edit_file', arguments: { path: 'src/a.ts', oldText: 'a', newText: 'b' } },
  { id: 't3', name: 'run_command', arguments: { command: 'rm -rf /' } },
]

describe('batchTitle', () => {
  it('states the count of pending operations', () => {
    expect(batchTitle(3)).toBe('3 个操作待批准')
    expect(batchTitle(1)).toBe('1 个操作待批准')
  })
})

describe('batchItems —— 一行一项', () => {
  it('keeps payload order and never sorts', () => {
    expect(batchItems(tools).map((i) => i.id)).toEqual(['t1', 't2', 't3'])
    expect(batchItems([tools[2], tools[1]]).map((i) => i.id)).toEqual(['t3', 't2'])
  })

  it('renders tool label + target + risk word', () => {
    const [first, second, third] = batchItems(tools)
    expect(first.label).toBe('Bash')
    expect(first.target).toBe('npm run typecheck')
    expect(first.risk).toEqual({ level: 'command', word: '执行命令' })
    expect(second.label).toBe('Edit')
    expect(second.target).toBe('src/a.ts')
    expect(second.risk.word).toBe('写入文件')
    expect(third.risk).toEqual({ level: 'danger', word: '危险命令' })
  })

  it('falls back to the per-item preview when args carry no target', () => {
    const items = batchItems([{ id: 'x', name: 'manage_todo', arguments: {} }], ['更新 3 条任务'])
    expect(items[0].target).toBe('更新 3 条任务')
  })

  it('tolerates a tool call without arguments', () => {
    const items = batchItems([{ id: 'y', name: 'manage_todo' }])
    expect(items[0].target).toBe('')
    expect(items[0].risk.level).toBe('read')
  })
})

describe('batchView —— 三个纯文字操作 / 逐条展开', () => {
  it('collapsed: 全部批准 / 逐条确认 / 全部拒绝', () => {
    const view = batchView({ tools, previews: ['a', 'b', 'c'] })
    expect(view.title).toBe('3 个操作待批准')
    expect(view.expanded).toBe(false)
    expect(view.items).toHaveLength(3)
    expect(view.actions.map((a) => a.label)).toEqual(['全部批准', '逐条确认', '全部拒绝'])
    expect(view.actions.map((a) => a.id)).toEqual([
      BATCH_ACTION.approveAll,
      BATCH_ACTION.confirmEach,
      BATCH_ACTION.rejectAll,
    ])
    expect(view.actions.map((a) => a.tone)).toEqual(['primary', 'plain', 'danger'])
    expect(view.actions.map((a) => a.ariaLabel)).toEqual([
      '全部批准这 3 个操作',
      '逐条确认这批操作',
      '全部拒绝这 3 个操作',
    ])
  })

  it('expanded: apply is disabled until every item is decided', () => {
    const undecided = batchView({ tools }, { expanded: true })
    expect(undecided.expanded).toBe(true)
    expect(undecided.actions.map((a) => a.id)).toEqual([
      BATCH_ACTION.applyItems,
      BATCH_ACTION.rejectAll,
    ])
    expect(undecided.actions[0].label).toBe('还需选择 3 项')
    expect(undecided.actions[0].disabled).toBe(true)

    const partial = batchView({ tools }, { expanded: true, decisions: { t1: 'approve' } })
    expect(partial.actions[0].label).toBe('还需选择 2 项')
    expect(partial.actions[0].disabled).toBe(true)

    const complete = batchView(
      { tools },
      { expanded: true, decisions: { t1: 'approve', t2: 'reject', t3: 'approve' } },
    )
    expect(complete.actions[0].label).toBe('应用逐条选择')
    expect(complete.actions[0].disabled).toBe(false)
  })
})

describe('batchApplyPlan —— 逐条选择 → store 三档', () => {
  it('all approved maps to the blanket approval', () => {
    const plan = batchApplyPlan(tools, { t1: 'approve', t2: 'approve', t3: 'approve' })
    expect(plan.decision).toBe('all')
    expect(plan.allowNames).toEqual(['run_command', 'edit_file'])
    expect(plan.rejectedCount).toBe(0)
    expect(plan.decided).toBe(3)
    expect(plan.total).toBe(3)
  })

  it('all rejected maps to the blanket rejection', () => {
    const plan = batchApplyPlan(tools, { t1: 'reject', t2: 'reject', t3: 'reject' })
    expect(plan.decision).toBe('reject')
    expect(plan.allowNames).toEqual([])
    expect(plan.rejectedCount).toBe(3)
  })

  it('a mix falls back to per-item confirmation and keeps approved names', () => {
    const plan = batchApplyPlan(tools, { t1: 'approve', t2: 'reject', t3: 'approve' })
    expect(plan.decision).toBe('confirm')
    expect(plan.allowNames).toEqual(['run_command'])
    expect(plan.rejectedCount).toBe(1)
  })

  it('undoing every choice counts as undecided, not as rejection', () => {
    const plan = batchApplyPlan(tools, {})
    expect(plan.decision).toBe('confirm')
    expect(plan.decided).toBe(0)
    expect(plan.allowNames).toEqual([])
  })

  it('handles an empty batch without claiming approval', () => {
    const plan = batchApplyPlan([], {})
    expect(plan.decision).toBe('confirm')
    expect(plan.total).toBe(0)
  })
})
