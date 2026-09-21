import { useEffect, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import type { TodoItem } from '@/types'
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'

/**
 * Agent status panel: shows the agent's todo list (manage_todo) and the plan
 * approval card (submit_plan) — in-chat agent task tracking.
 */

const STATUS_LABEL_KEY: Record<TodoItem['status'], TranslationKey> = {
  pending: 'agent.pending',
  in_progress: 'agent.inProgress',
  completed: 'agent.completed',
  failed: 'agent.failed',
}

/** Todo icon per status — mockup「极简纯净版」Material 图标（进行中旋转），
 *  仅 in_progress 用 accent 强调，完成/待办保持中性灰。 */
function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return (
      <span className="material-symbols-outlined text-[16px] leading-none text-nova-text-muted shrink-0" aria-hidden>check</span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="material-symbols-outlined text-[16px] leading-none text-[var(--red,#dc2626)] shrink-0" aria-hidden>close</span>
    )
  }
  if (status === 'in_progress') {
    return (
      <span className="material-symbols-outlined text-[16px] leading-none animate-spin-slow text-nova-accent shrink-0" aria-hidden>progress_activity</span>
    )
  }
  // pending
  return (
    <span className="material-symbols-outlined text-[16px] leading-none text-nova-text-muted opacity-60 shrink-0" aria-hidden>radio_button_unchecked</span>
  )
}

