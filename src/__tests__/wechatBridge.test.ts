import { describe, it, expect, beforeEach, vi } from 'vitest'

// Monaco's browser modules reference `window` at import time, which the Node
// test env can't provide — replace the singleton with an empty stub (same
// pattern as chatStore.test.ts). The bridge never touches monaco directly.
vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))

import { answerPendingDecision, nextSendChunk, ensureSession, resolveWechatConfig, formatOfficeSnapshotText, repairSession } from '@/services/wechat/wechatBridge'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { useWechatStore } from '@/stores/wechatStore'
import type { ApiConfigGroup, WechatAgentState, WechatGatewayEvent } from '@/types'

type GatewayListener = (ev: WechatGatewayEvent) => void

const sentTexts: Array<{ to: string; text: string }> = []

const AGENT_STATE: WechatAgentState = {
  sandboxPath: 'C:\\sandbox',
  currentWorkspace: null,
  approvalMode: 'approve',
  configGroupId: '',
  modelId: null,
  memory: [],
  updatedAt: 0,
}

const electronApi = {
  wechatSendText: vi.fn(async (to: string, text: string) => {
    sentTexts.push({ to, text })
    return { event: 'sent' as const, ok: true }
  }),
  saveSession: vi.fn(async () => true),
  onWechatEvent: vi.fn((_cb: GatewayListener) => () => {}),
  getWechatStatus: vi.fn(async () => ({ state: 'idle' as const })),
  openProject: vi.fn(async () => {}),
  getWechatAgentState: vi.fn(async () => AGENT_STATE),
  saveWechatAgentState: vi.fn(async () => ({ ok: true })),
  wechatGrantWorkspace: vi.fn(async () => ({ ok: true })),
  wechatUpdateSessionMode: vi.fn(async () => ({ ok: true })),
  authorize: vi.fn(async () => true),
  getSessions: vi.fn(async () => []),
  getOfficeSnapshot: vi.fn(async () => null),
  sendOfficeInstruction: vi.fn(async () => ({ instructionId: 'i1', ok: false, status: 'failed', message: '未打开' })),
}

vi.stubGlobal('window', { electronAPI: electronApi })

const initialState = useChatStore.getState()

beforeEach(() => {
  useChatStore.setState(initialState)
  useWechatStore.setState({ agentState: AGENT_STATE })
  sentTexts.length = 0
  vi.clearAllMocks()
})

/** 建一个微信会话（mode='wechat'），决策走后台队列而非 UI 槽位。 */
function makeWechatSession(): string {
  return useChatStore.getState().createSession('g-test', 'C:\\sandbox', { mode: 'wechat' })
}

function offer(kind: 'approval' | 'question' | 'batch' | 'scope', sessionId: string): void {
  const base = { sessionId, toolCall: { id: 't1', name: 'write_file', arguments: {} }, preview: '写文件 test.txt' }
  const value: Record<string, unknown> = { ...base }
  if (kind === 'question') {
    Object.assign(value, { id: 'q1', question: '选哪个方案？', options: ['方案甲', '方案乙'] })
  }
  if (kind === 'batch') {
    Object.assign(value, { runId: 'r1', tools: [base.toolCall, { id: 't2', name: 'read_file', arguments: {} }], previews: ['a', 'b'] })
  }
  if (kind === 'scope') {
    Object.assign(value, { paths: ['a.txt'] })
  }
  useChatStore.getState().offerDecision({ kind, sessionId, value } as never)
}

