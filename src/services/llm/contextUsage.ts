/**
 * Context-window usage — the single view model behind every "how much of the
 * window is this conversation eating" surface (composer ring, status bar,
 * warning banner, breakdown popover).
 *
 * Why a dedicated module: the number itself already existed
 * (`estimateContextTokens`) but each surface re-derived its own percentage and
 * threshold from raw primitives, so the banner and the status bar could disagree
 * and neither could explain WHY the number was what it was. Here the accounting
 * happens once, in one pure function, and every surface renders the same object.
 *
 * Accounting rules (kept identical to the request path on purpose):
 *  - `used` is `estimateContextTokens` — real provider usage of the last
 *    response as the baseline plus an estimate for messages added since — with
 *    one correction: before any provider baseline exists that estimate only
 *    covers MESSAGES, so the observed system+tools prefix is added on top
 *    (otherwise the ring under-reports the fixed per-request cost).
 *  - `window` is `getContextWindow` — user model config → curated table →
 *    vendor catalog → 128K, the same resolution trimming/compaction uses, so
 *    the displayed percentage and the compaction trigger can never diverge.
 *  - `reserve` mirrors the request's output budget (maxTokens or 20% of window).
 *  - Segments split `used` into system+tools / summary / history / other. The
 *    prefix size is observed by the agent loop (contextBreakdown); before the
 *    first request of this process it is unknown, and `prefixPending` says so
 *    instead of silently blaming history for the missing tokens.
 */
import { estimateContextTokens, estimateSessionHistoryTokens, estimateTokens, toolResultCompactOptionsFor } from '@/stores/chatStore'
import { buildSummaryBlock } from './compaction'
import { getContextWindow } from './modelDefaults'
import { getStablePrefixTokens } from './contextBreakdown'
import type { CustomModel } from '@/types'

/** Thresholds, shared with the UI so a colour never lies about the level. */
export const CONTEXT_HIGH_RATIO = 0.65
export const CONTEXT_WARNING_RATIO = 0.8
export const CONTEXT_CRITICAL_RATIO = 0.95

export type ContextUsageLevel = 'idle' | 'normal' | 'high' | 'warning' | 'critical'

export interface ContextUsageSegments {
  /** System prompt + tool definitions (byte-stable request prefix). */
  system: number
  /** LLM summary that replaces the pre-boundary history at request time. */
  summary: number
  /** Stored messages after the compaction boundary, seen as the request sees them. */
  history: number
  /** Reality minus estimates: provider-reported baseline vs. our segment sums. */
  other: number
}

export interface ContextUsage {
  used: number
  window: number
  /** 0–100, rounded; clamped so a provider overshoot never renders 103%. */
  percent: number
  level: ContextUsageLevel
  /** window − used − reserve, floored at 0. */
  remaining: number
  /** Output budget held back for the next response. */
  reserve: number
  /** Token count at which compaction fires (window × 80%). */
  compactionAt: number
  /** 'real' once a provider-reported usage baseline exists for this session. */
  source: 'real' | 'estimated'
  segments: ContextUsageSegments
  /** True when the system+tools prefix has not been observed yet (first request pending). */
  prefixPending: boolean
}

/** Structural subset of ChatSession the accounting needs (keeps tests trivial). */
export interface ContextUsageSession {
  id: string
  model?: string
  modelParams?: { maxTokens?: number }
  lastContextTokens?: number
  lastContextMessageCount?: number
  summary?: string
  summaryMessageCount?: number
  targetMode?: boolean
  workerRole?: string
  messages: Array<{ role: string; content: string; toolCalls?: unknown[] }>
}

/** 12345 → "12.3K", 200000 → "200K", 1500000 → "1.5M". */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(Math.round(n))
}

export function contextUsageLevel(ratio: number, used: number): ContextUsageLevel {
  if (used <= 0) return 'idle'
  if (ratio >= CONTEXT_CRITICAL_RATIO) return 'critical'
  if (ratio >= CONTEXT_WARNING_RATIO) return 'warning'
  if (ratio >= CONTEXT_HIGH_RATIO) return 'high'
  return 'normal'
}

export function computeContextUsage(session: ContextUsageSession, customModels?: CustomModel[]): ContextUsage {
  const window = getContextWindow(session.model || '', customModels)
  const messageTokens = Math.max(0, estimateContextTokens(session))

  // Request view of the history: everything after the compaction boundary, with
  // old oversized tool results collapsed exactly like the request path does.
  const opts = toolResultCompactOptionsFor(session)
  const summarized = Math.min(session.summaryMessageCount ?? 0, session.messages.length)
  const summaryTokens = session.summary ? estimateTokens(buildSummaryBlock(session.summary)) : 0
  const historyTokens = estimateSessionHistoryTokens(session.messages.slice(summarized), opts)
  const prefix = getStablePrefixTokens(session.id)
  const systemTokens = prefix ?? 0
  // `estimateContextTokens` only sums MESSAGES. Once the provider reported a
  // baseline, that baseline already contains the system+tools prefix — but
  // before the first response it doesn't, and the ring would under-report the
  // fixed cost of every request (~10–20K tokens) as if the window were emptier
  // than it is. Add the observed prefix only in the baseline-less case.
  const hasBaseline = (session.lastContextTokens ?? 0) > 0 && (session.lastContextMessageCount ?? 0) > 0
  const used = hasBaseline ? messageTokens : messageTokens + systemTokens
  const ratio = window > 0 ? used / window : 0

  const maxOutput = session.modelParams?.maxTokens ?? 0
  const reserve = maxOutput > 0 ? maxOutput : Math.floor(window * 0.2)

  // `used` is the authority (it may carry provider-reported output tokens and
  // cache reads the segments can't see) — the remainder goes to `other` rather
  // than making the segments add up to something the ring doesn't show.
  const other = Math.max(0, used - systemTokens - summaryTokens - historyTokens)

  return {
    used,
    window,
    percent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    level: contextUsageLevel(ratio, used),
    remaining: Math.max(0, window - used - reserve),
    reserve,
    compactionAt: Math.floor(window * CONTEXT_WARNING_RATIO),
    source: (session.lastContextTokens ?? 0) > 0 && (session.lastContextMessageCount ?? 0) > 0 ? 'real' : 'estimated',
    segments: { system: systemTokens, summary: summaryTokens, history: historyTokens, other },
    prefixPending: prefix == null,
  }
}
