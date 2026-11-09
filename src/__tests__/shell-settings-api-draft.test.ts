import { describe, expect, it } from 'vitest'

import type { ApiConfigGroup } from '@/types'
import {
  applyCatalogPreset,
  countHeaderLines,
  describeDraftDiff,
  draftDiff,
  draftFromGroup,
  emptyDraftForProvider,
  formatHeadersText,
  formatTokenCount,
  isFormatOverrideRisky,
  modelSpecLine,
  parseHeadersText,
  requiresApiKey,
  validateDraftForSave,
  validateDraftForTest,
  type ApiDraft,
} from '@/shell/settings/apiDraft'

const group: ApiConfigGroup = {
  id: 'g1',
  name: '主力模型',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  systemPrompt: '',
  defaultModel: 'gpt-4o-mini',
  provider: 'openai',
  apiFormat: 'auto',
  customHeaders: { 'X-A': '1' },
  skipTlsVerify: false,
  color: '#6C9EFF',
  createdAt: 1,
  updatedAt: 1,
}

function draft(overrides: Partial<ApiDraft> = {}): ApiDraft {
  return { ...draftFromGroup(group), ...overrides }
}

describe('apiDraft · 草稿构造', () => {
  it('按提供商预填名称与默认地址', () => {
    const empty = emptyDraftForProvider('anthropic')
    expect(empty.name).toContain('配置')
    expect(empty.baseUrl.length).toBeGreaterThan(0)
    expect(empty.apiFormat).toBe('auto')
    expect(empty.skipTlsVerify).toBe(false)
    expect(empty.customHeaders).toEqual({})
  })

  it('未知提供商也给出可用草稿（名称至少含配置二字）', () => {
    const empty = emptyDraftForProvider('nope')
    expect(empty.name).toBe('nope 配置')
    expect(empty.provider).toBe('nope')
  })

  it('已保存配置 → 草稿是深拷贝（改请求头不会回写 store 对象）', () => {
    const copy = draftFromGroup(group)
    copy.customHeaders['X-B'] = '2'
    expect(group.customHeaders).toEqual({ 'X-A': '1' })
    expect(copy.id).toBe('g1')
    expect(copy.defaultModel).toBe('gpt-4o-mini')
  })
})

describe('apiDraft · 请求头文本', () => {
  it('每行 Header: Value，忽略空行与缺值行', () => {
    const text = 'Authorization: Bearer sk-x\n\nX-API-Key\n: nokey\nX-Empty:   '
    expect(parseHeadersText(text)).toEqual({ Authorization: 'Bearer sk-x' })
    expect(countHeaderLines(text)).toBe(1)
  })

  it('首个冒号分键值（值里可以再有冒号）', () => {
    expect(parseHeadersText('X-Url: https://a/b')).toEqual({ 'X-Url': 'https://a/b' })
  })

  it('对象 → 文本可往返', () => {
    const text = formatHeadersText({ A: '1', B: '2' })
    expect(text).toBe('A: 1\nB: 2')
    expect(parseHeadersText(text)).toEqual({ A: '1', B: '2' })
  })

  it('undefined 返回空串', () => {
    expect(formatHeadersText(undefined)).toBe('')
    expect(countHeaderLines('')).toBe(0)
  })
})

describe('apiDraft · 保存校验', () => {
  const groups = [{ id: 'g1', name: '主力模型' }, { id: 'g2', name: '备用' }]

  it('名称 / 地址必填', () => {
    expect(validateDraftForSave({ name: '  ', baseUrl: 'https://a' }, groups)).toEqual({
      ok: false,
      error: '请填写配置名称',
    })
    expect(validateDraftForSave({ name: '新配置', baseUrl: '   ' }, groups)).toEqual({
      ok: false,
      error: '请填写 API 基础 URL',
    })
  })

  it('同名配置被拒绝，编辑自己不算重名', () => {
    expect(validateDraftForSave({ name: '备用', baseUrl: 'https://a' }, groups)).toEqual({
      ok: false,
      error: '配置名称已存在',
    })
    expect(validateDraftForSave({ id: 'g2', name: '备用', baseUrl: 'https://a' }, groups)).toEqual({ ok: true })
  })

  it('名称两侧空白不造成重名误判', () => {
    expect(validateDraftForSave({ name: ' 备用 ', baseUrl: 'https://a' }, groups)).toEqual({
      ok: false,
      error: '配置名称已存在',
    })
  })
})

describe('apiDraft · 测试连接校验', () => {
  it('地址必填', () => {
    expect(validateDraftForTest({ baseUrl: '', apiKey: 'k', provider: 'openai' })).toEqual({
      ok: false,
      error: '请先填写 API 基础 URL',
    })
  })

  it('Ollama / 自建中继可无密钥，其余必须有', () => {
    expect(requiresApiKey('ollama')).toBe(false)
    expect(requiresApiKey('custom')).toBe(false)
    expect(requiresApiKey('openai')).toBe(true)
    expect(validateDraftForTest({ baseUrl: 'http://localhost:11434', apiKey: '', provider: 'ollama' })).toEqual({ ok: true })
    expect(validateDraftForTest({ baseUrl: 'https://a', apiKey: '  ', provider: 'anthropic' })).toEqual({
      ok: false,
      error: '请先填写 API 密钥',
    })
  })
})