export function TodoPanel({ sessionId }: { sessionId: string }) {
  const session = useChatStore((s) => s.sessions.find((x) => x.id === sessionId))
  const todos = session?.todos || []
  const t = useI18n()

  if (todos.length === 0) return null

  return (
    /* mockup「任务清单」：minimal-panel 卡片 + checklist 图标 + 状态行 */
    <div className="minimal-panel relative">
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3 text-nova-text-primary">
          <span className="material-symbols-outlined text-[18px] leading-none" aria-hidden>checklist</span>
          <h3 className="text-sm font-semibold">{t('agent.todoList')}</h3>
          <span className="ml-auto text-[10px] font-medium text-nova-text-muted shrink-0">
            {t('agent.doneCount', { done: todos.filter((x) => x.status === 'completed').length, total: todos.length })}
          </span>
        </div>
        <div className="flex flex-col gap-1 max-h-40 overflow-y-auto text-[13px]">
          {todos.map((todo) => (
            <div
              key={todo.id}
              className={`flex items-center gap-2.5 px-1.5 py-1 rounded-md hover:bg-nova-hover transition-colors ${
                todo.status === 'completed'
                  ? 'text-nova-text-muted line-through opacity-70'
                  : todo.status === 'pending'
                    ? 'text-nova-text-muted'
                    : todo.status === 'in_progress'
                      ? 'text-nova-text-primary font-medium'
                      : 'text-nova-text-primary'
              }`}
            >
              <TodoStatusIcon status={todo.status} />
              <span className="min-w-0 flex-1 leading-snug">{todo.content}</span>
              <span className="text-[10px] shrink-0 opacity-70 text-nova-text-muted">
                {t(STATUS_LABEL_KEY[todo.status])}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function PlanCard({ sessionId }: { sessionId: string }) {
  const session = useChatStore((s) => s.sessions.find((x) => x.id === sessionId))
  const approvePlan = useChatStore((s) => s.approvePlan)
  const dismissPlan = useChatStore((s) => s.dismissPlan)
  const isRunning = useChatStore((s) => s.runningSessionIds.includes(sessionId))
  const t = useI18n()
  // Plan-approved auto-approval (allowedPrompts-style): when checked, the
  // execution phase of this run proceeds without per-tool dialogs. Local
  // state only — it is passed once to approvePlan and cleared when the run ends.
  const [autoApprove, setAutoApprove] = useState(false)

  // A fresh plan always starts with auto-approve unchecked — don't leak the
  // choice made for a previously approved plan into the next plan's card
  // (otherwise the user could re-approve a new plan with auto-approval on
  // without noticing the checkbox was still ticked).
  useEffect(() => {
    if (session?.planStatus === 'pending_approval') setAutoApprove(false)
  }, [session?.planStatus])

  // A canceled plan stays on record (planContent kept, status 'canceled') so
  // the conversation still shows what was submitted and later canceled — the
  // user may want to manually adjust or re-approve it.
  if (!session || !session.planContent || session.planStatus === 'none') return null
  const status = session.planStatus

  let title = t('agent.executePlan')
  const steps: Array<{ summary: string; detail?: string }> = []
  try {
    const plan = JSON.parse(session.planContent)
    title = plan.title || title
    if (Array.isArray(plan.steps)) steps.push(...plan.steps)
  } catch { /* plain text plan */ }

  const renderSteps = () =>
    steps.length > 0 ? (
      <ol className="space-y-1.5">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2 text-xs">
            <span className="shrink-0 w-4 h-4 rounded-full bg-accent-20 text-nova-accent text-[10px] flex items-center justify-center font-medium">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-nova-text-primary">{step.summary}</div>
              {step.detail && <div className="text-nova-text-muted text-[11px]">{step.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
    ) : (
      <pre className="text-xs text-nova-text-secondary whitespace-pre-wrap">{session.planContent}</pre>
    )

  // Approved — read-only record of the executed plan
  if (status === 'approved') {
    return (
      <div
        role="region"
        aria-label={title}
        className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border border-l-2 rounded-xl overflow-hidden shadow-sm"
        style={{ borderLeftColor: 'var(--success, #16a34a)' }}
      >
        <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
          <span className="material-symbols-outlined text-[18px] leading-none text-success shrink-0" aria-hidden>check_circle</span>
          <span className="text-[13px] font-semibold text-nova-text-primary">{title}</span>
          <span className="ml-auto text-[11px] px-2 py-0.5 rounded bg-success-10 text-success border border-success-20">
            {t('agent.planApproved')}
          </span>
        </div>
        <div className="px-4 py-3">{renderSteps()}</div>
      </div>
    )
  }

  // Canceled — the plan stays visible as a record, with a re-approve action
  if (status === 'canceled') {
    return (
      <div
        role="region"
        aria-label={title}
        className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border rounded-xl overflow-hidden shadow-sm opacity-90"
      >
        <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
          <span className="material-symbols-outlined text-[18px] leading-none text-nova-text-muted shrink-0" aria-hidden>cancel</span>
          <span className="text-[13px] font-semibold text-nova-text-muted">{title}</span>
          <span className="ml-auto text-[11px] text-nova-text-muted">{t('agent.planCanceled')}</span>
        </div>
        <div className="px-4 py-3">
          {renderSteps()}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => approvePlan(sessionId)}
              disabled={isRunning}
              className="px-3.5 py-1.5 text-[13px] font-medium text-white bg-nova-accent hover:opacity-90 rounded-lg transition-opacity disabled:opacity-40"
            >
              {t('agent.reapprovePlan')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // pending_approval — the interactive approve / modify card
  // (mockup「计划批准」→ 极简纯净版 V2：白卡 + 发丝线边框 + 左侧 2px 电光蓝
  //  边线 + 头部/操作条结构，与 ToolApprovalDialog / BatchApprovalDialog 等
  //  内嵌决策卡同款；电光蓝「同意并执行」主按钮 / 白底「修改计划」ghost 按钮。)
  return (
    <div
      role="region"
      aria-label={title}
      className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border border-l-2 rounded-xl overflow-hidden shadow-sm"
      style={{ borderLeftColor: 'var(--accent)' }}
    >
      <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
        <span className="material-symbols-outlined text-[18px] leading-none text-nova-accent shrink-0" aria-hidden>assignment</span>
        <span className="text-[13px] font-semibold text-nova-text-primary">{title}</span>
        <span className="ml-auto text-[11px] px-2 py-0.5 rounded bg-nova-accent/5 text-nova-accent border border-nova-accent/10">
          {t('agent.awaitingApproval')}
        </span>
      </div>
      <div className="px-4 py-3 flex flex-col gap-2.5">
        {renderSteps()}
        <label className="flex items-center gap-1.5 text-[12px] text-nova-text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
            className="accent-nova-accent w-3.5 h-3.5"
          />
          {t('agent.autoApproveAfterPlan')}
        </label>
      </div>
      <div className="px-4 py-3 border-t border-nova-border flex items-center justify-end gap-2 bg-nova-surface">
        <button
          onClick={() => dismissPlan(sessionId)}
          className="px-3.5 py-1.5 text-[13px] font-medium text-nova-text-secondary border border-nova-border rounded-lg hover:bg-nova-hover transition-colors"
        >
          {t('agent.modifyPlan')}
        </button>
        <button
          onClick={() => approvePlan(sessionId, { autoApprove })}
          disabled={isRunning}
          className="px-3.5 py-1.5 text-[13px] font-medium text-white bg-nova-accent hover:opacity-90 rounded-lg transition-opacity disabled:opacity-40"
        >
          {t('agent.approveAndRun')}
        </button>
      </div>
    </div>
  )
}
