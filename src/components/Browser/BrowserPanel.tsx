import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n/useI18n'
import { useBrowserStore, syncBrowserStore } from '@/stores/browserStore'
import type { BrowserConsoleEntry } from '@shared/types'
import { isComposingEvent } from '@/utils/composition'

const LEVEL_STYLE: Record<BrowserConsoleEntry['level'], string> = {
  verbose: 'text-nova-text-muted',
  info: 'text-nova-text-secondary',
  warning: 'text-warning',
  error: 'text-red-500',
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Window onto the agent browser session: the same page the assistant navigates,
 * the same console lines `browser_read_console` returns. "Show page" opens the
 * real window so a human can look at what the model is looking at (and log into
 * a dev server it cannot).
 */
export default function BrowserPanel() {
  const t = useI18n()
  const { session, entries, screenshot, error, navigate, history, setVisible, capture, clearConsole, close } =
    useBrowserStore()
  const [address, setAddress] = useState(session.url)
  const listRef = useRef<HTMLDivElement>(null)

  // Follow the page the assistant is on, unless the user is mid-edit of the box.
  useEffect(() => {
    void syncBrowserStore()
  }, [])
  useEffect(() => {
    if (document.activeElement?.getAttribute('data-browser-address') !== 'true') setAddress(session.url)
  }, [session.url])
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length])

  const button =
    'px-2 py-1 text-[10px] font-bold rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15 disabled:opacity-35'

  return (
    <div className="h-full flex flex-col text-sm">
      <div className="px-3 py-2.5 flex items-center gap-1.5">
        <span className="text-[11px] font-bold tracking-widest uppercase text-nova-text-muted">{t('browser.title')}</span>
        <span className="ml-auto text-[10px] font-mono text-nova-text-muted truncate max-w-[150px]">
          {session.title || (session.url ? hostOf(session.url) : t('browser.idle'))}
        </span>
      </div>

      <div className="px-2 flex items-center gap-1">
        <button onClick={() => void history('back')} disabled={!session.canGoBack} className={button} title={t('browser.back')}>
          ‹
        </button>
        <button onClick={() => void history('forward')} disabled={!session.canGoForward} className={button} title={t('browser.forward')}>
          ›
        </button>
        <button onClick={() => void history('reload')} disabled={!session.url} className={button} title={t('browser.reload')}>
          ⟳
        </button>
        <input
          value={address}
          data-browser-address="true"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isComposingEvent(e) && address.trim()) void navigate(address.trim())
          }}
          placeholder={t('browser.addressPlaceholder')}
          className="flex-1 min-w-0 bg-white/60 dark:bg-white/10 border border-glass-border rounded-md px-2 py-1 text-[11px] font-mono text-nova-text-primary outline-none focus:border-nova-accent"
        />
        <button
          onClick={() => address.trim() && void navigate(address.trim())}
          className={button}
          title={t('browser.go')}
        >
          {t('browser.go')}
        </button>
      </div>

      <div className="px-2 py-1.5 flex items-center gap-1 flex-wrap">
        <button onClick={() => void setVisible(!session.visible)} className={button}>
          {session.visible ? t('browser.hidePage') : t('browser.showPage')}
        </button>
        <button onClick={() => void capture()} disabled={!session.url} className={button}>
          {t('browser.screenshot')}
        </button>
        <button onClick={clearConsole} disabled={!entries.length} className={button}>
          {t('browser.clear')}
        </button>
        <button onClick={() => void close()} disabled={!session.url} className={button}>
          {t('browser.close')}
        </button>
        {session.loading && <span className="text-[10px] text-primary">{t('browser.loading')}</span>}
      </div>

      {session.lastError && (
        <div className="mx-2 mb-1 px-2 py-1 rounded bg-warning-10 border border-warning-30 text-warning text-[10px] break-all">
          {session.lastError}
        </div>
      )}
      {error && (
        <div className="mx-2 mb-1 px-2 py-1 rounded bg-warning-10 border border-warning-30 text-warning text-[10px] break-all">
          {error}
        </div>
      )}

      {screenshot && (
        <div className="mx-2 mb-1.5 rounded-lg overflow-hidden border border-glass-border">
          <img src={screenshot.dataUrl} alt="" className="w-full block" />
        </div>
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-0.5">
        {entries.length === 0 && (
          <div className="px-2 py-3 text-[11px] text-nova-text-muted leading-relaxed">{t('browser.empty')}</div>
        )}
        {entries.map((entry, i) => (
          <div key={i} className="px-2 py-1 rounded bg-white/50 dark:bg-white/5">
            <span className={`text-[10px] font-bold uppercase mr-1.5 ${LEVEL_STYLE[entry.level]}`}>{entry.level}</span>
            <span className="text-[11px] font-mono text-nova-text-primary whitespace-pre-wrap break-words">{entry.text}</span>
            {entry.source && <div className="text-[11px] font-mono text-nova-text-muted truncate">{entry.source}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
