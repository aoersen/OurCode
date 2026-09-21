import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// Monaco's browser modules reference `window` at import time, which the Node
// test env can't provide — replace the singleton with an empty stub. The
// tested actions never touch monaco (that's editor-runtime territory).
// vi.mock is hoisted by vitest, so it runs before the imports below.
vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))

// The store persists through window.electronAPI in actions; stub it here (the
// localStorage/document globals come from vitest.setup.ts which runs before
// imports). Not touching window at module load, so this placement is safe.
const mockApi = {
  getSessions: vi.fn(async () => []),
  saveSession: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => {}),
  checkpointList: vi.fn(async () => []),
  checkpointListReverted: vi.fn(async () => []),
  checkpointSave: vi.fn(async () => {}),
  checkpointDelete: vi.fn(async () => {}),
  checkpointRevert: vi.fn(async () => ({ ok: true, restored: 1 })),
  spillDeleteSession: vi.fn(async () => {}),
  wireLogDeleteSession: vi.fn(async () => {}),
  saveConfigGroup: vi.fn(async () => ({})),
  getConfigGroups: vi.fn(async () => []),
  getSubagentRuns: vi.fn(async () => []),
  saveSubagentRun: vi.fn(async () => true),
}
vi.stubGlobal('window', { electronAPI: mockApi })

import { useChatStore, reconcileInterruptedRuns, APPROVAL_AUTO_REJECT_MS, stopGitBranchPolling, trimHistoryForContext, compactToolResults, sanitizeToolPairing, generateSessionTitle, generateAiSessionTitle, estimateSessionHistoryTokens, estimateContextTokens, DEFAULT_SESSION_TITLE, normalizeTodos, sessionLastUserActivity, isGhostSession, parseToolArguments, toolCallSignature, toRequestImages } from '@/stores/chatStore'
import type { MessageAttachment } from '@/types'
import { useUIStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import { createToolRegistry } from '@/services/tools/ToolRegistry'

// Capture the pristine initial state so each test starts clean
const initialState = useChatStore.getState()

function makeSession(id = 's1') {
  useChatStore.getState().createSession('cfg-1')
  // createSession prepends and sets activeSessionId to the generated uuid;
  // rename to the readable id AND keep activeSessionId in sync
  const s = useChatStore.getState().sessions[0]
  useChatStore.setState((st) => ({
    activeSessionId: id,
    sessions: st.sessions.map((x) => (x.id === s.id ? { ...x, id } : x)),
  }))
  return id
}

function addUser(sessionId: string, content: string) {
  useChatStore.getState().addMessage(sessionId, { role: 'user', content })
}

function addAssistant(sessionId: string, content: string) {
  useChatStore.getState().addMessage(sessionId, { role: 'assistant', content })
}

describe('chatStore message management', () => {
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

  afterAll(() => {
    stopGitBranchPolling()
  })

  it('addMessage appends with dense sortOrder and token estimate', () => {
    makeSession()
    addUser('s1', 'hello')
    addAssistant('s1', 'hi there')
    const msgs = useChatStore.getState().getActiveSession()!.messages
    expect(msgs).toHaveLength(2)
    expect(msgs.map((m) => m.sortOrder)).toEqual([0, 1])
    expect(msgs[0].role).toBe('user')
    expect(msgs[1].tokenCount).toBeGreaterThan(0)
  })

  it('addMessage carries per-round request timing/usage onto the message', () => {
    makeSession()
    useChatStore.getState().addMessage('s1', {
      role: 'assistant',
      content: 'done',
      requestStartedAt: 1000,
      requestDurationMs: 500,
      ttftMs: 120,
      requestTokensIn: 100,
      requestTokensOut: 20,
    })
    const msg = useChatStore.getState().getActiveSession()!.messages[0]
    expect(msg.requestStartedAt).toBe(1000)
    expect(msg.requestDurationMs).toBe(500)
    expect(msg.ttftMs).toBe(120)
    expect(msg.requestTokensIn).toBe(100)
    expect(msg.requestTokensOut).toBe(20)
  })

  it('appendToolResult persists per-tool timing on the assistant message', () => {
    makeSession()
    useChatStore.getState().addMessage('s1', {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }],
    })
    const asstId = useChatStore.getState().getActiveSession()!.messages[0].id
    useChatStore.getState().appendToolResult('s1', asstId, {
      toolCallId: 'c1',
      name: 'read_file',
      result: 'ok',
      startedAt: 100,
      finishedAt: 250,
      durationMs: 150,
    } as any)
    const msg = useChatStore.getState().getActiveSession()!.messages[0]
    expect(msg.toolResults).toHaveLength(1)
    expect(msg.toolResults![0].startedAt).toBe(100)
    expect(msg.toolResults![0].finishedAt).toBe(250)
    expect(msg.toolResults![0].durationMs).toBe(150)
  })

  it('editMessage updates content, editedAt and persists', () => {
    makeSession()
    addUser('s1', 'old text')
    const msgId = useChatStore.getState().getActiveSession()!.messages[0].id
    useChatStore.getState().editMessage('s1', msgId, 'new text')
    const msg = useChatStore.getState().getActiveSession()!.messages[0]
    expect(msg.content).toBe('new text')
    expect(msg.editedAt).toBeGreaterThan(0)
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('deleteMessage removes one message and keeps sortOrder dense', () => {
    makeSession()
    addUser('s1', 'a')
    addAssistant('s1', 'b')
    addUser('s1', 'c')
    const msgs = useChatStore.getState().getActiveSession()!.messages
    useChatStore.getState().deleteMessage('s1', msgs[1].id)
    const remaining = useChatStore.getState().getActiveSession()!.messages
    expect(remaining.map((m) => m.content)).toEqual(['a', 'c'])
    expect(remaining.map((m) => m.sortOrder)).toEqual([0, 1])
    expect(useChatStore.getState().undoStack).toHaveLength(1)
  })

  it('deleteMessages removes several and reindexes', () => {
    makeSession()
    addUser('s1', 'a')
    addAssistant('s1', 'b')
    addUser('s1', 'c')
    addAssistant('s1', 'd')
    const msgs = useChatStore.getState().getActiveSession()!.messages
    useChatStore.getState().deleteMessages('s1', [msgs[0].id, msgs[2].id])
    const remaining = useChatStore.getState().getActiveSession()!.messages
    expect(remaining.map((m) => m.content)).toEqual(['b', 'd'])
    expect(remaining.map((m) => m.sortOrder)).toEqual([0, 1])
    expect(useChatStore.getState().undoStack[0].messages).toHaveLength(2)
  })

  it('undoDelete restores deleted messages within the window', () => {
    makeSession()
    addUser('s1', 'a')
    addAssistant('s1', 'b')
    const msgs = useChatStore.getState().getActiveSession()!.messages
    useChatStore.getState().deleteMessage('s1', msgs[1].id)
    useChatStore.getState().undoDelete()
    const restored = useChatStore.getState().getActiveSession()!.messages
    expect(restored.map((m) => m.content)).toEqual(['a', 'b'])
    expect(restored.map((m) => m.sortOrder)).toEqual([0, 1])
    expect(useChatStore.getState().undoStack).toHaveLength(0)
  })

  it('undoDelete discards entries older than the 5s window', () => {
    makeSession()
    addUser('s1', 'a')
    addAssistant('s1', 'b')
    const msgs = useChatStore.getState().getActiveSession()!.messages
    useChatStore.getState().deleteMessage('s1', msgs[1].id)
    // Age the entry beyond the undo window
    useChatStore.setState((st) => ({
      undoStack: st.undoStack.map((e) => ({ ...e, timestamp: Date.now() - 6000 })),
    }))
    useChatStore.getState().undoDelete()
    expect(useChatStore.getState().getActiveSession()!.messages).toHaveLength(1)
    expect(useChatStore.getState().undoStack).toHaveLength(0)
  })

  it('reorderMessages moves a message and reindexes', () => {
    makeSession()
    addUser('s1', 'a')
    addAssistant('s1', 'b')
    addUser('s1', 'c')
    useChatStore.getState().reorderMessages('s1', 2, 0)
    const msgs = useChatStore.getState().getActiveSession()!.messages
    expect(msgs.map((m) => m.content)).toEqual(['c', 'a', 'b'])
    expect(msgs.map((m) => m.sortOrder)).toEqual([0, 1, 2])
  })

  it('clearMessages empties the session', () => {
    makeSession()
    addUser('s1', 'a')
    useChatStore.getState().clearMessages('s1')
    expect(useChatStore.getState().getActiveSession()!.messages).toHaveLength(0)
  })

  it('createSession sets it active but does not persist an empty session', () => {
    makeSession()
    const s = useChatStore.getState().getActiveSession()!
    expect(s.configGroupId).toBe('cfg-1')
    expect(s.agentMode).toBe('agent')
    // 空白会话不落盘（避免"新建对话"堆积一堆空白会话），首条消息后才会持久化。
    expect(mockApi.saveSession).not.toHaveBeenCalled()
  })

  it('a session is persisted once it gets a message', () => {
    makeSession()
    // Send-flow equivalent: a user message triggers auto-title rename (and the
    // agent loop's finally), both of which persist the session.
    useChatStore.getState().addMessage('s1', { role: 'user', content: '帮我修一下登录页' })
    useChatStore.getState().saveSession('s1')
    expect(mockApi.saveSession).toHaveBeenCalled()
    const saved = mockApi.saveSession.mock.calls[0][0]
    expect(saved.messages).toHaveLength(1)
    expect(saved.messages[0].content).toBe('帮我修一下登录页')
  })

  it('updateSessionModel with a configGroupId rebinds the session to that group', () => {
    makeSession()
    useChatStore.getState().updateSessionModel('s1', 'LongCat-2.0', 'cfg-longcat')
    const s = useChatStore.getState().getActiveSession()!
    expect(s.model).toBe('LongCat-2.0')
    expect(s.configGroupId).toBe('cfg-longcat')
  })

  it('updateSessionModel without a configGroupId keeps the existing binding', () => {
    makeSession()
    useChatStore.getState().updateSessionModel('s1', 'gpt-4o')
    const s = useChatStore.getState().getActiveSession()!
    expect(s.model).toBe('gpt-4o')
    expect(s.configGroupId).toBe('cfg-1')
  })

  it('updateSessionConfigGroup rebinds without touching the model', () => {
    makeSession()
    useChatStore.getState().updateSessionModel('s1', 'LongCat-2.0')
    useChatStore.getState().updateSessionConfigGroup('s1', 'cfg-longcat')
    const s = useChatStore.getState().getActiveSession()!
    expect(s.model).toBe('LongCat-2.0')
    expect(s.configGroupId).toBe('cfg-longcat')
  })

  it('exportSession markdown renders roles and content', () => {
    makeSession()
    addUser('s1', '你好')
    addAssistant('s1', '世界')
    const md = useChatStore.getState().exportSession('s1', 'markdown')
    expect(md).toContain('你')
    expect(md).toContain('世界')
    expect(md).toContain('用户') // role markers
  })
})

describe('chatStore generateSessionTitle', () => {
  it('uses the first non-empty line of the message', () => {
    expect(generateSessionTitle('\n\n修复登录页的按钮样式\n\n详见如下')).toBe('修复登录页的按钮样式')
  })

  it('strips markdown-ish prefixes', () => {
    expect(generateSessionTitle('# 重构数据库查询')).toBe('重构数据库查询')
    expect(generateSessionTitle('- 添加单元测试')).toBe('添加单元测试')
    expect(generateSessionTitle('> 引用内容')).toBe('引用内容')
  })

  it('caps long titles at 30 chars with an ellipsis', () => {
    const long = '这'.repeat(40)
    expect(generateSessionTitle(long)).toBe('这'.repeat(30) + '…')
  })

  it('generateAiSessionTitle returns "" when no API is configured', async () => {
    // The test env has no config groups → the LLM call is skipped entirely
    const title = await generateAiSessionTitle('修复登录页按钮样式')
    expect(title).toBe('')
  })

  it('returns the raw first line when stripping leaves nothing', () => {
    expect(generateSessionTitle('---')).toBe('---')
  })

  it('new sessions start with the default title', () => {
    expect(DEFAULT_SESSION_TITLE).toBe('新对话')
    makeSession()
    expect(useChatStore.getState().sessions[0].title).toBe(DEFAULT_SESSION_TITLE)
  })
})

describe('chatStore ghost sessions (never-used empty chats)', () => {
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

  it('isGhostSession is true right after creation, false once a message is sent', () => {
    makeSession('s1')
    const fresh = useChatStore.getState().sessions.find((x) => x.id === 's1')!
    expect(isGhostSession(fresh)).toBe(true)
    addUser('s1', '帮我修一下登录页')
    const used = useChatStore.getState().sessions.find((x) => x.id === 's1')!
    expect(isGhostSession(used)).toBe(false)
  })

  it('a renamed-but-still-empty session is NOT a ghost (user showed intent)', () => {
    makeSession('s1')
    useChatStore.getState().renameSession('s1', 'TODO 备忘')
    const renamed = useChatStore.getState().sessions.find((x) => x.id === 's1')!
    expect(isGhostSession(renamed)).toBe(false)
  })

  it('setActiveSession prunes never-used ghost sessions but keeps the target', () => {
    makeSession('s1')
    makeSession('s2')
    useChatStore.getState().setActiveSession('s2')
    expect(useChatStore.getState().sessions.map((x) => x.id)).toEqual(['s2'])
  })

  it('setActiveSession keeps used sessions and prunes only ghosts', () => {
    makeSession('s1')
    addUser('s1', 'hello') // s1 becomes a real conversation
    makeSession('s2') // s2 is a fresh ghost
    useChatStore.getState().setActiveSession('s1')
    expect(useChatStore.getState().sessions.map((x) => x.id)).toEqual(['s1'])
  })

  it('deleteSession does not leave an invisible ghost active when the active session is deleted', () => {
    makeSession('s1')
    makeSession('s2') // s2 is a ghost, now active
    addUser('s2', 'hello') // s2 becomes real; s1 stays an unused ghost
    useChatStore.getState().deleteSession('s2')
    // The next active must not fall onto the invisible ghost s1
    expect(useChatStore.getState().sessions).toHaveLength(0)
    expect(useChatStore.getState().activeSessionId).toBeNull()
  })

  it('deleteSession keeps the active ghost the user is composing in', () => {
    makeSession('s1')
    addUser('s1', 'hello') // s1 is a real conversation
    makeSession('g1') // g1 is a ghost, now active
    useChatStore.getState().deleteSession('s1')
    expect(useChatStore.getState().sessions.map((x) => x.id)).toEqual(['g1'])
    expect(useChatStore.getState().activeSessionId).toBe('g1')
  })
})

describe('chatStore trimHistoryForContext', () => {
  it('keeps everything when within the model budget', () => {
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ]
    const result = trimHistoryForContext(messages, 'gpt-4o')
    expect(result).toHaveLength(3)
    expect(result.some((m) => m.content.includes('上下文管理'))).toBe(false)
  })

  it('drops the oldest messages over budget and inserts a notice', () => {
    const longText = 'x'.repeat(380000) // ≈ 114k tokens (over the 102k gpt-4o budget)
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: longText },
      { role: 'assistant' as const, content: 'a' },
      { role: 'user' as const, content: 'current question' },
    ]
    const result = trimHistoryForContext(messages, 'gpt-4o') // 128k budget, 80% → 102k
    expect(result.some((m) => m.content === longText)).toBe(false)
    expect(result.some((m) => m.content.includes('上下文管理'))).toBe(true)
    expect(result[result.length - 1].content).toBe('current question')
  })

  it('never drops the system message or the newest message', () => {
    const big = 'y'.repeat(200000)
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: big },
      { role: 'user' as const, content: big },
    ]
    const result = trimHistoryForContext(messages, 'gpt-4o')
    expect(result[0].role).toBe('system')
    expect(result[result.length - 1].content).toBe(big)
  })

  it('uses a large default budget when the model is unknown', () => {
    const small = 'z'.repeat(10000) // ~5k tokens — far under any default
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: small },
    ]
    expect(trimHistoryForContext(messages, 'unknown-model-xyz')).toHaveLength(2)
  })
})

