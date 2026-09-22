import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUsageStore } from '@/stores/usageStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { listSkills, type SkillInfo } from '@/services/skills/skillManager'
import type { TranslationKey } from '@/i18n'
import type { UsageDailyRow, UsageEventCategory, UsageRankRow, UsageRecentRow } from '@/types'

/**
 * Usage statistics panel (sidebar tab): a dashboard of what the AI assistant has
 * done — LLM token usage by model, plus ranked usage of skills, subagents and
 * MCP tools, a token trend chart and a recent-activity feed. Also hosts the
 * "available skills" list with a one-click run action.
 */

const RANGE_OPTIONS: Array<{ days: number; labelKey: TranslationKey }> = [
  { days: 7, labelKey: 'usage.range7' },
  { days: 30, labelKey: 'usage.range30' },
  { days: 90, labelKey: 'usage.range90' },
  { days: 0, labelKey: 'usage.rangeAll' },
]

const CATEGORY_META: Record<UsageEventCategory, { labelKey: TranslationKey; color: string }> = {
  llm: { labelKey: 'usage.category.llm', color: '#3B82F6' },
  skill: { labelKey: 'usage.category.skill', color: '#10B981' },
  subagent: { labelKey: 'usage.category.subagent', color: '#8B5CF6' },
  mcp: { labelKey: 'usage.category.mcp', color: '#F59E0B' },
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function formatClock(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export default function UsagePanel() {
  const t = useI18n()
  const summary = useUsageStore((s) => s.summary)
  const rangeDays = useUsageStore((s) => s.rangeDays)
  const loading = useUsageStore((s) => s.loading)
  const error = useUsageStore((s) => s.error)
  const load = useUsageStore((s) => s.load)
  const setRange = useUsageStore((s) => s.setRange)
  const clear = useUsageStore((s) => s.clear)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [clearing, setClearing] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load on mount + refresh when usage events are recorded (debounced)
  useEffect(() => {
    load()
    const onRecorded = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => load(), 600)
    }
    window.addEventListener('ourcode:usage-recorded', onRecorded)
    return () => {
      window.removeEventListener('ourcode:usage-recorded', onRecorded)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Discover available skills for the "run skill" list
  useEffect(() => {
    listSkills().then(setSkills).catch(() => setSkills([]))
  }, [])

  const handleClear = useCallback(async () => {
    if (!confirm(t('usage.clearConfirm'))) return
    setClearing(true)
    await clear()
    setClearing(false)
  }, [clear, t])

  const runSkill = useCallback((name: string, description: string) => {
    window.dispatchEvent(new CustomEvent('ourcode:set-chat-input', {
      detail: `请执行技能「${name}」${description ? `（${description}）` : ''}：`,
    }))
    const ui = useUIStore.getState()
    if (!ui.isChatVisible) ui.toggleChat()
  }, [])

  const skillRankMap = useMemo(() => {
    const map = new Map<string, UsageRankRow>()
    for (const s of summary?.skills || []) map.set(s.name, s)
    return map
  }, [summary])

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <div className="p-4 flex flex-col gap-4">
        {/* Header (Stitch: title + refresh/clear, sliding-white-pill range control) */}
        <div className="flex flex-col gap-2.5 shrink-0">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[15px] font-semibold text-nova-text-primary">{t('usage.panelTitle')}</h2>
            <div className="flex gap-1">
              <button
                onClick={() => load()}
                disabled={loading}
                className="w-7 h-7 flex items-center justify-center rounded-full text-nova-text-muted hover:text-nova-accent hover:bg-white/60 dark:hover:bg-white/10 transition-colors"
                title={t('usage.refresh')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
              <button
                onClick={handleClear}
                disabled={clearing || loading}
                className="w-7 h-7 flex items-center justify-center rounded-full text-nova-text-muted hover:text-error hover:bg-white/60 dark:hover:bg-white/10 transition-colors"
                title={t('usage.clear')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                </svg>
              </button>
            </div>
          </div>
          {/* Range segmented control — active gets a sliding white pill */}
          <div className="bg-black/5 dark:bg-white/10 rounded-full p-1 flex justify-between items-center relative text-[11px] font-medium text-nova-text-muted">
            {RANGE_OPTIONS.map((opt) => {
              const active = rangeDays === opt.days
              return (
                <button
                  key={opt.labelKey}
                  onClick={() => setRange(opt.days)}
                  className={`flex-1 py-1 text-center relative z-10 transition-colors ${active ? 'text-nova-accent font-semibold' : 'hover:text-nova-text-primary'}`}
                >
                  {active && (
                    <span className="absolute inset-0 bg-white dark:bg-white/20 rounded-full shadow-sm -z-10 border border-black/5 dark:border-white/10" />
                  )}
                  {t(opt.labelKey)}
                </button>
              )
            })}
          </div>
        </div>

        {loading && !summary ? (
          <div className="flex items-center justify-center py-12 text-xs text-nova-text-muted">
            <span className="w-3 h-3 rounded-full border-2 border-nova-accent border-t-transparent animate-spin mr-2" />
            {t('usage.loading')}
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
            {error}
          </div>
        ) : !summary || summary.totals.requests === 0 ? (
          <EmptyState onRefresh={() => load()} />
        ) : (
          <>
            {/* Summary cards — 2x2 glass grid (Stitch: font-code 18px numbers) */}
            <div className="grid grid-cols-2 gap-2">
              <StatCard label={t('usage.requests')} value={String(summary.totals.requests)} accent="text-[#3B82F6]" />
              <StatCard
                label={t('usage.totalTokens')}
                value={formatTokens(summary.totals.tokensIn + summary.totals.tokensOut)}
                accent="text-nova-accent"
                sub={`↑ ${formatTokens(summary.totals.tokensIn)} / ↓ ${formatTokens(summary.totals.tokensOut)}`}
              />
              <StatCard label={t('usage.todayTokens')} value={formatTokens(todayTokens(summary.daily))} accent="text-[#10B981]" />
              <StatCard
                label={t('usage.failed')}
                value={String(summary.totals.errors)}
                accent={summary.totals.errors > 0 ? 'text-red-400' : 'text-nova-text-muted'}
              />
            </div>

            {/* Token trend (Stitch: title + legend + rounded bar chart) */}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center px-1">
                <h3 className="text-[12px] font-semibold text-nova-text-primary">{t('usage.tokenTrend')}</h3>
                <div className="flex items-center gap-2 text-[10px] text-nova-text-muted">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-nova-accent" />{t('usage.input')}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[#8B5CF6]" />{t('usage.output')}</span>
                </div>
              </div>
              <TrendChart daily={summary.daily} rangeDays={rangeDays} />
            </div>

            {/* By model (Stitch: 模型分布, primary progress bars) */}
            {summary.byModel.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-[12px] font-semibold text-nova-text-primary px-1">{t('usage.byModel')}</h3>
                <ModelList rows={summary.byModel} />
              </div>
            )}

            {/* Skills: available + ranking (Stitch: 技能统计, 运行 pill) */}
            <div className="flex flex-col gap-2">
              <h3 className="text-[12px] font-semibold text-nova-text-primary px-1">{t('usage.skills')}</h3>
              {skills.length === 0 && summary.skills.length === 0 ? (
                <div className="text-xs text-nova-text-muted px-1">{t('usage.noSkills')}</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {skills.map((s) => {
                    const stat = skillRankMap.get(s.name)
                    return (
                      <div key={s.name} className="bg-white/50 dark:bg-white/5 border border-glass-border rounded-md p-2 flex items-center justify-between group">
                        <div className="flex flex-col min-w-0">
                          <div className="text-[11px] font-medium text-nova-text-primary truncate">{s.name}</div>
                          <div className="text-[10px] text-nova-text-muted truncate">
                            {s.description}
                            {stat && <span className="text-nova-accent"> · {t('usage.calls', { count: stat.count })}</span>}
                          </div>
                        </div>
                        <button
                          onClick={() => runSkill(s.name, s.description)}
                          className="shrink-0 ml-2 bg-accent-10 text-nova-accent hover:bg-nova-accent hover:text-white transition-colors text-[10px] font-medium px-2 py-1 rounded-full"
                        >
                          {t('usage.runSkill')}
                        </button>
                      </div>
                    )
                  })}
                  {summary.skills
                    .filter((s) => !skills.some((k) => k.name === s.name))
                    .map((s) => (
                      <div key={`h-${s.name}`} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-nova-text-primary truncate">{s.name}</div>
                          <div className="text-[10px] text-nova-text-muted">
                            {t('usage.calls', { count: s.count })} · {t('usage.lastUsed', { time: formatClock(s.lastUsed) })}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* Subagents */}
            {summary.subagents.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-[12px] font-semibold text-nova-text-primary px-1">{t('usage.subagents')}</h3>
                <div className="bg-white/50 dark:bg-white/5 border border-glass-border rounded-md p-2">
                  <RankList rows={summary.subagents} valueFormatter={(r) => t('usage.calls', { count: r.count })} />
                </div>
              </div>
            )}

            {/* MCP tools */}
            {summary.mcp.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-[12px] font-semibold text-nova-text-primary px-1">{t('usage.mcp')}</h3>
                <McpList rows={summary.mcp} />
              </div>
            )}

            {/* Recent activity (Stitch: color dot + name + tokens + time) */}
            {summary.recent.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-[12px] font-semibold text-nova-text-primary px-1">{t('usage.recent')}</h3>
                <div className="bg-white/50 dark:bg-white/5 border border-glass-border rounded-md p-2 flex flex-col gap-2">
                  {summary.recent.slice(0, 30).map((r) => (
                    <RecentRow key={r.id} row={r} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ───────────────────────── sub-components ───────────────────────── */

function StatCard({ label, value, accent, sub }: { label: string; value: string; accent: string; sub?: string }) {
  return (
    <div className="bg-white/50 dark:bg-white/5 border border-glass-border p-2.5 flex flex-col gap-1 rounded-md backdrop-blur-xl">
      <span className="text-[11px] text-nova-text-muted font-medium">{label}</span>
      <span className={`font-mono text-[18px] leading-none font-medium ${accent}`}>{value}</span>
      {sub && <span className="font-mono text-[11px] text-nova-text-muted">{sub}</span>}
    </div>
  )
}

function EmptyState({ onRefresh }: { onRefresh: () => void }) {
  const t = useI18n()
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center space-y-3">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-nova-text-muted/50" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="20" x2="4" y2="14" />
        <line x1="10" y1="20" x2="10" y2="6" />
        <line x1="16" y1="20" x2="16" y2="11" />
        <line x1="22" y1="20" x2="22" y2="3" />
        <path d="M2 20h22" />
      </svg>
      <div className="text-xs text-nova-text-muted">{t('usage.empty')}</div>
      <button
        onClick={onRefresh}
        className="px-2.5 py-1 rounded text-[11px] text-nova-accent bg-accent-10 hover:bg-accent-20 transition-colors"
      >
        {t('usage.refresh')}
      </button>
    </div>
  )
}

function todayTokens(daily: UsageDailyRow[]): number {
  const now = new Date()
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const row = daily.find((d) => d.day === key)
  return row ? row.tokensIn + row.tokensOut : 0
}

/** Hand-rolled SVG bar chart (no chart library in this app) — input + output stacked */
function TrendChart({ daily, rangeDays }: { daily: UsageDailyRow[]; rangeDays: number }) {
  const days = useMemo(() => {
    const map = new Map(daily.map((d) => [d.day, d]))
    const n = rangeDays > 0 ? Math.min(rangeDays, 90) : 30
    const today = new Date()
    const out: UsageDailyRow[] = []
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      out.push(map.get(key) || { day: key, tokensIn: 0, tokensOut: 0, requests: 0 })
    }
    return out
  }, [daily, rangeDays])

  const max = Math.max(...days.map((d) => d.tokensIn + d.tokensOut), 1)

  return (
    <div className="h-[80px] flex items-end justify-between px-2 pt-2 pb-1 gap-1 border-b border-black/5 dark:border-white/10">
      <svg
        className="w-full h-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {days.map((d, i) => {
          const hIn = (d.tokensIn / max) * 88
          const hOut = (d.tokensOut / max) * 88
          const x = 2 + i * ((96 - 2) / days.length)
          const w = Math.max((96 - 2) / days.length - 2, 1)
          return (
            <g key={d.day}>
              <title>{`${d.day}: ↑${formatTokens(d.tokensIn)} ↓${formatTokens(d.tokensOut)}`}</title>
              {/* output on top (tertiary), input below (primary) — Stitch chart */}
              <rect x={x} y={96 - hIn - hOut} width={w} height={hOut} rx={2} fill="#8B5CF6" />
              <rect x={x} y={96 - hIn} width={w} height={hIn} rx={2} fill="var(--primary-color, #0058bc)" />
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function ModelList({ rows }: { rows: UsageRankRow[] }) {
  const max = Math.max(...rows.map((r) => r.tokensIn + r.tokensOut), 1)
  const t = useI18n()
  return (
    <div className="bg-white/50 dark:bg-white/5 border border-glass-border rounded-md p-2 flex flex-col gap-2">
      {rows.slice(0, 8).map((r, idx) => {
        const total = r.tokensIn + r.tokensOut
        const pct = Math.max((total / max) * 100, total > 0 ? 3 : 0)
        // Decreasing primary opacity per rank (Stitch: 100% → 70% → 50%)
        const opacities = [1, 0.7, 0.5, 0.35, 0.25, 0.2, 0.15, 0.12]
        return (
          <div key={r.name} className="flex flex-col gap-1">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-nova-text-primary font-medium truncate">{r.name}</span>
              <span className="font-mono text-[11px] text-nova-text-muted shrink-0">
                {t('usage.calls', { count: r.count })} · {formatTokens(total)}
              </span>
            </div>
            <div className="h-1.5 w-full bg-black/5 dark:bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full"
                style={{ width: `${pct}%`, opacity: opacities[idx] ?? 0.12 }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RankList({ rows, valueFormatter }: { rows: UsageRankRow[]; valueFormatter: (r: UsageRankRow) => string }) {
  return (
    <div className="space-y-1">
      {rows.slice(0, 10).map((r) => (
        <div key={r.name} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-nova-hover/40">
          <span className="min-w-0 flex-1 text-xs text-nova-text-primary truncate">{r.name}</span>
          {r.errors > 0 && <span className="shrink-0 text-[10px] text-red-400">{r.errors} ✗</span>}
          <span className="shrink-0 text-[10px] text-nova-text-muted">{valueFormatter(r)}</span>
        </div>
      ))}
    </div>
  )
}

/** MCP usage grouped by server, tools listed underneath */
function McpList({ rows }: { rows: UsageRankRow[] }) {
  const t = useI18n()
  const groups = useMemo(() => {
    const g = new Map<string, { tools: UsageRankRow[]; connections: UsageRankRow[] }>()
    for (const r of rows) {
      const server = r.sub || r.name.split('__')[0] || '?'
      if (!g.has(server)) g.set(server, { tools: [], connections: [] })
      const group = g.get(server)!
      // Lifecycle events (server__server from MCPManager) are health stats, not tool usage
      if (r.name === `${server}__server`) group.connections.push(r)
      else group.tools.push(r)
    }
    return Array.from(g.entries())
  }, [rows])

  return (
    <div className="bg-white/50 dark:bg-white/5 border border-glass-border rounded-md p-2 flex flex-col gap-2">
      {groups.slice(0, 10).map(([server, { tools, connections }]) => {
        const connErrors = connections.reduce((s, r) => s + r.errors, 0)
        return (
          <div key={server} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-nova-text-primary truncate">{server}</span>
              {connErrors > 0 && (
                <span className="shrink-0 text-[10px] text-red-400" title={t('usage.serverErrors')}>
                  {connErrors} ✗
                </span>
              )}
              <span className="ml-auto shrink-0 text-[10px] text-nova-text-muted">
                {t('usage.calls', { count: tools.reduce((s, x) => s + x.count, 0) })}
              </span>
            </div>
            {tools.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {tools.slice(0, 6).map((r) => {
                  const tool = r.name.includes('__') ? r.name.slice(r.name.indexOf('__') + 2) : r.name
                  return (
                    <div key={r.name} className="flex items-center gap-2 pl-1.5">
                      <span className="min-w-0 flex-1 text-[11px] text-nova-text-muted truncate font-mono">{tool}</span>
                      {r.errors > 0 && <span className="shrink-0 text-[10px] text-red-400">{r.errors} ✗</span>}
                      <span className="shrink-0 text-[10px] text-nova-text-muted">{t('usage.calls', { count: r.count })}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function RecentRow({ row }: { row: UsageRecentRow }) {
  const t = useI18n()
  const meta = CATEGORY_META[row.category] || CATEGORY_META.llm
  const label = t(meta.labelKey)
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="shrink-0 w-1.5 h-1.5 rounded-full"
          style={{ background: row.ok ? meta.color : '#EF4444' }}
          title={row.ok ? label : `${label} · ${row.error || ''}`}
        />
        <span className="min-w-0 flex-1 text-[11px] text-nova-text-primary truncate">{row.name}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="font-mono text-[11px] text-nova-text-muted">
          {row.tokensIn + row.tokensOut > 0
            ? `${formatTokens(row.tokensIn + row.tokensOut)} t`
            : row.durationMs > 0
              ? formatDuration(row.durationMs)
              : ''}
        </span>
        <span className="text-[11px] text-nova-text-muted w-10 text-right">{formatClock(row.startedAt)}</span>
      </div>
    </div>
  )
}
