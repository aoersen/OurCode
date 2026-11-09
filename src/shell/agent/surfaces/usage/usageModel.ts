/**
 * 「用量」面的视图模型（纯函数）。
 *
 * 输入是主进程聚合好的 UsageSummary（SQLite GROUP BY），这里只负责：
 *  - 范围选项与日期补齐（7 / 30 / 90 天 / 全部）
 *  - 四行统计
 *  - 条形图的缩放（div 画柱，不依赖 SVG）
 *  - 模型排行与最近活动的行
 */
import type { UsageDailyRow, UsageRankRow, UsageRecentRow, UsageSummary } from '@/types'

export interface UsageRangeOption {
  days: number
  label: string
}

export const USAGE_RANGES: ReadonlyArray<UsageRangeOption> = [
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
  { days: 0, label: '全部' },
]

/** 「全部」没有确切的起止，按最近 30 天画图（与旧 UsagePanel 的兜底一致）。 */
export const ALL_RANGE_BARS = 30

export function rangeLabel(days: number): string {
  return USAGE_RANGES.find((option) => option.days === days)?.label ?? `${days} 天`
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** `YYYY-MM-DD`（本地时区，与主进程聚合口径一致）。 */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function formatClock(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  const sameDay = date.toDateString() === today.toDateString()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return sameDay ? `${hh}:${mm}` : `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`
}

export function todayTokens(daily: ReadonlyArray<UsageDailyRow>, now: Date = new Date()): number {
  const key = dayKey(now)
  const row = daily.find((entry) => entry.day === key)
  return row ? row.tokensIn + row.tokensOut : 0
}

export interface UsageStatLine {
  label: string
  value: string
  sub?: string
}

/** 四行统计：请求 / 总 Token（↑↓）/ 今日 / 失败。 */
export function usageStats(summary: UsageSummary | null, now: Date = new Date()): UsageStatLine[] {
  if (!summary) {
    return [
      { label: '请求', value: '—' },
      { label: '总 Token', value: '—' },
      { label: '今日', value: '—' },
      { label: '失败', value: '—' },
    ]
  }
  const { totals } = summary
  const totalTokens = totals.tokensIn + totals.tokensOut
  return [
    { label: '请求', value: String(totals.requests) },
    {
      label: '总 Token',
      value: formatTokens(totalTokens),
      sub: `↑ ${formatTokens(totals.tokensIn)} · ↓ ${formatTokens(totals.tokensOut)}`,
    },
    { label: '今日', value: formatTokens(todayTokens(summary.daily, now)) },
    { label: '失败', value: String(totals.errors) },
  ]
}

/**
 * 补齐日期空洞：从 `now` 往回 n 天，缺失的那天按 0 处理。
 * `rangeDays = 0`（全部）时画最近 ALL_RANGE_BARS 天。
 */
export function chartSeries(
  daily: ReadonlyArray<UsageDailyRow>,
  rangeDays: number,
  now: Date = new Date(),
  maxBars = 90,
): UsageDailyRow[] {
  const requested = rangeDays > 0 ? Math.min(rangeDays, maxBars) : ALL_RANGE_BARS
  const byDay = new Map(daily.map((row) => [row.day, row]))
  const series: UsageDailyRow[] = []
  for (let offset = requested - 1; offset >= 0; offset -= 1) {
    const date = new Date(now)
    date.setDate(date.getDate() - offset)
    const key = dayKey(date)
    series.push(byDay.get(key) ?? { day: key, tokensIn: 0, tokensOut: 0, requests: 0 })
  }
  return series
}

export interface ChartBar {
  day: string
  /** 相对最大值的百分比（0–100） */
  inputPct: number
  outputPct: number
  tokens: number
}

/** 非零值至少给 2% 的高度，否则柱子会「消失」。 */
export function barPercent(value: number, max: number, minVisible = 2): number {
  if (value <= 0) return 0
  if (max <= 0) return 0
  return Math.max(minVisible, Math.round((value / max) * 100))
}

export function chartBars(series: ReadonlyArray<UsageDailyRow>): ChartBar[] {
  const totals = series.map((row) => row.tokensIn + row.tokensOut)
  const max = Math.max(...totals, 0)
  return series.map((row, index) => {
    const total = totals[index]
    return {
      day: row.day,
      inputPct: barPercent(row.tokensIn, max),
      outputPct: barPercent(row.tokensOut, max),
      tokens: total,
    }
  })
}

export interface ModelRankRow {
  name: string
  count: number
  tokens: number
  countLabel: string
  tokenLabel: string
  /** 相对第一名的宽度（0–100），最小 3% 让非零项可见 */
  widthPct: number
}

export function modelRanking(rows: ReadonlyArray<UsageRankRow>, limit = 8): ModelRankRow[] {
  const sorted = [...rows].sort(
    (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut) || b.count - a.count,
  )
  const max = Math.max(...sorted.map((row) => row.tokensIn + row.tokensOut), 0)
  return sorted.slice(0, limit).map((row) => {
    const tokens = row.tokensIn + row.tokensOut
    return {
      name: row.name,
      count: row.count,
      tokens,
      countLabel: `${row.count} 次`,
      tokenLabel: formatTokens(tokens),
      widthPct: tokens > 0 && max > 0 ? Math.max(3, Math.round((tokens / max) * 100)) : 0,
    }
  })
}

export interface RecentRow {
  id: string
  name: string
  time: string
  amount: string
  ok: boolean
}

export function recentRows(
  rows: ReadonlyArray<UsageRecentRow>,
  limit = 30,
  now: number = Date.now(),
): RecentRow[] {
  return rows.slice(0, limit).map((row) => {
    const tokens = row.tokensIn + row.tokensOut
    return {
      id: row.id,
      name: row.name,
      time: formatClock(row.startedAt, now),
      amount: tokens > 0 ? `${formatTokens(tokens)} t` : formatDuration(row.durationMs),
      ok: row.ok,
    }
  })
}