describe('chatStore compactToolResults', () => {
  const bigTool = (id: string) => ({ role: 'tool' as const, content: 'x'.repeat(20000), toolCallId: id })

  it('keeps the most recent tool results untouched and compresses older long ones', () => {
    // 12 tool results (> MAX_UNCOMPACTED_TOOL_RESULTS = 10) with long content
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'question' },
      ...Array.from({ length: 12 }, (_, i) => bigTool(`t${i}`)),
    ]
    const result = compactToolResults(messages)
    // 消息数与 role/toolCallId 全部保留（tool 配对完整性）
    expect(result).toHaveLength(14)
    result.forEach((m, i) => {
      if (i >= 2) expect(m.role).toBe('tool')
      if (i >= 2 && m.role === 'tool') expect(m.toolCallId).toBe(`t${i - 2}`)
    })
    // 最早的 2 条被压缩，最新的 10 条保留原文
    expect(result[2].content).toContain('已压缩')
    expect(result[3].content).toContain('已压缩')
    expect(result[4].content).toBe('x'.repeat(20000))
    expect(result[result.length - 1].content).toBe('x'.repeat(20000))
  })

  it('does not compress short tool results or recent ones', () => {
    const messages = [
      { role: 'tool' as const, content: 'short', toolCallId: 'a' },
      { role: 'tool' as const, content: 'x'.repeat(5000), toolCallId: 'b' }, // long but below the 12KB threshold
    ]
    const result = compactToolResults(messages)
    expect(result[0].content).toBe('short')
    expect(result[1].content).toBe('x'.repeat(5000))
  })

  it('preserves non-tool messages as-is', () => {
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hello' },
    ]
    expect(compactToolResults(messages)).toEqual(messages)
  })
})

describe('chatStore estimateSessionHistoryTokens', () => {
  it('compacts old oversized tool results the same way the live request does', () => {
    // 20 huge tool results — the 10 newest stay verbatim (≈30k tokens each),
    // the 10 oldest collapse to a short note (~40 tokens) like compactToolResults.
    const tools = Array.from({ length: 20 }, (_, i) => ({
      role: 'tool' as const,
      content: 'x'.repeat(100000),
      toolCallId: `t${i}`,
    }))
    const messages = [
      { role: 'user' as const, content: '帮我看看' },
      { role: 'assistant' as const, content: '好的' },
      ...tools,
    ]
    const total = estimateSessionHistoryTokens(messages)
    expect(total).toBeGreaterThan(10 * 30000) // newest 10 counted verbatim
    expect(total).toBeLessThan(11 * 30000) // oldest 10 compacted, not full
  })

  it('calibrated estimate is far below the old double-counted one', () => {
    const mixed = '帮我看看为什么构建失败 fix the build error now please'
    const messages = [{ role: 'user' as const, content: mixed }]
    const total = estimateSessionHistoryTokens(messages)
    // Old formula ≈ 18×2 + 6×1.3 + ~17×0.5 ≈ 53; new ≈ 18×1.2 + 23×0.3 ≈ 28
    expect(total).toBeLessThan(35)
  })
})