describe('wechatBridge 决策应答（后台队列）', () => {
  it('批准/拒绝单个工具审批（微信决策不进入 UI 槽位）', () => {
    const sessionId = makeWechatSession()
    offer('approval', sessionId)

    expect(useChatStore.getState().wechatDecisions.approval?.sessionId).toBe(sessionId)
    expect(useChatStore.getState().pendingApproval).toBeNull() // 不占 IDE 槽位

    expect(answerPendingDecision(sessionId, 'contact-1', '批准')).toBe(true)
    expect(useChatStore.getState().wechatDecisions.approval).toBeNull()
    expect(sentTexts.at(-1)?.text).toBe('已批准 ✅')
    expect(sentTexts.at(-1)?.to).toBe('contact-1')

    offer('approval', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '拒绝')).toBe(true)
    expect(useChatStore.getState().wechatDecisions.approval).toBeNull()
    expect(sentTexts.at(-1)?.text).toBe('已拒绝')
  })

  it('审批等待期间的非答案消息被消费并给出指引，不清空队列', () => {
    const sessionId = makeWechatSession()
    offer('approval', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '随便说点什么')).toBe(true)
    expect(useChatStore.getState().wechatDecisions.approval).not.toBeNull()
    expect(sentTexts.at(-1)?.text).toContain('批准')
  })

  it('提问按编号映射到选项', () => {
    const sessionId = makeWechatSession()
    offer('question', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '2')).toBe(true)
    expect(useChatStore.getState().wechatDecisions.question).toBeNull()
    expect(sentTexts.at(-1)?.text).toContain('方案乙')
  })

  it('批量审批：全部 / 批准 / 拒绝', () => {
    const sessionId = makeWechatSession()
    offer('batch', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '全部')).toBe(true)
    expect(useChatStore.getState().wechatDecisions.batch).toBeNull()

    offer('batch', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '拒绝')).toBe(true)
    expect(useChatStore.getState().wechatDecisions.batch).toBeNull()
  })

  it('作用域决策：加入计划', () => {
    const sessionId = makeWechatSession()
    offer('scope', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '加入计划')).toBe(true)
    expect(useChatStore.getState().wechatDecisions.scope).toBeNull()
    expect(sentTexts.at(-1)?.text).toBe('已加入计划 ✅')
  })

  it('计划待批准时非答案消息被消费并给出指引（不触发执行）', () => {
    const sessionId = makeWechatSession()
    useChatStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId ? { ...x, planStatus: 'pending_approval' as const, planContent: '做一个项目' } : x,
      ),
    }))
    expect(answerPendingDecision(sessionId, 'contact-1', '先等等')).toBe(true)
    expect(useChatStore.getState().sessions.find((x) => x.id === sessionId)?.planStatus).toBe('pending_approval')
    expect(sentTexts.at(-1)?.text).toContain('批准计划')
  })

  it('无待决决策时返回 false（消息继续作为新消息处理）', () => {
    const sessionId = makeWechatSession()
    expect(answerPendingDecision(sessionId, 'contact-1', '你好')).toBe(false)
    expect(sentTexts).toHaveLength(0)
  })
})

