/**
 * 单条工具审批卡。
 *
 * 解剖：标题行 → 一行目标（`Edit · src/...`）→ 正文（edit_file 的红删绿增、
 * 危险命令的告警文、可折叠「参数」JSON 井）→ 操作条（批准 / 始终允许（本项目）
 * / 拒绝）。危险命令只有批准 / 拒绝：白名单对它是禁区，卡片不提供 store 会
 * 拒绝执行的选项。
 *
 * 键盘：Enter = 批准，⌘⇧Enter = 始终允许（本项目），Esc = 焦点跳到拒绝。
 */
import { useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import DecisionCard, { Disclosure, MonoWell, riskTone } from './DecisionCard'
import { TOOL_ACTION, toolApprovalView } from './approvalModel'

export default function ToolApprovalCard() {
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const approveToolCall = useChatStore((s) => s.approveToolCall)
  const rejectToolCall = useChatStore((s) => s.rejectToolCall)
  const allowToolPermanently = useChatStore((s) => s.allowToolPermanently)
  // 并行会话：只画当前会话的审批卡，切到会话才显示（与旧决策区一致）
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // 「参数」展开态按 toolCall.id 记：新的一条审批到达时自动收起
  const [openParamsId, setOpenParamsId] = useState<string | null>(null)

  if (!pendingApproval || pendingApproval.sessionId !== activeSessionId) return null

  const view = toolApprovalView(pendingApproval)
  const toolCallId = pendingApproval.toolCall.id
  const paramsOpen = openParamsId === toolCallId

  const handleAction = (actionId: string) => {
    switch (actionId) {
      case TOOL_ACTION.approve:
        approveToolCall()
        return
      case TOOL_ACTION.alwaysAllowProject:
        // 先写白名单再批准：顺序反了会先关掉卡片，白名单就落在这条调用之后
        allowToolPermanently(view.toolName)
        approveToolCall()
        return
      case TOOL_ACTION.reject:
        rejectToolCall()
        return
      default:
        return
    }
  }

  const description = view.target ? `${view.label} · ${view.target}` : view.label

  return (
    <DecisionCard
      testId="tool-approval-card"
      ariaLabel={view.ariaLabel}
      title={view.title}
      description={description}
      tone={view.risk.level === 'danger' ? 'danger' : 'default'}
      meta={<span className={riskTone(view.risk)}>{view.risk.word}</span>}
      actions={view.actions}
      onAction={handleAction}
      primaryActionId={TOOL_ACTION.approve}
      alwaysAllowActionId={TOOL_ACTION.alwaysAllowProject}
      rejectActionId={TOOL_ACTION.reject}
      note={view.risk.level === 'danger' ? '危险命令不可加入白名单' : undefined}
    >
      <div className="flex flex-col gap-2">
        {/* 危险命令：把 store 已经判好的告警文（含原因）原样呈现 */}
        {view.risk.level === 'danger' && view.preview ? (
          <MonoWell testId="tool-approval-warning" maxHeightClass="max-h-[16vh]">
            {view.preview}
          </MonoWell>
        ) : null}

        {/* edit_file / multi_edit_file：红删绿增（等宽，200 字上限） */}
        {view.edit ? (
          <div className="flex flex-col gap-1" data-testid="tool-approval-diff">
            <div className="rounded-md border-l-2 border-[var(--pure-danger)] bg-[var(--pure-code)] px-2.5 py-1.5 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap break-all text-[var(--pure-danger)]">
              {`- ${view.edit.removed || '（空）'}`}
            </div>
            <div className="rounded-md border-l-2 border-[var(--success)] bg-[var(--pure-code)] px-2.5 py-1.5 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap break-all text-[var(--success)]">
              {`+ ${view.edit.added || '（空）'}`}
            </div>
          </div>
        ) : null}

        <Disclosure
          label="参数"
          open={paramsOpen}
          onToggle={() => setOpenParamsId(paramsOpen ? null : toolCallId)}
          count={view.args.truncated ? `共 ${view.args.totalChars} 字符` : undefined}
        >
          <MonoWell testId="tool-approval-params">{view.args.text}</MonoWell>
        </Disclosure>
      </div>
    </DecisionCard>
  )
}
