import { useState } from 'react'

import { useEditorStore } from '@/stores/editorStore'
import { useI18n } from '@/i18n/useI18n'
import { useBrowserSession } from '@/hooks/useBrowserSession'
import { SettingsSwitch } from '@/components/Settings/settings-ui'

/**
 * Small floating control in the chat panel for the agent's built-in browser.
 *
 * The browser itself is a separate native BrowserWindow; this bubble is the
 * discoverable entry point while chatting: it shows whether the window is
 * visible and can show/hide/focus it without opening Settings. "Show" uses the
 * focusing path (browserSetVisible default), so a window hidden behind the IDE
 * always comes to the front.
 */
export default function BrowserBubble() {
  const t = useI18n()
  const preferences = useEditorStore((s) => s.preferences)
  const savePreferences = useEditorStore((s) => s.savePreferences)
  const { state, refresh, setVisible } = useBrowserSession()
  const [open, setOpen] = useState(false)

  const autoShow = preferences.browserAutoShow !== false
  const hasPage = Boolean(state.url)
  const statusText = state.visible ? t('browser.visible') : t('browser.hidden')
  const pageText = hasPage
    ? `${state.title || state.url}${state.loading ? ` · ${t('browser.loading')}` : ''}`
    : t('browser.idle')

  const toggleOpen = () => {
    if (!open) void refresh()
    setOpen(!open)
  }

  const showWindow = () => {
    void setVisible(true)
    setOpen(false)
  }

  const hideWindow = () => {
    void setVisible(false)
    setOpen(false)
  }

  return (
    <div className="absolute right-3 top-2 z-30">
      <button
        type="button"
        onClick={toggleOpen}
        aria-label={t('browser.title')}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={hasPage ? `${t('browser.title')} · ${state.title || state.url}` : t('browser.title')}
        className="flex h-7 items-center gap-1.5 rounded-full border border-nova-border bg-nova-surface/90 px-2.5 text-[11px] text-nova-text-secondary shadow-sm backdrop-blur transition-colors hover:bg-nova-hover hover:text-nova-text-primary"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
          <circle cx="6.5" cy="6.5" r=".6" fill="currentColor" />
        </svg>
        <span>{t('browser.bubble')}</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${state.visible ? 'bg-green-500' : 'bg-gray-400'}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label={t('browser.title')}
            className="absolute right-0 top-full z-50 mt-2 w-72 max-h-[60vh] overflow-y-auto rounded-xl border p-3 shadow-2xl animate-fade-in"
            style={{ background: 'var(--surface)', borderColor: 'var(--border-strong)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-nova-text-primary">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M3 9h18" />
                  <circle cx="6.5" cy="6.5" r=".6" fill="currentColor" />
                </svg>
                {t('browser.title')}
              </div>
              <span className={`inline-flex items-center gap-1 text-[10px] ${state.visible ? 'text-green-500' : 'text-nova-text-muted'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${state.visible ? 'bg-green-500' : 'bg-gray-400'}`} />
                {statusText}
              </span>
            </div>

            <div
              className="mt-2 truncate rounded-md border border-nova-border bg-nova-input-bg px-2 py-1.5 text-[11px] text-nova-text-secondary"
              title={hasPage ? state.url : undefined}
            >
              {pageText}
            </div>
            {!hasPage && (
              <div className="mt-1 text-[10px] leading-relaxed text-nova-text-muted">{t('browser.idleHint')}</div>
            )}

            <div className="mt-2.5 flex items-center gap-1.5">
              {state.visible ? (
                <>
                  <button
                    type="button"
                    onClick={showWindow}
                    className="flex-1 rounded-md border border-nova-border px-2 py-1.5 text-[11px] text-nova-text-secondary transition-colors hover:bg-nova-hover hover:text-nova-text-primary"
                  >
                    {t('browser.focus')}
                  </button>
                  <button
                    type="button"
                    onClick={hideWindow}
                    className="flex-1 rounded-md border border-nova-border px-2 py-1.5 text-[11px] text-nova-text-secondary transition-colors hover:bg-nova-hover hover:text-nova-text-primary"
                  >
                    {t('browser.hide')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={showWindow}
                  disabled={!hasPage}
                  className="flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background: 'var(--accent)' }}
                >
                  {t('browser.show')}
                </button>
              )}
            </div>

            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-nova-border pt-2.5">
              <div className="min-w-0">
                <div className="text-[11px] text-nova-text-primary">{t('browser.autoShow')}</div>
                <div className="text-[10px] leading-relaxed text-nova-text-muted">{t('browser.autoShowHint')}</div>
              </div>
              <SettingsSwitch
                label={t('browser.autoShow')}
                checked={autoShow}
                onChange={(v) => { void savePreferences({ browserAutoShow: v }) }}
              />
            </div>

            <div className="mt-2 text-[10px] leading-relaxed text-nova-text-muted">{t('browser.manualHint')}</div>
          </div>
        </>
      )}
    </div>
  )
}
