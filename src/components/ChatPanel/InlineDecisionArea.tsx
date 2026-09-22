import ToolApprovalDialog from './ToolApprovalDialog'
import BatchApprovalDialog from './BatchApprovalDialog'
import QuestionDialog from './QuestionDialog'
import ScopeBlockDialog from './ScopeBlockDialog'
import RegenerateConfirmDialog from './RegenerateConfirmDialog'
import RevertAllConfirmDialog from './RevertAllConfirmDialog'
import { useChatStore } from '@/stores/chatStore'

/**
 * 对话面板决策区 —— 吸底显示在消息区最底部、模式栏（目标模式按钮）上方。
 *
 * 把过去全部「从对话面板弹窗」的框内嵌进对话本身：询问选择（ask_user_question）、
 * 工具调用审批、批量审批、计划外写入拦截、重新生成确认、回退全部改动确认，
 * 全部在对话面板内完成，不再出现居中弹窗或遮罩（通知 toast 除外）。只对当前
 * 会话渲染，各子卡自带 sessionId 过滤与 questionGate 门控；此处仅在至少一项
 * 待处理时占位，避免空档。
 */
export default function InlineDecisionArea() {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const batchApproval = useChatStore((s) => s.batchApproval)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const pendingScope = useChatStore((s) => s.pendingScope)
  const questionGate = useChatStore((s) => s.questionGate)
  const inlineConfirm = useChatStore((s) => s.inlineConfirm)

  // 与各子卡相同的门控：问题只有在未挂在「先确认」门（confirm/dismissed）时才
  // 显示；确认门由 QuestionConfirmBar 处理。任一决策属于当前会话即渲染决策区。
  const questionShown =
    !!pendingQuestion &&
    pendingQuestion.sessionId === activeSessionId &&
    questionGate[pendingQuestion.sessionId] !== 'confirm' &&
    questionGate[pendingQuestion.sessionId] !== 'dismissed'

  const hasAny =
    (pendingApproval && pendingApproval.sessionId === activeSessionId) ||
    (batchApproval && batchApproval.sessionId === activeSessionId) ||
    (pendingScope && pendingScope.sessionId === activeSessionId) ||
    questionShown ||
    (inlineConfirm && inlineConfirm.sessionId === activeSessionId)

  if (!hasAny || !activeSessionId) return null

  return (
    <div className="shrink-0 px-6 pt-2 pb-1 flex flex-col gap-2">
      <ToolApprovalDialog />
      <BatchApprovalDialog />
      <ScopeBlockDialog />
      <QuestionDialog />
      <RegenerateConfirmDialog />
      <RevertAllConfirmDialog />
    </div>
  )
}
