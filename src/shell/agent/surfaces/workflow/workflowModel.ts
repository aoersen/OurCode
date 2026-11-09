/**
 * 「工作流」面的视图模型（纯函数）。
 *
 * 分类沿用 WorkflowModal 里那套关键词规则（旧弹窗的同一条口径，搬成纯函数
 * 以便单测与复用）。分组顺序固定，空组不返回。
 */
import type { Workflow } from '@/types'
import { matchesQuery } from '../surfaceModel'

export type WorkflowCategory = 'code-gen' | 'review' | 'refactor' | 'docs' | 'debug' | 'other'

export type WorkflowCategoryFilter = 'all' | WorkflowCategory

export interface WorkflowCategoryMeta {
  id: WorkflowCategoryFilter
  label: string
}

export const WORKFLOW_CATEGORIES: ReadonlyArray<WorkflowCategoryMeta> = [
  { id: 'all', label: '全部' },
  { id: 'code-gen', label: '代码生成' },
  { id: 'review', label: '代码审查' },
  { id: 'refactor', label: '重构' },
  { id: 'docs', label: '文档' },
  { id: 'debug', label: '调试' },
  { id: 'other', label: '其他' },
]

export function workflowCategoryLabel(id: WorkflowCategoryFilter): string {
  return WORKFLOW_CATEGORIES.find((entry) => entry.id === id)?.label ?? id
}

/** 关键词归类（与旧 WorkflowModal.detectCategory 完全一致）。 */
export function detectWorkflowCategory(name: string, description: string, prompt: string): WorkflowCategory {
  const text = `${name} ${description} ${prompt}`.toLowerCase()
  if (text.includes('生成') || text.includes('generate') || text.includes('create') || text.includes('写') || text.includes('write')) return 'code-gen'
  if (text.includes('审查') || text.includes('review') || text.includes('检查') || text.includes('check') || text.includes('lint')) return 'review'
  if (text.includes('重构') || text.includes('refactor') || text.includes('优化') || text.includes('optimize') || text.includes('改进')) return 'refactor'
  if (text.includes('文档') || text.includes('doc') || text.includes('注释') || text.includes('comment') || text.includes('readme')) return 'docs'
  if (text.includes('调试') || text.includes('debug') || text.includes('修复') || text.includes('fix') || text.includes('bug')) return 'debug'
  return 'other'
}

export function categoryOfWorkflow(workflow: Workflow): WorkflowCategory {
  return detectWorkflowCategory(workflow.name, workflow.description, workflow.prompt)
}

export interface WorkflowGroup {
  id: WorkflowCategory
  label: string
  workflows: Workflow[]
}

export function filterWorkflows(
  workflows: ReadonlyArray<Workflow>,
  input: { category: WorkflowCategoryFilter; query: string },
): Workflow[] {
  return workflows.filter((workflow) => {
    if (input.category !== 'all' && categoryOfWorkflow(workflow) !== input.category) return false
    return (
      matchesQuery(workflow.name, input.query) ||
      matchesQuery(workflow.description, input.query) ||
      matchesQuery(workflow.prompt, input.query)
    )
  })
}

export function workflowCategoryCounts(
  workflows: ReadonlyArray<Workflow>,
): Record<WorkflowCategoryFilter, number> {
  const counts: Record<WorkflowCategoryFilter, number> = {
    all: workflows.length,
    'code-gen': 0,
    review: 0,
    refactor: 0,
    docs: 0,
    debug: 0,
    other: 0,
  }
  for (const workflow of workflows) counts[categoryOfWorkflow(workflow)] += 1
  return counts
}

/** 分组列表：分类顺序固定（全部时按 WORKFLOW_CATEGORIES 的顺序）。 */
export function groupWorkflows(
  workflows: ReadonlyArray<Workflow>,
  input: { category: WorkflowCategoryFilter; query: string },
): WorkflowGroup[] {
  const filtered = filterWorkflows(workflows, input)
  const order: WorkflowCategory[] = ['code-gen', 'review', 'refactor', 'docs', 'debug', 'other']
  const groups: WorkflowGroup[] = []
  for (const category of order) {
    const items = filtered.filter((workflow) => categoryOfWorkflow(workflow) === category)
    if (items.length > 0) groups.push({ id: category, label: workflowCategoryLabel(category), workflows: items })
  }
  return groups
}

/** 行里那一行描述：优先 description，没有就把提示词压成一行。 */
export function workflowSummary(workflow: Workflow, maxChars = 80): string {
  const source = (workflow.description || workflow.prompt || '').replace(/\s+/g, ' ').trim()
  if (source.length <= maxChars) return source
  return `${source.slice(0, maxChars)}…`
}
