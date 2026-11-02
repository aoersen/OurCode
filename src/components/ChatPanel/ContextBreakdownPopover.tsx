import { useEffect, useRef } from 'react'
import ContextUsageRing from '../Common/ContextUsageRing'
import { CONTEXT_WARNING_RATIO, formatTokenCount, type ContextUsage } from '@/services/llm/contextUsage'
import { useI18n } from '@/i18n/useI18n'

/**
 * Context-window breakdown popover (Stitch「上下文用量」spec sheet).
 *
 * Answers the question the bare percentage can't: WHAT is filling the window.
 * Four segments (system+tools / summary / history / other) are drawn against the
 * full window, with the compaction threshold as a tick — so "80%" stops being an
 * abstract warning and becomes a line you can see approaching.
 *
 * The accounting is not re-derived here: `usage` comes from computeContextUsage,
 * which is also what the ring and the status bar render.
 */
export default function ContextBreakdownPopover({
  usage,
  placement = 'below',
  align = 'center',
  onClose,
}: {
  usage: ContextUsage
  placement?: 'above' | 'below'
  align?: 'center' | 'left' | 'right'
  onClose?: () => void
}) {
  const t = useI18n()
  const ref = useRef<HTMLDivElement>(null)

  // Escape closes — the click-outside half is owned by the caller, whose wrapper
  // also contains the trigger (otherwise mousedown-outside + click-toggle would
  // close and immediately reopen the popover).
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const windowTokens = Math.max(1, usage.window)
  const fillPct = Math.min(100, (usage.used / windowTokens) * 100)
  const seg = usage.segments
  const segSum = Math.max(1, seg.system + seg.summary + seg.history + seg.other)
  const pctOf = (tokens: number) => (tokens / segSum) * fillPct

  const rows: Array<{ key: string; label: string; tokens: number; color: string; pending?: boolean }> = [
    { key: 'system', label: t('context.usage.segment.system'), tokens: seg.system, color: 'var(--accent)', pending: usage.prefixPending },
    { key: 'summary', label: t('context.usage.segment.summary'), tokens: seg.summary, color: 'var(--accent-purple)' },
    { key: 'history', label: t('context.usage.segment.history'), tokens: seg.history, color: 'var(--text-muted)' },
    { key: 'other', label: t('context.usage.segment.other'), tokens: seg.other, color: 'var(--warning)' },
  ]

  const alignClass = align === 'right' ? 'right-0' : align === 'left' ? 'left-0' : 'left-1/2 -translate-x-1/2'
  const arrowAlign = align === 'right' ? 'right-5' : align === 'left' ? 'left-5' : 'left-1/2 -translate-x-1/2'

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('context.usage.title')}
      className={`absolute ${alignClass} z-50 w-[320px] max-w-[calc(100vw-24px)] ${
        placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2'
      }`}
    >
      <div
        className={`absolute ${arrowAlign} w-0 h-0 border-l-[6px] border-r-[6px] ${
          placement === 'above'
            ? '-bottom-[5px] border-t-[6px] border-t-[var(--surface-popover)] border-b-transparent'
            : '-top-[5px] border-b-[6px] border-b-[var(--surface-popover)] border-t-transparent'
        }`}
      />
      <div className="bg-[var(--surface-popover)] backdrop-blur-xl border border-glass-border rounded-xl shadow-[0_8px_40px_rgba(15,23,42,0.10)] dark:shadow-[0_8px_40px_rgba(0,0,0,0.45)] p-4 flex flex-col gap-3">
        {/* Title + provenance */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <ContextUsageRing percent={usage.percent} level={usage.level} size={14} stroke={2} />
            <span className="text-[12px] font-bold text-nova-text-primary truncate">{t('context.usage.title')}</span>
          </div>
          <span
            className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border ${
              usage.source === 'real'
                ? 'text-success-text border-success-20 bg-success-10'
                : 'text-nova-text-muted border-nova-border'
            }`}
          >
            {usage.source === 'real' ? t('context.usage.source.real') : t('context.usage.source.estimate')}
          </span>
        </div>

        {/* Hero numbers */}
        <div className="flex items-baseline justify-between gap-2 font-mono">
          <span className="text-[15px] font-extrabold text-nova-text-primary tabular-nums">
            {formatTokenCount(usage.used)} / {formatTokenCount(usage.window)}
          </span>
          <span className="text-[13px] font-bold tabular-nums text-nova-text-primary">{usage.percent}%</span>
        </div>

        {/* Segmented bar across the whole window, with the compaction tick */}
        <div className="relative h-2 rounded-full overflow-hidden" style={{ background: 'var(--hover)' }}>
          <div className="absolute inset-y-0 left-0 w-full flex">
            {rows
              .filter((r) => !r.pending && r.tokens > 0)
              .map((r) => (
                <div
                  key={r.key}
                  style={{ width: `${pctOf(r.tokens)}%`, background: r.color }}
                  title={`${r.label} ${formatTokenCount(r.tokens)}`}
                />
              ))}
          </div>
          <div
            className="absolute inset-y-[-2px] w-px"
            style={{ left: `${CONTEXT_WARNING_RATIO * 100}%`, background: 'var(--border-strong)' }}
            aria-hidden
          />
        </div>
        <div className="flex justify-between text-[10px] text-nova-text-muted -mt-1.5">
          <span className="tabular-nums">0</span>
          <span className="tabular-nums">
            {t('context.usage.compactionLine', { percent: Math.round(CONTEXT_WARNING_RATIO * 100), tokens: formatTokenCount(usage.compactionAt) })}
          </span>
          <span className="tabular-nums">{formatTokenCount(usage.window)}</span>
        </div>

        {/* Legend */}
        <div className="flex flex-col gap-1">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="flex items-center gap-1.5 min-w-0 text-nova-text-secondary">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: r.color }} aria-hidden />
                <span className="truncate">{r.label}</span>
              </span>
              <span className="font-mono tabular-nums text-nova-text-primary shrink-0">
                {r.pending ? '—' : formatTokenCount(r.tokens)}
              </span>
            </div>
          ))}
        </div>

        <div className="h-px" style={{ background: 'var(--border)' }} />

        <div className="flex flex-col gap-1 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-nova-text-secondary">{t('context.usage.reserve')}</span>
            <span className="font-mono tabular-nums text-nova-text-primary">{formatTokenCount(usage.reserve)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-nova-text-secondary">{t('context.usage.remaining')}</span>
            <span className="font-mono tabular-nums text-nova-text-primary">{formatTokenCount(usage.remaining)}</span>
          </div>
        </div>

        <p className="text-[10px] leading-relaxed text-nova-text-muted">
          {usage.prefixPending ? t('context.usage.hint.prefixPending') : t('context.usage.hint.source')}
        </p>
      </div>
    </div>
  )
}