describe('chatStore estimateContextTokens', () => {
  it('baselines on real API usage and estimates only messages added since', () => {
    const base = [
      { role: 'user' as const, content: '你好' },
      { role: 'assistant' as const, content: '好的' },
    ]
    const session = {
      lastContextTokens: 150000, // billing-accurate usage from last API response
      lastContextMessageCount: base.length,
      messages: [
        ...base,
        { role: 'user' as const, content: '继续' },
        { role: 'assistant' as const, content: '完成' },
      ],
    }
    const total = estimateContextTokens(session)
    // 150000 baseline + only the 2 new messages estimated (a few tokens)
    expect(total).toBeGreaterThan(150000)
    expect(total).toBeLessThan(150000 + 50)
  })

  it('falls back to pure estimation when no real baseline was recorded', () => {
    const session = {
      messages: [{ role: 'user' as const, content: '你好世界' }],
    }
    expect(estimateContextTokens(session)).toBe(estimateSessionHistoryTokens(session.messages))
  })

  it('counts the compaction-aware request view when a summary exists (no baseline)', () => {
    const summarizedHistory = [
      { role: 'user' as const, content: 'x'.repeat(5000) },
      { role: 'assistant' as const, content: 'y'.repeat(5000) },
    ]
    const session = {
      summary: '## 目标\n完成功能',
      summaryMessageCount: summarizedHistory.length,
      messages: [
        ...summarizedHistory,
        { role: 'user' as const, content: '继续' },
      ],
    }
    const total = estimateContextTokens(session)
    // Only the summary (~20 tokens) + the 1 un-summarized message — the
    // 10k chars of summarized history must NOT be counted.
    expect(total).toBeLessThan(100)
    expect(total).toBeGreaterThan(10)
  })
})

describe('chatStore sanitizeToolPairing', () => {
  const asst = (content: string, callIds: string[] = []) => ({
    role: 'assistant' as const,
    content,
    toolCalls: callIds.length > 0
      ? callIds.map((id) => ({ id, type: 'function' as const, function: { name: 'f', arguments: '{}' } }))
      : undefined,
  })
  const tool = (id: string) => ({ role: 'tool' as const, content: `result of ${id}`, toolCallId: id })

  it('keeps a complete tool round-trip intact', () => {
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'q' },
      asst('', ['c1']),
      tool('c1'),
      asst('answer'),
      { role: 'user' as const, content: 'follow-up' },
    ]
    expect(sanitizeToolPairing(messages)).toEqual(messages)
  })

  it('keeps multiple tool responses for one round in order', () => {
    const messages = [
      { role: 'user' as const, content: 'q' },
      asst('', ['c1', 'c2']),
      tool('c1'),
      tool('c2'),
      asst('answer'),
    ]
    expect(sanitizeToolPairing(messages)).toEqual(messages)
  })

  it('strips toolCalls from an assistant message whose responses are missing', () => {
    const messages = [
      { role: 'user' as const, content: 'q' },
      asst('', ['c1']),
      asst('answer'),
    ]
    const result = sanitizeToolPairing(messages)
    expect(result).toHaveLength(3)
    expect(result[1].role).toBe('assistant')
    expect(result[1].toolCalls).toBeUndefined()
  })

  it('strips a partial round (some ids unanswered) and drops its stray responses', () => {
    const messages = [
      { role: 'user' as const, content: 'q' },
      asst('', ['c1', 'c2']),
      tool('c1'), // c2 never answered
      { role: 'user' as const, content: 'next' },
    ]
    const result = sanitizeToolPairing(messages)
    expect(result.filter((m) => m.role === 'tool')).toHaveLength(0)
    const asstMsg = result.find((m) => m.content === '')
    expect(asstMsg?.toolCalls).toBeUndefined()
  })

  it('drops orphaned tool messages that answer no tool_calls', () => {
    const messages = [
      { role: 'user' as const, content: 'q' },
      tool('c9'),
      { role: 'user' as const, content: 'next' },
    ]
    const result = sanitizeToolPairing(messages)
    expect(result).toEqual([
      { role: 'user', content: 'q' },
      { role: 'user', content: 'next' },
    ])
  })

  it('strips an unanswered round that ends the history', () => {
    const messages = [
      { role: 'user' as const, content: 'q' },
      asst('', ['c1']),
    ]
    const result = sanitizeToolPairing(messages)
    expect(result[1].toolCalls).toBeUndefined()
  })
})

