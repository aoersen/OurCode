import { useChatStore } from '@/stores/chatStore'
import { useUIStore, type ContextMenuItem } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'

/** A session only needs the fields the menu inspects. */
export interface SessionMenuTarget {
  id: string
  pinnedAt?: number | null
  archivedAt?: number | null
}

/**
 * Shared per-session actions for every surface that lists conversations (the
 * chat session sidebar and the left project panel): 置顶 / 重命名 / 导出
 * Markdown+JSON / 归档 / 删除 — all exposed through the same context menu so
 * the two lists behave identically.
 */
export function useSessionMenu() {
  const t = useI18n()
  const deleteSession = useChatStore((s) => s.deleteSession)
  const runningSessionIds = useChatStore((s) => s.runningSessionIds)
  const renameSession = useChatStore((s) => s.renameSession)
  const exportSession = useChatStore((s) => s.exportSession)
  const togglePin = useChatStore((s) => s.togglePin)
  const toggleArchive = useChatStore((s) => s.toggleArchive)
  const showContextMenu = useUIStore((s) => s.showContextMenu)

  const handleDelete = (sessionId: string) => {
    // Deleting stops the run — the user must know the file edits it already made
    // lose their rollback snapshots along with the conversation.
    const running = runningSessionIds.includes(sessionId)
    if (confirm(t(running ? 'chat.deleteSessionConfirmRunning' : 'chat.deleteSessionConfirm'))) {
      deleteSession(sessionId)
    }
  }

  const handleRename = (sessionId: string) => {
    const title = prompt(t('chat.renameSessionPrompt'))
    if (title?.trim()) {
      renameSession(sessionId, title.trim())
    }
  }

  const handleExport = (sessionId: string, format: 'markdown' | 'json') => {
    const content = exportSession(sessionId, format)
    const blob = new Blob([content], {
      type: format === 'markdown' ? 'text/markdown' : 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${t('layout.chatFilePrefix')}-${Date.now()}.${format === 'markdown' ? 'md' : 'json'}`
    a.click()
    URL.revokeObjectURL(url)
  }

  /** Build the shared per-session context menu. */
  const buildSessionMenu = (session: SessionMenuTarget): ContextMenuItem[] => [
    {
      label: session.pinnedAt ? t('chat.unpin') : t('chat.pin'),
      icon: '📌',
      action: () => togglePin(session.id),
    },
    { separator: true, label: '' },
    { label: t('common.rename'), icon: '✏️', action: () => handleRename(session.id) },
    { label: t('chat.exportMarkdown'), icon: '📄', action: () => handleExport(session.id, 'markdown') },
    { label: t('chat.exportJson'), icon: '🧾', action: () => handleExport(session.id, 'json') },
    { separator: true, label: '' },
    {
      label: session.archivedAt ? t('chat.unarchive') : t('chat.archive'),
      icon: '📦',
      action: () => toggleArchive(session.id),
    },
    { separator: true, label: '' },
    { label: t('common.delete'), icon: '🗑️', action: () => handleDelete(session.id) },
  ]

  /** Open the menu anchored at a mouse event (right-click or hover ⋯ button). */
  const openSessionMenu = (e: React.MouseEvent, session: SessionMenuTarget) => {
    e.preventDefault()
    e.stopPropagation()
    showContextMenu(e.clientX, e.clientY, buildSessionMenu(session))
  }

  return { buildSessionMenu, openSessionMenu }
}
