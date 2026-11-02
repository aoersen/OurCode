import { describe, it, expect, beforeEach, vi } from 'vitest'

// Same two shims chatStore.test.ts needs: importing the store pulls monaco's
// browser modules (which read `window` at import time) and the Electron API.
// vi.mock is hoisted, so both land before the imports below.
vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))
vi.stubGlobal('window', { electronAPI: {} })

import {
  computeContextUsage,
  contextUsageLevel,
  formatTokenCount,
  CONTEXT_HIGH_RATIO,
  CONTEXT_WARNING_RATIO,
  CONTEXT_CRITICAL_RATIO,
  type ContextUsageSession,
} from '@/services/llm/contextUsage'
import { estimateContextTokens } from '@/stores/chatStore'
import { rememberStablePrefixTokens, clearStablePrefixTokens } from '@/services/llm/contextBreakdown'
import { DEFAULT_CONTEXT_WINDOW } from '@/services/llm/modelDefaults'

/** ASCII filler: estimateTokens counts non-CJK at 0.3 tokens/char, so
 *  N chars ≈ 0.3·N tokens — deterministic fixtures without a tokenizer. */
const fill = (chars: number) => 'a'.repeat(chars)

function session(overrides: Partial<ContextUsageSession> = {}): ContextUsageSession {
  // Empty model → the 128K default window, so fixtures don't depend on the
  // vendor catalog (gpt-4.1 is a 1M-token model and would halve every ratio).
  return {
    id: 's-test',
    model: '',
    messages: [],
    ...overrides,
  }
}

function withUserMessage(chars: number, extra: Partial<ContextUsageSession> = {}): ContextUsageSession {
  return session({ messages: [{ role: 'user', content: fill(chars) }], ...extra })
}

beforeEach(() => {
  clearStablePrefixTokens('s-test')
})

describe('formatTokenCount', () => {
  it('scales K/M the way the design spells numbers', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(12_400)).toBe('12.4K')
    expect(formatTokenCount(84_200)).toBe('84.2K')
    expect(formatTokenCount(200_000)).toBe('200K')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
  })

  it('never renders NaN/negative garbage', () => {
    expect(formatTokenCount(Number.NaN)).toBe('0')
    expect(formatTokenCount(-5)).toBe('0')
  })
})

describe('contextUsageLevel', () => {
  it('maps ratios onto the four designed levels', () => {
    expect(contextUsageLevel(0, 0)).toBe('idle')
    expect(contextUsageLevel(0.2, 5000)).toBe('normal')
    expect(contextUsageLevel(CONTEXT_HIGH_RATIO - 0.01, 5000)).toBe('normal')
    expect(contextUsageLevel(CONTEXT_HIGH_RATIO, 5000)).toBe('high')
    expect(contextUsageLevel(CONTEXT_WARNING_RATIO - 0.01, 5000)).toBe('high')
    expect(contextUsageLevel(CONTEXT_WARNING_RATIO, 5000)).toBe('warning')
    expect(contextUsageLevel(CONTEXT_CRITICAL_RATIO - 0.01, 5000)).toBe('warning')
    expect(contextUsageLevel(CONTEXT_CRITICAL_RATIO, 5000)).toBe('critical')
    expect(contextUsageLevel(1.4, 5000)).toBe('critical')
  })

  it('treats a session with nothing in it as idle even at ratio 0', () => {
    expect(contextUsageLevel(0, 0)).toBe('idle')
  })
})

