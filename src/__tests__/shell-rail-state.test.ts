import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@shared/types'
import {
  SESSION_STATE_LABEL,
  buildRailGroups,
  countStates,
  deriveSessionState,
  matchesStateFilter,
  sessionStateOf,
} from '@/shell/agent/rail/railModel'

const session = (over: Partial<ChatSession> & { id: string }): ChatSession =>
  ({
    title: over.id,
    configGroupId: 'cfg',
    model: 'm',
    modelParams: {
      temperature: 0,
      maxTokens: 0,
      topP: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      thinking: false,
      reasoningEffort: 'medium',
    },
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    projectPath: 'C:\\ws',
    ...over,
  }) as ChatSession

const run = (status: string) =>
  ({ id: `run-${status}`, task: 't', status, startedAt: 0, toolCallCount: 0, fileChangeCount: 0, stepCount: 0 }) as never

describe('railModel · 会话状态', () => {
  it('优先级：进行中 > 待处理 > 异常 > 结束 > 未开始', () => {
    expect(
      deriveSessionState({ running: true, blocked: true, lastRunStatus: 'error' }),
    ).toBe('running')
    expect(
      deriveSessionState({ running: false, blocked: true, lastRunStatus: 'error' }),
    ).toBe('waiting')
    expect(
      deriveSessionState({ running: false, blocked: false, lastRunStatus: 'error' }),
    ).toBe('error')
    expect(
      deriveSessionState({ running: false, blocked: false, lastRunStatus: 'done' }),
    ).toBe('done')
    expect(deriveSessionState({ running: false, blocked: false })).toBe('idle')
  })

  it('计划待批准算「待处理」，中断算「结束」', () => {
    expect(
      deriveSessionState({ running: false, blocked: false, lastRunStatus: 'waiting_plan' }),
    ).toBe('waiting')
    expect(
      deriveSessionState({ running: false, blocked: false, lastRunStatus: 'stopped' }),
    ).toBe('done')
  })

  it('最后一条回复带错误 → 异常；只有回复没运行记录 → 结束', () => {
    const withError = session({
      id: 'e1',
      messages: [
        { id: 'm1', role: 'user', content: 'hi' } as never,
        { id: 'm2', role: 'assistant', content: 'boom', error: { message: 'x' } } as never,
      ],
    })
    expect(sessionStateOf(withError, false, false)).toBe('error')

    const answered = session({
      id: 'e2',
      messages: [
        { id: 'm1', role: 'user', content: 'hi' } as never,
        { id: 'm2', role: 'assistant', content: 'ok' } as never,
      ],
    })
    expect(sessionStateOf(answered, false, false)).toBe('done')

    expect(sessionStateOf(session({ id: 'e3' }), false, false)).toBe('idle')
    expect(sessionStateOf(session({ id: 'e4', agentRuns: [run('running')] }), true, false)).toBe(
      'running',
    )
  })

  it('状态文案齐全（行内 title / 读屏用）', () => {
    expect(SESSION_STATE_LABEL.running).toBe('进行中')
    expect(SESSION_STATE_LABEL.waiting).toBe('待处理')
    expect(SESSION_STATE_LABEL.error).toBe('异常')
    expect(SESSION_STATE_LABEL.done).toBe('结束')
    expect(SESSION_STATE_LABEL.idle).toBe('')
  })
})

describe('railModel · 状态筛选与项目摘要', () => {
  const sessions = [
    session({ id: 'running', updatedAt: 5, agentRuns: [run('running')] }),
    session({ id: 'failed', updatedAt: 4, messages: [{ id: 'm', role: 'assistant', content: 'x', error: { message: 'e' } } as never] }),
    session({ id: 'done', updatedAt: 3, messages: [{ id: 'm', role: 'assistant', content: 'ok' } as never] }),
    session({
      id: 'blocked',
      updatedAt: 2,
      projectPath: 'C:\\other',
      messages: [{ id: 'm', role: 'assistant', content: 'ok' } as never],
    }),
  ]

  const input = {
    sessions,
    activeSessionId: null,
    runningSessionIds: ['running'],
    attentionIds: new Set(['blocked']),
    recentProjects: ['C:\\ws', 'C:\\other'],
  }

  it('每行带上状态，项目行带全量摘要', () => {
    const groups = buildRailGroups(input)
    const ws = groups.find((group) => group.key === 'C:\\ws')!
    expect(ws.sessions.find((row) => row.id === 'failed')?.state).toBe('error')
    expect(ws.states).toMatchObject({ running: 1, error: 1, done: 1 })
    expect(groups.find((group) => group.key === 'C:\\other')!.states.waiting).toBe(1)
  })

  it('筛选只裁对话行，项目摘要不被反噬', () => {
    const errorsOnly = buildRailGroups({ ...input, stateFilter: 'error' })
    expect(errorsOnly).toHaveLength(1)
    expect(errorsOnly[0].sessions.map((row) => row.id)).toEqual(['failed'])
    // 摘要仍是全量（否则「这个项目有 1 个异常」在筛选后反而会消失）
    expect(errorsOnly[0].states.done).toBe(1)

    expect(buildRailGroups({ ...input, stateFilter: 'active' })).toHaveLength(2)
    expect(buildRailGroups({ ...input, stateFilter: 'done' })[0].sessions.map((r) => r.id)).toEqual(['done'])
  })

  it('matchesStateFilter / countStates 与筛选一致', () => {
    expect(matchesStateFilter('running', 'active')).toBe(true)
    expect(matchesStateFilter('waiting', 'active')).toBe(true)
    expect(matchesStateFilter('done', 'active')).toBe(false)
    expect(matchesStateFilter('error', 'all')).toBe(true)

    expect(countStates([{ state: 'running' }, { state: 'done' }, { state: 'done' }])).toEqual({
      running: 1,
      waiting: 0,
      error: 0,
      done: 2,
      idle: 0,
    })
  })
})
