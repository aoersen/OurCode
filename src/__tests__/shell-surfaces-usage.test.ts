import { describe, expect, it } from 'vitest'
import type { UsageDailyRow, UsageRankRow, UsageRecentRow, UsageSummary } from '@/types'
import {
  ALL_RANGE_BARS,
  USAGE_RANGES,
  barPercent,
  chartBars,
  chartSeries,
  dayKey,
  formatClock,
  formatDuration,
  formatTokens,
  modelRanking,
  recentRows,
  todayTokens,
  usageStats,
} from '@/shell/agent/surfaces/usage/usageModel'

const NOW = new Date(2026, 0, 10, 12, 0, 0)

const daily: UsageDailyRow[] = [
  { day: '2026-01-10', tokensIn: 100, tokensOut: 200, requests: 1 },
  { day: '2026-01-08', tokensIn: 400, tokensOut: 0, requests: 2 },
]

const summary: UsageSummary = {
  totals: { requests: 3, tokensIn: 1500, tokensOut: 2500, errors: 1 },
  daily,
  byModel: [
    { name: 'b', sub: '', count: 2, tokensIn: 100, tokensOut: 100, errors: 0, lastUsed: 1 } as UsageRankRow,
    { name: 'a', sub: '', count: 5, tokensIn: 300, tokensOut: 0, errors: 0, lastUsed: 1 } as UsageRankRow,
  ],
  skills: [],
  subagents: [],
  mcp: [],
  recent: [
    {
      id: '1', category: 'llm', name: 'gpt-x', sub: '', sessionId: '',
      startedAt: NOW.getTime(), durationMs: 1200, tokensIn: 1000, tokensOut: 500, ok: true, error: '',
    } as UsageRecentRow,
    {
      id: '2', category: 'skill', name: 'review', sub: '', sessionId: '',
      startedAt: NOW.getTime(), durationMs: 1200, tokensIn: 0, tokensOut: 0, ok: false, error: 'boom',
    } as UsageRecentRow,
  ],
}

describe('usageModel · 范围与格式化', () => {
  it('四个范围选项', () => {
    expect(USAGE_RANGES.map((option) => option.label)).toEqual(['7 天', '30 天', '90 天', '全部'])
    expect(USAGE_RANGES.map((option) => option.days)).toEqual([7, 30, 90, 0])
  })

  it('token 数字压缩到 K / M', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5K')
    expect(formatTokens(2_400_000)).toBe('2.4M')
  })

  it('时长与时钟', () => {
    expect(formatDuration(0)).toBe('')
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(65_000)).toBe('1m5s')
    expect(formatClock(new Date(2026, 0, 10, 9, 5).getTime(), NOW.getTime())).toBe('09:05')
    expect(formatClock(new Date(2026, 0, 9, 9, 5).getTime(), NOW.getTime())).toBe('1/9 09:05')
  })

  it('dayKey 用本地时区补零', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dayKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('今日 token 只认今天那一行', () => {
    expect(todayTokens(daily, NOW)).toBe(300)
    expect(todayTokens(daily, new Date(2026, 0, 20))).toBe(0)
  })
})

describe('usageModel · 四行统计', () => {
  it('请求 / 总 token / 今日 / 失败', () => {
    expect(usageStats(summary, NOW)).toEqual([
      { label: '请求', value: '3' },
      { label: '总 Token', value: '4.0K', sub: '↑ 1.5K · ↓ 2.5K' },
      { label: '今日', value: '300' },
      { label: '失败', value: '1' },
    ])
  })

  it('没有 summary 时是四个破折号', () => {
    expect(usageStats(null, NOW).map((line) => line.value)).toEqual(['—', '—', '—', '—'])
  })
})

describe('usageModel · 图表', () => {
  it('7 天范围补齐空洞并以今天结尾', () => {
    const series = chartSeries(daily, 7, NOW)
    expect(series).toHaveLength(7)
    expect(series[0].day).toBe('2026-01-04')
    expect(series[6].day).toBe('2026-01-10')
    expect(series[6].tokensIn).toBe(100)
    expect(series[3].day).toBe('2026-01-07')
    expect(series[3].tokensIn).toBe(0)
  })

  it('「全部」按最近 30 天画', () => {
    expect(chartSeries(daily, 0, NOW)).toHaveLength(ALL_RANGE_BARS)
    expect(chartSeries(daily, 90, NOW)).toHaveLength(90)
    expect(chartSeries(daily, 900, NOW)).toHaveLength(90)
  })

  it('百分比缩放：最大值 100%，非零最小 2%，零值 0%', () => {
    expect(barPercent(50, 100)).toBe(50)
    expect(barPercent(100, 100)).toBe(100)
    expect(barPercent(0, 100)).toBe(0)
    expect(barPercent(1, 1000)).toBe(2)
    expect(barPercent(5, 0)).toBe(0)
  })

  it('柱状数据按 max(输入+输出) 缩放', () => {
    const bars = chartBars([
      { day: 'a', tokensIn: 50, tokensOut: 50, requests: 1 },
      { day: 'b', tokensIn: 0, tokensOut: 0, requests: 0 },
      { day: 'c', tokensIn: 1, tokensOut: 0, requests: 1 },
    ])
    expect(bars[0]).toEqual({ day: 'a', inputPct: 50, outputPct: 50, tokens: 100 })
    expect(bars[1]).toEqual({ day: 'b', inputPct: 0, outputPct: 0, tokens: 0 })
    expect(bars[2].inputPct).toBe(2)
  })
})

describe('usageModel · 排行与活动', () => {
  it('模型排行按 token 倒序，宽度相对第一名', () => {
    const rows = modelRanking(summary.byModel)
    expect(rows.map((row) => row.name)).toEqual(['a', 'b'])
    expect(rows[0].widthPct).toBe(100)
    expect(rows[1].widthPct).toBe(67)
    expect(rows[0].countLabel).toBe('5 次')
    expect(rows[0].tokenLabel).toBe('300')
  })

  it('模型排行 limit 生效', () => {
    expect(modelRanking(summary.byModel, 1)).toHaveLength(1)
  })

  it('近期活动：有 token 显示 token，否则显示耗时', () => {
    const rows = recentRows(summary.recent, 30, NOW.getTime())
    expect(rows[0]).toEqual({ id: '1', name: 'gpt-x', time: '12:00', amount: '1.5K t', ok: true })
    expect(rows[1]).toEqual({ id: '2', name: 'review', time: '12:00', amount: '1.2s', ok: false })
  })
})
