import StepRow from './StepRow'
import SubAgentRows from './SubAgentRows'
import type { RunStep, SubAgentRow } from './runModel'

/**
 * 展开后的 run：步骤行 + 嵌套子任务行。
 *
 * 刻意不画卡片、不画竖线、不画分割线 —— 设计稿（pure-02b）里这一段就是
 * 一段缩进 16px 的纯文本列表，靠行距和字色分层。
 */
export default function RunDetails({
  steps,
  subAgents,
  onRetry,
}: {
  steps: readonly RunStep[]
  subAgents: readonly SubAgentRow[]
  /** 失败步骤的「重试」——传 undefined 时不出现这个入口 */
  onRetry?: () => void
}) {
  if (steps.length === 0 && subAgents.length === 0) return null

  return (
    <div className="pb-1" data-testid="run-details">
      <div className="pl-4 flex flex-col">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} onRetry={step.state === 'failed' ? onRetry : undefined} />
        ))}
      </div>
      <SubAgentRows rows={subAgents} />
    </div>
  )
}