describe('apiDraft · 脏值比较', () => {
  it('完全相同 → 不脏', () => {
    const diff = draftDiff(draftFromGroup(group), draftFromGroup(group))
    expect(diff.dirty).toBe(false)
    expect(diff.fields).toEqual([])
  })

  it('尾部空格与请求头书写顺序不算修改', () => {
    const next = draft({
      name: ' 主力模型 ',
      baseUrl: 'https://api.example.com/v1 ',
      customHeaders: { 'X-A': '1' },
    })
    expect(draftDiff(draftFromGroup(group), next).dirty).toBe(false)
  })

  it('列出被改字段，且带中文说明', () => {
    const next = draft({ name: '新名字', skipTlsVerify: true, customHeaders: { 'X-A': '1', 'X-B': '2' } })
    const diff = draftDiff(draftFromGroup(group), next)
    expect(diff.dirty).toBe(true)
    expect(diff.fields).toEqual(['name', 'customHeaders', 'skipTlsVerify'])
    expect(describeDraftDiff(diff)).toBe('名称、请求头、证书校验')
  })

  it('apiFormat 的 undefined 与 auto 等价', () => {
    const saved = { ...draftFromGroup(group), apiFormat: undefined }
    const next = draft({ apiFormat: 'auto' })
    expect(draftDiff(saved, next).dirty).toBe(false)
    expect(draftDiff(saved, draft({ apiFormat: 'anthropic' })).fields).toEqual(['apiFormat'])
  })

  it('缺少任一侧 → 不脏（新建配置没有基线）', () => {
    expect(draftDiff(null, draft()).dirty).toBe(false)
    expect(draftDiff(draft(), null).dirty).toBe(false)
  })
})

describe('apiDraft · 格式覆盖提示', () => {
  it('跟随默认 / 与原生一致时不提示', () => {
    expect(isFormatOverrideRisky({ provider: 'openai', apiFormat: 'auto' })).toBe(false)
    expect(isFormatOverrideRisky({ provider: 'openai', apiFormat: undefined })).toBe(false)
    expect(isFormatOverrideRisky({ provider: 'openai', apiFormat: 'openai' })).toBe(false)
  })

  it('改成非原生格式时提示', () => {
    expect(isFormatOverrideRisky({ provider: 'openai', apiFormat: 'anthropic' })).toBe(true)
    expect(isFormatOverrideRisky({ provider: 'anthropic', apiFormat: 'openai' })).toBe(true)
  })
})

describe('apiDraft · 厂商目录预设', () => {
  const preset = {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'https://api.deepseek.com/v1',
    format: 'openai' as const,
    suggestedModels: ['deepseek-chat'],
  }

  it('新建时改写自动生成的名字并套用地址/模型', () => {
    const base = emptyDraftForProvider('openai')
    const next = applyCatalogPreset(base, preset, { isCreating: true })
    expect(next.name).toBe('DeepSeek 配置')
    expect(next.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(next.provider).toBe('deepseek')
    expect(next.apiFormat).toBe('auto')
    expect(next.defaultModel).toBe('deepseek-chat')
  })

  it('用户手写过的名字不被覆盖', () => {
    const base = { ...emptyDraftForProvider('openai'), name: '公司中转' }
    expect(applyCatalogPreset(base, preset, { isCreating: true }).name).toBe('公司中转')
    expect(applyCatalogPreset(base, preset, { isCreating: false }).name).toBe('公司中转')
  })

  it('已填的默认模型不被预设顶掉', () => {
    const base = { ...emptyDraftForProvider('openai'), defaultModel: 'gpt-4o' }
    expect(applyCatalogPreset(base, preset, { isCreating: true }).defaultModel).toBe('gpt-4o')
  })

  it('目录里没有可用地址的条目（Bedrock/Vertex）原样返回', () => {
    const base = emptyDraftForProvider('openai')
    const unchanged = applyCatalogPreset(base, { ...preset, api: '' }, { isCreating: true })
    expect(unchanged).toEqual(base)
  })

  it('非内置厂商落到 custom，并显式写 apiFormat', () => {
    const base = emptyDraftForProvider('openai')
    const next = applyCatalogPreset(
      base,
      { id: 'moonshot', name: 'Moonshot', api: 'https://api.moonshot.cn/v1', format: 'anthropic', suggestedModels: [] },
      { isCreating: true },
    )
    expect(next.provider).toBe('custom')
    expect(next.apiFormat).toBe('anthropic')
  })
})

describe('apiDraft · 模型展示', () => {
  it('formatTokenCount 走 K / M', () => {
    expect(formatTokenCount(0)).toBe('—')
    expect(formatTokenCount(undefined)).toBe('—')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(128000)).toBe('128K')
    expect(formatTokenCount(1_048_576)).toBe('1M')
    expect(formatTokenCount(2_097_152)).toBe('2M')
  })

  it('modelSpecLine 拼上下文 / 输出 / 输入', () => {
    expect(modelSpecLine({ contextWindow: 128000, maxOutputTokens: 8192, inputModalities: ['text', 'image'] })).toBe(
      '上下文 128K · 输出 8K · 输入 文本/图片',
    )
    expect(modelSpecLine({})).toBe('')
    expect(modelSpecLine(null)).toBe('')
    expect(modelSpecLine({ contextWindow: 32000 })).toBe('上下文 32K')
  })
})
