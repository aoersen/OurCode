import { describe, expect, it } from 'vitest'
import {
  PLAN_ACTION,
  QUESTION_ACTION,
  SKIP_ANSWER,
  composeAnswer,
  parsePlan,
  planView,
  questionView,
} from '@/shell/agent/approvals/approvalModel'

describe('questionView —— 提问卡', () => {
  const base = {
    question: '要不要把 chatStore 的 5 个 action 一起重命名？',
    options: ['直接重命名', '重构成 slice store', '先出影响清单'],
  }

  it('keeps the payload order of options', () => {
    const view = questionView({ ...base, options: ['b', 'a', 'c'] })
    expect(view.options.map((o) => o.label)).toEqual(['b', 'a', 'c'])
    expect(view.options.map((o) => o.index)).toEqual([0, 1, 2])
  })

  it('drops blank options but keeps their payload index', () => {
    const view = questionView({ ...base, options: ['第一个', '   ', '第三个'] })
    expect(view.options).toEqual([
      { index: 0, label: '第一个', preview: undefined },
      { index: 2, label: '第三个', preview: undefined },
    ])
  })

  it('aligns previews by payload index and ignores blank ones', () => {
    const view = questionView({ ...base, preview: ['ASCII A', '', 'ASCII C'] })
    expect(view.options.map((o) => o.preview)).toEqual(['ASCII A', undefined, 'ASCII C'])
  })

  it('is single-select without options even when multiSelect is set', () => {
    const view = questionView({ question: '自由回答？', multiSelect: true, options: [] })
    expect(view.multiSelect).toBe(false)
    expect(view.options).toEqual([])
    expect(view.actions.map((a) => a.id)).toEqual([QUESTION_ACTION.skip])
    expect(view.freeTextPlaceholder).toBe('输入回答…')
  })

  it('adds 提交选择 only for multi-select', () => {
    const multi = questionView({ ...base, multiSelect: true })
    expect(multi.multiSelect).toBe(true)
    expect(multi.actions.map((a) => a.label)).toEqual(['提交选择', '跳过'])
    expect(multi.actions.map((a) => a.tone)).toEqual(['primary', 'plain'])

    const single = questionView(base)
    expect(single.multiSelect).toBe(false)
    expect(single.actions.map((a) => a.label)).toEqual(['跳过'])
    expect(single.freeTextPlaceholder).toBe('或输入自定义回答…')
  })

  it('gives every action an aria-label', () => {
    const multi = questionView({ ...base, multiSelect: true })
    expect(multi.actions.every((a) => a.ariaLabel.length > 0)).toBe(true)
  })
})

describe('composeAnswer —— 回喂给 agent 的回答', () => {
  const q = { question: 'q', options: ['甲', '乙', '丙'] }

  it('prefers free text over the picked options', () => {
    expect(composeAnswer(q, [0, 1], '我自己写')).toBe('我自己写')
  })

  it('joins picked options in payload order with a full-width semicolon', () => {
    expect(composeAnswer(q, [2, 0], '')).toBe('甲；丙')
  })

  it('ignores duplicates and out-of-range indexes', () => {
    expect(composeAnswer(q, [1, 1, 9, -1], '')).toBe('乙')
  })

  it('returns an empty string when nothing was picked', () => {
    expect(composeAnswer(q, [], '   ')).toBe('')
    expect(SKIP_ANSWER).toBe('（用户跳过了此问题）')
  })
})

describe('parsePlan —— submit_plan 的载荷', () => {
  it('reads the JSON shape the store persists', () => {
    const content = JSON.stringify({
      title: '重构底栏决策区',
      steps: [{ summary: '抽视图模型' }, { summary: '写卡片', detail: '四载荷' }],
    })
    expect(parsePlan(content)).toEqual({
      title: '重构底栏决策区',
      steps: ['抽视图模型', '写卡片'],
    })
  })

  it('falls back to plain text plans', () => {
    const parsed = parsePlan('# 计划\n第一步\n第二步')
    expect(parsed.title).toBe('计划')
    expect(parsed.steps).toEqual(['第一步', '第二步'])
  })

  it('survives an empty or garbage payload', () => {
    expect(parsePlan('')).toEqual({ title: '执行计划', steps: [] })
    const garbage = parsePlan('{not json')
    expect(garbage.title).toContain('{not json')
    expect(garbage.steps).toEqual([])
  })

  it('drops steps without any text', () => {
    const content = JSON.stringify({ title: 't', steps: [{ summary: '  ' }, { detail: '仅有细节' }, '字面步'] })
    expect(parsePlan(content).steps).toEqual(['仅有细节', '字面步'])
  })
})

describe('planView —— 三态计划卡', () => {
  const content = JSON.stringify({
    title: '重构底栏决策区',
    steps: [
      { summary: '步骤一' },
      { summary: '步骤二' },
      { summary: '步骤三' },
      { summary: '步骤四' },
    ],
  })

  it('is null when there is no plan to show', () => {
    expect(planView(null)).toBeNull()
    expect(planView({ planStatus: 'none', planContent: content })).toBeNull()
    expect(planView({ planStatus: 'pending_approval' })).toBeNull()
  })

  it('pending: title + three-line summary + hidden count + three actions', () => {
    const view = planView({ planStatus: 'pending_approval', planContent: content })
    expect(view?.state).toBe('pending')
    expect(view?.title).toBe('重构底栏决策区')
    expect(view?.lines).toEqual(['步骤一', '步骤二', '步骤三'])
    expect(view?.hiddenSteps).toBe(1)
    expect(view?.actions.map((a) => a.label)).toEqual(['批准计划', '要求修改', '取消'])
    expect(view?.actions.map((a) => a.id)).toEqual([PLAN_ACTION.approve, PLAN_ACTION.revise, PLAN_ACTION.cancel])
    expect(view?.actions.map((a) => a.tone)).toEqual(['primary', 'plain', 'plain'])
  })

  it('respects a custom summary cap', () => {
    const view = planView({ planStatus: 'pending_approval', planContent: content }, 1)
    expect(view?.lines).toHaveLength(1)
    expect(view?.hiddenSteps).toBe(3)
  })

  it('approved: collapses to a muted record with no actions', () => {
    const view = planView({
      planStatus: 'approved',
      planContent: content,
      planDeliverables: ['src/a.ts', 'src/b.ts'],
    })
    expect(view?.state).toBe('approved')
    expect(view?.actions).toEqual([])
    expect(view?.recordLine).toBe('计划已批准 · 4 步 · 2 个文件')
    expect(view?.deliverables).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('canceled: stays on record and can be re-approved', () => {
    const view = planView({ planStatus: 'canceled', planContent: content })
    expect(view?.state).toBe('canceled')
    expect(view?.recordLine).toBe('计划已取消 · 4 步 · 可重新批准')
    expect(view?.actions.map((a) => a.label)).toEqual(['重新批准'])
    expect(view?.actions[0].ariaLabel).toBe('重新批准这份计划')
  })
})
