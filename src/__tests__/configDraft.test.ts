import { describe, it, expect } from 'vitest'
import { toFullConfigGroup } from '@/services/llm/configDraft'
import type { ApiConfigGroup } from '@/types'

/** Regression: the settings editor's draft → full group conversion used to drop
 *  skipTlsVerify, so "测试连接" against an intranet self-signed endpoint always
 *  failed with 证书校验失败 even with the box ticked. */
describe('toFullConfigGroup', () => {
  it('carries skipTlsVerify through to the request config', () => {
    const group = toFullConfigGroup({
      name: '内网网关',
      baseUrl: ' https://10.10.27.182:30082/api/v1 ',
      apiKey: ' sk-test ',
      provider: 'openai',
      skipTlsVerify: true,
    })
    expect(group.skipTlsVerify).toBe(true)
    expect(group.baseUrl).toBe('https://10.10.27.182:30082/api/v1')
    expect(group.apiKey).toBe('sk-test')
  })

  it('defaults skipTlsVerify to false and fills required fields', () => {
    const group: ApiConfigGroup = toFullConfigGroup({ baseUrl: 'https://api.example.com/v1' })
    expect(group.skipTlsVerify).toBe(false)
    expect(group.id).toBe('draft')
    expect(group.name).toBe('未命名配置')
    expect(group.provider).toBe('openai')
    expect(group.customHeaders).toEqual({})
  })

  it('ignores a non-boolean skipTlsVerify (persisted JSON may hold 0/1)', () => {
    const group = toFullConfigGroup({ baseUrl: 'https://x/v1', skipTlsVerify: 1 as unknown as boolean })
    expect(group.skipTlsVerify).toBe(false)
  })

  it('keeps the remaining request-relevant fields', () => {
    const group = toFullConfigGroup({
      id: 'g1',
      name: 'n',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      systemPrompt: 'sys',
      defaultModel: ' gpt-4o ',
      provider: 'anthropic',
      apiFormat: 'openai',
      customHeaders: { 'X-Tenant': 't' },
      color: '#123456',
      sortOrder: 3,
      createdAt: 1234,
    })
    expect(group).toMatchObject({
      id: 'g1',
      systemPrompt: 'sys',
      defaultModel: 'gpt-4o',
      provider: 'anthropic',
      apiFormat: 'openai',
      customHeaders: { 'X-Tenant': 't' },
      color: '#123456',
      sortOrder: 3,
      createdAt: 1234,
    })
    expect(group.updatedAt).toBeGreaterThan(0)
  })
})
