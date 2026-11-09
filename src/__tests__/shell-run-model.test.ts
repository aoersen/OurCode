import { describe, expect, it } from 'vitest'
import {
  countLineDelta,
  countStepStates,
  deriveRunSteps,
  deriveStepState,
  deriveSubAgentRows,
  editLineDelta,
  formatRunDuration,
  formatStepDuration,
  formatTokens,
  isEditTool,
  pickCurrentTurnMessages,
  pickRunMessages,
  resultLineDelta,
  runDurationMs,
  runProgressPercent,
  runSummaryState,
  runTokens,
  splitLines,
  stepErrorLine,
  stepTarget,
  summarizeRunLine,
  thinkingLabel,
  toolLabel,
  type RunMessageLike,
} from '@/shell/agent/run/runModel'

const call = (id: string, name: string, args: Record<string, any> = {}) => ({ id, name, arguments: args })

describe('toolLabel', () => {
  it('maps known tools to sans labels', () => {
    expect(toolLabel('read_file')).toBe('Read')
    expect(toolLabel('edit_file')).toBe('Edit')
    expect(toolLabel('run_command')).toBe('Bash')
    expect(toolLabel('multi_edit_file')).toBe('Edit')
  })

  it('falls back for unknown tools and MCP tools', () => {
    expect(toolLabel('some_custom_tool')).toBe('some custom tool')
    expect(toolLabel('mcp__github__create_issue')).toBe('create issue')
  })

  it('knows which tools carry edit counters', () => {
    expect(isEditTool('edit_file')).toBe(true)
    expect(isEditTool('write_file')).toBe(true)
    expect(isEditTool('read_file')).toBe(false)
  })
})

