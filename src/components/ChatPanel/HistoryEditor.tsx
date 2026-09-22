import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import { askText } from '@/components/Common/PromptDialog'

interface HistoryEditorProps {
  sessionId: string
  isExpanded: boolean
  onToggle: () => void
}

export default function HistoryEditor({ sessionId, isExpanded, onToggle }: HistoryEditorProps) {
  const session = useChatStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const editMessage = useChatStore((s) => s.editMessage)
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const regenerateFromMessage = useChatStore((s) => s.regenerateFromMessage)
  const t = useI18n()

  if (!session) return null

  // Get user messages for history display
  const userMessages = session.messages.filter((m) => m.role === 'user')

  const handleEdit = async (msgId: string, currentContent: string) => {
    const newContent = await askText({ title: t('chat.editHistoryPrompt'), defaultValue: currentContent, multiline: true })
    if (newContent && newContent !== currentContent) {
      editMessage(sessionId, msgId, newContent)
    }
  }

  const handleRerun = (msgId: string) => {
    regenerateFromMessage(sessionId, msgId)
  }

  const handleDelete = (msgId: string) => {
    if (confirm(t('chat.deleteHistoryConfirm'))) {
      deleteMessage(sessionId, msgId)
    }
  }

  return (
    <div
      className="border-t border-nova-border flex-shrink-0"
      style={{ maxHeight: isExpanded ? 260 : 48 }}
    >
      {/* Header */}
      <div
        className="px-4 py-2.5 bg-nova-surface flex items-center justify-between cursor-pointer border-b border-nova-border"
        onClick={onToggle}
      >
        <span className="text-xs font-semibold text-text-secondary flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {t('chat.historyEditor')}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform text-nova-text-muted"
          style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(180deg)' }}
        >
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </div>

      {/* History List */}
      {isExpanded && (
        <div className="overflow-y-auto p-2.5 flex flex-col gap-2" style={{ maxHeight: 212 }}>
          {userMessages.length === 0 ? (
            <div className="text-center text-text-muted text-xs py-4">{t('chat.noHistory')}</div>
          ) : (
            userMessages.map((msg) => (
              <div
                key={msg.id}
                className="bg-nova-card rounded-[14px] px-3 py-2.5 flex items-center justify-between group hover:bg-nova-hover transition-colors"
              >
                <div className="flex items-center gap-2.5 overflow-hidden">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className="text-xs text-text-secondary truncate">
                    {msg.content.length > 45 ? msg.content.substring(0, 45) + '...' : msg.content}
                  </span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleEdit(msg.id, msg.content)}
                    className="p-1 text-text-muted hover:text-accent-blue transition-colors"
                    title={t('chat.edit')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleRerun(msg.id)}
                    className="p-1 text-text-muted hover:text-accent-blue transition-colors"
                    title={t('chat.rerun')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(msg.id)}
                    className="p-1 text-text-muted hover:text-red-400 transition-colors"
                    title={t('common.delete')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
