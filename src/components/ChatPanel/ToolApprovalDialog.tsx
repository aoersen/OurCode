import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import MSIcon from '@/components/Common/icons/MSIcon'

/**
 * 工具调用审批 —— 内嵌于对话面板决策区（极简纯净版 V2 落地方案）：
 * 白卡 + 发丝线边框 + 左侧 2px 电光蓝边线，吸底显示在消息区最底部、模式栏
 * （目标模式按钮）上方，不再弹窗。仅对当前会话生效（并行会话各自持有自己的
 * 审批状态，切换会话即切换审批对象）。
 *
 * 权限模式重设计（五选项，对齐 ZCode）：
 *   允许（一次）/ 始终允许本会话 / 始终允许本项目 / 拒绝 / 始终拒绝
 * 危险命令只提供 允许（一次）/ 拒绝，不可加入任何白名单。权限请求不超时。
 */
export default function ToolApprovalDialog() {
  // Fine-grained selectors, not the whole store: while a parallel session
  // streams (~20 Hz) a whole-store subscription here would re-render the
  // dialog on every flush even though nothing it reads changed.
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const approveToolCall = useChatStore((s) => s.approveToolCall)
  const rejectToolCall = useChatStore((s) => s.rejectToolCall)
  const allowToolPermanently = useChatStore((s) => s.allowToolPermanently)
  const allowToolForSession = useChatStore((s) => s.allowToolForSession)
  const denyToolPermanently = useChatStore((s) => s.denyToolPermanently)
  // With parallel conversations, only the active session's approval dialog is
  // shown — switching to the session that owns the pending call reveals it.
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const t = useI18n()

  if (!pendingApproval || pendingApproval.sessionId !== activeSessionId) return null

  const { toolCall, preview, dangerous } = pendingApproval

  const handleApprove = () => approveToolCall()
  const handleAllowSession = () => allowToolForSession(toolCall.name)
  const handleAllowProject = () => {
    allowToolPermanently(toolCall.name)
    approveToolCall()
  }
  const handleReject = () => rejectToolCall()
  const handleAlwaysDeny = () => denyToolPermanently(toolCall.name)

  return (
    <div className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border border-l-2 rounded-xl overflow-hidden shadow-sm"
      style={{ borderLeftColor: dangerous ? 'var(--danger, #dc2626)' : 'var(--accent)' }}
      role="region"
      aria-label={t('chat.toolApprovalDialog')}
    >
      {/* 头部：⚠️ 警告图标 + 标题 + 工具名等宽徽标 */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
        <MSIcon name="warning" className={`text-[18px] leading-none shrink-0 ${dangerous ? 'text-red-500' : 'text-warning'}`} />
        <span className="text-[13px] font-semibold text-nova-text-primary">
          {dangerous ? t('approval.dangerousTitle') : t('chat.toolApprovalTitle')}
        </span>
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

      {/* 操作条：危险命令仅 允许（一次）/拒绝；普通五选项 */}
      <div className="px-4 py-3 border-t border-nova-border flex flex-col gap-2 bg-nova-surface">
        {dangerous ? (
          <>
            <div className="flex items-center gap-2">
              <button
                onClick={handleApprove}
                className="flex-1 px-3.5 py-1.5 text-[13px] text-white bg-nova-accent hover:opacity-90 rounded-lg transition-opacity"
              >
                {t('approval.allowOnce')}
              </button>
              <button
                onClick={handleReject}
                className="flex-1 px-3.5 py-1.5 text-[13px] text-red-500 border border-red-500/25 rounded-lg hover:bg-red-500/5 transition-colors"
              >
                {t('approval.denyOnce')}
              </button>
            </div>
            <p className="text-[11px] text-nova-text-muted">{t('approval.dangerNote')}</p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button
                onClick={handleApprove}
                className="flex-1 px-3 py-1.5 text-[13px] text-white bg-nova-accent hover:opacity-90 rounded-lg transition-opacity"
              >
                {t('approval.allowOnce')}
              </button>
              <button
                onClick={handleAllowSession}
                className="flex-1 px-2.5 py-1.5 text-[12px] text-nova-text-secondary border border-nova-border rounded-lg hover:bg-nova-hover transition-colors"
              >
                {t('approval.alwaysAllowSession')}
              </button>
              <button
                onClick={handleAllowProject}
                className="flex-1 px-2.5 py-1.5 text-[12px] text-nova-text-secondary border border-nova-border rounded-lg hover:bg-nova-hover transition-colors"
              >
                {t('approval.alwaysAllowProject')}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleReject}
                className="flex-1 px-3 py-1.5 text-[13px] text-red-500 border border-red-500/25 rounded-lg hover:bg-red-500/5 transition-colors"
              >
                {t('approval.denyOnce')}
              </button>
              <button
                onClick={handleAlwaysDeny}
                className="flex-1 px-3 py-1.5 text-[13px] text-red-500 border border-red-500/25 rounded-lg hover:bg-red-500/5 transition-colors"
              >
                {t('approval.alwaysDeny')}
              </button>
            </div>
            <p className="text-[11px] text-nova-text-muted">{t('approval.waitForeverHint')}</p>
          </>
        )}
      </div>
    </div>
  )
}
