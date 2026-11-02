import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@/types'
import {
  buildProcessRounds,
  summarizeProcess,
  pendingToolsOf,
  describeProcessStatus,
  elapsedSinceStart,
} from '@/components/ChatPanel/processView'

function msg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    sortOrder: 0,
    contextFiles: [],
    tokenCount: 0,
    createdAt: 0,
    ...partial,
  }
}

describe('buildProcessRounds', () => {
  it('keeps the final answer out of the fold (rendered below by the caller)', () => {
    const rounds = buildProcessRounds([
      msg({ id: 'a', thinking: '先看看文件', content: '我先读一下配置。' }),
      msg({ id: 'b', thinking: '再改', content: '最终回答：改好了。' }),
    ])
    expect(rounds.map((r) => r.id)).toEqual(['a', 'b'])
    // 中间轮次正文保留 —— 折叠时仍然显示
    expect(rounds[0].prose).toBe('我先读一下配置。')
    expect(rounds[0].thinking).toBe('先看看文件')
    // 最后一条是最终回答，不在折叠块里重复渲染
    expect(rounds[1].prose).toBe('')
  })

  it('keeps a single-round message visible as text but without duplicate prose', () => {
    const rounds = buildProcessRounds([msg({ id: 'only', thinking: 'think', content: 'answer' })])
    expect(rounds).toHaveLength(1)
    expect(rounds[0].prose).toBe('')
  })

  it('drops rounds with no thinking, no prose and no tool calls', () => {
    const rounds = buildProcessRounds([
      msg({ id: 'empty', content: '   ' }),
      msg({ id: 'tool', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }] }),
      msg({ id: 'final', content: 'done' }),
    ])
    // 最后一条是最终回答（正文在折叠块外），没有思考/工具就不进块内
    expect(rounds.map((r) => r.id)).toEqual(['tool'])
    expect(rounds[0].toolCalls).toHaveLength(1)
  })
})

describe('summarizeProcess', () => {
  it('counts rounds with visible content and every tool call', () => {
    const rounds = buildProcessRounds([
      msg({ id: 'a', thinking: 'x', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }] }),
      msg({ id: 'b', content: '中间说明' }),
      msg({ id: 'c', content: '最终' }),
    ])
    expect(summarizeProcess(rounds)).toEqual({ rounds: 2, tools: 1 })
  })

  it('returns zeros for an empty turn', () => {
    expect(summarizeProcess([])).toEqual({ rounds: 0, tools: 0 })
  })
})

describe('pendingToolsOf', () => {
  it('returns tool calls of the latest assistant message that have no result yet', () => {
    const pending = pendingToolsOf([
      msg({ id: 'user', role: 'user', content: 'hi' }),
      msg({
        id: 'a',
        toolCalls: [
          { id: 't1', name: 'read_file', arguments: {}, startedAt: 1000 },
          { id: 't2', name: 'search_in_files', arguments: {}, startedAt: 1500 },
        ],
        toolResults: [{ toolCallId: 't1', name: 'read_file', result: 'ok' }],
      }),
    ])
    expect(pending).toEqual([{ name: 'search_in_files', startedAt: 1500 }])
  })

  it('reports nothing while the model is writing (all calls resolved)', () => {
    const pending = pendingToolsOf([
      msg({
        id: 'a',
        toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }],
        toolResults: [{ toolCallId: 't1', name: 'read_file', result: 'ok' }],
      }),
    ])
    expect(pending).toEqual([])
  })

  it('ignores non-assistant messages', () => {
    expect(pendingToolsOf([msg({ id: 'u', role: 'user', content: 'hi' })])).toEqual([])
  })
})

describe('describeProcessStatus', () => {
  const summary = { rounds: 3, tools: 2 }

  it('names the running tool while one call is in flight', () => {
    expect(
      describeProcessStatus({ running: true, pendingTools: [{ name: 'run_command' }], summary }),
    ).toEqual({ key: 'chat.processStatusTool', vars: { name: 'run_command' } })
  })

  it('counts parallel calls', () => {
    expect(
      describeProcessStatus({ running: true, pendingTools: [{ name: 'a' }, { name: 'b' }], summary }),
    ).toEqual({ key: 'chat.processStatusTools', vars: { count: 2 } })
  })

  it('falls back to the run phase when nothing is executing', () => {
    expect(describeProcessStatus({ running: true, phase: 'waiting', pendingTools: [], summary })).toEqual({
      key: 'chat.processStatusWaiting',
    })
    expect(describeProcessStatus({ running: true, phase: 'preparing', pendingTools: [], summary })).toEqual({
      key: 'chat.processStatusPreparing',
    })
    expect(describeProcessStatus({ running: true, phase: 'compacting', pendingTools: [], summary })).toEqual({
      key: 'chat.processStatusCompacting',
    })
    expect(describeProcessStatus({ running: true, phase: 'streaming', pendingTools: [], summary })).toEqual({
      key: 'chat.processStatusThinking',
    })
  })

  it('summarises a settled turn and stays silent when there is no process', () => {
    expect(describeProcessStatus({ running: false, pendingTools: [], summary })).toEqual({
      key: 'chat.processSummary',
      vars: { rounds: 3, tools: 2 },
    })
    expect(
      describeProcessStatus({ running: false, pendingTools: [], summary: { rounds: 0, tools: 0 } }),
    ).toBeNull()
  })
})

describe('elapsedSinceStart', () => {
  it('measures from the earliest startedAt', () => {
    expect(elapsedSinceStart([{ name: 'a', startedAt: 1_000 }, { name: 'b', startedAt: 4_000 }], 9_500)).toBe(8)
  })

  it('returns 0 without timestamps and never goes negative', () => {
    expect(elapsedSinceStart([{ name: 'a' }], 9_500)).toBe(0)
    expect(elapsedSinceStart([{ name: 'a', startedAt: 9_000 }], 1_000)).toBe(0)
    expect(elapsedSinceStart([], 9_500)).toBe(0)
  })
})
