import { describe, it, expect, beforeEach, vi } from 'vitest'

// Monaco 的浏览器模块在 import 期就摸 window，Node 环境下必须换成空壳。
// vi.mock 会被 vitest 提升到 import 之前执行。
vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))

// store 的持久化动作走 window.electronAPI —— 这里给最小可用桩。
const mockApi = {
  getSessions: vi.fn(async () => []),
  saveSession: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => {}),
  openProject: vi.fn(async () => true),
  getSubagentRuns: vi.fn(async () => []),
  saveConfigGroup: vi.fn(async () => ({})),
  getConfigGroups: vi.fn(async () => []),
}
vi.stubGlobal('window', { electronAPI: mockApi })

import {
  useChatStore,
  normalizeTodos,
  promoteNextTodo,
  buildTodoNudge,
  TODO_NUDGE_ROUNDS,
} from '@/stores/chatStore'
import type { TodoItem } from '@/types'

const initialState = useChatStore.getState()

/** 造一个最小会话（与 chatStore.test.ts 的 makeSession 同思路）。 */
function makeSession(id = 's1') {
  useChatStore.getState().createSession('cfg-1')
  const created = useChatStore.getState().sessions[0]
  useChatStore.setState((st) => ({
    activeSessionId: id,
    sessions: st.sessions.map((x) => (x.id === created.id ? { ...x, id } : x)),
  }))
  return id
}

const todo = (content: string, status: TodoItem['status']): TodoItem => ({
  id: content,
  content,
  status,
  order: 0,
})

describe('normalizeTodos 状态归一（进度不再被吞）', () => {
  it('接受模型常见的状态别名，不再把完成降级成 pending', () => {
    const todos = normalizeTodos([
      { content: 'a', status: 'done' },
      { content: 'b', status: 'DONE' },
      { content: 'c', status: '已完成' },
      { content: 'd', status: 'in-progress' },
      { content: 'e', status: '进行中' },
      { content: 'f', status: 'success' },
    ])
    expect(todos.map((t) => t.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'in_progress',
      'pending', // 第二条 in_progress 会被降级（至多一条进行中），但不会变成完成
      'completed',
    ])
  })

  it('中文/大写/连字符写法都收敛到枚举', () => {
    expect(normalizeTodos([{ content: 'a', status: '  In Progress ' }])[0].status).toBe('in_progress')
    expect(normalizeTodos([{ content: 'a', status: '待办' }])[0].status).toBe('pending')
    expect(normalizeTodos([{ content: 'a', status: '失败' }])[0].status).toBe('failed')
  })

  it('无法识别的写法仍降级为 pending，不误报完成', () => {
    const todos = normalizeTodos([{ content: 'a', status: 'bogus' }])
    expect(todos[0].status).toBe('pending')
  })

  it('去掉首尾空白与空条目，order 保持稠密', () => {
    const todos = normalizeTodos([
      { content: '  写代码 ', status: 'pending' },
      { content: '   ', status: 'pending' },
      { content: '跑测试', status: 'completed' },
    ])
    expect(todos.map((t) => t.content)).toEqual(['写代码', '跑测试'])
    expect(todos.map((t) => t.order)).toEqual([0, 1])
  })
})

describe('promoteNextTodo 自动推进', () => {
  it('完成一条后没有进行中项 → 下一条 pending 自动成为进行中', () => {
    const next = promoteNextTodo([
      todo('a', 'completed'),
      todo('b', 'pending'),
      todo('c', 'pending'),
    ])
    expect(next.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('已有进行中项时不改动（模型自己维护的优先）', () => {
    const input = [todo('a', 'completed'), todo('b', 'in_progress'), todo('c', 'pending')]
    expect(promoteNextTodo(input)).toBe(input)
  })

  it('一条都没完成时不臆造「开始某一条」', () => {
    const input = [todo('a', 'pending'), todo('b', 'pending')]
    expect(promoteNextTodo(input)).toBe(input)
  })

  it('全部完成 / 没有 pending 时是恒等变换', () => {
    const allDone = [todo('a', 'completed'), todo('b', 'completed')]
    expect(promoteNextTodo(allDone)).toBe(allDone)
    const doneWithFailures = [todo('a', 'completed'), todo('b', 'failed')]
    expect(promoteNextTodo(doneWithFailures)).toBe(doneWithFailures)
  })
})

describe('buildTodoNudge 催更提醒', () => {
  it('点名 manage_todo 与状态字段，模型才知道下一步怎么补', () => {
    const text = buildTodoNudge(TODO_NUDGE_ROUNDS)
    expect(text).toContain('manage_todo')
    expect(text).toContain('completed')
    expect(text).toContain('in_progress')
    expect(text).toContain(String(TODO_NUDGE_ROUNDS))
  })
})

describe('setTodos 触发订阅方重渲染（左上角进度）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
      undoStack: [],
      queuedMessagesBySession: {},
    })
  })

  it('写入完成状态后，session 对象换新（Object.is 不再相等 → 面板重渲染）', () => {
    const id = makeSession('s1')
    useChatStore.getState().setTodos(id, normalizeTodos([{ content: 'a', status: 'in_progress' }]))
    const before = useChatStore.getState().sessions.find((s) => s.id === id)!

    let notified = 0
    const unsubscribe = useChatStore.subscribe(() => { notified += 1 })

    useChatStore.getState().setTodos(id, normalizeTodos([
      { id: 'a', content: 'a', status: 'completed' },
      { id: 'b', content: 'b', status: 'in_progress' },
    ]))

    const after = useChatStore.getState().sessions.find((s) => s.id === id)!
    unsubscribe()

    expect(notified).toBeGreaterThan(0)
    expect(Object.is(before, after)).toBe(false)
    expect(before.todos?.filter((t) => t.status === 'completed').length).toBe(0)
    expect(after.todos?.filter((t) => t.status === 'completed').length).toBe(1)
    expect(after.todos?.length).toBe(2)
  })

  it('不存在的会话不产生新状态（避免无意义重渲染）', () => {
    makeSession('s1')
    const before = useChatStore.getState().sessions
    useChatStore.getState().setTodos('missing', normalizeTodos([{ content: 'a', status: 'completed' }]))
    const after = useChatStore.getState().sessions
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id))
    expect(after[0].todos).toEqual([])
  })
})
