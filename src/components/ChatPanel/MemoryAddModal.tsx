import { useState } from 'react'
import { useMemoryStore } from '@/stores/memoryStore'
import { useI18n } from '@/i18n/useI18n'
import ModalPortal from '../Common/ModalPortal'

/**
 * 添加记忆对话框 — 从记忆管理器顶栏的「添加记忆」按钮打开。
 * 在弹框内编辑内容，并选择保存到哪个项目（下拉可选任意项目）还是全局；
 * 确认后才写入长期记忆。
 */
export default function MemoryAddModal({
  initialScope,
  initialProjectPath,
  projectPaths,
  onClose,
  onSaved,
}: {
  /** 默认作用域：有打开项目时默认「项目」，否则默认「全局」 */
  initialScope: 'global' | 'project'
  /** 默认保存到的项目（通常是当前项目） */
  initialProjectPath: string | null
  /** 可选的所有项目路径（当前项目排最前） */
  projectPaths: string[]
  onClose: () => void
  onSaved: (scope: 'global' | 'project', projectPath?: string) => void
}) {
  const t = useI18n()
  const addMemory = useMemoryStore((s) => s.addMemory)
  const [text, setText] = useState('')
  const [scope, setScope] = useState<'global' | 'project'>(initialScope)
  const [projectPath, setProjectPath] = useState<string>(initialProjectPath || projectPaths[0] || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = text.trim()
  const canSave = trimmed.length > 0 && !saving && (scope === 'global' || projectPath.length > 0)

  const projectName = (p: string) => p.split(/[/\\]/).pop() || p

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await addMemory(trimmed, scope, scope === 'project' ? projectPath : undefined)
      onSaved(scope, scope === 'project' ? projectPath : undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
        <div className="w-[600px] max-w-[94vw] flex flex-col rounded-2xl glass-modal" style={{ boxShadow: 'var(--shadow-xl)' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-nova-border shrink-0">
            <div className="flex items-center gap-2.5">
              <span className="text-lg">🧠</span>
              <div>
                <strong className="text-sm text-nova-text-primary">{t('chat.addMemory')}</strong>
                <div className="text-[11px] text-nova-text-muted">{t('chat.memoryAddHint')}</div>
              </div>
            </div>
            <button onClick={onClose} className="text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover p-1 rounded transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content editor + scope */}
          <div className="p-5 space-y-3 overflow-y-auto">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSave() }}
              placeholder={t('chat.memoryPlaceholder')}
              rows={4}
              spellCheck={false}
              autoFocus
              className="w-full px-3 py-2.5 text-xs leading-relaxed bg-nova-input-bg border border-nova-border rounded-lg text-nova-text-primary placeholder:text-nova-text-muted focus:border-nova-accent/50 focus:outline-none transition-colors resize-y font-mono"
            />

            <div className="flex items-center gap-3">
              <span className="text-[11px] text-nova-text-muted shrink-0">{t('chat.memoryScope')}</span>
              <div className="flex items-center gap-0.5 bg-nova-hover rounded-lg p-0.5">
                <button
                  onClick={() => setScope('global')}
                  className={`flex items-center gap-1 px-3 py-1 text-xs rounded-md transition-colors ${
                    scope === 'global' ? 'bg-nova-card text-nova-text-primary shadow-sm' : 'text-nova-text-muted hover:text-nova-text-secondary'
                  }`}
                >
                  <span>🌐</span>
                  <span>{t('chat.memoryScopeGlobal')}</span>
                </button>
                <button
                  onClick={() => setScope('project')}
                  className={`flex items-center gap-1 px-3 py-1 text-xs rounded-md transition-colors ${
                    scope === 'project' ? 'bg-nova-card text-nova-text-primary shadow-sm' : 'text-nova-text-muted hover:text-nova-text-secondary'
                  }`}
                >
                  <span>📁</span>
                  <span>{t('chat.memoryScopeProject')}</span>
                </button>
              </div>
            </div>

            {/* 保存到哪个项目 — 项目作用域时可选任意项目 */}
            {scope === 'project' && (
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-nova-text-muted shrink-0">{t('chat.memorySelectProjectHint')}</span>
                {projectPaths.length > 0 ? (
                  <select
                    value={projectPath}
                    onChange={(e) => setProjectPath(e.target.value)}
                    className="flex-1 min-w-0 text-xs bg-nova-input-bg text-nova-text-primary border border-nova-border rounded px-2 py-1.5 outline-none"
                  >
                    {projectPaths.map((p) => (
                      <option key={p} value={p}>{projectName(p)}</option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[11px] text-yellow-400">未打开项目，无法选择项目作用域</span>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex flex-col gap-2 px-5 py-3.5 border-t border-nova-border shrink-0">
            {error && (
              <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                {t('chat.rememberError')}: {error}
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-nova-text-muted">Ctrl+Enter 快速保存</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
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
                    t('chat.saveMemory')
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
