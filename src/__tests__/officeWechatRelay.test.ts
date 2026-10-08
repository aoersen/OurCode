import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))

import { buildOfficeSnapshot } from '@/services/office/wechatRelay'
import { useChatStore } from '@/stores/chatStore'

vi.stubGlobal('window', {
  electronAPI: {
    pushOfficeStatus: vi.fn(),
    replyOfficeWechatInstruction: vi.fn(),
    onOfficeWechatInstruction: vi.fn(() => () => {}),
  },
})

const initialState = useChatStore.getState()

beforeEach(() => {
  useChatStore.setState(initialState)
})

describe('officeWechatRelay 快照', () => {
  it('公司/员工/近期活动进入快照，运行相位与员工状态正确', () => {
    const companyId = useChatStore.getState().createSession('g', 'C:\\proj', { mode: 'office' })
    useChatStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === companyId ? { ...x, title: '部署任务', workerRole: undefined, workerSlot: undefined } : x,
      ),
      runningSessionIds: [companyId],
      runPhaseBySession: { [companyId]: { phase: 'streaming' as never, since: Date.now() } },
      subagentProgress: {
        key1: {
          status: 'running',
          sessionId: companyId,
          name: '研发',
          task: '实现登录接口',
          startedAt: 100,
          thinking: '',
          steps: [],
        },
      },
    }))

    const snap = buildOfficeSnapshot()
    expect(snap.companies).toHaveLength(1)
    expect(snap.companies[0].title).toBe('部署任务')
    expect(snap.companies[0].running).toBe(true)
    expect(snap.companies[0].phase).toBe('streaming')
    expect(snap.recentActivity[0].status).toBe('running')
    expect(snap.recentActivity[0].label).toBe('研发')
  })

  it('员工会话映射为工位快照（运行中 = 工作中）', () => {
    const companyId = useChatStore.getState().createSession('g', 'C:\\proj', { mode: 'office' })
    const workerId = useChatStore.getState().createSession('g', 'C:\\proj', { mode: 'office' })
    useChatStore.setState((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id === workerId) return { ...x, workerRole: 'tm-developer', workerSlot: 4, messages: [{ id: 'm1', role: 'user' as const, content: '写个页面', createdAt: 0 }] }
        if (x.id === companyId) return { ...x, workerRole: undefined, workerSlot: undefined, hidden: true }
        return x
      }),
      runningSessionIds: [workerId],
    }))

    const snap = buildOfficeSnapshot()
    expect(snap.companies).toHaveLength(0) // hidden 的会话不算公司
    expect(snap.workers).toHaveLength(1)
    expect(snap.workers[0].role).toBe('tm-developer')
    expect(snap.workers[0].running).toBe(true)
    expect(snap.workers[0].task).toContain('写个页面')
  })
})
