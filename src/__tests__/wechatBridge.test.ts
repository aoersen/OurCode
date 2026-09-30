import { describe, it, expect, beforeEach, vi } from 'vitest'

// Monaco's browser modules reference `window` at import time, which the Node
// test env can't provide — replace the singleton with an empty stub (same
// pattern as chatStore.test.ts). The bridge never touches monaco directly.
vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))

import { answerPendingDecision, nextSendChunk } from '@/services/wechat/wechatBridge'
import { useChatStore } from '@/stores/chatStore'
import type { WechatGatewayEvent } from '@/types'

type GatewayListener = (ev: WechatGatewayEvent) => void

const sentTexts: Array<{ to: string; text: string }> = []

const electronApi = {
  wechatSendText: vi.fn(async (to: string, text: string) => {
    sentTexts.push({ to, text })
    return { event: 'sent' as const, ok: true }
  }),
  saveSession: vi.fn(async () => true),
  onWechatEvent: vi.fn((_cb: GatewayListener) => () => {}),
  getWechatStatus: vi.fn(async () => ({ state: 'idle' as const })),
  openProject: vi.fn(async () => {}),
}

vi.stubGlobal('window', { electronAPI: electronApi })

const initialState = useChatStore.getState()

/** 建一个活动会话（微信会话的替身），供决策槽测试使用。 */
function makeActiveSession(): string {
  const sessionId = useChatStore.getState().createSession('', '')
  useChatStore.getState().setActiveSession(sessionId)
  return sessionId
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

beforeEach(() => {
  useChatStore.setState(initialState)
  sentTexts.length = 0
  vi.clearAllMocks()
})

describe('wechatBridge 决策应答', () => {
  it('批准/拒绝单个工具审批', () => {
    const sessionId = makeActiveSession()
    offer('approval', sessionId)

    expect(answerPendingDecision(sessionId, 'contact-1', '批准')).toBe(true)
    expect(useChatStore.getState().pendingApproval).toBeNull()
    expect(sentTexts.at(-1)?.text).toBe('已批准 ✅')
    expect(sentTexts.at(-1)?.to).toBe('contact-1')

    offer('approval', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '拒绝')).toBe(true)
    expect(useChatStore.getState().pendingApproval).toBeNull()
    expect(sentTexts.at(-1)?.text).toBe('已拒绝')
  })

  it('审批等待期间的非答案消息被消费并给出指引，不清空槽位', () => {
    const sessionId = makeActiveSession()
    offer('approval', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '随便说点什么')).toBe(true)
    expect(useChatStore.getState().pendingApproval).not.toBeNull()
    expect(sentTexts.at(-1)?.text).toContain('批准')
  })

  it('提问按编号映射到选项', () => {
    const sessionId = makeActiveSession()
    offer('question', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '2')).toBe(true)
    expect(useChatStore.getState().pendingQuestion).toBeNull()
    expect(sentTexts.at(-1)?.text).toContain('方案乙')
  })

  it('批量审批：全部 / 批准 / 拒绝', () => {
    const sessionId = makeActiveSession()
    offer('batch', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '全部')).toBe(true)
    expect(useChatStore.getState().batchApproval).toBeNull()

    offer('batch', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '拒绝')).toBe(true)
    expect(useChatStore.getState().batchApproval).toBeNull()
  })

  it('作用域决策：加入计划', () => {
    const sessionId = makeActiveSession()
    offer('scope', sessionId)
    expect(answerPendingDecision(sessionId, 'contact-1', '加入计划')).toBe(true)
    expect(useChatStore.getState().pendingScope).toBeNull()
    expect(sentTexts.at(-1)?.text).toBe('已加入计划 ✅')
  })

  it('计划待批准时非答案消息被消费并给出指引（不触发执行）', () => {
    const sessionId = makeActiveSession()
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
    const sessionId = makeActiveSession()
    expect(answerPendingDecision(sessionId, 'contact-1', '你好')).toBe(false)
    expect(sentTexts).toHaveLength(0)
  })
})

describe('wechatBridge 分片发送', () => {
  it('流式节流：剩余不足 400 不发；达到后按 1700 分片', () => {
    const acc = 'x'.repeat(2000)
    expect(nextSendChunk(acc, 1601, false)).toBeNull() // 剩 399
    expect(nextSendChunk(acc, 1600, false)).toBe('x'.repeat(400))
    expect(nextSendChunk(acc, 0, false)).toBe('x'.repeat(1700))
    expect(nextSendChunk(acc, 1700, false)).toBeNull() // 剩 300 < 400
  })

  it('完成阶段强制发送剩余内容', () => {
    const acc = 'hello'
    expect(nextSendChunk(acc, 0, true)).toBe('hello')
    expect(nextSendChunk(acc, 5, true)).toBeNull()
  })
})
