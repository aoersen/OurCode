/**
 * 重新生成 / 回退全部 两种确认 —— 复用同一张决策卡，只换文案与危险操作的落点。
 *
 * 两条确认都来自 `chatStore.inlineConfirm`（不是弹窗）：卡片在 composer 之上
 * 的决策区里，文件清单进等宽井，正文超高只在卡内滚，操作条常驻。
 */
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import DecisionCard, { MonoWell } from './DecisionCard'
import { CONFIRM_ACTION, regenerateConfirmView, revertAllConfirmView } from './approvalModel'

export function RegenerateConfirmCard() {
  const inlineConfirm = useChatStore((s) => s.inlineConfirm)
  const dismissInlineConfirm = useChatStore((s) => s.dismissInlineConfirm)
  const revertCheckpoint = useChatStore((s) => s.revertCheckpoint)
  const regenerateFromMessage = useChatStore((s) => s.regenerateFromMessage)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  const confirm = inlineConfirm?.type === 'regenerate' ? inlineConfirm : null
  if (!confirm || confirm.sessionId !== activeSessionId) return null

  const view = regenerateConfirmView(confirm.filePaths)
  const { sessionId, messageId, checkpointIds } = confirm

  /** 回退这条回复改过的文件，然后重新生成；失败不回退（仅提示），照常重新生成。 */
  const revertThenRun = async () => {
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
        `回退改动失败：${lastError || String(failed)}`,
        'error',
      )
    }
    void regenerateFromMessage(sessionId, messageId)
  }

  const handleAction = (actionId: string) => {
    switch (actionId) {
      case CONFIRM_ACTION.regenerateRevert:
        void revertThenRun()
        return
      case CONFIRM_ACTION.regenerateKeep:
        dismissInlineConfirm()
        void regenerateFromMessage(sessionId, messageId)
        return
      case CONFIRM_ACTION.dismiss:
        dismissInlineConfirm()
        return
      default:
        return
    }
  }

  return (
    <DecisionCard
      testId="regenerate-confirm-card"
      ariaLabel={view.ariaLabel}
      title={view.title}
      description={view.body}
      actions={view.actions}
      onAction={handleAction}
      primaryActionId={CONFIRM_ACTION.regenerateKeep}
      rejectActionId={CONFIRM_ACTION.dismiss}
    >
      {view.files.length > 0 ? (
        <MonoWell testId="regenerate-confirm-files" maxHeightClass="max-h-[18vh]">
          {view.files.join('\n')}
        </MonoWell>
      ) : null}
    </DecisionCard>
  )
}

export function RevertAllConfirmCard() {
  const inlineConfirm = useChatStore((s) => s.inlineConfirm)
  const dismissInlineConfirm = useChatStore((s) => s.dismissInlineConfirm)
  const revertFilesByPaths = useChatStore((s) => s.revertFilesByPaths)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  const confirm = inlineConfirm?.type === 'revert_all' ? inlineConfirm : null
  if (!confirm || confirm.sessionId !== activeSessionId) return null

  const view = revertAllConfirmView(confirm.filePaths)
  const { sessionId } = confirm
  const files = view.files

  /** 确认框里选「回退」后真正执行全部回退。 */
  const revertAll = async () => {
    dismissInlineConfirm()
    const { ok, failed } = await revertFilesByPaths(sessionId, files)
    const notify = useUIStore.getState().showNotification
    if (failed > 0) notify(`有 ${failed} 个文件的改动回退失败`, 'error')
    else if (ok > 0) notify(`已回退 ${ok} 个文件的改动`, 'success')
    else notify('已无待回退的改动', 'info')
  }

  const handleAction = (actionId: string) => {
    switch (actionId) {
      case CONFIRM_ACTION.revertAll:
        void revertAll()
        return
      case CONFIRM_ACTION.revertAllKeep:
        dismissInlineConfirm()
        return
      default:
        return
    }
  }

  return (
    <DecisionCard
      testId="revert-all-confirm-card"
      ariaLabel={view.ariaLabel}
      title={view.title}
      description={view.body}
      actions={view.actions}
      onAction={handleAction}
      primaryActionId={CONFIRM_ACTION.revertAllKeep}
      rejectActionId={CONFIRM_ACTION.revertAllKeep}
    >
      {files.length > 0 ? (
        <MonoWell testId="revert-all-confirm-files" maxHeightClass="max-h-[18vh]">
          {files.join('\n')}
        </MonoWell>
      ) : null}
    </DecisionCard>
  )
}
