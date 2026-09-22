import { useMemo } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import MSIcon from '@/components/Common/icons/MSIcon'

/**
 * 重新生成确认 —— 内嵌于对话面板决策区（极简纯净版 V2 风格）：白卡 + 发丝线
 * 边框 + 左侧 2px 电光蓝边线，吸底显示在消息区最底部、模式栏（目标模式按钮）
 * 上方，不再弹窗。点「重新生成」且该回复改过文件时，通过 chatStore 的
 * inlineConfirm 状态在此渲染；确认后执行回退 / 保留并重新生成。
 */
export default function RegenerateConfirmDialog() {
  const inlineConfirm = useChatStore((s) => s.inlineConfirm)
  const dismissInlineConfirm = useChatStore((s) => s.dismissInlineConfirm)
  const revertCheckpoint = useChatStore((s) => s.revertCheckpoint)
  const regenerateFromMessage = useChatStore((s) => s.regenerateFromMessage)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const t = useI18n()

  const confirm = inlineConfirm?.type === 'regenerate' ? inlineConfirm : null
  // Hooks must run unconditionally — derive the deduped list from whatever is
  // pending (falls back to empty when no regenerate confirm is active).
  const list = useMemo(
    () => Array.from(new Set((confirm?.filePaths || []).filter(Boolean))),
    [confirm?.filePaths],
  )
  // Parallel conversations: only the active session's confirm renders.
  if (!confirm || confirm.sessionId !== activeSessionId) return null

  const { sessionId, messageId, checkpointIds } = confirm

  /** 回退这条回复改过的文件，然后重新生成；失败不回退（仅提示），照常重新生成。 */
  const handleRevert = async () => {
    let failed = 0
    let lastError = ''
    for (const id of checkpointIds) {
      const res = await revertCheckpoint(id)
      if (!res?.ok) {
        failed++
        if (res?.error) lastError = res.error
      }
    }
    dismissInlineConfirm()
    if (failed > 0) {
      useUIStore.getState().showNotification(
        t('chat.regenerateRevertFailed', { error: lastError || String(failed) }),
        'error',
      )
    }
    void regenerateFromMessage(sessionId, messageId)
  }

  const handleKeep = () => {
    dismissInlineConfirm()
    void regenerateFromMessage(sessionId, messageId)
  }

  const handleClose = () => dismissInlineConfirm()

  return (
    <div
      role="region"
      aria-label={t('chat.regenerateConfirmTitle')}
      className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border border-l-2 rounded-xl overflow-hidden shadow-sm"
      style={{ borderLeftColor: 'var(--accent)' }}
    >
      {/* 头部：refresh 图标 + 标题 + 右上角关闭 */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
        <MSIcon name="refresh" className="text-[18px] leading-none text-nova-accent shrink-0" />
        <span className="text-[13px] font-semibold text-nova-text-primary">{t('chat.regenerateConfirmTitle')}</span>
        <button
          onClick={handleClose}
          title={t('common.close')}
          className="ml-auto text-nova-text-muted hover:text-nova-text-primary transition-colors p-1 rounded hover:bg-nova-hover"
        >
          <MSIcon name="close" className="text-[18px] leading-none" />
        </button>
      </div>

      {/* 正文：说明 + 文件清单 */}
      <div className="px-4 py-3 flex flex-col gap-3">
        <p className="text-[13px] text-nova-text-secondary leading-relaxed">
          {t('chat.regenerateConfirmBodyPre')}
          <span className="font-semibold text-nova-text-primary">{list.length}</span>
          {t('chat.regenerateConfirmBodySuffix')}
        </p>
        {list.length > 0 && (
          <div className="bg-[#f8fafc] dark:bg-white/5 rounded-lg p-3 flex flex-col gap-2 border border-nova-border">
            {list.map((p) => (
              <div key={p} className="flex items-center gap-2 text-nova-text-secondary min-w-0">
                <MSIcon name="description" className="text-[15px] leading-none text-nova-text-muted shrink-0" />
                <span className="font-mono text-[12px] truncate" title={p}>{p}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 操作条：取消 / 回退并重新生成 / 保留并重新生成 */}
      <div className="px-4 py-3 border-t border-nova-border flex items-center justify-end gap-2 bg-nova-surface">
        <button
          onClick={handleClose}
          className="px-3 py-1.5 text-[13px] font-medium text-nova-text-secondary hover:text-nova-text-primary transition-colors rounded-lg hover:bg-nova-hover"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={() => void handleRevert()}
          title={t('chat.rollbackHint')}
          className="px-3.5 py-1.5 text-[13px] font-medium text-white bg-red-500 hover:bg-red-600 transition-colors rounded-lg shadow-sm"
        >
          {t('chat.regenerateRevertAndRun')}
        </button>
        <button
          onClick={handleKeep}
          className="px-3.5 py-1.5 text-[13px] font-medium text-white bg-nova-accent hover:opacity-90 transition-opacity rounded-lg shadow-sm"
        >
          {t('chat.regenerateKeepAndRun')}
        </button>
      </div>
    </div>
  )
}
