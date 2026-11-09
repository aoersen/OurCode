/**
 * composer 模型浮层的纯逻辑（`menus/modelMenu.ts`）。
 *
 * 这里覆盖的是「哪些字段能显示、显示成什么」——能力行不许发明配置里没有的能力，
 * 收藏条顺序要跟 favoriteModelIds 一致，思考档位必须来自 getReasoningLevels。
 */
import { describe, it, expect, vi } from 'vitest'

// 和 chatStore/contextUsage 两个既有测试一样的两道 shim：模型能力行的上下文容量
// 走 `formatTokenCount`，那条 import 链会拉到 monaco 的浏览器模块（导入期读
// `window`）。vi.mock 会被提升，所以它们先于下面的 import 生效。
vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))
vi.stubGlobal('window', { electronAPI: {} })

import {
  capabilityTags,
  effectiveThinkingLevel,
  favoriteNames,
  filterModels,
  modelName,
  prettyModelId,
  sortThinkingLevels,
  stepThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelsFor,
} from '@/shell/agent/composer/menus/modelMenu'
import type { CustomModel, ModelInfo } from '@/types'

function model(partial: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: partial.id,
    isFree: false,
    isFavorite: false,
    ...partial,
  } as ModelInfo
}

const MODELS: ModelInfo[] = [
  model({ id: 'claude-sonnet-4-5', alias: 'Sonnet 4.5', contextWindow: 200_000, vision: true, functionCall: true }),
  model({ id: 'deepseek-chat', alias: 'DeepSeek Chat', contextWindow: 128_000 }),
  model({ id: 'gpt-4o-mini', isFree: true, vision: true }),
]

describe('modelName / prettyModelId', () => {
  it('prefers the alias and falls back to a readable id', () => {
    expect(modelName(MODELS[0])).toBe('Sonnet 4.5')
    expect(modelName({ id: 'claude-sonnet-4-5' })).toBe('Claude Sonnet 4.5')
    expect(prettyModelId('gpt-4o-mini')).toBe('Gpt 4o Mini')
  })

  it('keeps the raw id when nothing can be prettified', () => {
    expect(prettyModelId('')).toBe('')
  })
})

describe('filterModels', () => {
  it('matches id substrings, case-insensitively', () => {
    expect(filterModels(MODELS, 'DEEPSEEK').map((m) => m.id)).toEqual(['deepseek-chat'])
    expect(filterModels(MODELS, 'sonnet').map((m) => m.id)).toEqual(['claude-sonnet-4-5'])
  })

  it('matches aliases too', () => {
    expect(filterModels(MODELS, 'chat').map((m) => m.id)).toEqual(['deepseek-chat'])
    expect(filterModels(MODELS, 'sonnet 4.5').map((m) => m.id)).toEqual(['claude-sonnet-4-5'])
  })

  it('returns the full list for an empty/blank query without mutating the input', () => {
    const all = filterModels(MODELS, '   ')
    expect(all.map((m) => m.id)).toEqual(MODELS.map((m) => m.id))
    expect(all).not.toBe(MODELS)
  })

  it('returns nothing when the query matches no id or alias', () => {
    expect(filterModels(MODELS, 'llama')).toEqual([])
  })
})

describe('capabilityTags', () => {
  it('builds the line only from fields the config really has', () => {
    expect(capabilityTags(MODELS[0], 'zh-CN')).toEqual(['200K', '视觉', '函数调用'])
  })

  it('omits fields that are absent or false instead of inventing them', () => {
    // 没有 contextWindow / vision / functionCall 字段
    expect(capabilityTags({ isFree: false }, 'zh-CN')).toEqual([])
    // false 是「没有这项能力」，不该渲染成一行噪音
    expect(capabilityTags({ vision: false, functionCall: false, isFree: false }, 'zh-CN')).toEqual([])
  })

  it('shows the free flag and localizes the words', () => {
    expect(capabilityTags(MODELS[2], 'zh-CN')).toEqual(['视觉', '免费'])
    expect(capabilityTags(MODELS[2], 'en-US')).toEqual(['Vision', 'Free'])
  })

  it('formats large windows with the shared token formatter', () => {
    expect(capabilityTags({ contextWindow: 1_000_000 }, 'zh-CN')).toEqual(['1.0M'])
    expect(capabilityTags({ contextWindow: 32_000 }, 'zh-CN')).toEqual(['32.0K'])
  })
})

describe('favoriteNames', () => {
  it('keeps favoriteModelIds order, drops unknown ids and caps the line at 4', () => {
    const ids = ['gpt-4o-mini', 'missing-model', 'deepseek-chat', 'claude-sonnet-4-5']
    expect(favoriteNames(MODELS, ids)).toEqual(['Gpt 4o Mini', 'DeepSeek Chat', 'Sonnet 4.5'])
  })

  it('respects the limit argument', () => {
    const ids = ['gpt-4o-mini', 'deepseek-chat', 'claude-sonnet-4-5']
    expect(favoriteNames(MODELS, ids, 2)).toEqual(['Gpt 4o Mini', 'DeepSeek Chat'])
  })

  it('is empty when nothing is favorited', () => {
    expect(favoriteNames(MODELS, [])).toEqual([])
  })
})

describe('thinking levels', () => {
  const custom = (partial: Partial<CustomModel> & { id: string }): CustomModel =>
    ({ name: partial.id, provider: 'openai', createdAt: 0, ...partial }) as CustomModel

  it('defaults to every level when the model restricts nothing', () => {
    expect(thinkingLevelsFor('some-unknown-model', [])).toEqual(['off', 'low', 'medium', 'high', 'max'])
    expect(thinkingLevelsFor('', [])).toEqual(['off', 'low', 'medium', 'high', 'max'])
  })

  it('honours the custom model reasoningLevels and re-sorts them canonically', () => {
    const models = [custom({ id: 'deepseek-reasoner', reasoningLevels: ['max', 'off', 'medium'] })]
    expect(thinkingLevelsFor('deepseek-reasoner', models)).toEqual(['off', 'medium', 'max'])
  })

  it('drops unknown level strings', () => {
    expect(sortThinkingLevels(['high', 'turbo', 'off'])).toEqual(['off', 'high'])
  })

  it('labels come from the design copy', () => {
    expect(thinkingLevelLabel('off', 'zh-CN')).toBe('关')
    expect(thinkingLevelLabel('max', 'zh-CN')).toBe('最高')
    expect(thinkingLevelLabel('medium', 'en-US')).toBe('Med')
  })

  it('←/→ stops at both ends instead of wrapping', () => {
    const levels = sortThinkingLevels(['off', 'medium', 'max'])
    expect(stepThinkingLevel(levels, 'off', -1)).toBe('off')
    expect(stepThinkingLevel(levels, 'off', 1)).toBe('medium')
    expect(stepThinkingLevel(levels, 'max', 1)).toBe('max')
    expect(stepThinkingLevel(levels, 'medium', -1)).toBe('off')
  })

  it('falls back to the first supported level when the stored one is unsupported', () => {
    expect(effectiveThinkingLevel(['off', 'high'], 'max')).toBe('off')
    expect(effectiveThinkingLevel(['off', 'high'], 'high')).toBe('high')
    expect(effectiveThinkingLevel([], 'high')).toBe('high')
  })
})
