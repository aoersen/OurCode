import { describe, it, expect } from 'vitest'
import {
  maybeCompact,
  findKeepBoundary,
  findCompactionCutPoint,
  extractFileOps,
  formatFileOps,
  buildSummaryBlock,
  isSummaryMessage,
  getContextWindow,
  DEFAULT_CONTEXT_WINDOW,
  SUMMARY_MARKER,
  CompactMessage,
} from '@/services/llm/compaction'
import { useConfigStore } from '@/stores/configStore'

/**
 * Compaction logic tests — pure orchestration with a fake summarizer, so no
 * LLM calls happen. Covers the trigger timing (estimate-confirmed overflow
 * only, or force), the request-view rebuild (original messages untouched) and
 * the fallback contract (null = caller keeps current behavior).
 */

// estimateTokens: 1 token per char for simplicity.
const est = (t: string) => t.length
const sys: CompactMessage = { role: 'system', content: 'SYSTEM PROMPT' }
const user = (content: string): CompactMessage => ({ role: 'user', content })
const assistant = (content: string): CompactMessage => ({ role: 'assistant', content })

/** Summarizer stub: records its input and returns a fixed summary. */
function fakeSummarize(spy?: { anchor: string; history: string }[]) {
  return async (input: { anchor: string; history: string }) => {
    spy?.push(input)
    return '## 目标\n完成功能 X\n## 关键细节\n文件 src/a.ts 已修改'
  }
}

function baseOpts(overrides: Partial<Parameters<typeof maybeCompact>[0]> = {}) {
  return {
    session: {},
    messages: [sys, user('u1'), assistant('a1'), user('u2')],
    compactionEnabled: true,
    estimateTokens: est,
    summarize: fakeSummarize(),
    ...overrides,
  }
}

describe('findKeepBoundary', () => {
  it('returns the index of the last user message', () => {
    expect(findKeepBoundary([sys, user('u1'), assistant('a1'), user('u2')])).toBe(3)
  })

  it('returns 0 when there is no user message', () => {
    expect(findKeepBoundary([sys])).toBe(0)
    expect(findKeepBoundary([])).toBe(0)
  })
})

describe('findCompactionCutPoint', () => {
  it('keeps the most recent work verbatim and cuts at a safe boundary', () => {
    // Long agent run: user sits at the START, then assistant + tool results.
    const msgs = [sys, user('run start'), assistant('a1'), { role: 'tool' as const, content: 't'.repeat(1000) }, assistant('a2')]
    // keepRecentTokens=100 → walk back: a2(2) → tool(1000) → cut at the a2 boundary.
    expect(findCompactionCutPoint(msgs, 100, est)).toBe(4)
  })

  it('never cuts on a tool message (keeps assistant + its tool results together)', () => {
    // Tail ends in tool results; the cut must land on the assistant that owns them.
    const msgs = [sys, user('q'), assistant('a1'), { role: 'tool' as const, content: 'x'.repeat(500) }, { role: 'tool' as const, content: 'y'.repeat(500) }]
    expect(findCompactionCutPoint(msgs, 100, est)).toBe(2)
  })

  it('returns 1 (nothing to summarize) when history is under the budget', () => {
    expect(findCompactionCutPoint([sys, user('hi'), assistant('hello')], 1000, est)).toBe(1)
  })

  it('returns 0 for an empty or system-only message list', () => {
    expect(findCompactionCutPoint([], 10, est)).toBe(0)
    expect(findCompactionCutPoint([sys], 10, est)).toBe(0)
  })
})

describe('summary message marker', () => {
  it('buildSummaryBlock marks the message, isSummaryMessage recognizes it', () => {
    const block = buildSummaryBlock('SUM')
    expect(block.startsWith(SUMMARY_MARKER)).toBe(true)
    expect(isSummaryMessage({ role: 'system', content: block })).toBe(true)
    expect(isSummaryMessage({ role: 'system', content: 'plain system' })).toBe(false)
    expect(isSummaryMessage({ role: 'user', content: block })).toBe(false)
  })
})

