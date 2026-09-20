import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatSession } from '@/types'
import {
  parseSessionReferences,
  findSessionByIdOrTitle,
  formatSessionTranscript,
  buildReferenceBlock,
  searchSessionsForQuery,
  MAX_REFERENCE_MESSAGES,
  MAX_MESSAGE_CHARS,
} from '@/services/sessionKnowledge'

let seq = 0
function msg(role: ChatMessage['role'], content: string, toolCalls?: Array<{ name: string }>): ChatMessage {
  return {
    id: `m${++seq}`,
    role,
    content,
    sortOrder: seq,
    contextFiles: [],
    tokenCount: 0,
    createdAt: 0,
    toolCalls: toolCalls as any,
  }
}

function session(id: string, title: string, messages: ChatMessage[]): ChatSession {
  return {
    id,
    title,
    configGroupId: 'cfg',
    model: '',
    modelParams: {} as any,
    messages,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('parseSessionReferences', () => {
  it('extracts and dedups #sess_<id> references', () => {
    expect(parseSessionReferences('参考 #sess_abc 和 #sess_def 以及 #sess_abc 的结论')).toEqual(['abc', 'def'])
  })

  it('returns [] when there are no references', () => {
    expect(parseSessionReferences('普通消息 sess_abc #foo')).toEqual([])
  })
})

describe('findSessionByIdOrTitle', () => {
  const a = session('aaaa-1111', '接口设计', [])
  const b = session('aaaa-2222', '部署脚本', [])

  it('matches exact id first, then a unique prefix, and title', () => {
    expect(findSessionByIdOrTitle([a, b], 'aaaa-1111')?.id).toBe('aaaa-1111')
    expect(findSessionByIdOrTitle([a, b], 'aaaa-1111-extra')?.id).toBe(undefined)
    expect(findSessionByIdOrTitle([a, b], 'aaaa-2')?.id).toBe('aaaa-2222')
    expect(findSessionByIdOrTitle([a, b], undefined, '部署脚本')?.id).toBe('aaaa-2222')
  })

  it('an ambiguous prefix resolves to nothing', () => {
    expect(findSessionByIdOrTitle([a, b], 'aaaa')).toBeUndefined()
  })
})

describe('formatSessionTranscript', () => {
  it('renders a bounded tail with a header and skips empty messages', () => {
    const s = session('s1', 'T', [
      msg('user', '第一条'),
      msg('assistant', ''),
      msg('user', '第二条'),
    ])
    const out = formatSessionTranscript(s, 2)
    expect(out).toContain('会话「T」')
    expect(out).toContain('用户：第二条')
    expect(out).not.toContain('第一条') // outside the tail window
    expect(out).not.toContain('助手：') // empty message skipped
  })

  it('caps message length', () => {
    const s = session('s1', 'T', [msg('user', 'x'.repeat(MAX_MESSAGE_CHARS + 100))])
    expect(formatSessionTranscript(s)).toContain('(截断)')
  })
})

describe('buildReferenceBlock', () => {
  it('includes tool-call notes and is bounded to MAX_REFERENCE_MESSAGES', () => {
    const messages = Array.from({ length: MAX_REFERENCE_MESSAGES + 5 }, (_, i) =>
      i === MAX_REFERENCE_MESSAGES + 4
        ? msg('assistant', '完成', [{ name: 'write_file' }, { name: 'run_command' }])
        : msg('user', `m${i}`),
    )
    const out = buildReferenceBlock(session('s1', 'T', messages))
    expect(out).toContain('<referenced_session')
    expect(out).toContain('[调用了 2 个工具：write_file、run_command]')
    // The first messages fell outside the tail window.
    expect(out).not.toContain('m0')
  })
})

describe('searchSessionsForQuery', () => {
  it('is case-insensitive and keeps one hit per session (newest first)', () => {
    const s1 = session('s1', 'A', [msg('user', '讨论过 Redis 缓存'), msg('user', 'Redis 又提到了')])
    const s2 = session('s2', 'B', [msg('assistant', '这里没有')])
    const hits = searchSessionsForQuery([s1, s2], 'REDIS')
    expect(hits).toHaveLength(1)
    expect(hits[0].sessionId).toBe('s1')
    expect(hits[0].snippet).toContain('Redis 又提到了') // newest hit wins
  })

  it('caps the number of returned sessions and handles empty queries', () => {
    const sessions = ['a', 'b', 'c'].map((id) => session(id, id, [msg('user', '关键字')]))
    expect(searchSessionsForQuery(sessions, '关键字', 2)).toHaveLength(2)
    expect(searchSessionsForQuery(sessions, '  ')).toEqual([])
  })
})
