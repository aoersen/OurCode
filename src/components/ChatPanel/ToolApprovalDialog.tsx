import { useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import MSIcon from '@/components/Common/icons/MSIcon'

/**
 * 工具调用审批 —— 内嵌于对话面板决策区（极简纯净版 V2 落地方案）：
 * 白卡 + 发丝线边框 + 左侧 2px 电光蓝边线，吸底显示在消息区最底部、模式栏
 * （目标模式按钮）上方，不再弹窗。仅对当前会话生效（并行会话各自持有自己的
 * 审批状态，切换会话即切换审批对象）。
 */
export default function ToolApprovalDialog() {
  // Fine-grained selectors, not the whole store: while a parallel session
  // streams (~20 Hz) a whole-store subscription here would re-render the
  // dialog on every flush even though nothing it reads changed.
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const approveToolCall = useChatStore((s) => s.approveToolCall)
  const rejectToolCall = useChatStore((s) => s.rejectToolCall)
  const allowToolPermanently = useChatStore((s) => s.allowToolPermanently)
  // With parallel conversations, only the active session's approval dialog is
  // shown — switching to the session that owns the pending call reveals it.
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const t = useI18n()

  if (!pendingApproval || pendingApproval.sessionId !== activeSessionId) return null

  const { toolCall, preview } = pendingApproval

  const handleApprove = () => {
    if (alwaysAllow) allowToolPermanently(toolCall.name)
    setAlwaysAllow(false)
    approveToolCall()
  }
  const handleReject = () => {
    setAlwaysAllow(false)
    rejectToolCall()
  }

  return (
    <div className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border border-l-2 rounded-xl overflow-hidden shadow-sm"
      style={{ borderLeftColor: 'var(--accent)' }}
      role="region"
      aria-label={t('chat.toolApprovalDialog')}
    >
      {/* 头部：⚠️ 警告图标 + 标题 + 工具名等宽徽标 */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
        <MSIcon name="warning" className="text-[18px] leading-none text-warning shrink-0" />
        <span className="text-[13px] font-semibold text-nova-text-primary">{t('chat.toolApprovalTitle')}</span>
        <span className="ml-auto font-mono text-[12px] px-2 py-0.5 rounded bg-nova-accent/5 text-nova-accent border border-nova-accent/10">
          {toolCall.name}
        </span>
      </div>

      {/* 正文：说明 + 调用参数预览 / diff 预览 */}
      <div className="px-4 py-3 flex flex-col gap-2.5">
        <div className="bg-[#f8fafc] dark:bg-white/5 rounded-lg p-3 border border-nova-border font-mono text-[12px] text-nova-text-secondary whitespace-pre-wrap max-h-40 overflow-y-auto">
          {preview}
        </div>

        {toolCall.name === 'edit_file' && toolCall.arguments.oldText && (
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] text-nova-text-muted">{t('chat.changePreview')}</div>
            <div className="bg-red-500/5 border border-red-500/15 rounded px-2.5 py-1.5 font-mono text-[12px] text-red-500 whitespace-pre-wrap break-all">
              - {(toolCall.arguments.oldText || '').slice(0, 200)}
              {(toolCall.arguments.oldText || '').length > 200 && '...'}
            </div>
            <div className="bg-green-500/5 border border-green-500/15 rounded px-2.5 py-1.5 font-mono text-[12px] text-green-600 dark:text-green-400 whitespace-pre-wrap break-all">
              + {(toolCall.arguments.newText || '').slice(0, 200)}
              {(toolCall.arguments.newText || '').length > 200 && '...'}
            </div>
          </div>
        )}
      </div>

      {/* 操作条：始终允许 + 拒绝 / 批准 */}
      <div className="px-4 py-3 border-t border-nova-border flex items-center justify-between gap-3 bg-nova-surface">
        <label className="flex items-center gap-1.5 text-[12px] text-nova-text-muted cursor-pointer select-none hover:text-nova-text-secondary transition-colors">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => setAlwaysAllow(e.target.checked)}
            className="accent-nova-accent w-3.5 h-3.5"
          />
          {t('agent.alwaysAllowTool')}
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReject}
            className="px-3.5 py-1.5 text-[13px] text-red-500 border border-red-500/25 rounded-lg hover:bg-red-500/5 transition-colors"
          >
            {t('chat.reject')}
          </button>
          <button
            onClick={handleApprove}
            className="px-3.5 py-1.5 text-[13px] text-white bg-nova-accent hover:opacity-90 rounded-lg transition-opacity"
          >
            {t('chat.approve')}
          </button>
        </div>
      </div>
    </div>
  )
}