describe('chatStore agent run state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useChatStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
      undoStack: [],
      queuedMessagesBySession: {},
      activeRuns: {},
      agentTraces: {},
      batchApprovedBySession: {},
      toolAllowlist: {},
      batchApproval: null,
    })
  })

  it('setTargetMode persists the target mode on the session', () => {
    makeSession()
    useChatStore.getState().setTargetMode('s1', true)
    expect(useChatStore.getState().sessions[0].targetMode).toBe(true)
    useChatStore.getState().setTargetMode('s1', false)
    expect(useChatStore.getState().sessions[0].targetMode).toBe(false)
  })

  it('createSession always runs in agent mode, bound to the current project', () => {
    // Inside a project (open folder) → bound to that project
    useUIStore.getState().enterProject('/proj-a')
    useChatStore.getState().createSession('cfg-1')
    const inProject = useChatStore.getState().sessions[0]
    expect(inProject.agentMode).toBe('agent')
    expect(inProject.projectPath).toBe('/proj-a')
    // Target mode is never defaulted on
    expect(inProject.targetMode).toBeUndefined()

    // The current project follows the ACTIVE SESSION: a new conversation with
    // no explicit project inherits the active session's bound project, even
    // after the browsed folder is closed.
    useUIStore.getState().setRootPath(null)
    useChatStore.getState().createSession('cfg-1')
    const followsSession = useChatStore.getState().sessions[0]
    expect(followsSession.projectPath).toBe('/proj-a')
    expect(followsSession.agentMode).toBe('agent')

    // No session-bound project AND no open folder → still agent mode, unbound
    // (the workspace falls back to the app-owned default project at startup).
    useChatStore.setState({ sessions: [], activeSessionId: null })
    useChatStore.getState().createSession('cfg-1')
    const outside = useChatStore.getState().sessions[0]
    expect(outside.agentMode).toBe('agent')
    expect(outside.projectPath).toBeUndefined()
  })

  it('blocks enabling target mode while another session of the same project runs it', () => {
    makeSession('s1')
    useChatStore.setState((st) => ({ sessions: st.sessions.map((s) => ({ ...s, projectPath: '/proj' })) }))
    useChatStore.getState().setTargetMode('s1', true)
    expect(useChatStore.getState().sessions.find((s) => s.id === 's1')!.targetMode).toBe(true)

    // Second session, same project — must be refused
    makeSession('s2')
    useChatStore.setState((st) => ({ sessions: st.sessions.map((s) => (s.id === 's2' ? { ...s, projectPath: '/proj' } : s)) }))
    useChatStore.getState().setTargetMode('s2', true)
    expect(useChatStore.getState().sessions.find((s) => s.id === 's2')!.targetMode).toBeUndefined()

    // A different project is fine
    useChatStore.setState((st) => ({ sessions: st.sessions.map((s) => (s.id === 's2' ? { ...s, projectPath: '/other' } : s)) }))
    useChatStore.getState().setTargetMode('s2', true)
    expect(useChatStore.getState().sessions.find((s) => s.id === 's2')!.targetMode).toBe(true)
  })

  it('switches auto_edit/plan to manual confirm when target mode is enabled', () => {
    makeSession()
    useChatStore.getState().setProjectEditMode('s1', 'auto_edit')
    useChatStore.getState().setTargetMode('s1', true)
    expect(useChatStore.getState().sessions[0].targetMode).toBe(true)
    expect(useChatStore.getState().sessions[0].projectEditMode).toBe('confirm_before_change')
  })

  it('startAgentRun creates a run record, sets activeRuns and resets the trace', () => {
    makeSession()
    useChatStore.getState().startAgentRun('s1', '重构 auth 模块')
    const st = useChatStore.getState()
    expect(st.activeRuns['s1']?.sessionId).toBe('s1')
    expect(st.batchApprovedBySession['s1']).toBe(false)
    const session = st.sessions.find((s) => s.id === 's1')!
    expect(session.agentRuns).toHaveLength(1)
    expect(session.agentRuns![0].task).toBe('重构 auth 模块')
    expect(session.agentRuns![0].status).toBe('running')

    // A new user turn starts a fresh run
    useChatStore.getState().startAgentRun('s1', '新任务')
    const st2 = useChatStore.getState()
    expect(st2.sessions.find((s) => s.id === 's1')!.agentRuns).toHaveLength(2)
    expect(st2.activeRuns['s1']?.runId).not.toBe(st.activeRuns['s1']?.runId)
    expect(st2.batchApprovedBySession['s1']).toBe(false)
  })

  it('startAgentRun with resumeRunId reuses the existing run record', () => {
    makeSession()
    useChatStore.getState().startAgentRun('s1', '任务')
    const runId = useChatStore.getState().activeRuns['s1']!.runId
    // Plan approval resumes the same run
    useChatStore.getState().startAgentRun('s1', '任务', { resumeRunId: runId })
    const st = useChatStore.getState()
    expect(st.sessions.find((s) => s.id === 's1')!.agentRuns).toHaveLength(1)
    expect(st.activeRuns['s1']?.runId).toBe(runId)
    expect(st.batchApprovedBySession['s1']).toBe(false)
    expect(st.sessions.find((s) => s.id === 's1')!.agentRuns![0].status).toBe('running')
  })

  it('finishAgentRun records counts/status and caps agentRuns at 20', () => {
    makeSession()
    // Fill past the cap
    for (let i = 0; i < 22; i++) {
      useChatStore.getState().startAgentRun('s1', `任务 ${i}`)
    }
    const st = useChatStore.getState()
    expect(st.sessions.find((s) => s.id === 's1')!.agentRuns).toHaveLength(20)
    const runId = st.activeRuns['s1']!.runId

    useChatStore.getState().setRunStatus(runId, 'approved_running')
    useChatStore.getState().appendTrace('s1', { id: 't1', toolCallId: 'c1', name: 'read_file', kind: 'search', status: 'success', summary: 'auth.ts' })
    useChatStore.getState().appendTrace('s1', { id: 't2', toolCallId: 'c2', name: 'edit_file', kind: 'edit', status: 'success', summary: 'auth.ts' })
    useChatStore.getState().finishAgentRun('s1', runId, 'done')

    // Re-read state — zustand's set() produces a new sessions array
    const st2 = useChatStore.getState()
    const run = st2.sessions.find((s) => s.id === 's1')!.agentRuns!.find((r) => r.id === runId)!
    expect(run.status).toBe('done')
    expect(run.finishedAt).toBeGreaterThan(0)
    expect(run.toolCallCount).toBe(2)
    expect(run.fileChangeCount).toBe(1) // only the edit kind
    expect(st2.batchApprovedBySession['s1']).toBe(false)
  })

  it('finishAgentRun persists the run token totals', () => {
    makeSession()
    useChatStore.getState().startAgentRun('s1', '任务')
    const runId = useChatStore.getState().activeRuns['s1']!.runId

    useChatStore.getState().finishAgentRun('s1', runId, 'done', {
      tokensIn: 1200,
      tokensOut: 340,
      requestCount: 7,
      cacheHits: 3,
      cacheTokensSaved: 12400,
    })

    const run = useChatStore.getState().sessions.find((s) => s.id === 's1')!.agentRuns!.find((r) => r.id === runId)!
    expect(run.status).toBe('done')
    expect(run.tokensIn).toBe(1200)
    expect(run.tokensOut).toBe(340)
    // New usage-detail fields (token badge popover data)
    expect(run.requestCount).toBe(7)
    expect(run.cacheHits).toBe(3)
    expect(run.cacheTokensSaved).toBe(12400)
  })

  it('decideBatchApproval clears the dialog and approveBatchRun sets the flag', () => {
    makeSession()
    useChatStore.setState({ batchApproval: { sessionId: 's1', runId: 'r1', tools: [{ id: 'c1', name: 'write_file', arguments: { path: '/tmp/a.ts' } }] } })
    // The loop resolves the dialog, then (for "all") flips the run to batch-approved
    useChatStore.getState().decideBatchApproval('all')
    expect(useChatStore.getState().batchApproval).toBeNull()
    // No run started → no per-session batch flag exists yet
    expect(useChatStore.getState().batchApprovedBySession['s1']).toBeUndefined()
    useChatStore.getState().approveBatchRun('s1')
    expect(useChatStore.getState().batchApprovedBySession['s1']).toBe(true)
  })

  it('allowToolPermanently persists to localStorage and clearToolAllowlist removes it', () => {
    // vitest.setup stubs localStorage as a no-op; swap in an in-memory map so
    // the persistence contract is actually exercised.
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) },
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    })

    makeSession()
    // Give the session a project path so the allowlist has a scope
    useChatStore.setState((st) => ({
      sessions: st.sessions.map((s) => (s.id === 's1' ? { ...s, projectPath: 'C:/proj' } : s)),
    }))
    useChatStore.getState().allowToolPermanently('run_command')
    expect(useChatStore.getState().toolAllowlist['C:/proj']).toEqual(['run_command'])
    expect(JSON.parse(mem.get('ourcode-tool-allowlist:C:/proj') || '[]')).toEqual(['run_command'])
    useChatStore.getState().clearToolAllowlist('C:/proj')
    expect(useChatStore.getState().toolAllowlist['C:/proj']).toBeUndefined()
    expect(mem.get('ourcode-tool-allowlist:C:/proj')).toBeUndefined()
  })

  it('deleteAgentRun removes the record and clears activeRuns when active', () => {
    makeSession()
    useChatStore.getState().startAgentRun('s1', '任务')
    const runId = useChatStore.getState().activeRuns['s1']!.runId
    useChatStore.getState().deleteAgentRun('s1', runId)
    const st = useChatStore.getState()
    expect(st.sessions.find((s) => s.id === 's1')!.agentRuns).toHaveLength(0)
    expect(st.activeRuns['s1']).toBeUndefined()
  })

  it('supports parallel running sessions — stopGeneration only aborts its own controller', () => {
    makeSession('s1')
    makeSession('s2')
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    useChatStore.setState({
      runningSessionIds: ['s1', 's2'],
      abortControllers: { s1: ac1, s2: ac2 },
    })
    const spy1 = vi.spyOn(ac1, 'abort')
    const spy2 = vi.spyOn(ac2, 'abort')
    useChatStore.getState().stopGeneration('s1')
    expect(spy1).toHaveBeenCalledTimes(1)
    expect(spy2).not.toHaveBeenCalled()
    expect(useChatStore.getState().abortControllers['s1']).toBeUndefined()
    expect(useChatStore.getState().abortControllers['s2']).toBe(ac2)
  })

  it('queueMessage is scoped per session and clearQueue only clears its own', () => {
    useChatStore.getState().queueMessage('s1', '第一条')
    useChatStore.getState().queueMessage('s1', '第二条')
    useChatStore.getState().queueMessage('s2', '另一条')
    const contents = (id: string) => (useChatStore.getState().queuedMessagesBySession[id] || []).map((q) => q.content)
    expect(contents('s1')).toEqual(['第一条', '第二条'])
    expect(contents('s2')).toEqual(['另一条'])
    useChatStore.getState().clearQueue('s1')
    expect(useChatStore.getState().queuedMessagesBySession['s1']).toBeUndefined()
    expect(contents('s2')).toEqual(['另一条'])
  })

  it('queueMessage carries image attachments and accepts an image-only entry', () => {
    const img = { id: 'a1', name: 'shot.png', mimeType: 'image/png', dataBase64: 'AAA' }
    useChatStore.getState().queueMessage('s1', '看图', [img])
    useChatStore.getState().queueMessage('s1', '', [img])
    const q = useChatStore.getState().queuedMessagesBySession['s1']
    expect(q.map((x) => x.content)).toEqual(['看图', ''])
    expect(q[0].attachments).toEqual([img])
    // Nothing at all (no text, no image) is not a message.
    useChatStore.getState().queueMessage('s2', '   ')
    expect(useChatStore.getState().queuedMessagesBySession['s2']).toBeUndefined()
  })

  it('removeQueuedMessage deletes only the given index and keeps order', () => {
    useChatStore.getState().queueMessage('s1', 'A')
    useChatStore.getState().queueMessage('s1', 'B')
    useChatStore.getState().queueMessage('s1', 'C')
    useChatStore.getState().removeQueuedMessage('s1', 1)
    const contents = () => (useChatStore.getState().queuedMessagesBySession['s1'] || []).map((q) => q.content)
    expect(contents()).toEqual(['A', 'C'])
    // Invalid index / unknown session are no-ops
    useChatStore.getState().removeQueuedMessage('s1', 5)
    useChatStore.getState().removeQueuedMessage('s1', -1)
    useChatStore.getState().removeQueuedMessage('s2', 0)
    expect(contents()).toEqual(['A', 'C'])
  })

  it('sendQueuedNow stops the run and promotes the picked message to the front', () => {
    const ac = new AbortController()
    useChatStore.setState({ runningSessionIds: ['s1'], abortControllers: { s1: ac } })
    useChatStore.getState().queueMessage('s1', 'A')
    useChatStore.getState().queueMessage('s1', 'B')
    useChatStore.getState().queueMessage('s1', 'C')
    const abortSpy = vi.spyOn(ac, 'abort')
    useChatStore.getState().sendQueuedNow('s1', 2)
    // The picked message is now first (drained next by the aborted run's finally)
    expect(
      useChatStore.getState().queuedMessagesBySession['s1'].map((q) => q.content)
    ).toEqual(['C', 'A', 'B'])
    // stopGeneration aborted the controller and dropped it from the map
    expect(abortSpy).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().abortControllers['s1']).toBeUndefined()
  })

  it('sendQueuedNow with an invalid index is a no-op', () => {
    const ac = new AbortController()
    useChatStore.setState({ runningSessionIds: ['s1'], abortControllers: { s1: ac } })
    useChatStore.getState().queueMessage('s1', 'A')
    const abortSpy = vi.spyOn(ac, 'abort')
    useChatStore.getState().sendQueuedNow('s1', 3)
    useChatStore.getState().sendQueuedNow('s1', -1)
    expect(
      useChatStore.getState().queuedMessagesBySession['s1'].map((q) => q.content)
    ).toEqual(['A'])
    expect(abortSpy).not.toHaveBeenCalled()
  })

  it('createSession binds to an explicitly passed projectPath', () => {
    useChatStore.getState().createSession('cfg-1', '/explicit/proj')
    const s = useChatStore.getState().sessions[0]
    expect(s.projectPath).toBe('/explicit/proj')
    expect(s.agentMode).toBe('agent')
  })
})