describe('maybeCompact', () => {
  it('does nothing when compaction is disabled', async () => {
    const result = await maybeCompact(baseOpts({ compactionEnabled: false }))
    expect(result).toBeNull()
  })

  it('does nothing when the estimate is under the budget', async () => {
    const result = await maybeCompact(baseOpts({ contextWindow: 1000 })) // budget 800 >> 4 chars
    expect(result).toBeNull()
  })

  it('does nothing when aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await maybeCompact(baseOpts({ signal: ctrl.signal }))
    expect(result).toBeNull()
  })

  it('compacts the older prefix and keeps the most recent work verbatim', async () => {
    const result = await maybeCompact(baseOpts({ contextWindow: 100 })) // budget 80 < 4 chars? no — messages are tiny
    expect(result).toBeNull()

    // Long history → over the 80-token budget.
    const big = [sys, user('x'.repeat(100)), assistant('y'.repeat(100)), user('CURRENT TURN')]
    const compacted = await maybeCompact(baseOpts({ messages: big, contextWindow: 200 })) // budget 160 < 200
    expect(compacted).not.toBeNull()
    expect(compacted!.summary).toContain('## 目标')
    // keepRecentTokens = 200 * 0.2 = 40 → cut at the assistant, keeping assistant + current turn.
    expect(compacted!.boundaryCount).toBe(1) // the older user message was summarized
    expect(compacted!.messages.map((m) => m.role)).toEqual(['system', 'system', 'assistant', 'user'])
    expect(compacted!.messages[3]).toEqual(user('CURRENT TURN'))
    expect(compacted!.messages[1].content!.startsWith(SUMMARY_MARKER)).toBe(true)
  })

  it('excludes request-only messages from the summarized count', async () => {
    // Same shape as the case above, plus the per-turn dynamic-context message
    // the runner assembles onto the request without storing it on the session.
    // Counting it would make summaryMessageCount grow faster than the session,
    // so every following turn slices away real history that still renders.
    const withSynthetic = [
      sys,
      user('x'.repeat(100)),
      { role: 'user' as const, content: 'MEMORY / 编辑器状态', synthetic: true },
      assistant('y'.repeat(100)),
      user('CURRENT TURN'),
    ]
    const compacted = await maybeCompact(baseOpts({ messages: withSynthetic, contextWindow: 200 }))
    expect(compacted).not.toBeNull()
    expect(compacted!.boundaryCount).toBe(1)
  })

  it('force skips the budget check (context-overflow fallback)', async () => {
    const tiny = [sys, user('u1'), assistant('a1'), user('u2')]
    const result = await maybeCompact(baseOpts({ messages: tiny, force: true, keepRecentTokens: 1 }))
    expect(result).not.toBeNull()
  })

  it('counts the tool-schema overhead that rides outside the messages array', async () => {
    // Messages alone are far under the budget — only the request-body overhead
    // (tool schemas) pushes the real request over the line.
    const plain = await maybeCompact(baseOpts({ contextWindow: 1000 })) // budget 800 > ~19 tokens
    expect(plain).toBeNull()
    const withOverhead = await maybeCompact(baseOpts({ contextWindow: 1000, overheadTokens: 1000, keepRecentTokens: 1 })) // ≈19 + 1000 > 800
    expect(withOverhead).not.toBeNull()
  })

  it('reserves output headroom (thinking) by lowering the effective budget', async () => {
    const messages = [sys, user('x'.repeat(50)), assistant('y'.repeat(50)), user('CURRENT')] // ≈120 tokens
    // Under the 80% budget on its own…
    const plain = await maybeCompact(baseOpts({ messages, contextWindow: 200 })) // budget 160 > 120
    expect(plain).toBeNull()
    // …but with a thinking-reply reserve the effective budget drops to 110 and
    // the same history crosses the line, compacting BEFORE the round overflows.
    const reserved = await maybeCompact(baseOpts({ messages, contextWindow: 200, outputReserve: 50 }))
    expect(reserved).not.toBeNull()
  })

  it('does not summarize when only the system prompt precedes the current turn', async () => {
    const result = await maybeCompact(baseOpts({ messages: [sys, user('u1')], force: true }))
    expect(result).toBeNull()
  })

  it('passes the previous summary as the anchor and excludes the summary message from history', async () => {
    const calls: Array<{ anchor: string; history: string }> = []
    const oldBlock = buildSummaryBlock('OLD SUMMARY')
    const messages = [sys, { role: 'system', content: oldBlock }, user('new question'), assistant('answer'), user('and more')]
    const result = await maybeCompact(
      baseOpts({
        session: { summary: 'OLD SUMMARY', summaryMessageCount: 1 },
        messages,
        force: true,
        keepRecentTokens: 1, // tiny tail budget so the token cut reaches the last user message
        summarize: fakeSummarize(calls),
      }),
    )
    expect(result).not.toBeNull()
    expect(calls.length).toBe(1)
    expect(calls[0].anchor).toBe('OLD SUMMARY')
    // The old summary message is not re-sent as history (anchor replaces it).
    expect(calls[0].history).not.toContain(SUMMARY_MARKER)
    expect(calls[0].history).toContain('new question')
  })

  it('returns null when the summarizer throws (caller falls back to the lossy trim)', async () => {
    const result = await maybeCompact(
      baseOpts({ force: true, summarize: async () => { throw new Error('summarizer down') } }),
    )
    expect(result).toBeNull()
  })

  it('returns null when the summarizer returns empty', async () => {
    const result = await maybeCompact(baseOpts({ force: true, summarize: async () => '' }))
    expect(result).toBeNull()
  })

  it('caps the summarizer input size (bounded cost on huge contexts)', async () => {
    const calls: Array<{ anchor: string; history: string }> = []
    const big = [sys, user('x'.repeat(1_000_000)), user('CURRENT')]
    const result = await maybeCompact(
      baseOpts({ messages: big, force: true, keepRecentTokens: 1, summarize: fakeSummarize(calls) }),
    )
    expect(result).not.toBeNull()
    expect(calls[0].history.length).toBeLessThan(500_000)
  })
})