describe('splitLines / countLineDelta', () => {
  it('ignores the trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
  })

  it('counts only the changed middle block', () => {
    expect(countLineDelta('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 })
    expect(countLineDelta('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 })
    expect(countLineDelta('a', 'a\nb\nc')).toEqual({ added: 2, removed: 0 })
    expect(countLineDelta('a\nb\nc', 'a')).toEqual({ added: 0, removed: 2 })
  })
})

describe('resultLineDelta', () => {
  it('parses +N −M summaries in several dash spellings', () => {
    expect(resultLineDelta('+142 −0')).toEqual({ added: 142, removed: 0 })
    expect(resultLineDelta('+28 -15')).toEqual({ added: 28, removed: 15 })
    expect(resultLineDelta('no counts here')).toBeNull()
    expect(resultLineDelta('')).toBeNull()
    expect(resultLineDelta(undefined)).toBeNull()
  })
})

describe('stepTarget', () => {
  it('prefers paths, then commands, then queries', () => {
    expect(stepTarget({ path: 'src/shell/AgentShell.tsx' })).toBe('src/shell/AgentShell.tsx')
    expect(stepTarget({ command: 'pnpm  check:types' })).toBe('pnpm check:types')
    expect(stepTarget({ query: 'chatWidth' })).toBe('chatWidth')
  })

  it('summarises multi-file arguments', () => {
    expect(stepTarget({ paths: ['a', 'b', 'c'] })).toBe('3 个文件')
    expect(stepTarget({ edits: [{ path: 'a' }, { path: 'b' }] })).toBe('2 处编辑')
  })

  it('truncates long targets and tolerates missing args', () => {
    expect(stepTarget(undefined)).toBe('')
    expect(stepTarget({ path: 'x'.repeat(100) }).length).toBe(56)
  })
})

describe('editLineDelta', () => {
  it('diffs edit_file arguments', () => {
    expect(editLineDelta('edit_file', { path: 'a.ts', oldText: 'one', newText: 'one\ntwo\nthree' })).toEqual({
      added: 2,
      removed: 0,
    })
  })

  it('sums multi_edit_file edits', () => {
    expect(
      editLineDelta('multi_edit_file', {
        edits: [
          { path: 'a', oldText: 'x', newText: 'x\ny' },
          { path: 'b', oldText: 'p\nq', newText: 'p' },
        ],
      }),
    ).toEqual({ added: 1, removed: 1 })
  })

  it('counts write_file content as additions', () => {
    expect(editLineDelta('write_file', { path: 'a', content: 'a\nb' })).toEqual({ added: 2, removed: 0 })
  })

  it('returns null when the arguments carry nothing derivable', () => {
    expect(editLineDelta('edit_file', {})).toBeNull()
    expect(editLineDelta('read_file', { path: 'a' })).toBeNull()
    expect(editLineDelta('write_file', undefined)).toBeNull()
  })
})

describe('deriveStepState / stepErrorLine', () => {
  it('treats missing results as running or pending', () => {
    expect(deriveStepState(undefined, true)).toBe('running')
    expect(deriveStepState(undefined, false)).toBe('pending')
    expect(deriveStepState({ toolCallId: '1' }, true)).toBe('done')
    expect(deriveStepState({ toolCallId: '1', isError: true }, false)).toBe('failed')
  })

  it('keeps only the first non-empty error line', () => {
    expect(stepErrorLine(undefined)).toBeUndefined()
    expect(stepErrorLine({ toolCallId: '1', isError: false, result: 'ok' })).toBeUndefined()
    expect(stepErrorLine({ toolCallId: '1', isError: true, result: '\n  Error: boom\nstack' })).toBe('Error: boom')
    expect(stepErrorLine({ toolCallId: '1', isError: true, result: '' })).toBe('执行失败')
  })
})

describe('deriveRunSteps', () => {
  const messages: RunMessageLike[] = [
    {
      id: 'm1',
      role: 'assistant',
      runId: 'r1',
      toolCalls: [
        call('c1', 'read_file', { path: 'src/a.ts' }),
        call('c2', 'edit_file', { path: 'src/b.ts', oldText: 'a', newText: 'a\nb' }),
      ],
    },
    {
      id: 'm2',
      role: 'assistant',
      runId: 'r1',
      toolCalls: [call('c3', 'run_command', { command: 'pnpm test' })],
      toolResults: [
        { toolCallId: 'c1', result: 'ok', durationMs: 120 },
        { toolCallId: 'c2', result: 'ok', durationMs: 1_400 },
        { toolCallId: 'c3', isError: true, result: 'Error: nope', startedAt: 1_000, finishedAt: 2_500 },
      ],
    },
  ]

  it('flattens calls across messages in execution order with derived state', () => {
    const steps = deriveRunSteps(messages, { running: false })
    expect(steps.map((s) => [s.id, s.label, s.state])).toEqual([
      ['c1', 'Read', 'done'],
      ['c2', 'Edit', 'done'],
      ['c3', 'Bash', 'failed'],
    ])
    expect(steps[1].added).toBe(1)
    expect(steps[1].removed).toBe(0)
    expect(steps[2].error).toBe('Error: nope')
  })

  it('prefers durationMs and falls back to finishedAt - startedAt', () => {
    const steps = deriveRunSteps(messages, { running: false })
    expect(steps[0].durationMs).toBe(120)
    expect(steps[2].durationMs).toBe(1500)
  })

  it('falls back to the counters a tool reported in its own result', () => {
    const steps = deriveRunSteps([
      {
        id: 'm',
        toolCalls: [
          { id: 'e1', name: 'edit_file', arguments: { path: 'a.ts' } },
          { id: 'e2', name: 'edit_file', arguments: { path: 'b.ts' } },
        ],
        toolResults: [
          { toolCallId: 'e1', result: '+142 −0' },
          { toolCallId: 'e2', result: 'File edited: b.ts (first occurrence)' },
        ],
      },
    ])
    expect(steps[0].added).toBe(142)
    expect(steps[0].removed).toBe(0)
    expect(steps[1].added).toBeUndefined()
    expect(steps[1].removed).toBeUndefined()
  })

  it('marks in-flight steps running while the session runs, pending afterwards', () => {
    const running = deriveRunSteps(messages, { running: true })
    expect(running.map((s) => s.state)).toEqual(['done', 'done', 'failed'])

    const inflight: RunMessageLike[] = [{ id: 'm', role: 'assistant', toolCalls: [call('c9', 'grep', { query: 'x' })] }]
    expect(deriveRunSteps(inflight, { running: true })[0].state).toBe('running')
    expect(deriveRunSteps(inflight, { running: false })[0].state).toBe('pending')
  })

  it('dedupes repeated call ids and ignores empty messages', () => {
    const dup: RunMessageLike[] = [
      { id: 'm', role: 'assistant', toolCalls: [call('c1', 'read_file', { path: 'a' })] },
      { id: 'm2', role: 'assistant', toolCalls: [call('c1', 'read_file', { path: 'a' })] },
    ]
    expect(deriveRunSteps(dup)).toHaveLength(1)
    expect(deriveRunSteps([])).toEqual([])
  })
})

describe('counts and progress', () => {
  it('counts each state', () => {
    const steps = deriveRunSteps(
      [
        {
          id: 'm',
          toolCalls: [call('a', 'read_file'), call('b', 'read_file'), call('c', 'read_file'), call('d', 'grep')],
          toolResults: [{ toolCallId: 'a', result: 'ok' }, { toolCallId: 'b', isError: true, result: 'x' }],
        },
      ],
      { running: false },
    )
    expect(countStepStates(steps)).toEqual({ total: 4, done: 1, failed: 1, running: 0, pending: 2 })
  })

  it('returns a small non-zero progress while running with no steps', () => {
    const empty = countStepStates([])
    expect(runProgressPercent(empty, true)).toBe(6)
    expect(runProgressPercent(empty, false)).toBe(100)
    expect(runProgressPercent({ total: 4, done: 2, failed: 0, running: 1, pending: 1 }, true)).toBe(50)
  })
})

describe('summarizeRunLine', () => {
  it('renders 已处理 N 步 · 时长 · token', () => {
    const steps = deriveRunSteps([{ id: 'm', toolCalls: [call('a', 'read_file')] }])
    expect(
      summarizeRunLine({
        run: { stepCount: 18, startedAt: 1_000, finishedAt: 103_000, tokensIn: 8_000, tokensOut: 4_000 },
        steps,
      }),
    ).toBe('已处理 18 步 · 1m42s · 12k tok')
  })

  it('omits absent fields and returns null when nothing is known', () => {
    const steps = deriveRunSteps([{ id: 'm', toolCalls: [call('a', 'read_file')] }])
    expect(summarizeRunLine({ steps })).toBe('已处理 1 步')
    expect(summarizeRunLine({ steps: [], run: { tokensOut: 512 } })).toBe('512 tok')
    expect(summarizeRunLine({ steps: [] })).toBeNull()
  })

  it('falls back to the message token count and prefers stepCount', () => {
    expect(summarizeRunLine({ steps: [], message: { tokenCount: 1_500 } })).toBe('1.5k tok')
    const steps = deriveRunSteps([{ id: 'm', toolCalls: [call('a', 'read_file'), call('b', 'read_file')] }])
    expect(summarizeRunLine({ steps, run: { stepCount: 9 } })).toBe('已处理 9 步')
  })
})

describe('run meta helpers', () => {
  it('derives duration and tokens defensively', () => {
    expect(runDurationMs(null)).toBeNull()
    expect(runDurationMs({ startedAt: 5 })).toBeNull()
    expect(runDurationMs({ startedAt: 1_000, finishedAt: 999 })).toBeNull()
    expect(runDurationMs({ startedAt: 1_000, finishedAt: 4_000 })).toBe(3_000)
    expect(runTokens({ tokensIn: 10, tokensOut: 5 })).toBe(15)
    expect(runTokens(null)).toBe(0)
  })

  it('prioritises failure over running over done', () => {
    const failedSteps = deriveRunSteps([{ id: 'm', toolCalls: [call('a', 'read_file')], toolResults: [{ toolCallId: 'a', isError: true, result: 'x' }] }])
    expect(runSummaryState({ steps: failedSteps })).toBe('failed')
    expect(runSummaryState({ steps: [], running: true })).toBe('running')
    expect(runSummaryState({ steps: [], run: { status: 'error' } })).toBe('failed')
    expect(runSummaryState({ steps: [], run: { status: 'done' } })).toBe('done')
  })
})

describe('formatting helpers', () => {
  it('formats tokens', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(512)).toBe('512')
    expect(formatTokens(1_200)).toBe('1.2k')
    expect(formatTokens(2_000)).toBe('2k')
    expect(formatTokens(3_400_000)).toBe('3.4M')
  })

  it('formats run and step durations', () => {
    expect(formatRunDuration(0)).toBe('0s')
    expect(formatRunDuration(480)).toBe('480ms')
    expect(formatRunDuration(6_000)).toBe('6s')
    expect(formatRunDuration(102_000)).toBe('1m42s')
    expect(formatStepDuration(120)).toBe('120ms')
    expect(formatStepDuration(1_400)).toBe('1.4s')
  })

  it('labels the thinking row', () => {
    expect(thinkingLabel({ streaming: true, ttftMs: 6_000 })).toBe('推理中')
    expect(thinkingLabel({ ttftMs: 6_000 })).toBe('推理 6 s')
    expect(thinkingLabel({})).toBe('推理')
  })
})

describe('message picking', () => {
  const messages: RunMessageLike[] = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant', runId: 'r1' },
    { id: 'a2', role: 'assistant', runId: 'r1' },
    { id: 't1', role: 'tool', runId: 'r1' },
    { id: 'a3', role: 'assistant', runId: 'r2' },
  ]

  it('groups messages of the same run and drops tool rows', () => {
    expect(pickRunMessages(messages, messages[1]).map((m) => m.id)).toEqual(['a1', 'a2'])
  })

  it('falls back to the anchor message when it has no run', () => {
    const legacy: RunMessageLike = { id: 'x', role: 'assistant' }
    expect(pickRunMessages(messages, legacy)).toEqual([legacy])
  })

  it('picks the current turn from the last user message', () => {
    expect(pickCurrentTurnMessages(messages).map((m) => m.id)).toEqual(['u1', 'a1', 'a2', 'a3'])
    expect(pickCurrentTurnMessages([messages[0], { id: 'u2', role: 'user' }, messages[4]]).map((m) => m.id)).toEqual([
      'u2',
      'a3',
    ])
  })
})

