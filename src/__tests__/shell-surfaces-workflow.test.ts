import { describe, expect, it } from 'vitest'
import type { Workflow } from '@/types'
import {
  WORKFLOW_CATEGORIES,
  categoryOfWorkflow,
  detectWorkflowCategory,
  filterWorkflows,
  groupWorkflows,
  workflowCategoryCounts,
  workflowCategoryLabel,
  workflowSummary,
} from '@/shell/agent/surfaces/workflow/workflowModel'

function workflow(over: Partial<Workflow> & { id: string; name: string }): Workflow {
  return {
    description: '',
    prompt: '',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as Workflow
}

const list: Workflow[] = [
  workflow({ id: '1', name: '生成接口测试', prompt: '为这段代码生成单测' }),
  workflow({ id: '2', name: '代码审查', prompt: '审查这段改动的边界条件' }),
  workflow({ id: '3', name: '重构旧组件', prompt: '把这段重构掉' }),
  workflow({ id: '4', name: '补 README 文档', prompt: '为项目补一份 readme 文档' }),
  workflow({ id: '5', name: '修 bug', prompt: 'debug 一下这里为什么崩' }),
  workflow({ id: '6', name: '日常杂项', prompt: '整理一下待办' }),
]

describe('workflowModel · 分类', () => {
  it('六个分类按固定顺序，标签是纯中文', () => {
    expect(WORKFLOW_CATEGORIES.map((entry) => entry.id)).toEqual([
      'all',
      'code-gen',
      'review',
      'refactor',
      'docs',
      'debug',
      'other',
    ])
    expect(workflowCategoryLabel('docs')).toBe('文档')
    expect(workflowCategoryLabel('debug')).toBe('调试')
  })

  it('关键词优先级的顺序与旧弹窗一致（生成 > 审查 > 重构 > 文档 > 调试）', () => {
    expect(detectWorkflowCategory('生成审查报告', '', '')).toBe('code-gen')
    expect(detectWorkflowCategory('审查并重构', '', '')).toBe('review')
    expect(detectWorkflowCategory('重构并补文档', '', '')).toBe('refactor')
    expect(detectWorkflowCategory('补文档并修 bug', '', '')).toBe('docs')
    expect(detectWorkflowCategory('修 bug', '', '')).toBe('debug')
    expect(detectWorkflowCategory('杂项', '', '')).toBe('other')
    expect(detectWorkflowCategory('Generate tests', '', '')).toBe('code-gen')
  })

  it('每条工作流都能归类', () => {
    expect(list.map(categoryOfWorkflow)).toEqual([
      'code-gen',
      'review',
      'refactor',
      'docs',
      'debug',
      'other',
    ])
  })

  it('分类计数', () => {
    expect(workflowCategoryCounts(list)).toEqual({
      all: 6,
      'code-gen': 1,
      review: 1,
      refactor: 1,
      docs: 1,
      debug: 1,
      other: 1,
    })
    expect(workflowCategoryCounts([]).all).toBe(0)
  })
})

describe('workflowModel · 过滤与分组', () => {
  it('按分类过滤', () => {
    expect(filterWorkflows(list, { category: 'review', query: '' }).map((entry) => entry.id)).toEqual(['2'])
    expect(filterWorkflows(list, { category: 'all', query: '' })).toHaveLength(6)
  })

  it('搜索命中名称 / 描述 / 提示词', () => {
    expect(filterWorkflows(list, { category: 'all', query: 'README' }).map((entry) => entry.id)).toEqual(['4'])
    expect(filterWorkflows(list, { category: 'all', query: '边界条件' }).map((entry) => entry.id)).toEqual(['2'])
  })

  it('分组顺序固定且空组不返回', () => {
    const groups = groupWorkflows(list, { category: 'all', query: '' })
    expect(groups.map((group) => group.id)).toEqual([
      'code-gen',
      'review',
      'refactor',
      'docs',
      'debug',
      'other',
    ])
    expect(groups[0].label).toBe('代码生成')
    const single = groupWorkflows(list, { category: 'debug', query: '' })
    expect(single).toHaveLength(1)
    expect(single[0].workflows.map((entry) => entry.id)).toEqual(['5'])
    expect(groupWorkflows([], { category: 'all', query: '' })).toEqual([])
  })

  it('搜索把没有命中的组一起收掉', () => {
    const groups = groupWorkflows(list, { category: 'all', query: '重构' })
    expect(groups.map((group) => group.id)).toEqual(['refactor'])
  })
})

describe('workflowModel · 描述行', () => {
  it('有 description 用它，没有就把提示词压成一行', () => {
    expect(workflowSummary(workflow({ id: 'a', name: 'a', description: '一句话', prompt: '长提示词' }))).toBe('一句话')
    expect(workflowSummary(workflow({ id: 'b', name: 'b', prompt: '第一行\n第二行' }))).toBe('第一行 第二行')
    expect(workflowSummary(workflow({ id: 'c', name: 'c' }))).toBe('')
  })

  it('超长描述截断并加省略号', () => {
    const long = 'x'.repeat(120)
    const summary = workflowSummary(workflow({ id: 'd', name: 'd', description: long }), 10)
    expect(summary).toBe(`${'x'.repeat(10)}…`)
  })
})