describe('wechatBridge 会话映射', () => {
  function makeGroup(id: string, defaultModel: string): ApiConfigGroup {
    return {
      id,
      name: `组${id}`,
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      systemPrompt: '',
      defaultModel,
      provider: 'custom',
      customHeaders: {},
      createdAt: 0,
      updatedAt: 0,
    }
  }

  it('ensureSession 创建 mode=wechat 的会话，工作区取自 AgentState（沙盒）', () => {
    useConfigStore.setState({ configGroups: [makeGroup('g1', 'model-a')], activeConfigGroupId: 'g1' })
    const sessionId = ensureSession('contact-map-1')
    const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.mode).toBe('wechat')
    expect(session?.projectPath).toBe('C:\\sandbox')
    expect(session?.projectEditMode).toBe('confirm_before_change') // approve 模式
  })

  it('ensureSession 使用 AgentState 里的组与模型，并自动修复空配置组的旧会话', () => {
    useConfigStore.setState({
      configGroups: [makeGroup('g1', 'model-a'), makeGroup('g2', 'model-b')],
      activeConfigGroupId: 'g2',
    })
    useWechatStore.setState({ agentState: { ...AGENT_STATE, configGroupId: 'g1', modelId: 'model-x' } })

    const sessionId = ensureSession('contact-map-2')
    const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.configGroupId).toBe('g1')
    expect(session?.model).toBe('model-x')

    // 模拟早期竞态产物（空配置组会话）：下次入站时被自动修复
    useChatStore.setState((prev) => ({
      sessions: prev.sessions.map((x) => (x.id === sessionId ? { ...x, configGroupId: '' } : x)),
    }))
    expect(ensureSession('contact-map-2')).toBe(sessionId)
    expect(useChatStore.getState().sessions.find((s) => s.id === sessionId)?.configGroupId).toBe('g1')
  })

  it('resolveWechatConfig 未显式选择时回退到当前组，再到第一个组', () => {
    useConfigStore.setState({
      configGroups: [makeGroup('g1', 'm1'), makeGroup('g2', 'm2')],
      activeConfigGroupId: 'g2',
    })
    useEditorStore.getState().updatePreferences({ wechatConfigGroupId: '', wechatModelId: '' })
    expect(resolveWechatConfig().configGroupId).toBe('g2')

    useConfigStore.setState({ activeConfigGroupId: null })
    expect(resolveWechatConfig().configGroupId).toBe('g1')
  })

  it('resolveWechatConfig AgentState 显式选择的组优先于偏好与当前组', () => {
    useConfigStore.setState({
      configGroups: [makeGroup('g1', 'm1'), makeGroup('g2', 'm2')],
      activeConfigGroupId: 'g2',
    })
    useWechatStore.setState({ agentState: { ...AGENT_STATE, configGroupId: 'g1', modelId: 'm1' } })
    const resolved = resolveWechatConfig()
    expect(resolved.configGroupId).toBe('g1')
    expect(resolved.modelId).toBe('m1')
  })

  it('repairSession 随 AgentState 换组并连带换模型（防旧组密钥绑新模型 400/401）', () => {
    useConfigStore.setState({
      configGroups: [makeGroup('g1', 'm1'), makeGroup('g2', 'm2')],
      activeConfigGroupId: 'g1',
    })
    useWechatStore.setState({ agentState: { ...AGENT_STATE, configGroupId: '', modelId: null } })
    const sessionId = ensureSession('contact-rebind')
    const before = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    expect(before?.configGroupId).toBe('g1')

    // 对话里切到 g2 组的模型：repairSession 必须连带换组，不能只换模型
    useWechatStore.setState({ agentState: { ...AGENT_STATE, configGroupId: 'g2', modelId: 'm2' } })
    repairSession(sessionId)
    const after = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    expect(after?.configGroupId).toBe('g2')
    expect(after?.model).toBe('m2')
  })

  it('resolveWechatConfig 显式组被删除时回退当前组并忽略旧模型偏好', () => {
    useConfigStore.setState({
      configGroups: [makeGroup('g1', 'm1'), makeGroup('g2', 'm2')],
      activeConfigGroupId: 'g2',
    })
    useEditorStore.getState().updatePreferences({ wechatConfigGroupId: 'g-deleted', wechatModelId: 'stale-model' })
    const resolved = resolveWechatConfig()
    expect(resolved.configGroupId).toBe('g2')
    expect(resolved.modelId).toBeNull()
  })
})

describe('wechatBridge 办公室快照格式化', () => {
  it('办公室未启动时给出明确提示', () => {
    expect(formatOfficeSnapshotText(null)).toContain('办公室未启动')
  })

  it('格式化公司/员工/活动', () => {
    const text = formatOfficeSnapshotText({
      companies: [
        { sessionId: 's1', title: '部署任务', projectPath: 'C:/proj', running: true, phase: 'streaming' },
      ],
      workers: [{ sessionId: 'w1', role: '研发', slot: 4, running: false, task: '待命中' }],
      recentActivity: [{ label: '研发', task: '实现登录', status: 'running', startedAt: 1 }],
      updatedAt: 0,
    })
    expect(text).toContain('部署任务')
    expect(text).toContain('运行中')
    expect(text).toContain('研发')
  })
})

describe('wechatBridge 分片发送', () => {
  it('流式节流：剩余不足 400 不发；达到后按 1700 分片', () => {
    const acc = 'x'.repeat(2000)
    expect(nextSendChunk(acc, 1601, false)).toBeNull() // 剩 399
    expect(nextSendChunk(acc, 1600, false)).toBe('x'.repeat(400))
    expect(nextSendChunk(acc, 0, false)).toBe('x'.repeat(2000)) // 上限已对齐官方 4000
    expect(nextSendChunk(acc, 1700, false)).toBeNull() // 剩 300 < 400
  })

  it('完成阶段强制发送剩余内容', () => {
    const acc = 'hello'
    expect(nextSendChunk(acc, 0, true)).toBe('hello')
    expect(nextSendChunk(acc, 5, true)).toBeNull()
  })

  it('超长内容按官方上限 4000 分片', () => {
    const acc = 'x'.repeat(5000)
    expect(nextSendChunk(acc, 0, true)).toBe('x'.repeat(4000))
    expect(nextSendChunk(acc, 4000, true)).toBe('x'.repeat(1000))
  })

})
