import { useMemo } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import MSIcon from '@/components/Common/icons/MSIcon'

/**
 * 回退全部改动确认 —— 内嵌于对话面板决策区（极简纯净版 V2 风格）：白卡 + 发丝线
 * 边框 + 左侧 2px 电光蓝边线，吸底显示在消息区最底部、模式栏（目标模式按钮）上方，
 * 不再弹窗。点「回退全部改动」时通过 chatStore 的 inlineConfirm 状态在此渲染，
 * 列出待回退文件路径，让用户明确选择「回退」还是「保留」。
 */
export default function RevertAllConfirmDialog() {
  const inlineConfirm = useChatStore((s) => s.inlineConfirm)
  const dismissInlineConfirm = useChatStore((s) => s.dismissInlineConfirm)
  const revertFilesByPaths = useChatStore((s) => s.revertFilesByPaths)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const t = useI18n()

  const confirm = inlineConfirm?.type === 'revert_all' ? inlineConfirm : null
  // Hooks must run unconditionally — derive the deduped list from whatever is
  // pending (falls back to empty when no revert-all confirm is active).
  const list = useMemo(
    () => Array.from(new Set((confirm?.filePaths || []).filter(Boolean))),
    [confirm?.filePaths],
  )
  // Parallel conversations: only the active session's confirm renders.
  if (!confirm || confirm.sessionId !== activeSessionId) return null

  const { sessionId } = confirm

  /** 确认框里选「回退」后真正执行全部回退。 */
  const handleRevert = async () => {
    dismissInlineConfirm()
    const { ok, failed } = await revertFilesByPaths(sessionId, list)
    if (failed > 0) {
      useUIStore.getState().showNotification(t('chat.filesChangedRevertFailed', { count: failed }), 'error')
    } else if (ok > 0) {
      useUIStore.getState().showNotification(t('chat.filesChangedReverted', { count: ok }), 'success')
    } else {
      useUIStore.getState().showNotification(t('chat.filesChangedEmpty'), 'info')
    }
  }

  const handleKeep = () => dismissInlineConfirm()

  return (
    <div
      role="region"
      aria-label={t('chat.filesChangedRevertAll')}
      className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border border-l-2 rounded-xl overflow-hidden shadow-sm"
      style={{ borderLeftColor: 'var(--accent)' }}
    >
      {/* 头部：undo 图标 + 标题 + 右上角关闭 */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
        <MSIcon name="undo" className="text-[18px] leading-none text-nova-accent shrink-0" />
        <span className="text-[13px] font-semibold text-nova-text-primary">{t('chat.filesChangedRevertAll')}</span>
        <button
          onClick={handleKeep}
          title={t('common.close')}
          className="ml-auto text-nova-text-muted hover:text-nova-text-primary transition-colors p-1 rounded hover:bg-nova-hover"
        >
          <MSIcon name="close" className="text-[18px] leading-none" />
        </button>
      </div>

      {/* 正文：说明 + 文件清单 */}
      <div className="px-4 py-3 flex flex-col gap-3">
        <p className="text-[13px] text-nova-text-secondary leading-relaxed">
          {t('chat.filesChangedRevertAllBodyPre')}
          <span className="font-semibold text-nova-text-primary">{list.length}</span>
          {t('chat.filesChangedRevertAllBodySuffix')}
        </p>
        {list.length > 0 && (
          <div className="bg-[#f8fafc] dark:bg-white/5 rounded-lg p-3 flex flex-col gap-2 border border-nova-border max-h-48 overflow-y-auto">
            {list.map((p) => (
              <div key={p} className="flex items-center gap-2 text-nova-text-secondary min-w-0">
                <MSIcon name="description" className="text-[15px] leading-none text-nova-text-muted shrink-0" />
                <span className="font-mono text-[12px] truncate" title={p}>{p}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 操作条：保留改动 / 回退 */}
      <div className="px-4 py-3 border-t border-nova-border flex items-center justify-end gap-2 bg-nova-surface">
        <button
          onClick={handleKeep}
          className="px-3.5 py-1.5 text-[13px] font-medium text-white bg-nova-accent hover:opacity-90 transition-opacity rounded-lg shadow-sm"
        >
          {t('chat.filesChangedRevertAllKeep')}
        </button>
        <button
          onClick={() => void handleRevert()}
          title={t('chat.filesChangedRevertAll')}
          className="px-3.5 py-1.5 text-[13px] font-medium text-white bg-red-500 hover:bg-red-600 transition-colors rounded-lg shadow-sm"
        >
          {t('chat.filesChangedRevertAllConfirm')}
        </button>
      </div>
    </div>
  )
}
