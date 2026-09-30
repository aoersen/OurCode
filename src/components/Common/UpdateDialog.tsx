import { useUpdateStore } from '@/stores/updateStore'
import { useI18n } from '@/i18n/useI18n'
import MarkdownRenderer from './MarkdownRenderer'

/**
 * Update prompt shown in two phases:
 *  1. `available` — a new version was found; offer download (release notes
 *     rendered through the shared MarkdownRenderer → marked + DOMPurify).
 *  2. `downloaded` — the update is staged; offer restart to install.
 *
 * "Later" dismisses the dialog for this session only; the status bar keeps
 * showing the pending state so the user can still act on it there.
 */
export default function UpdateDialog() {
  const uiState = useUpdateStore((s) => s.uiState)
  const newVersion = useUpdateStore((s) => s.newVersion)
  const releaseNotes = useUpdateStore((s) => s.releaseNotes)
  const dialogDismissed = useUpdateStore((s) => s.dialogDismissed)
  const download = useUpdateStore((s) => s.download)
  const install = useUpdateStore((s) => s.install)
  const dismissDialog = useUpdateStore((s) => s.dismissDialog)
  const t = useI18n()

  const showAvailable = uiState === 'available' && !dialogDismissed
  const showReady = uiState === 'downloaded' && !dialogDismissed
  if (!showAvailable && !showReady) return null

  return (
    <div role="dialog" aria-modal="true" aria-label={showReady ? t('update.readyTitle') : t('update.availableTitle')} className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="glass-modal rounded-xl shadow-2xl w-full max-w-lg mx-4 animate-fade-in flex flex-col max-h-[80vh]">
        <div className="p-5 overflow-y-auto">
          <h3 className="text-lg font-semibold text-nova-text-primary mb-2">
            {showReady ? t('update.readyTitle') : t('update.availableTitle')}
          </h3>
          <p className="text-nova-text-secondary text-sm mb-3">
            {showReady
              ? t('update.readyDesc')
              : t('update.availableDesc', { version: newVersion })}
          </p>
          {!showReady && (
            <>
              <div className="text-[11px] font-semibold text-nova-text-muted uppercase tracking-wider mb-1.5">
                {t('update.releaseNotes')}
              </div>
              {releaseNotes ? (
                <div className="rounded-lg border border-nova-border bg-nova-card p-3">
                  <MarkdownRenderer content={releaseNotes} />
                </div>
              ) : (
                <div className="text-xs text-nova-text-muted">{t('update.noNotes')}</div>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-3 px-5 pb-5 shrink-0">
          <button
            onClick={dismissDialog}
            className="px-4 py-2 text-sm rounded-lg bg-nova-hover text-nova-text-secondary hover:text-nova-text-primary transition-colors"
          >
            {t('update.later')}
          </button>
          <button
            onClick={showReady ? install : () => void download()}
            className="px-4 py-2 text-sm rounded-lg bg-nova-accent hover:opacity-90 text-white transition-colors"
          >
            {showReady ? t('update.restartNow') : t('update.downloadNow')}
          </button>
        </div>
      </div>
    </div>
  )
}
