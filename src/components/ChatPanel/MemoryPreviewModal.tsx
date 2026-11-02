import { useState } from 'react'
import { useMemoryStore } from '@/stores/memoryStore'
import { useI18n } from '@/i18n/useI18n'
import ModalPortal from '../Common/ModalPortal'

/**
 * Preview dialog shown after the AI condenses a conversation for the "记住"
 * button. The user gets a chance to read/edit the memory before it is
 * actually written — the write only happens on explicit confirmation.
 */
export default function MemoryPreviewModal({
  content,
  projectPath,
  onCancel,
  onSaved,
}: {
  content: string
  projectPath: string | null
  onCancel: () => void
  onSaved: (scope: 'project' | 'global') => void
}) {
  const t = useI18n()
  const addMemory = useMemoryStore((s) => s.addMemory)
  const [text, setText] = useState(content)
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = text.trim()
  const canSave = trimmed.length > 0 && !saving
  // Without a project the "project" scope would silently fall back — disable it.
  const projectScopeAvailable = !!projectPath

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const resolvedScope = scope === 'project' && projectScopeAvailable ? 'project' : 'global'
      await addMemory(trimmed, resolvedScope, projectPath ?? undefined)
      onSaved(resolvedScope)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const projectName = projectPath ? projectPath.split(/[/\\]/).pop() || projectPath : null

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="w-[600px] max-w-[94vw] flex flex-col rounded-2xl glass-modal" style={{ boxShadow: 'var(--shadow-xl)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-nova-border shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-lg">🧠</span>
            <div>
              <strong className="text-sm text-nova-text-primary">{t('chat.memoryPreviewTitle')}</strong>
              <div className="text-[11px] text-nova-text-muted">{t('chat.memoryPreviewHint')}</div>
            </div>
          </div>
          <button onClick={onCancel} className="text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover p-1 rounded transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Editable memory content */}
        <div className="p-5 space-y-3 overflow-y-auto">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="w-full h-48 px-3 py-2.5 text-xs leading-relaxed bg-nova-input-bg border border-nova-border rounded-lg text-nova-text-primary placeholder-nova-text-muted focus:border-nova-accent/50 focus:outline-none transition-colors resize-y font-mono"
          />

          {/* Scope selector */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-nova-text-muted shrink-0">{t('chat.memoryScope')}</span>
            <div className="flex items-center gap-0.5 bg-nova-hover rounded-lg p-0.5">
              <button
                onClick={() => setScope('project')}
                disabled={!projectScopeAvailable}
                className={`flex items-center gap-1 px-3 py-1 text-xs rounded-md transition-colors ${
                  scope === 'project'
                    ? 'bg-nova-card text-nova-text-primary shadow-sm'
                    : 'text-nova-text-muted hover:text-nova-text-secondary'
                } ${!projectScopeAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <span>📁</span>
                <span>{t('chat.memoryScopeProject')}</span>
              </button>
              <button
                onClick={() => setScope('global')}
                className={`flex items-center gap-1 px-3 py-1 text-xs rounded-md transition-colors ${
                  scope === 'global'
                    ? 'bg-nova-card text-nova-text-primary shadow-sm'
                    : 'text-nova-text-muted hover:text-nova-text-secondary'
                }`}
              >
                <span>🌐</span>
                <span>{t('chat.memoryScopeGlobal')}</span>
              </button>
            </div>
            {scope === 'project' && projectName && (
              <span className="text-[11px] text-nova-text-muted truncate min-w-0">
                {t('chat.memoryScopeInProject', { project: projectName })}
              </span>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 px-5 py-3.5 border-t border-nova-border shrink-0">
          {error && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {t('chat.rememberError')}: {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-1.5 text-xs text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-4 py-1.5 text-xs font-medium text-white bg-nova-accent hover:opacity-90 disabled:opacity-40 rounded-lg transition-opacity flex items-center gap-1.5"
            >
              {saving ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  {t('common.saving')}
                </>
              ) : (
                t('chat.memoryPreviewSave')
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
    </ModalPortal>
  )
}
