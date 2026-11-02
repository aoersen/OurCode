import { useState } from 'react'
import type { ChatError } from '@/types'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'

interface ErrorCardProps {
  error: ChatError
  /** Re-runs the failed request (shown for non-auth errors) */
  onRetry?: () => void
}

/**
 * User-friendly LLM error card. The upstream error is parsed into a title +
 * explanation + action button (see parseLLMError); the raw detail (e.g. a JSON
 * error body) is only surfaced inside a collapsible "view details" area.
 */
export default function ErrorCard({ error, onRetry }: ErrorCardProps) {
  const openSettings = useUIStore((s) => s.openSettings)
  const t = useI18n()
  const [showDetail, setShowDetail] = useState(false)
  const isAuth = error.type === 'auth'

  return (
    <div className="bg-red-500/10 border border-red-500/40 rounded-lg p-4 text-sm space-y-2.5">
      {/* Title row: warning icon + "API 请求失败" (+ HTTP code badge) */}
      <div className="flex items-center gap-2 text-red-400">
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span className="font-semibold">{t('chat.errorTitle')}</span>
        {error.code && (
          <span className="text-[11px] px-1.5 py-px rounded bg-red-500/20 border border-red-500/40 text-red-300 font-medium">
            HTTP {error.code}
          </span>
        )}
      </div>

      {/* Friendly explanation */}
      <p className="text-nova-text-muted leading-relaxed text-xs">{error.message}</p>

      {/* Action button: fix the key config / retry (blue primary, per design) */}
      {(isAuth || onRetry) && (
        <div className="pt-1">
          {isAuth ? (
            <button
              onClick={() => openSettings()}
              className="inline-flex items-center gap-2 bg-nova-accent hover:bg-nova-accent/85 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
              {t('chat.errorGoSettings')}
            </button>
          ) : onRetry ? (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-2 bg-nova-accent hover:bg-nova-accent/85 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              {t('chat.errorRetry')}
            </button>
          ) : null}
        </div>
      )}

      {/* Collapsible raw upstream detail (never rendered inline as text) */}
      {error.detail && (
        <div className="pt-1">
          <button
            onClick={() => setShowDetail((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-red-400/80 hover:text-red-300 transition-colors"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showDetail ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            {showDetail ? t('chat.errorHideDetail') : t('chat.errorViewDetail')}
          </button>
          {showDetail && (
            <pre className="mt-2 text-[11px] leading-relaxed text-nova-text-muted bg-nova-bg/70 border border-red-500/20 rounded-lg p-2.5 overflow-auto whitespace-pre-wrap break-all font-mono max-h-48">
              {error.detail}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
