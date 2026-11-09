import { useEffect, useMemo, useRef } from 'react'
import { useUsageStore } from '@/stores/usageStore'
import {
  EmptyHint,
  SectionLabel,
  SurfaceRow,
  TextAction,
  useListKeyboard,
} from '../surfaceParts'
import {
  USAGE_RANGES,
  chartBars,
  chartSeries,
  formatTokens,
  modelRanking,
  recentRows,
  usageStats,
} from './usageModel'

/**
 * 「用量」面：范围选择 + 四行统计 + div 柱状图 + 模型排行 + 最近活动。
 *
 * 数据全部来自 usageStore（load / setRange），主进程按 SQLite 聚合；这里只做
 * 展示口径（见 usageModel）。不引入图表库：柱子就是按百分比撑高的 div。
 */

/** `2026-11-06` → `11/06`（趋势图两端的时间轴标签）。 */
function shortDay(day: string | undefined): string {
  return day ? day.slice(5).replace('-', '/') : ''
}

export default function UsageSurface() {
  const summary = useUsageStore((s) => s.summary)
  const rangeDays = useUsageStore((s) => s.rangeDays)
  const loading = useUsageStore((s) => s.loading)
  const error = useUsageStore((s) => s.error)
  const load = useUsageStore((s) => s.load)
  const setRange = useUsageStore((s) => s.setRange)

  const listKeyboard = useListKeyboard()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void load()
    const onRecorded = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => void load(), 600)
    }
    window.addEventListener('ourcode:usage-recorded', onRecorded)
    return () => {
      window.removeEventListener('ourcode:usage-recorded', onRecorded)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时拉一次，之后按 usage 事件刷新
  }, [])

  const stats = useMemo(() => usageStats(summary), [summary])
  const series = useMemo(() => chartSeries(summary?.daily ?? [], rangeDays), [summary, rangeDays])
  const bars = useMemo(() => chartBars(series), [series])
  const ranking = useMemo(() => modelRanking(summary?.byModel ?? []), [summary])
  const recent = useMemo(() => recentRows(summary?.recent ?? []), [summary])

  const hasData = !!summary && summary.totals.requests > 0

  return (
    <div className="h-full min-h-0 overflow-y-auto pure-scroll px-5 pb-6">
      <div className="flex flex-wrap items-baseline gap-x-1 gap-y-1 pt-1">
        {USAGE_RANGES.map((option) => {
          const active = option.days === rangeDays
          return (
            <button
              key={option.days}
              type="button"
              aria-pressed={active}
              onClick={() => setRange(option.days)}
              className={`pure-focus rounded-md px-2 py-0.5 text-[12px] leading-[20px] transition-colors ${
                active
                  ? 'bg-[var(--pure-active)] text-[var(--pure-ink)]'
                  : 'text-[var(--pure-muted)] hover:bg-[var(--pure-hover)] hover:text-[var(--pure-ink)]'
              }`}
            >
              {option.label}
            </button>
          )
        })}
        <span className="ml-auto inline-flex">
          <TextAction
            onClick={() => void load()}
            title="刷新用量"
          >
            {loading ? '刷新中…' : '刷新'}
          </TextAction>
        </span>
      </div>

      {error && (
        <div className="pt-2 text-[12px] leading-[18px] text-[var(--pure-danger)]" role="alert">
          {error}
        </div>
      )}

      {!hasData ? (
        <EmptyHint>
          {loading ? '读取中…' : '这段时间还没有记录到调用。跑一次对话或技能后，这里会有 token、模型与近期活动。'}
        </EmptyHint>
      ) : (
        <>
          <div className="pt-3">
            {stats.map((line) => (
              <div key={line.label} className="flex items-baseline gap-3 py-1">
                <span className="text-[12.5px] leading-[20px] text-[var(--pure-muted)]">{line.label}</span>
                {line.sub && (
                  <span className="text-[11.5px] leading-[18px] text-[var(--pure-muted)]">{line.sub}</span>
                )}
                <span className="ml-auto text-[15px] leading-[22px] text-[var(--pure-ink)] tabular-nums">
                  {line.value}
                </span>
              </div>
            ))}
          </div>

          <SectionLabel trailing="输入 / 输出">Token 趋势</SectionLabel>
          {/* 柱状图：底部一条基线，零值给 2px 灰桩，柱子圆角 —— 否则空白日会让
              整张图读起来像「只有一根柱子 + 一堆断线」。 */}
          <div
            className="flex items-end gap-[2px] h-[72px] border-b border-[var(--pure-border)]"
            role="img"
            aria-label={`最近 ${series.length} 天的 token 用量`}
          >
            {bars.map((bar) => (
              <div
                key={bar.day}
                className="flex-1 min-w-0 h-full flex flex-col justify-end"
                title={`${bar.day} · ${formatTokens(bar.tokens)} tokens`}
              >
                {bar.tokens === 0 ? (
                  <div className="h-[2px] rounded-t-[2px] bg-[var(--pure-hover)]" />
                ) : (
                  <>
                    {bar.outputPct > 0 && (
                      <div className="pure-bar-output rounded-t-[2px]" style={{ height: `${bar.outputPct}%` }} />
                    )}
                    {bar.inputPct > 0 && (
                      <div className="pure-bar-input rounded-t-[2px]" style={{ height: `${bar.inputPct}%` }} />
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] leading-[14px] tabular-nums text-[var(--pure-muted)]">
            <span>{shortDay(series[0]?.day)}</span>
            <span>今天</span>
          </div>

          {ranking.length > 0 && (
            <>
              <SectionLabel trailing={`${ranking.length} 个模型`}>模型排行</SectionLabel>
              {ranking.map((row) => (
                <div key={row.name} className="py-1">
                  <div className="flex items-baseline gap-3">
                    <span className="flex-1 min-w-0 text-[12.5px] leading-[20px] text-[var(--pure-ink)] truncate">
                      {row.name}
                    </span>
                    <span className="shrink-0 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
                      {row.countLabel} · {row.tokenLabel}
                    </span>
                  </div>
                  <div className="mt-1 h-[2px] w-full pure-bar-track rounded-full">
                    <div
                      className="h-full rounded-full bg-[var(--pure-secondary)]"
                      style={{ width: `${row.widthPct}%` }}
                    />
                  </div>
                </div>
              ))}
            </>
          )}

          {recent.length > 0 && (
            <>
              <SectionLabel trailing="最近 30 条">近期活动</SectionLabel>
              <div onKeyDown={listKeyboard}>
                {recent.map((row) => (
                  <SurfaceRow key={row.id} label={`${row.name} ${row.time} ${row.amount}`}>
                    <div className="flex items-baseline gap-3">
                      <span className="w-[52px] shrink-0 text-[11.5px] leading-[18px] text-[var(--pure-muted)] tabular-nums">
                        {row.time}
                      </span>
                      <span className="flex-1 min-w-0 text-[12.5px] leading-[20px] text-[var(--pure-ink)] truncate">
                        {row.name}
                      </span>
                      {!row.ok && (
                        <span className="shrink-0 text-[11.5px] leading-[18px] text-[var(--pure-danger)]">失败</span>
                      )}
                      <span className="shrink-0 text-[11.5px] leading-[18px] text-[var(--pure-muted)] tabular-nums">
                        {row.amount}
                      </span>
                    </div>
                  </SurfaceRow>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
