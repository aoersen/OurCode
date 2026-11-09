/**
 * 计划外写入拦截卡。
 *
 * 计划批准后，agent 想写未声明的路径 → 这张卡解释原因并给三条出路：
 * 加入计划并执行 / 切换模式继续 / 拒绝。视觉上仍是同一张决策卡，只是标题带
 * 红点（危险倾向）且「拒绝」用红令牌。
 */
import { useChatStore } from '@/stores/chatStore'
import DecisionCard, { MonoWell } from './DecisionCard'
import { SCOPE_ACTION, scopeView } from './approvalModel'

export default function ScopeBlockCard() {
  const pendingScope = useChatStore((s) => s.pendingScope)
  const resolveScopeDecision = useChatStore((s) => s.resolveScopeDecision)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  if (!pendingScope || pendingScope.sessionId !== activeSessionId) return null

  const view = scopeView(pendingScope.toolCall.name, pendingScope.paths)

  const handleAction = (actionId: string) => {
    switch (actionId) {
      case SCOPE_ACTION.addToPlan:
        resolveScopeDecision('add_to_plan')
        return
      case SCOPE_ACTION.switchMode:
        resolveScopeDecision('switch_mode')
        return
      case SCOPE_ACTION.reject:
        resolveScopeDecision('reject')
        return
      default:
        return
    }
  }

  return (
    <DecisionCard
      testId="scope-block-card"
      ariaLabel={view.ariaLabel}
      title={view.title}
      description={view.body}
      tone="danger"
      meta={<span className="text-[var(--pure-muted)]">{view.paths.length} 个路径</span>}
      actions={view.actions}
      onAction={handleAction}
      primaryActionId={SCOPE_ACTION.addToPlan}
      rejectActionId={SCOPE_ACTION.reject}
    >
      {view.paths.length > 0 ? (
        <MonoWell testId="scope-block-paths" maxHeightClass="max-h-[16vh]">
          {view.paths.join('\n')}
        </MonoWell>
      ) : null}
    </DecisionCard>
  )
}