describe('getContextWindow', () => {
  it('prefers a user-defined custom model window over the static table', () => {
    const prev = useConfigStore.getState().customModels
    useConfigStore.setState({ customModels: [{ id: 'my-ollama', name: 'my-ollama', provider: 'ollama', contextWindow: 8192, createdAt: 0 }] })
    try {
      expect(getContextWindow('my-ollama')).toBe(8192)
    } finally {
      useConfigStore.setState({ customModels: prev })
    }
  })

  it('falls back to the static metadata table for known models', () => {
    expect(getContextWindow('deepseek-chat')).toBe(200000)
  })

  it('falls back to the default for unknown models', () => {
    expect(getContextWindow('totally-unknown-model-xyz')).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})

// Helper: a tool call declaration matching the LLMToolCall wire shape.
const tc = (name: string, args: Record<string, unknown>) => ({
  id: 'c1',
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
})

describe('extractFileOps', () => {
  it('extracts read paths from read_file and read_multiple_files', () => {
    const messages: CompactMessage[] = [
      { role: 'assistant', content: '', toolCalls: [tc('read_file', { path: '/a/b.py' }), tc('read_multiple_files', { paths: ['/c/d.py', '/e/f.py'] })] },
    ]
    const ops = extractFileOps(messages)
    expect(Array.from(ops.read).sort()).toEqual(['/a/b.py', '/c/d.py', '/e/f.py'])
    expect(ops.edited.size).toBe(0)
  })

  it('extracts edited paths from write/edit/multi_edit', () => {
    const messages: CompactMessage[] = [
      { role: 'assistant', content: '', toolCalls: [
        tc('write_file', { path: '/w/x.py' }),
        tc('edit_file', { path: '/e/y.py' }),
        tc('multi_edit_file', { edits: [{ path: '/m/z.py' }, { path: '/m/w.py' }] }),
      ] },
    ]
    const ops = extractFileOps(messages)
    expect(ops.read.size).toBe(0)
    expect(Array.from(ops.edited).sort()).toEqual(['/e/y.py', '/m/w.py', '/m/z.py', '/w/x.py'])
  })

  it('ignores non-file tools and dedupes repeated reads', () => {
    const messages: CompactMessage[] = [
      { role: 'assistant', content: '', toolCalls: [
        tc('search_files', { query: 'x' }),
        tc('run_command', { command: 'ls' }),
        tc('read_file', { path: '/dup.py' }),
        tc('read_file', { path: '/dup.py' }),
      ] },
    ]
    const ops = extractFileOps(messages)
    expect(Array.from(ops.read)).toEqual(['/dup.py'])
    expect(ops.edited.size).toBe(0)
  })
})

describe('formatFileOps', () => {
  it('renders read + edited sections', () => {
    const out = formatFileOps(['/a.py'], ['/b.py'])
    expect(out).toContain('## 已读文件')
    expect(out).toContain('- /a.py')
    expect(out).toContain('## 已改文件')
    expect(out).toContain('- /b.py')
  })

  it('renders empty when there is nothing to list', () => {
    expect(formatFileOps([], [])).toBe('')
  })
})

describe('maybeCompact file list integration', () => {
  it('appends the deterministic read/edited file list to the summary', async () => {
    const messages: CompactMessage[] = [
      sys,
      { role: 'assistant', content: 'read x', toolCalls: [tc('read_file', { path: '/x.py' }), tc('edit_file', { path: '/y.py' })] },
      user('current'),
    ]
    const result = await maybeCompact(baseOpts({ messages, force: true, keepRecentTokens: 1 }))
    expect(result).not.toBeNull()
    expect(result!.summary).toContain('## 已读文件')
    expect(result!.summary).toContain('- /x.py')
    expect(result!.summary).toContain('## 已改文件')
    expect(result!.summary).toContain('- /y.py')
  })
})
