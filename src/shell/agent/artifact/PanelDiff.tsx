import { useCallback } from 'react'
import DiffView from '@/components/Editor/DiffView'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'

/**
 * 面板内的 diff 查看器：editorStore.activeDiff 有值时接管整个面板高度。
 *
 * 复用 components/Editor/DiffView（原样，不改它）：
 *  - 逐块「接受 / 拒绝」由 DiffView 自己在 filePath 存在时提供（接受=保留现状，
 *    拒绝=把该块的前像写回磁盘）；
 *  - 整笔「回退」走 chatStore.revertCheckpoint（checkpointId）；
 *  - 已回退文件的「恢复」走 chatStore.restoreRevertedPath。
 * 关闭 = editorStore.closeDiff()，面板回到之前的页签。
 */
export default function PanelDiff() {
  const diff = useEditorStore((s) => s.activeDiff)
  const closeDiff = useEditorStore((s) => s.closeDiff)
  const revertCheckpoint = useChatStore((s) => s.revertCheckpoint)
  const restoreRevertedPath = useChatStore((s) => s.restoreRevertedPath)

  const notify = useCallback((message: string, type: 'info' | 'success' | 'error') => {
    useUIStore.getState().showNotification(message, type)
  }, [])

  const handleRevert = useCallback(() => {
    const current = useEditorStore.getState().activeDiff
    if (!current?.checkpointId) return
    if (!window.confirm(`确定要回退 "${current.fileName}" 的 AI 改动吗？此操作会恢复到 AI 修改之前的内容。`)) return
    void revertCheckpoint(current.checkpointId)
      .then((result) => {
        if (!result?.ok) {
          notify(`回退失败：${result?.error ?? '检查点不可用'}`, 'error')
          return
        }
        window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: current.path }))
        useEditorStore.getState().closeDiff()
      })
      .catch((error: unknown) => {
        notify(`回退失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      })
  }, [notify, revertCheckpoint])

  const handleRestore = useCallback(() => {
    const current = useEditorStore.getState().activeDiff
    if (!current?.restoreSessionId || !current?.restorePath) return
    const { restoreSessionId: sessionId, restorePath: path, fileName } = current
    if (!window.confirm(`确定要恢复 "${fileName}" 的 AI 改动吗？此操作会把回退前 AI 写入的版本写回磁盘。`)) return
    void restoreRevertedPath(sessionId, path)
      .then((ok) => {
        if (!ok) {
          notify('恢复失败：未找到该文件可恢复的改动。', 'error')
          return
        }
        window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: path }))
        useEditorStore.getState().closeDiff()
      })
      .catch((error: unknown) => {
        notify(`恢复失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      })
  }, [notify, restoreRevertedPath])

  if (!diff) return null

  // 只有「AI 修改前快照」的 diff 才打开逐块接受/拒绝：那是在磁盘上的 AI 改动，
  // 拒绝=写回前像。git（HEAD 对比）diff 里逐块拒绝等于丢弃工作区改动，不该在
  // 只读对比里悄悄提供，所以不传 filePath。
  const reviewableFilePath = diff.kind === 'checkpoint' ? diff.path : undefined

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <DiffView
        original={diff.original}
        modified={diff.modified}
        language={diff.language}
        title={diff.fileName}
        notice={diff.notice}
        filePath={reviewableFilePath}
        onClose={closeDiff}
        onRevert={diff.checkpointId ? handleRevert : undefined}
        onRestore={diff.restoreSessionId && diff.restorePath ? handleRestore : undefined}
      />
    </div>
  )
}
