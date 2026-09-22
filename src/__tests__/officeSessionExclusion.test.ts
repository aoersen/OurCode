import { describe, it, expect, vi, beforeEach } from 'vitest'

// Monaco's browser modules reference `window` at import time (same stub as
// chatStore.test.ts).
vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))

// IS_OFFICE 在 chatStore 模块加载时求值——vi.stubGlobal 不 hoist、晚于 import，
// 必须用 vi.mock（会提升）直接钉死 windowMode 模块：办公室窗口语义 =
// createSession 新建的会话默认 targetMode=true，且走「同项目正在运行的目标
// 模式会话」排他分支。
vi.mock('@/utils/windowMode', () => ({
  IS_OFFICE: true,
  WINDOW_MODE: 'office',
  modeKey: (base: string) => base,
}))

const mockApi = {
  getSessions: vi.fn(async () => []),
  saveSession: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => {}),
  checkpointList: vi.fn(async () => []),
  checkpointListReverted: vi.fn(async () => []),
  checkpointSave: vi.fn(async () => {}),
  checkpointDelete: vi.fn(async () => {}),
  spillDeleteSession: vi.fn(async () => {}),
  wireLogDeleteSession: vi.fn(async () => {}),
  saveConfigGroup: vi.fn(async () => ({})),
  getConfigGroups: vi.fn(async () => []),
}
vi.stubGlobal('window', { electronAPI: mockApi })

import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'

const initialState = useChatStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.setState({
    ...initialState,
    sessions: [],
    activeSessionId: null,
    runningSessionIds: [],
  })
  useUIStore.setState({ notifications: [] })
})

/**
 * 一人公司「新建任务」排他语义回归测试。
 *
 * 用户主诉：没在跑任务时点「新建任务对话」，却提示「该项目已有公司在运营」。
 * 根因：createSession 的排他判定是「同项目存在目标模式会话」（会话存在 ≠ 在
 * 运营），未运行的历史会话也会占位拦截。修复后：只拦「正在运行」的会话，
 * 未运行的旧会话不占位，新建任务 = 干净新会话（防双跑下沉到 runAgentLoop
 * 启动检查）。
 */
describe('createSession 一人公司排他（IS_OFFICE）', () => {
  it('同项目只有未运行的历史目标模式会话时，新建任务正常创建（不拦截不提示）', () => {
    const oldId = useChatStore.getState().createSession('cfg-1', '/proj/a')
    // 旧会话未在运行（runningSessionIds 为空）——用户主诉场景
    const newId = useChatStore.getState().createSession('cfg-1', '/proj/a')

    expect(newId).not.toBe(oldId)
    const state = useChatStore.getState()
    expect(state.sessions.filter((s) => s.projectPath === '/proj/a')).toHaveLength(2)
    expect(state.activeSessionId).toBe(newId)
    // 未拦截 → 不应出现「已为你切换」的通知
    expect(useUIStore.getState().notifications).toHaveLength(0)
  })

  it('同项目有目标模式会话正在运行时，新建任务切回该会话（防双跑）', () => {
    const oldId = useChatStore.getState().createSession('cfg-1', '/proj/a')
    useChatStore.setState((s) => ({ runningSessionIds: [...s.runningSessionIds, oldId] }))

    const returned = useChatStore.getState().createSession('cfg-1', '/proj/a')

    const state = useChatStore.getState()
    expect(returned).toBe(oldId)
    expect(state.activeSessionId).toBe(oldId)
    // 未新建会话：项目下仍只有一个目标模式会话
    expect(state.sessions.filter((s) => s.projectPath === '/proj/a')).toHaveLength(1)
    // 拦截成功 → 提示已切换（文案：任务正在运行）
    const note = useUIStore.getState().notifications[0]
    expect(note?.message).toContain('正在运行')
  })

  it('不同项目互不干扰：未运行会话的项目各自新建', () => {
    useChatStore.getState().createSession('cfg-1', '/proj/a')
    const b = useChatStore.getState().createSession('cfg-1', '/proj/b')

    const state = useChatStore.getState()
    expect(state.activeSessionId).toBe(b)
    expect(state.sessions.filter((s) => s.projectPath === '/proj/a')).toHaveLength(1)
    expect(state.sessions.filter((s) => s.projectPath === '/proj/b')).toHaveLength(1)
  })
})
