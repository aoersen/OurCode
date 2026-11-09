/**
 * 底栏决策区 —— 所有审批 / 决策卡片的唯一挂载点（挂在 composer 正上方）。
 *
 * 约束（设计稿反复验证过的布局契约）：
 *   · 卡是 in-flow 的，排在 720px 阅读列里，绝不 overlay、绝不遮内容；
 *   · 决策区整体限高 70vh 并可滚 —— 卡再多也把上方消息区留住；
 *   · 单卡正文超高只在卡内滚，操作条常驻（见 DecisionCard）。
 *
 * 门控与旧 InlineDecisionArea 一致：只看当前会话的槽位；提问另有 questionGate
 * （'confirm' 走确认门槛条，'dismissed' 隐藏）。
 */
import { useChatStore } from '@/stores/chatStore'
import ToolApprovalCard from './ToolApprovalCard'
import BatchApprovalCard from './BatchApprovalCard'
import PlanApprovalCard from './PlanApprovalCard'
import ScopeBlockCard from './ScopeBlockCard'
import QuestionCard, { QuestionConfirmBar } from './QuestionCard'
import { RegenerateConfirmCard, RevertAllConfirmCard } from './ConfirmCards'

export default function ApprovalsDock() {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const batchApproval = useChatStore((s) => s.batchApproval)
  const pendingScope = useChatStore((s) => s.pendingScope)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const questionGate = useChatStore((s) => s.questionGate)
  const inlineConfirm = useChatStore((s) => s.inlineConfirm)
  // 两个原子选择器（不能让 selector 返回新对象：useSyncExternalStore 会把每次
  // 快照都当成变更）
  const planStatus = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId)?.planStatus : undefined,
  )
  const hasPlanContent = useChatStore((s) =>
    s.activeSessionId ? !!s.sessions.find((x) => x.id === s.activeSessionId)?.planContent : false,
  )
  const isRunning = useChatStore((s) =>
    s.activeSessionId ? s.runningSessionIds.includes(s.activeSessionId) : false,
  )

  if (!activeSessionId) return null

  const forActive = (slot: { sessionId: string } | null): boolean => !!slot && slot.sessionId === activeSessionId

  const gate = questionGate[activeSessionId]
  const questionGated = !!pendingQuestion && forActive(pendingQuestion) && gate === 'confirm'
  const questionShown =
    !!pendingQuestion && forActive(pendingQuestion) && gate !== 'confirm' && gate !== 'dismissed'

  // 计划：待批准 / 已取消（可重新批准）必须出现；已批准只在执行期留一行记录，
  // 执行结束后收进对话流（决策区不该常驻一条历史）。
  const showPlan =
    hasPlanContent &&
    (planStatus === 'pending_approval' ||
      planStatus === 'canceled' ||
      (planStatus === 'approved' && isRunning))

  const hasAny =
    !!activeSessionId &&
    ((pendingApproval && forActive(pendingApproval)) ||
      (batchApproval && forActive(batchApproval)) ||
      (pendingScope && forActive(pendingScope)) ||
      (inlineConfirm && forActive(inlineConfirm)) ||
      questionGated ||
      questionShown ||
      showPlan)

  if (!hasAny) return null

  return (
    <div
      data-testid="approvals-dock"
      className="flex max-h-[70vh] w-full shrink-0 flex-col gap-2 overflow-y-auto pure-scroll"
    >
      <ToolApprovalCard />
      <BatchApprovalCard />
      <PlanApprovalCard />
      <ScopeBlockCard />
      {questionGated ? <QuestionConfirmBar /> : null}
      {questionShown ? <QuestionCard /> : null}
      <RegenerateConfirmCard />
      <RevertAllConfirmCard />
    </div>
  )
}