describe('chatStore cross-session messaging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useChatStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
      runningSessionIds: [],
      undoStack: [],
      queuedMessagesBySession: {},
      inboundQueue: [],
      activeRuns: {},
      agentTraces: {},
      batchApprovedBySession: {},
      toolAllowlist: {},
      batchApproval: null,
    })
    // Sandbox the inbound policy so tests are independent of user preferences
    useEditorStore.setState((st) => ({ preferences: { ...st.preferences, crossSessionInbound: 'accept' } }))
  })

  it('receiveInboundMessage delivers a marked user message and persists', () => {
    makeSession('s1')
    makeSession('s2')
    const status = useChatStore.getState().receiveInboundMessage('会话一', 's2', '帮我看看 auth 模块')
    expect(status).toContain('已投递并触发')
    const target = useChatStore.getState().sessions.find((s) => s.id === 's2')!
    expect(target.messages).toHaveLength(1)
    expect(target.messages[0].role).toBe('user')
    expect(target.messages[0].content).toContain('[来自会话「会话一」的会话间消息]')
    expect(target.messages[0].content).toContain('帮我看看 auth 模块')
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('receiveInboundMessage queues the message while the target is generating', () => {
    makeSession('s1')
    makeSession('s2')
    // Simulate the target's agent loop being active
    useChatStore.setState({ runningSessionIds: ['s2'] })
    const status = useChatStore.getState().receiveInboundMessage('会话一', 's2', '忙完后告诉我')
    expect(status).toContain('已排队')
    const target = useChatStore.getState().sessions.find((s) => s.id === 's2')!
    expect(target.messages).toHaveLength(0) // not delivered yet
    expect(useChatStore.getState().inboundQueue).toHaveLength(1)
    expect(useChatStore.getState().inboundQueue[0].targetSessionId).toBe('s2')
  })

  it('receiveInboundMessage with hold=true appends without auto-processing', () => {
    makeSession('s1')
    makeSession('s2')
    const status = useChatStore.getState().receiveInboundMessage('会话一', 's2', '先放着', true)
    expect(status).toContain('hold')
    const target = useChatStore.getState().sessions.find((s) => s.id === 's2')!
    expect(target.messages).toHaveLength(1)
    expect(useChatStore.getState().inboundQueue).toHaveLength(0)
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('send_message tool rejects self-messaging and unknown targets', async () => {
    makeSession('s1')
    makeSession('s2')
    const tools = createToolRegistry()
    const sendMessage = tools.find((t) => t.name === 'send_message')!

    const self = await sendMessage.execute({ targetSessionId: 's1', message: 'hi' }, { sessionId: 's1' })
    expect(self).toContain('不能给自己发消息')

    const missing = await sendMessage.execute({ targetSessionId: 'ghost', message: 'hi' }, { sessionId: 's1' })
    expect(missing).toContain('不存在')

    // Nothing was delivered to s2 by the failed calls
    expect(useChatStore.getState().sessions.find((s) => s.id === 's2')!.messages).toHaveLength(0)
  })

  it('send_message tool honors the refuse policy', async () => {
    makeSession('s1')
    makeSession('s2')
    useEditorStore.setState((st) => ({ preferences: { ...st.preferences, crossSessionInbound: 'refuse' } }))
    const tools = createToolRegistry()
    const sendMessage = tools.find((t) => t.name === 'send_message')!
    const res = await sendMessage.execute({ targetSessionId: 's2', message: 'hi' }, { sessionId: 's1' })
    expect(res).toContain('拒绝')
    expect(useChatStore.getState().sessions.find((s) => s.id === 's2')!.messages).toHaveLength(0)
  })

  it('send_message tool resolves the target by title and reports delivery', async () => {
    makeSession('s1')
    makeSession('s2')
    useChatStore.getState().renameSession('s2', '收件人')
    const target = useChatStore.getState().sessions.find((s) => s.id === 's2')!
    const tools = createToolRegistry()
    const sendMessage = tools.find((t) => t.name === 'send_message')!
    const res = await sendMessage.execute({ targetTitle: '收件人', message: '请回复' }, { sessionId: 's1' })
    expect(res).toContain(target.title)
    expect(res).toContain('已发送')
    const targetMsgs = useChatStore.getState().sessions.find((s) => s.id === 's2')!.messages
    expect(targetMsgs).toHaveLength(1)
    expect(targetMsgs[0].content).toContain('请回复')
  })

  it('list_agents tool lists peer sessions and hides the caller', async () => {
    makeSession('s1')
    makeSession('s2')
    useChatStore.getState().renameSession('s2', '第二个会话')
    const tools = createToolRegistry()
    const listAgents = tools.find((t) => t.name === 'list_agents')!
    const res = await listAgents.execute({}, { sessionId: 's1' })
    expect(res).toContain('第二个会话')
    expect(res).toContain('s2')
    // The caller itself must not appear as a peer row
    expect(res).not.toContain('| s1 |')
  })
})

describe('chatStore questionGate (off-session ask confirm)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
      undoStack: [],
      queuedMessagesBySession: {},
      pendingQuestion: null,
      questionGate: {},
    })
  })

  it('setQuestionGate stores the per-session gate', () => {
    useChatStore.getState().setQuestionGate('s1', 'confirm')
    expect(useChatStore.getState().questionGate.s1).toBe('confirm')
  })

  it('answerQuestion clears the gate alongside the pending question', () => {
    useChatStore.getState().setQuestionGate('s1', 'confirm')
    useChatStore.setState({ pendingQuestion: { sessionId: 's1', id: 'q1', question: 'test?' } })
    useChatStore.getState().answerQuestion('yes')
    expect(useChatStore.getState().pendingQuestion).toBeNull()
    expect(useChatStore.getState().questionGate.s1).toBeUndefined()
  })

  it('setActiveSession re-arms a dismissed gate for a session with a pending question', () => {
    makeSession('s1')
    makeSession('s2')
    useChatStore.getState().setQuestionGate('s2', 'dismissed')
    useChatStore.setState({ pendingQuestion: { sessionId: 's2', id: 'q1', question: 'test?' } })
    useChatStore.getState().setActiveSession('s2')
    expect(useChatStore.getState().questionGate.s2).toBe('confirm')
  })

  it('setActiveSession leaves an auto gate untouched', () => {
    makeSession('s1')
    makeSession('s2')
    useChatStore.getState().setQuestionGate('s2', 'auto')
    useChatStore.setState({ pendingQuestion: { sessionId: 's2', id: 'q1', question: 'test?' } })
    useChatStore.getState().setActiveSession('s2')
    expect(useChatStore.getState().questionGate.s2).toBe('auto')
  })

  it('stopGeneration clears the gate for the session', () => {
    useChatStore.getState().setQuestionGate('s1', 'confirm')
    useChatStore.getState().stopGeneration('s1')
    expect(useChatStore.getState().questionGate.s1).toBeUndefined()
  })
})

describe('chatStore normalizeTodos', () => {
  it('keeps at most one in_progress — later ones demote to pending', () => {
    const todos = normalizeTodos([
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ])
    const statuses = todos.map((t) => t.status)
    expect(statuses).toEqual(['in_progress', 'pending', 'pending'])
  })

  it('does not misreport demoted todos as completed', () => {
    const todos = normalizeTodos([
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
    ])
    expect(todos[1].status).toBe('pending')
    expect(todos[1].status).not.toBe('completed')
  })

  it('validates status values and assigns dense order', () => {
    const todos = normalizeTodos([
      { content: 'a', status: 'bogus' },
      { content: 'b', status: 'completed' },
    ])
    expect(todos[0].status).toBe('pending')
    expect(todos.map((t) => t.order)).toEqual([0, 1])
    expect(todos.every((t) => t.id)).toBe(true)
  })

  it('returns an empty array for non-array input', () => {
    expect(normalizeTodos(undefined)).toEqual([])
    expect(normalizeTodos('x')).toEqual([])
  })
})

