/**
 * 批量审批卡。
 *
 * 收起态：`N 个操作待批准` + 一行行清单（工具 + 目标 + 风险词）+ 三个纯文字
 * 操作（全部批准 / 逐条确认 / 全部拒绝）。
 * 展开态（逐条确认）：每行变成「批准 / 拒绝」两选一，操作条只剩「应用逐条选择」。
 *
 * 逐条选择的落地方式受 store 约束：`decideBatchApproval` 只有 all/confirm/reject
 * 三档。全批准 → all；全拒绝 → reject；混合 → confirm（= 让管线逐个弹卡），
 * 其中被勾成批准的**工具名**写进会话白名单，使它们不再弹卡。这一层映射在
 * `batchApplyPlan` 里，是纯函数、有单测。
 */
import { useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import DecisionCard, { riskTone } from './DecisionCard'
import { CheckGlyph, CrossGlyph } from '../run/glyphs'
import {
  BATCH_ACTION,
  batchApplyPlan,
  batchView,
  type BatchDecisions,
  type BatchItemView,
} from './approvalModel'

interface BatchUiState {
  key: string
  expanded: boolean
  decisions: BatchDecisions
}

const EMPTY_STATE: BatchUiState = { key: '', expanded: false, decisions: {} }

export default function BatchApprovalCard() {
  const batchApproval = useChatStore((s) => s.batchApproval)
  const decideBatchApproval = useChatStore((s) => s.decideBatchApproval)
  const allowToolForSession = useChatStore((s) => s.allowToolForSession)
  // `allowToolForSession` 会顺手批准当前槽位里的单条审批（approveToolCall）。
  // 正常流程里批量卡与单条卡不会同时挂着（批量在前、逐条在后），但万一同时
  // 存在就放弃「预写白名单」，退回逐个弹卡 —— 绝不能替用户批准另一条。
  const otherApprovalPending = useChatStore((s) => s.pendingApproval !== null)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const [ui, setUi] = useState<BatchUiState>(EMPTY_STATE)

  // 新的一批到达（不同 run / 不同条数）时丢掉上一批的展开态与勾选
  const batchKey = batchApproval
    ? `${batchApproval.sessionId}::${batchApproval.runId}::${batchApproval.tools.length}`
    : ''
  const current = ui.key === batchKey ? ui : EMPTY_STATE

  if (!batchApproval || batchApproval.sessionId !== activeSessionId) return null

  const view = batchView(batchApproval, { expanded: current.expanded, decisions: current.decisions })

  const setDecision = (itemId: string, value: 'approve' | 'reject') => {
    setUi((prev) => {
      const base = prev.key === batchKey ? prev : EMPTY_STATE
      const decisions = { ...base.decisions }
      if (decisions[itemId] === value) delete decisions[itemId]
      else decisions[itemId] = value
      return { key: batchKey, expanded: base.expanded, decisions }
    })
  }

  const applyItems = () => {
    const plan = batchApplyPlan(batchApproval.tools, current.decisions)
    // 逐条批准的工具写进会话白名单（store 没有「单条批准」之外的入口）；
    // 有另一条单条审批挂着时不做这一步，避免顺手把它批掉。
    if (!otherApprovalPending) {
      for (const name of plan.allowNames) allowToolForSession(name)
    }
    decideBatchApproval(plan.decision)
  }

  const handleAction = (actionId: string) => {
    switch (actionId) {
      case BATCH_ACTION.approveAll:
        decideBatchApproval('all')
        return
      case BATCH_ACTION.confirmEach:
        setUi({ key: batchKey, expanded: true, decisions: {} })
        return
      case BATCH_ACTION.applyItems:
        applyItems()
        return
      case BATCH_ACTION.rejectAll:
        setUi(EMPTY_STATE)
        decideBatchApproval('reject')
        return
      default:
        return
    }
  }

  return (
    <DecisionCard
      testId="batch-approval-card"
      ariaLabel={view.ariaLabel}
      title={view.title}
      description={view.description}
      actions={view.actions}
      onAction={handleAction}
      primaryActionId={current.expanded ? BATCH_ACTION.applyItems : BATCH_ACTION.approveAll}
      rejectActionId={BATCH_ACTION.rejectAll}
      note="权限请求会一直等待，不会超时"
    >
      <ul className="flex flex-col">
        {view.items.map((item) => (
          <li key={item.id} className="border-b border-[var(--pure-border)] py-1 last:border-b-0">
            {current.expanded ? (
              <ExpandedRow
                item={item}
                decision={current.decisions[item.id]}
                onDecide={(value) => setDecision(item.id, value)}
              />
            ) : (
              <CompactRow item={item} />
            )}
          </li>
        ))}
      </ul>
    </DecisionCard>
  )
}

/** 一行：工具（sans）+ 目标（等宽，只有机器串用等宽）+ 风险词（灰/红）。 */
function CompactRow({ item }: { item: BatchItemView }) {
  return (
    <div className="flex items-baseline gap-2 text-[12.5px] leading-[20px]">
      <span className="w-[68px] shrink-0 truncate text-[var(--pure-ink)]">{item.label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--pure-muted)]" title={item.target}>
        {item.target || '—'}
      </span>
      <span className={`shrink-0 text-[11px] ${riskTone(item.risk)}`}>{item.risk.word}</span>
    </div>
  )
}

function ExpandedRow({
  item,
  decision,
  onDecide,
}: {
  item: BatchItemView
  decision?: 'approve' | 'reject'
  onDecide: (value: 'approve' | 'reject') => void
}) {
  return (
    <div
      className="flex items-baseline gap-2 text-[12.5px] leading-[20px]"
      role="group"
      aria-label={`${item.label} ${item.target}`}
    >
      <span
        className={`w-[68px] shrink-0 truncate ${decision === 'reject' ? 'text-[var(--pure-muted)] line-through' : 'text-[var(--pure-ink)]'}`}
      >
        {item.label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--pure-muted)]" title={item.target}>
        {item.target || '—'}
      </span>
      <span className={`shrink-0 text-[11px] ${riskTone(item.risk)}`}>{item.risk.word}</span>
      <button
        type="button"
        aria-label={`批准 ${item.label} ${item.target}`}
        aria-pressed={decision === 'approve'}
        onClick={() => onDecide('approve')}
        className={`pure-focus inline-flex shrink-0 items-center gap-0.5 rounded text-[11.5px] transition-colors ${
          decision === 'approve' ? 'text-[var(--pure-ink)]' : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
        }`}
      >
        {decision === 'approve' ? <CheckGlyph className="h-3 w-3" /> : null}
        批准
      </button>
      <button
        type="button"
        aria-label={`拒绝 ${item.label} ${item.target}`}
        aria-pressed={decision === 'reject'}
        onClick={() => onDecide('reject')}
        className={`pure-focus inline-flex shrink-0 items-center gap-0.5 rounded text-[11.5px] transition-colors ${
          decision === 'reject' ? 'text-[var(--pure-ink)]' : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
        }`}
      >
        {decision === 'reject' ? <CrossGlyph className="h-3 w-3" /> : null}
        拒绝
      </button>
    </div>
  )
}
