import { describe, expect, it } from 'vitest'
import { classifyError } from '../shell/agent/errors'

describe('classifyError', () => {
  it('recognises auth failures and offers settings', () => {
    for (const message of [
      '401 Unauthorized',
      'invalid_api_key: bad key',
      'API Key 未配置',
      '鉴权失败',
    ]) {
      const view = classifyError(message)
      expect(view.kind).toBe('auth')
      expect(view.action).toBe('settings')
      expect(view.hint.length).toBeGreaterThan(6)
    }
  })

  it('recognises context window overflow and suggests a new session', () => {
    for (const message of [
      'context_length_exceeded',
      'This model maximum context length is 200000 tokens',
      '上下文超出长度限制',
    ]) {
      const view = classifyError(message)
      expect(view.kind).toBe('context')
      expect(view.action).toBe('newSession')
    }
  })

  it('recognises rate limits and network failures as retryable', () => {
    expect(classifyError('429 rate limit reached').kind).toBe('rate')
    expect(classifyError('429 rate limit reached').action).toBe('retry')
    expect(classifyError('fetch failed: ECONNREFUSED 127.0.0.1:11434').kind).toBe('network')
    expect(classifyError('连接超时').action).toBe('retry')
  })

  it('falls back to the raw message with a retry action', () => {
    const view = classifyError('some unexpected tool crash')
    expect(view.kind).toBe('other')
    expect(view.hint).toBe('some unexpected tool crash')
    expect(view.actionLabel).toBe('重试')
  })

  it('never returns an empty hint', () => {
    for (const input of [undefined, null, '', '   ']) {
      expect(classifyError(input).hint.length).toBeGreaterThan(0)
    }
  })
})