describe('chatStore session user-activity sort anchor', () => {
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

  it('sessionLastUserActivity prefers lastUserMessageAt over updatedAt', () => {
    const s = {
      id: 'x',
      title: 't',
      configGroupId: 'g',
      model: '',
      modelParams: {},
      messages: [],
      createdAt: 100,
      updatedAt: 200,
      lastUserMessageAt: 150,
    } as any
    // lastUserMessageAt wins even though updatedAt is newer (agent activity
    // refreshes updatedAt constantly — the list must not follow it).
    expect(sessionLastUserActivity(s)).toBe(150)
    delete s.lastUserMessageAt
    expect(sessionLastUserActivity(s)).toBe(200)
  })

  it('addMessage sets lastUserMessageAt only for user messages', () => {
    makeSession()
    addUser('s1', 'first question')
    const afterUser = useChatStore.getState().sessions[0]
    expect(afterUser.lastUserMessageAt).toBeTypeOf('number')
    const anchor = afterUser.lastUserMessageAt!

    // An assistant reply (agent activity) must NOT move the anchor.
    const tick = Date.now()
    useChatStore.setState((st) => ({
      sessions: st.sessions.map((s) => (s.id === 's1' ? { ...s, updatedAt: tick + 60_000 } : s)),
    }))
    addAssistant('s1', 'working on it…')
    expect(useChatStore.getState().sessions[0].lastUserMessageAt).toBe(anchor)
  })

  it('loadSessions backfills lastUserMessageAt for legacy sessions', async () => {
    const legacy = {
      id: 'legacy-1',
      title: '旧会话',
      configGroupId: 'cfg-1',
      model: '',
      modelParams: {},
      messages: [
        { id: 'm1', role: 'user', content: 'a', createdAt: 1_000, sortOrder: 0 },
        { id: 'm2', role: 'assistant', content: 'b', createdAt: 2_000, sortOrder: 1 },
        { id: 'm3', role: 'user', content: 'c', createdAt: 3_000, sortOrder: 2 },
      ],
      createdAt: 500,
      updatedAt: 9_000, // agent activity later refreshed this
    }
    ;(mockApi.getSessions as any).mockResolvedValueOnce([legacy])
    await useChatStore.getState().loadSessions()

    const loaded = useChatStore.getState().sessions[0]
    // Derived from the LAST user message, not updatedAt (which would jump).
    expect(loaded.lastUserMessageAt).toBe(3_000)
    expect(sessionLastUserActivity(loaded)).toBe(3_000)
  })

  it('createSession seeds the last-picked edit mode and forces agent mode', () => {
    localStorage.setItem('lastProjectEditMode', 'full_access')
    try {
      useChatStore.getState().createSession('cfg-1', 'C:/proj')
      const s = useChatStore.getState().sessions[0]
      expect(s.agentMode).toBe('agent')
      expect(s.projectEditMode).toBe('full_access')
    } finally {
      localStorage.removeItem('lastProjectEditMode')
    }
  })
})

describe('chatStore rollActiveSessionAwayFrom (removed project fall-through)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
      undoStack: [],
      queuedMessagesBySession: {},
    })
    useUIStore.setState((s) => ({ ...s, removedProjects: [] }))
  })

  /** Seed N sessions bound to projects, with explicit activity anchors. Each
   *  gets a message so it's a real conversation (ghosts are skipped). */
  const seedSessions = (entries: Array<{ id: string; projectPath: string; lastUserMessageAt: number }>) => {
    for (const e of entries) {
      makeSession(e.id)
      addUser(e.id, 'hi')
    }
    useChatStore.setState((st) => ({
      activeSessionId: entries[0]?.id ?? null,
      sessions: st.sessions.map((s) => {
        const e = entries.find((x) => x.id === s.id)!
        return { ...s, projectPath: e.projectPath, lastUserMessageAt: e.lastUserMessageAt }
      }),
    }))
  }

  it('rolls the active conversation to the most recently used other-project session', () => {
    seedSessions([
      { id: 'a1', projectPath: '/proj-a', lastUserMessageAt: 100 },
      { id: 'b1', projectPath: '/proj-b', lastUserMessageAt: 300 },
      { id: 'c1', projectPath: '/proj-c', lastUserMessageAt: 400 },
    ])
    // Active = a1, the removed project's conversation
    useChatStore.getState().rollActiveSessionAwayFrom('/proj-a')
    expect(useChatStore.getState().activeSessionId).toBe('c1')
  })

  it('does nothing when the active conversation belongs to another project', () => {
    seedSessions([
      { id: 'a1', projectPath: '/proj-a', lastUserMessageAt: 100 },
      { id: 'b1', projectPath: '/proj-b', lastUserMessageAt: 300 },
    ])
    // Remove proj-b while proj-a's conversation is active → untouched
    useChatStore.getState().rollActiveSessionAwayFrom('/proj-b')
    expect(useChatStore.getState().activeSessionId).toBe('a1')
  })

  it('never rolls onto sessions of previously removed projects (no silent resurrection)', () => {
    seedSessions([
      { id: 'a1', projectPath: '/proj-a', lastUserMessageAt: 100 },
      { id: 'x1', projectPath: '/proj-x', lastUserMessageAt: 300 },
    ])
    // proj-x was removed earlier — rolling off proj-a must skip it
    useUIStore.setState((s) => ({ ...s, removedProjects: ['/proj-x'] }))
    useChatStore.getState().rollActiveSessionAwayFrom('/proj-a')
    expect(useChatStore.getState().activeSessionId).toBeNull()
  })

  it('clears the selection (and the persisted pointer) when no other project has conversations', () => {
    seedSessions([
      { id: 'a1', projectPath: '/proj-a', lastUserMessageAt: 100 },
      { id: 'a2', projectPath: '/proj-a', lastUserMessageAt: 200 },
    ])
    localStorage.setItem('lastActiveSessionId', 'a1')
    useChatStore.getState().rollActiveSessionAwayFrom('/proj-a')
    expect(useChatStore.getState().activeSessionId).toBeNull()
    // A restart must not bring the removed project's conversation back as active
    expect(localStorage.getItem('lastActiveSessionId')).toBeNull()
  })

  it('loadSessions skips sessions of removed projects when restoring the active one', async () => {
    const legacy = (id: string, projectPath: string) => ({
      id,
      title: id,
      configGroupId: 'cfg-1',
      model: '',
      modelParams: {},
      messages: [{ id: `${id}-m`, role: 'user', content: 'hi', createdAt: 100, sortOrder: 0 }],
      createdAt: 100,
      updatedAt: 100,
      projectPath,
      lastUserMessageAt: 100,
    })
    ;(mockApi.getSessions as any).mockResolvedValueOnce([legacy('a1', '/proj-a'), legacy('b1', '/proj-b')])
    useUIStore.setState((s) => ({ ...s, removedProjects: ['/proj-a'] }))
    // The persisted pointer targets the removed project's session
    localStorage.setItem('lastActiveSessionId', 'a1')

    await useChatStore.getState().loadSessions()

    expect(useChatStore.getState().activeSessionId).toBe('b1')
  })

  it('loadSessions keeps the selection empty when only removed projects have sessions', async () => {
    const legacy = (id: string, projectPath: string) => ({
      id,
      title: id,
      configGroupId: 'cfg-1',
      model: '',
      modelParams: {},
      messages: [{ id: `${id}-m`, role: 'user', content: 'hi', createdAt: 100, sortOrder: 0 }],
      createdAt: 100,
      updatedAt: 100,
      projectPath,
      lastUserMessageAt: 100,
    })
    ;(mockApi.getSessions as any).mockResolvedValueOnce([legacy('a1', '/proj-a')])
    useUIStore.setState((s) => ({ ...s, removedProjects: ['/proj-a'] }))
    localStorage.setItem('lastActiveSessionId', 'a1')

    await useChatStore.getState().loadSessions()

    expect(useChatStore.getState().activeSessionId).toBeNull()
  })
})

describe('checkpoint reload across session switches (issue: box disappears on return)', () => {
  beforeEach(() => {
    mockApi.checkpointList.mockReset()
    mockApi.checkpointList.mockImplementation(async (sessionId: string) => {
      if (sessionId === 's1') {
        return [{ id: 'cp1', sessionId: 's1', createdAt: 1, label: 'edit_file → a.ts', messageId: 'm1', files: [{ path: '/p/a.ts', content: 'x', existed: true }] }]
      }
      return []
    })
  })

  it('reloads checkpoints when switching back to a session', async () => {
    useChatStore.setState(initialState)
    useChatStore.getState().setActiveSession('s1')
    // wait for the async loadCheckpoints
    await vi.waitFor(() => {
      expect(useChatStore.getState().checkpoints.length).toBe(1)
    })
    // switch away to s2 (no checkpoints) — store should empty
    useChatStore.getState().setActiveSession('s2')
    await vi.waitFor(() => {
      expect(useChatStore.getState().checkpoints.length).toBe(0)
    })
    // switch back to s1 — must reload from store backend
    useChatStore.getState().setActiveSession('s1')
    await vi.waitFor(() => {
      expect(useChatStore.getState().checkpoints.length).toBe(1)
    })
    expect(useChatStore.getState().checkpoints[0].id).toBe('cp1')
  })
})

describe('chatStore window-mode isolation (一人公司与普通 agent 模式)', () => {
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

  it('importSession stamps the CURRENT window mode, ignoring the file mode', () => {
    // 测试环境 WINDOW_MODE='main'：导入一个 mode='office' 的备份，会话必须落到
    // 当前窗口的命名空间，否则同一对话会同时出现在两个窗口（交融/重复的根源）。
    const imported = {
      id: 'imported-id',
      title: '备份对话',
      configGroupId: 'cfg-1',
      model: 'm',
      modelParams: {},
      mode: 'office',
      messages: [{ id: 'm1', role: 'user', content: 'hi', sortOrder: 0, createdAt: 1 }],
      createdAt: 1,
      updatedAt: 1,
    }
    useChatStore.getState().importSession(JSON.stringify(imported))
    const session = useChatStore.getState().getActiveSession()!
    expect(session.mode).toBe('main')
    // 落盘时同样按当前窗口 mode 写入（SQLite 侧按 mode 过滤）
    const saved = mockApi.saveSession.mock.calls[0][0]
    expect(saved.mode).toBe('main')
    expect(saved.messages).toHaveLength(1)
  })

  it('createBranchFromMessage carries the source session window mode', () => {
    makeSession('s1')
    addUser('s1', 'a')
    addAssistant('s1', 'b')
    // 模拟办公室会话（office 模式）在主流程之外被分叉的场景
    useChatStore.setState((st) => ({
      sessions: st.sessions.map((x) => (x.id === 's1' ? { ...x, mode: 'office' } : x)),
    }))
    const msgId = useChatStore.getState().getActiveSession()!.messages[1].id
    useChatStore.getState().createBranchFromMessage('s1', msgId)
    const forked = useChatStore.getState().getActiveSession()!
    expect(forked.id).not.toBe('s1')
    expect(forked.mode).toBe('office')
    // 落盘 payload 同样带 office mode——否则 saveSession 会把它写成 main
    const saved = mockApi.saveSession.mock.calls[0][0]
    expect(saved.mode).toBe('office')
  })

  it('saveSession never persists a never-used ghost session (no DB accumulation)', async () => {
    makeSession('s1') // 新建的空会话
    await useChatStore.getState().saveSession('s1')
    expect(mockApi.saveSession).not.toHaveBeenCalled()
  })

  it('saveSession persists once the session has real content, and keeps persisting after clear', async () => {
    makeSession('s1')
    addUser('s1', 'hello')
    await useChatStore.getState().saveSession('s1')
    expect(mockApi.saveSession).toHaveBeenCalledTimes(1)
    // 清空全部消息后仍要落盘——「删除全部消息」必须跨重启生效（clearMessages
    // 自身会保存一次，这里再显式保存也绝不能因会话变空而被跳过）
    useChatStore.getState().clearMessages('s1')
    await useChatStore.getState().saveSession('s1')
    expect(mockApi.saveSession).toHaveBeenCalledTimes(3)
    const lastSaved = mockApi.saveSession.mock.calls[2][0]
    expect(lastSaved.messages).toHaveLength(0)
  })
})