describe('deriveSubAgentRows', () => {
  const messages: RunMessageLike[] = [
    {
      id: 'a1',
      role: 'assistant',
      toolCalls: [
        call('sub1', 'run_subagent', { name: 'LayoutValidator', prompt: 'check widths' }),
        call('sub2', 'run_subagent', { name: 'DomInspector' }),
        call('sub3', 'read_file', { path: 'a' }),
      ],
      toolResults: [{ toolCallId: 'sub1', result: 'done', durationMs: 2_100 }],
    },
  ]

  it('renders a row only when live progress exists', () => {
    const rows = deriveSubAgentRows(messages, {
      sub1: { status: 'done', name: 'LayoutValidator', task: '检查 Flex 容器计算宽度符合 720px' },
    })
    expect(rows).toEqual([
      {
        id: 'sub1',
        name: 'LayoutValidator',
        task: '检查 Flex 容器计算宽度符合 720px',
        state: 'done',
        durationMs: 2_100,
      },
    ])
    expect(deriveSubAgentRows(messages, {})).toEqual([])
    expect(deriveSubAgentRows(messages, undefined)).toEqual([])
  })

  it('derives running duration from startedAt without inventing state', () => {
    const rows = deriveSubAgentRows(
      messages,
      { sub2: { status: 'running', startedAt: 1_000 } },
      { now: 4_500 },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('DomInspector')
    expect(rows[0].state).toBe('running')
    expect(rows[0].durationMs).toBe(3_500)
  })
})
