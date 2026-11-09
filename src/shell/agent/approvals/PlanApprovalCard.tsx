/**
 * 计划审批卡（submit_plan）。
 *
 * 待批准：计划标题 + 3 行摘要（多出的步数只报数）+ 申请修改 / 取消；
 * 已批准：收成一条 muted 单行记录（不再占一块卡）；
 * 已取消：同一条记录 + 纯文字「重新批准」（计划仍在记录里，可再批）。
 *
 * store 只有 approvePlan / dismissPlan 两个入口：「要求修改」和「取消」都走
 * dismissPlan（planStatus → 'canceled'，run 标记 rejected，模型据此重提计划）。
 */
import { useChatStore } from '@/stores/chatStore'
import DecisionCard, { Disclosure, MonoWell } from './DecisionCard'
import { CheckGlyph } from '../run/glyphs'
import { PLAN_ACTION, planView } from './approvalModel'
import { useState } from 'react'

export default function PlanApprovalCard() {
  const session = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null,
  )
  const approvePlan = useChatStore((s) => s.approvePlan)
  const dismissPlan = useChatStore((s) => s.dismissPlan)
  const isRunning = useChatStore((s) =>
    s.activeSessionId ? s.runningSessionIds.includes(s.activeSessionId) : false,
  )
  const [filesOpen, setFilesOpen] = useState(false)

  const view = planView(session)
  if (!view || !session) return null

  // 已批准：一条 muted 记录就够（不画卡、不占高度）
  if (view.state === 'approved') {
    return (
      <div
        role="status"
        data-testid="plan-record"
        aria-label={`${view.title}（已批准）`}
        className="flex w-full shrink-0 items-center gap-2 rounded-xl border border-[var(--pure-border)] px-4 py-2 text-[12.5px] leading-[18px] text-[var(--pure-muted)]"
      >
        <CheckGlyph className="h-3 w-3" />
        <span className="min-w-0 flex-1 truncate" title={view.title}>
          {view.title}
        </span>
        <span className="shrink-0">{view.recordLine}</span>
      </div>
    )
  }

  const handleAction = (actionId: string) => {
    switch (actionId) {
      case PLAN_ACTION.approve:
      case PLAN_ACTION.reapprove:
        void approvePlan(session.id)
        return
      case PLAN_ACTION.revise:
      case PLAN_ACTION.cancel:
        dismissPlan(session.id)
        return
      default:
        return
    }
  }

  if (view.state === 'canceled') {
    return (
      <div
        role="status"
        data-testid="plan-record"
        aria-label={`${view.title}（已取消）`}
        className="flex w-full shrink-0 items-center gap-2 rounded-xl border border-[var(--pure-border)] px-4 py-2 text-[12.5px] leading-[18px] text-[var(--pure-muted)]"
      >
        <span className="min-w-0 flex-1 truncate line-through" title={view.title}>
          {view.title}
        </span>
        <span className="shrink-0">{view.recordLine}</span>
        <button
          type="button"
          onClick={() => handleAction(PLAN_ACTION.reapprove)}
          aria-label={view.actions[0]?.ariaLabel ?? '重新批准这份计划'}
          className="pure-focus shrink-0 rounded px-1 text-[12px] text-[var(--pure-ink)] transition-opacity hover:opacity-70"
        >
          {view.actions[0]?.label ?? '重新批准'}
        </button>
      </div>
    )
  }

  const summary = view.lines.length > 0 ? view.lines.join(' · ') : '（未分步）'

  return (
    <DecisionCard
      testId="plan-approval-card"
      ariaLabel={view.ariaLabel}
      title={view.title}
      description={summary}
      meta={
        <span className="text-[var(--pure-muted)]">
          {view.lines.length + view.hiddenSteps} 步
        </span>
      }
      actions={view.actions.map((action) =>
        action.id === PLAN_ACTION.approve ? { ...action, disabled: isRunning } : action,
      )}
      onAction={handleAction}
      primaryActionId={PLAN_ACTION.approve}
      rejectActionId={PLAN_ACTION.cancel}
    >
      <div className="flex flex-col gap-2">
        <ol className="flex flex-col gap-0.5">
          {view.lines.map((line, index) => (
            <li key={index} className="flex gap-2 text-[12.5px] leading-[20px] text-[var(--pure-secondary)]">
              <span aria-hidden className="shrink-0 tabular-nums text-[var(--pure-muted)]">
                {index + 1}.
              </span>
              <span className="min-w-0 flex-1 truncate" title={line}>
                {line}
              </span>
            </li>
          ))}
        </ol>
        {view.hiddenSteps > 0 ? (
          <span className="text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
            还有 {view.hiddenSteps} 步未展开
          </span>
        ) : null}

        {view.deliverables.length > 0 ? (
          <Disclosure
            label="最终产物"
            open={filesOpen}
            onToggle={() => setFilesOpen((v) => !v)}
            count={`${view.deliverables.length} 个文件`}
          >
            <MonoWell testId="plan-deliverables" maxHeightClass="max-h-[18vh]">
              {view.deliverables.join('\n')}
            </MonoWell>
          </Disclosure>
        ) : (
          <span className="text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
            未声明最终产物：批准后所有文件写入都会被拦截
          </span>
        )}
      </div>
    </DecisionCard>
  )
}