describe('loop guard: truncated tool-call arguments', () => {
  it('flags arguments cut off mid-stream instead of throwing', () => {
    // A response that hits max_tokens leaves trailing tool calls with partial
    // JSON. The loop used to call JSON.parse directly, which threw and killed
    // the whole run.
    expect(parseToolArguments('{"path":"a.ts","content":"half')).toEqual({ args: {}, ok: false })
  })

  it('accepts complete arguments', () => {
    expect(parseToolArguments('{"path":"a.ts"}')).toEqual({ args: { path: 'a.ts' }, ok: true })
  })

  it('treats missing/empty arguments as a valid empty call', () => {
    expect(parseToolArguments(undefined)).toEqual({ args: {}, ok: true })
    expect(parseToolArguments('')).toEqual({ args: {}, ok: true })
  })

  it('does not execute non-object payloads as arguments', () => {
    expect(parseToolArguments('"just a string"')).toEqual({ args: {}, ok: true })
    expect(parseToolArguments('null')).toEqual({ args: {}, ok: true })
  })
})

describe('loop guard: identical-call detection', () => {
  const sig = (name: string, args: Record<string, unknown>) =>
    toolCallSignature({ id: 'x', name, arguments: args } as any)

  it('signatures of the same call match', () => {
    expect(sig('read_file', { path: 'a.ts' })).toBe(sig('read_file', { path: 'a.ts' }))
  })

  it('key order does not change the signature', () => {
    // Providers stream argument properties in arbitrary order; a naive
    // JSON.stringify would call these two distinct and never detect the loop.
    expect(sig('edit_file', { path: 'a.ts', oldText: 'x', newText: 'y' })).toBe(
      sig('edit_file', { newText: 'y', oldText: 'x', path: 'a.ts' }),
    )
  })

  it('different tool or different argument produces a different signature', () => {
    expect(sig('read_file', { path: 'a.ts' })).not.toBe(sig('read_file', { path: 'b.ts' }))
    expect(sig('read_file', { path: 'a.ts' })).not.toBe(sig('list_directory', { path: 'a.ts' }))
  })

  it('nested and array arguments compare structurally, not by reference', () => {
    expect(sig('multi_edit_file', { path: 'a', edits: [{ oldText: 'x' }, { oldText: 'y' }] })).toBe(
      sig('multi_edit_file', { edits: [{ oldText: 'x' }, { oldText: 'y' }], path: 'a' }),
    )
    expect(sig('multi_edit_file', { edits: [{ oldText: 'x' }] })).not.toBe(
      sig('multi_edit_file', { edits: [{ oldText: 'z' }] }),
    )
  })
})

describe('vision input: attachments → request images', () => {
  const img = (over: Partial<MessageAttachment> = {}): MessageAttachment => ({
    id: 'a1',
    name: 'shot.png',
    mimeType: 'image/png',
    dataBase64: 'iVBORw0KGgo=',
    ...over,
  })

  beforeEach(() => {
    useChatStore.setState({ ...initialState, sessions: [], activeSessionId: null, queuedMessagesBySession: {} })
    mockApi.saveSession.mockClear()
  })

  it('images become request image parts; non-images and empty payloads are dropped', () => {
    expect(toRequestImages([img(), img({ id: 'a2', name: 'b.jpg', mimeType: 'image/jpeg' })])).toEqual([
      { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
      { mimeType: 'image/jpeg', dataBase64: 'iVBORw0KGgo=' },
    ])
    // A text file attached as an image would be rejected by every provider.
    expect(toRequestImages([img({ mimeType: 'application/pdf' })])).toBeUndefined()
    expect(toRequestImages([img({ dataBase64: '' })])).toBeUndefined()
    expect(toRequestImages(undefined)).toBeUndefined()
  })

  it('sendMessage stores attachments on the user message', async () => {
    const sessionId = makeSession()
    // No API config here — the loop bails early; we only assert the message.
    await useChatStore.getState().sendMessage(sessionId, '看图', [], [img()]).catch(() => {})
    const user = useChatStore.getState().getActiveSession()!.messages.find((m) => m.role === 'user')
    expect(user?.attachments).toEqual([img()])
  })

  it('attachment base64 is shipped once, then stripped from later saves', async () => {
    const sessionId = makeSession()
    useChatStore.getState().addMessage(sessionId, { role: 'user', content: '看图', attachments: [img()] })

    await useChatStore.getState().saveSession(sessionId)
    const first = mockApi.saveSession.mock.calls[0][0]
    expect(first.messages[0].attachments[0].dataBase64).toBe('iVBORw0KGgo=')

    // Every agent round re-saves the whole session; a multi-hundred-KB base64
    // must not ride along each time (the main process keeps its own copy).
    await useChatStore.getState().saveSession(sessionId)
    const second = mockApi.saveSession.mock.calls[1][0]
    expect(second.messages[0].attachments).toBeUndefined()
  })
})

describe('chatStore subagent run persistence (一人公司任务流回看)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
      undoStack: [],
      queuedMessagesBySession: {},
      subagentProgress: {},
    })
  })

  function addSession(id: string, targetMode: boolean) {
    useChatStore.setState((s) => ({
      sessions: [...s.sessions, { id, title: id, configGroupId: 'cfg-1', model: 'm', messages: [], targetMode } as any],
    }))
    return id
  }

  const finished = (sessionId: string) => ({
    status: 'done' as const,
    sessionId,
    name: 'tm-developer',
    task: '实现登录页',
    startedAt: 1000,
    thinking: '一大段思考原文',
    steps: [{ id: 'st1', name: 'edit_file', arguments: { path: 'a.tsx' }, status: 'success' as const }],
    toolCallCount: 1,
    tokenCount: 500,
  })

  it('persists a terminal run of a target-mode session, minus the thinking blob', async () => {
    const sid = addSession('tm-1', true)
    useChatStore.getState().updateSubagentProgress('call-1', finished(sid))
    await vi.waitFor(() => expect(mockApi.saveSubagentRun).toHaveBeenCalledTimes(1))

    const [toolCallId, record] = mockApi.saveSubagentRun.mock.calls[0]
    expect(toolCallId).toBe('call-1')
    expect(record.status).toBe('done')
    expect(record.thinking).toBe('')
    expect(record.steps[0].arguments.path).toBe('a.tsx')
  })

  it('never persists agent-mode sessions or still-running records', async () => {
    const plain = addSession('agent-1', false)
    useChatStore.getState().updateSubagentProgress('call-plain', finished(plain))
    const tm = addSession('tm-2', true)
    useChatStore.getState().updateSubagentProgress('call-live', { ...finished(tm), status: 'running' })
    await Promise.resolve()
    expect(mockApi.saveSubagentRun).not.toHaveBeenCalled()
  })

  it('hydrates persisted runs on load without clobbering the live record', async () => {
    const sid = addSession('tm-3', true)
    useChatStore.getState().updateSubagentProgress('live', { ...finished(sid), status: 'running', tokenCount: 7 })
    mockApi.getSubagentRuns.mockResolvedValueOnce([
      { toolCallId: 'live', record: finished(sid) },
      { toolCallId: 'old', record: { ...finished(sid), startedAt: 500, task: '上一轮的任务' } },
      { toolCallId: 'junk', record: { status: 'done' } },
      { toolCallId: 'nosteps', record: null },
    ])

    await useChatStore.getState().hydrateSubagentRuns()
    const table = useChatStore.getState().subagentProgress
    expect(table.live.status).toBe('running')
    expect(table.old.task).toBe('上一轮的任务')
    expect(table.junk).toBeUndefined()
    expect(table.nosteps).toBeUndefined()
  })

  it('survives an older database that has no records yet', async () => {
    addSession('tm-4', true)
    mockApi.getSubagentRuns.mockRejectedValueOnce(new Error('no such table: subagent_runs'))
    await expect(useChatStore.getState().hydrateSubagentRuns()).resolves.toBeUndefined()
    expect(useChatStore.getState().subagentProgress).toEqual({})
  })
})

