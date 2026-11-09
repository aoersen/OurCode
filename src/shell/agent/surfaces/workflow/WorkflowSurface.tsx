import { useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkflowStore } from '@/stores/workflowStore'
import type { Workflow } from '@/types'
import {
  EmptyHint,
  FieldLabel,
  FormShell,
  PlainInput,
  PlainTextarea,
  SectionLabel,
  SurfaceRow,
  TextAction,
  useListKeyboard,
} from '../surfaceParts'
import { ROW_PAGE_SIZE, nextRowLimit, rowWindow } from '../surfaceModel'
import {
  WORKFLOW_CATEGORIES,
  categoryOfWorkflow,
  groupWorkflows,
  workflowCategoryCounts,
  workflowCategoryLabel,
  workflowSummary,
  type WorkflowCategoryFilter,
} from './workflowModel'

/**
 * 「工作流」面：按既有关键词规则分组 + 行内运行/编辑/删除 + 行内新建。
 *
 * 数据与写入全走 workflowStore（loadWorkflows / addWorkflow / deleteWorkflow）。
 * 「运行」= 把提示词发到当前会话（没有会话时用活动配置组新建一个）——这是
 * 旧 WorkflowModal 里的运行语义，组件里只保留这几行胶水。
 */
export default function WorkflowSurface() {
  const workflows = useWorkflowStore((s) => s.workflows)
  const loaded = useWorkflowStore((s) => s.loaded)
  const loadWorkflows = useWorkflowStore((s) => s.loadWorkflows)
  const addWorkflow = useWorkflowStore((s) => s.addWorkflow)
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow)

  const [category, setCategory] = useState<WorkflowCategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(ROW_PAGE_SIZE)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)

  const listKeyboard = useListKeyboard()

  useEffect(() => {
    if (!loaded) void loadWorkflows()
  }, [loaded, loadWorkflows])

  useEffect(() => {
    setLimit(ROW_PAGE_SIZE)
  }, [category, query])

  const counts = useMemo(() => workflowCategoryCounts(workflows), [workflows])
  const groups = useMemo(() => groupWorkflows(workflows, { category, query }), [workflows, category, query])

  const flat = useMemo(
    () => groups.flatMap((group) => group.workflows.map((workflow) => ({ group, workflow }))),
    [groups],
  )
  const windowed = useMemo(() => rowWindow(flat, limit), [flat, limit])
  const visibleGroups = useMemo(() => {
    const buckets = new Map<string, { id: string; label: string; workflows: Workflow[] }>()
    for (const item of windowed.rows) {
      const bucket = buckets.get(item.group.id) ?? { id: item.group.id, label: item.group.label, workflows: [] }
      bucket.workflows.push(item.workflow)
      buckets.set(item.group.id, bucket)
    }
    return Array.from(buckets.values())
  }, [windowed])

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setDescription('')
    setPrompt('')
    setFormOpen(false)
  }

  const openCreate = () => {
    setEditingId(null)
    setName('')
    setDescription('')
    setPrompt('')
    setFormOpen(true)
    setError(null)
  }

  const openEdit = (workflow: Workflow) => {
    setEditingId(workflow.id)
    setName(workflow.name)
    setDescription(workflow.description)
    setPrompt(workflow.prompt)
    setFormOpen(true)
    setError(null)
  }

  const saveNew = async () => {
    if (saving) return
    if (!prompt.trim()) {
      setError('提示词不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await addWorkflow({
        name: name.trim() || '未命名工作流',
        description: description.trim(),
        prompt: prompt.trim(),
      })
      resetForm()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const run = async (workflow: Workflow) => {
    const chat = useChatStore.getState()
    if (!chat.activeSessionId) {
      const configGroupId = useConfigStore.getState().activeConfigGroupId
      if (!configGroupId) {
        useUIStore.getState().showNotification('还没有可用的 API 配置，先配置模型再运行工作流', 'error')
        return
      }
      chat.createSession(configGroupId)
    }
    const sessionId = useChatStore.getState().activeSessionId
    if (!sessionId) {
      useUIStore.getState().showNotification('没有可发送的会话', 'error')
      return
    }
    setBusy(workflow.id)
    try {
      await useChatStore.getState().sendMessage(sessionId, workflow.prompt)
      useUIStore.getState().showNotification(`已把「${workflow.name}」发到当前会话`, 'success')
    } catch (cause) {
      useUIStore.getState().showNotification(
        cause instanceof Error ? cause.message : '运行工作流失败',
        'error',
      )
    } finally {
      setBusy(null)
    }
  }

  const remove = async (workflow: Workflow) => {
    setBusy(workflow.id)
    setError(null)
    try {
      await deleteWorkflow(workflow.id)
      if (editingId === workflow.id) resetForm()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto pure-scroll px-5 pb-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pt-1">
        {WORKFLOW_CATEGORIES.map((entry) => {
          const active = entry.id === category
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              onClick={() => setCategory(entry.id)}
              className={`pure-focus text-[12.5px] leading-[20px] transition-colors ${
                active
                  ? 'pure-tab-underline text-[var(--pure-ink)]'
                  : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
              }`}
            >
              {entry.label}
              <span className="ml-1 text-[11.5px] text-[var(--pure-muted)]">{counts[entry.id]}</span>
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-3 pt-3">
        <PlainInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索工作流…"
          aria-label="搜索工作流"
          className="bg-[var(--pure-hover)]"
        />
        <TextAction
          onClick={() => (formOpen && !editingId ? resetForm() : openCreate())}
          title={formOpen && !editingId ? '收起新建' : '新建工作流'}
        >
          {formOpen && !editingId ? '取消' : '新建工作流'}
        </TextAction>
      </div>

      {error && !formOpen && (
        <div className="pt-2 text-[12px] leading-[18px] text-[var(--pure-danger)]" role="alert">
          {error}
        </div>
      )}

      {formOpen && (
        <FormShell>
          <div className="flex items-center gap-2">
            <PlainInput
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="名称"
              aria-label="工作流名称"
              className="flex-1"
            />
            <PlainInput
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="一句话描述"
              aria-label="工作流描述"
              className="flex-1"
            />
          </div>
          <div className="pt-1.5">
            <FieldLabel>提示词（可用 {'{selection}'} 引用选中代码）</FieldLabel>
            <PlainTextarea
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void saveNew()
              }}
              placeholder="例如：审查这段改动，指出可读性与边界条件问题"
              aria-label="工作流提示词"
            />
          </div>
          {editingId && (
            <div className="pt-1 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
              编辑：workflowStore 只有 addWorkflow / deleteWorkflow，没有 updateWorkflow；旧弹窗的「更新」是
              组件内先删后建。这里不复制那段逻辑，只能另存为新条目。
            </div>
          )}
          <div className="flex items-center gap-2 pt-1.5">
            {error && (
              <span className="text-[11.5px] leading-[18px] text-[var(--pure-danger)]" role="alert">
                {error}
              </span>
            )}
            <span className="ml-auto flex items-center gap-3">
              {formOpen && (
                <TextAction onClick={resetForm} title="取消">
                  取消
                </TextAction>
              )}
              <TextAction onClick={() => void saveNew()} disabled={saving || !prompt.trim()} title="保存工作流">
                {saving ? '保存中…' : editingId ? '另存为新工作流' : '保存'}
              </TextAction>
            </span>
          </div>
        </FormShell>
      )}

      <div onKeyDown={listKeyboard}>
        {flat.length === 0 ? (
          <EmptyHint>
            {query.trim()
              ? '没有匹配的工作流。'
              : '还没有工作流。把常用的提示词存成模板，之后一键发到当前会话。'}
          </EmptyHint>
        ) : (
          visibleGroups.map((group) => (
            <section key={group.id}>
              <SectionLabel trailing={`${group.workflows.length} 个`}>{group.label}</SectionLabel>
              {group.workflows.map((workflow) => (
                <SurfaceRow
                  key={workflow.id}
                  label={`${workflow.name}，${workflowCategoryLabel(categoryOfWorkflow(workflow))}`}
                  onActivate={() => void run(workflow)}
                  className="pure-row"
                >
                  <div className="flex items-baseline gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] leading-[20px] text-[var(--pure-ink)] truncate">{workflow.name}</div>
                      <div className="text-[11.5px] leading-[18px] text-[var(--pure-muted)] truncate">
                        {workflowSummary(workflow) || '（无描述）'}
                      </div>
                    </div>
                    <span className="shrink-0 flex items-center gap-3">
                      <TextAction
                        onClick={() => void run(workflow)}
                        disabled={busy === workflow.id}
                        title={`运行 ${workflow.name}`}
                      >
                        {busy === workflow.id ? '发送中…' : '运行'}
                      </TextAction>
                      <span className="pure-row-actions inline-flex items-center gap-3">
                        <TextAction onClick={() => openEdit(workflow)} title={`编辑 ${workflow.name}`}>
                          编辑
                        </TextAction>
                        <TextAction
                          onClick={() => void remove(workflow)}
                          disabled={busy === workflow.id}
                          danger
                          title={`删除 ${workflow.name}`}
                        >
                          删除
                        </TextAction>
                      </span>
                    </span>
                  </div>
                </SurfaceRow>
              ))}
            </section>
          ))
        )}

        {windowed.hidden > 0 && (
          <div className="pt-2">
            <TextAction onClick={() => setLimit((current) => nextRowLimit(current))}>
              显示更多（还有 {windowed.hidden} 个）
            </TextAction>
          </div>
        )}
      </div>
    </div>
  )
}