describe('computeContextUsage', () => {
  it('reports an empty session as 0% / idle against the default window', () => {
    const usage = computeContextUsage(session())
    expect(usage.used).toBe(0)
    expect(usage.percent).toBe(0)
    expect(usage.level).toBe('idle')
    expect(usage.window).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('uses exactly the same token total as the request path (no second algorithm)', () => {
    const s = withUserMessage(30_000)
    expect(computeContextUsage(s).used).toBe(estimateContextTokens(s))
  })

  it('rounds the percentage and clamps it to 100 on a provider overshoot', () => {
    const normal = withUserMessage(100_000) // ≈ 30K tokens of a 128K window
    expect(computeContextUsage(normal).percent).toBe(
      Math.round((estimateContextTokens(normal) / DEFAULT_CONTEXT_WINDOW) * 100),
    )

    // A provider-reported baseline far beyond the window must not render 180%.
    const runaway = session({
      lastContextTokens: 400_000,
      lastContextMessageCount: 1,
      messages: [{ role: 'user', content: fill(100) }],
    })
    const usage = computeContextUsage(runaway)
    expect(usage.used).toBeGreaterThan(DEFAULT_CONTEXT_WINDOW)
    expect(usage.percent).toBe(100)
    expect(usage.level).toBe('critical')
    expect(usage.remaining).toBe(0)
  })

  it('reserves the output budget (maxTokens when set, else 20% of the window)', () => {
    const plain = computeContextUsage(withUserMessage(1000))
    expect(plain.reserve).toBe(Math.floor(DEFAULT_CONTEXT_WINDOW * 0.2))
    expect(plain.remaining).toBe(DEFAULT_CONTEXT_WINDOW - plain.used - plain.reserve)

    const tuned = computeContextUsage(withUserMessage(1000, { modelParams: { maxTokens: 8000 } }))
    expect(tuned.reserve).toBe(8000)
    expect(tuned.remaining).toBe(DEFAULT_CONTEXT_WINDOW - tuned.used - 8000)
  })

  it('places the compaction tick at 80% of the window', () => {
    const usage = computeContextUsage(withUserMessage(1000))
    expect(usage.compactionAt).toBe(Math.floor(DEFAULT_CONTEXT_WINDOW * CONTEXT_WARNING_RATIO))
  })

  it('marks the number as estimated until a provider baseline exists', () => {
    expect(computeContextUsage(withUserMessage(1000)).source).toBe('estimated')
    const measured = computeContextUsage(
      withUserMessage(1000, { lastContextTokens: 12_000, lastContextMessageCount: 1 }),
    )
    expect(measured.source).toBe('real')
  })

  it('splits system+tools out only once the agent loop has observed the prefix', () => {
    const pending = computeContextUsage(withUserMessage(30_000))
    expect(pending.prefixPending).toBe(true)
    expect(pending.segments.system).toBe(0)

    rememberStablePrefixTokens('s-test', 5000)
    const s = withUserMessage(30_000)
    const known = computeContextUsage(s)
    expect(known.prefixPending).toBe(false)
    expect(known.segments.system).toBe(5000)
    // Without a provider baseline the prefix is ADDED to the message estimate —
    // every request pays for system+tools, so a fresh conversation must not
    // look emptier than it is.
    expect(known.used).toBe(estimateContextTokens(s) + 5000)
    const sum = known.segments.system + known.segments.summary + known.segments.history + known.segments.other
    expect(sum).toBe(known.used)
    expect(known.segments.other).toBe(0)
  })

  it('does not double-count the prefix once the provider reported a baseline', () => {
    rememberStablePrefixTokens('s-test', 5000)
    const measured = computeContextUsage(
      withUserMessage(1000, { lastContextTokens: 12_000, lastContextMessageCount: 1 }),
    )
    // Baseline already contains system+tools → used is the baseline, untouched.
    expect(measured.used).toBe(12_000)
    expect(measured.segments.system).toBe(5000)
  })

  it('drops the percentage after compaction (summary replaces the pre-boundary history)', () => {
    const long = withUserMessage(300_000) // ≈ 90K tokens
    const before = computeContextUsage(long)
    const compacted = computeContextUsage({
      ...long,
      summary: '总结：用户要求优化 Git 面板提交流程，已修改 GitPanel.tsx 与 MainLayout.tsx。',
      summaryMessageCount: long.messages.length,
    })
    expect(compacted.used).toBeLessThan(before.used)
    expect(compacted.percent).toBeLessThan(before.percent)
    expect(compacted.segments.summary).toBeGreaterThan(0)
    expect(compacted.segments.history).toBe(0)
  })

  it('walks into the designed level bands at the designed thresholds', () => {
    const high = computeContextUsage(withUserMessage(300_000)) // ~90K / 128K ≈ 70%
    expect(high.level).toBe('high')
    const warning = computeContextUsage(withUserMessage(350_000)) // ~105K / 128K ≈ 82%
    expect(warning.level).toBe('warning')
    expect(warning.percent).toBeGreaterThanOrEqual(80)
    const critical = computeContextUsage(withUserMessage(430_000)) // ~129K / 128K > 100%
    expect(critical.level).toBe('critical')
  })

  it('measures against the ACTUAL model window (a 1M model reads the same history as small)', () => {
    const history = { messages: [{ role: 'user', content: fill(300_000) }] }
    const small = computeContextUsage(session(history))
    const large = computeContextUsage(session({ ...history, model: 'gpt-4.1' }))
    expect(large.window).toBeGreaterThan(small.window)
    expect(large.window).toBeGreaterThanOrEqual(1_000_000)
    expect(large.percent).toBeLessThan(small.percent)
    expect(large.level).toBe('normal')
  })
})