describe('deleting a session stops its run', () => {
  const reset = () => {
    vi.clearAllMocks()
    useChatStore.setState({ ...initialState, sessions: [], activeSessionId: null })
  }

  it('aborts the controller and drops every per-session leftover', () => {
    reset()
    const id = makeSession('del-1')
    const controller = new AbortController()
    useChatStore.setState((s) => ({
      runningSessionIds: [...s.runningSessionIds, id],
      abortControllers: { ...s.abortControllers, [id]: controller },
      queuedMessagesBySession: { ...s.queuedMessagesBySession, [id]: [{ content: '稍后发' } as never] },
      inboundQueue: [
        { targetSessionId: id, senderTitle: 'peer', content: '投给它', hold: false },
        { targetSessionId: 'other', senderTitle: 'peer', content: '别人的', hold: false },
      ],
      streamingBySession: { ...s.streamingBySession, [id]: { content: 'x', thinking: '' } },
      runPhaseBySession: { ...s.runPhaseBySession, [id]: 'tool' as never },
      activeRuns: { ...s.activeRuns, [id]: { runId: 'r1', sessionId: id } },
      agentTraces: { ...s.agentTraces, [id]: [] },
      batchApprovedBySession: { ...s.batchApprovedBySession, [id]: true },
    }))

    useChatStore.getState().deleteSession(id)

    // The run must be taken down, not orphaned: an un-aborted loop keeps writing
    // files in a workspace whose checkpoints were deleted with the session.
    expect(controller.signal.aborted).toBe(true)
    const st = useChatStore.getState()
    expect(st.sessions.find((x) => x.id === id)).toBeUndefined()
    expect(st.runningSessionIds).not.toContain(id)
    expect(st.queuedMessagesBySession[id]).toBeUndefined()
    expect(st.streamingBySession[id]).toBeUndefined()
    expect(st.runPhaseBySession[id]).toBeUndefined()
    expect(st.activeRuns[id]).toBeUndefined()
    expect(st.agentTraces[id]).toBeUndefined()
    expect(st.batchApprovedBySession[id]).toBeUndefined()
    // Only this session's queued inbound send goes; a peer's still lands.
    expect(st.inboundQueue.map((m) => m.targetSessionId)).toEqual(['other'])
    expect(mockApi.checkpointDelete).toHaveBeenCalledWith(id)
  })

  it('clears only the deleted session’s dialog slot', () => {
    reset()
    const gone = makeSession('del-2')
    useChatStore.setState({ activeSessionId: gone })
    const keep = makeSession('keep-1')
    const call = { id: 'c1', name: 'write_file', arguments: {} }
    useChatStore.setState({
      pendingApproval: { sessionId: keep, toolCall: call as never, preview: 'p' },
      pendingQuestion: { sessionId: keep, id: 'q1', question: '还在吗' } as never,
    })

    useChatStore.getState().deleteSession(gone)

    const st = useChatStore.getState()
    expect(st.pendingApproval?.sessionId).toBe(keep)
    expect(st.pendingQuestion?.sessionId).toBe(keep)

    useChatStore.getState().deleteSession(keep)
    expect(useChatStore.getState().pendingApproval).toBeNull()
    expect(useChatStore.getState().pendingQuestion).toBeNull()
  })
})

describe('reconcileInterruptedRuns (crash recovery)', () => {
  const run = (id: string, status: string) =>
    ({ id, task: 't', status, startedAt: 1, toolCallCount: 0, fileChangeCount: 0, stepCount: 0 } as never)

  it('turns a run left in-flight by a crash into a terminal error', () => {
    const session = { id: 's1', agentRuns: [run('a', 'running'), run('b', 'done')] }
    const fixed = reconcileInterruptedRuns(session)
    expect(fixed.agentRuns![0].status).toBe('error')
    expect(fixed.agentRuns![0].finishedAt).toBeTypeOf('number')
    expect(fixed.agentRuns![0].lastError).toContain('崩溃')
    expect(fixed.agentRuns![1].status).toBe('done')
  })

  it('leaves an already-settled session object untouched', () => {
    const session = { id: 's1', agentRuns: [run('b', 'stopped')] }
    expect(reconcileInterruptedRuns(session)).toBe(session)
    expect(reconcileInterruptedRuns({ id: 's2' })).toEqual({ id: 's2' })
  })
})

describe('reverting every snapshot of a path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({ ...initialState, sessions: [], activeSessionId: null })
  })

  it('applies newest first so it lands on the pre-AI state', async () => {
    const id = makeSession('ro-1')
    const cp = (cid: string, createdAt: number) => ({
      id: cid, sessionId: id, createdAt, label: '', messageId: '',
      files: [{ path: 'C:/p/a.ts', content: cid, existed: true }],
    })
    // loadCheckpoints returns ASC while an in-flight run prepends DESC — the
    // order used to decide the outcome, so '回退全部' restored a mid-run state
    // depending on whether the session had been re-opened.
    useChatStore.setState({ checkpoints: [cp('old', 1), cp('mid', 2), cp('new', 3)] as never })
    const applied: string[] = []
    mockApi.checkpointRevert.mockImplementation(async (cid: string) => {
      applied.push(cid)
      return { ok: true, restored: 1 }
    })

    await expect(useChatStore.getState().revertPathInSession(id, 'C:/p/a.ts')).resolves.toBe(true)
    expect(applied).toEqual(['new', 'mid', 'old'])
    expect(useChatStore.getState().checkpoints).toEqual([])
    expect(useChatStore.getState().revertedFiles).toContain('C:/p/a.ts')
  })
})

describe('decision backlog across parallel conversations', () => {
  const mk = (id: string) => ({ id, title: id, messages: [], configGroupId: 'c', model: 'm', createdAt: 1, updatedAt: 1 })
  const approval = (sessionId: string, callId: string): never =>
    ({ kind: 'approval', sessionId, value: { sessionId, toolCall: { id: callId, name: 'write_file', arguments: {} }, preview: callId } }) as never
  const question = (sessionId: string, q: string): never =>
    ({ kind: 'question', sessionId, value: { sessionId, id: q, question: q } }) as never

  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({ ...initialState, sessions: [mk('A'), mk('B')] as never, activeSessionId: 'A' })
  })

  it('parks a second decision instead of overwriting the one on screen', () => {
    const st = () => useChatStore.getState()
    st().offerDecision(approval('A', 'call-a'))
    st().offerDecision(approval('B', 'call-b'))

    // Overwriting used to leave A's run awaiting a dialog that no longer
    // existed, and B's answer would have been shown in A's conversation.
    expect(st().pendingApproval?.toolCall.id).toBe('call-a')
    expect(st().decisionBacklog.map((d) => d.sessionId)).toEqual(['B'])
  })

  it('swaps slots with the conversation the user switches to', () => {
    const st = () => useChatStore.getState()
    st().offerDecision(approval('A', 'call-a'))
    st().offerDecision(approval('B', 'call-b'))

    st().setActiveSession('B')
    expect(st().pendingApproval?.toolCall.id).toBe('call-b')
    expect(st().decisionBacklog.map((d) => d.sessionId)).toEqual(['A'])

    st().setActiveSession('A')
    expect(st().pendingApproval?.toolCall.id).toBe('call-a')
    // B's approval is still unanswered, so it goes back to the backlog.
    expect(st().decisionBacklog.map((d) => d.sessionId)).toEqual(['B'])

    // Switching to B surfaces it; answering B leaves A's own (unanswered)
    // approval parked rather than hijacking B's now-empty slot.
    st().setActiveSession('B')
    expect(st().pendingApproval?.toolCall.id).toBe('call-b')
    st().approveToolCall()
    expect(st().pendingApproval).toBeNull()
    expect(st().decisionBacklog.map((d) => d.sessionId)).toEqual(['A'])
  })

  it('promotes the next parked decision of the same session once answered', () => {
    const st = () => useChatStore.getState()
    st().offerDecision(question('A', 'q1'))
    st().offerDecision(question('A', 'q2'))
    expect(st().pendingQuestion?.question).toBe('q1')
    expect(st().decisionBacklog).toHaveLength(1)

    st().answerQuestion('答复一')
    expect(st().pendingQuestion?.question).toBe('q2')
    expect(st().decisionBacklog).toHaveLength(0)

    st().answerQuestion('答复二')
    expect(st().pendingQuestion).toBeNull()
  })

  it('clears only a deleted session’s parked decisions', () => {
    const st = () => useChatStore.getState()
    st().offerDecision(approval('A', 'call-a'))
    st().offerDecision(approval('B', 'call-b'))
    st().deleteSession('B')
    expect(st().decisionBacklog.map((d) => d.sessionId)).toEqual([])
    expect(st().pendingApproval?.toolCall.id).toBe('call-a')
  })

  it('never auto-rejects an approval that was never shown', () => {
    vi.useFakeTimers()
    try {
      const st = () => useChatStore.getState()
      st().offerDecision(approval('B', 'call-b'))
      vi.advanceTimersByTime(APPROVAL_AUTO_REJECT_MS + 1000)
      // The old 60s clock started at creation, so a background approval expired
      // unseen and the model got a bare "denied".
      expect(st().decisionBacklog).toHaveLength(1)
      expect(st().pendingApproval).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-rejects a shown approval once the user ignores it for 60s', () => {
    vi.useFakeTimers()
    try {
      const st = () => useChatStore.getState()
      st().offerDecision(approval('A', 'call-a'))
      expect(st().pendingApproval?.toolCall.id).toBe('call-a')
      vi.advanceTimersByTime(APPROVAL_AUTO_REJECT_MS + 1000)
      expect(st().pendingApproval).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
