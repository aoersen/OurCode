import { describe, it, expect, afterEach } from 'vitest'
import {
  getCatalogModel,
  getCatalogProvider,
  getModelDefaults,
  listCatalogProviders,
} from '@shared/modelCatalog'
import {
  DEFAULT_CONTEXT_WINDOW,
  ALL_REASONING_LEVELS,
  getContextWindow,
  getConfiguredMaxOutputTokens,
  getReasoningLevels,
  getReasoningParamMap,
  resolveRequestMaxTokens,
} from '@/services/llm/modelDefaults'
import { useConfigStore } from '@/stores/configStore'
import type { CustomModel } from '@/types'

const customModel = (patch: Partial<CustomModel> & { id: string }): CustomModel => ({
  name: patch.id,
  provider: 'custom',
  createdAt: 0,
  ...patch,
})

afterEach(() => {
  useConfigStore.setState({ customModels: [] })
})

describe('catalog lookup', () => {
  it('resolves exact ids with context, output and modalities', () => {
    const spec = getCatalogModel('deepseek-flash')
    expect(spec).toBeDefined()
    expect(spec!.contextWindow).toBe(1_048_576)
    expect(spec!.maxOutputTokens).toBe(393_216)
    expect(spec!.inputModalities).toContain('image')
    expect(spec!.capabilities).toContain('tool_call')
  })

  it('is case-insensitive and strips decoration/date/provider prefixes', () => {
    expect(getCatalogModel('longcat-2.0')!.contextWindow).toBe(1_048_576)
    expect(getCatalogModel('deepseek-flash-2026-10-17')!.id).toBe('deepseek-flash')
    expect(getCatalogModel('mygateway/deepseek-flash')!.id).toBe('deepseek-flash')
    expect(getCatalogModel('deepseek-flash:free')!.id).toBe('deepseek-flash')
    expect(getCatalogModel('deepseek-flash@2026-10-17')!.id).toBe('deepseek-flash')
  })

  it('reads multimodal flags for the named small vendors', () => {
    const longcat = getCatalogModel('LongCat-2.5-Preview')!
    expect(longcat.contextWindow).toBe(1_048_576)
    expect(longcat.maxOutputTokens).toBe(262_144)
    expect(longcat.inputModalities).toEqual(['text', 'image'])

    const agnes = getCatalogModel('agnes-2.5-flash')!
    expect(agnes.contextWindow).toBe(512_000)
    expect(agnes.maxOutputTokens).toBe(65_536)
  })

  it('returns undefined for unknown ids', () => {
    expect(getCatalogModel('totally-unknown-model-xyz')).toBeUndefined()
  })

  it('exposes provider endpoints including Agnes AI and LongCat', () => {
    expect(getCatalogProvider('longcat')?.api).toBe('https://api.longcat.chat/openai')
    expect(getCatalogProvider('agnes')?.api).toBe('https://apihub.agnes-ai.com/v1')
    expect(getCatalogProvider('deepseek')?.api).toBe('https://api.deepseek.com')
    const ids = listCatalogProviders().map((p) => p.id)
    expect(ids).toContain('longcat')
    expect(ids).toContain('agnes')
  })

  it('derives reasoning levels from the vendor metadata', () => {
    // effort list (low/high/max) → off + those
    expect(getCatalogModel('deepseek-flash')!.reasoningLevels).toEqual(['off', 'low', 'high', 'max'])
    // toggle-only reasoning → off/high
    expect(getCatalogModel('LongCat-2.0')!.reasoningLevels).toEqual(['off', 'high'])
  })

  it('getModelDefaults mirrors the spec', () => {
    expect(getModelDefaults('agnes-2.5-flash')).toMatchObject({
      contextWindow: 512_000,
      maxOutputTokens: 65_536,
    })
    expect(getModelDefaults('totally-unknown-model-xyz')).toBeUndefined()
  })
})

describe('effective defaults', () => {
  it('prefers the user model config over everything', () => {
    useConfigStore.setState({
      customModels: [customModel({ id: 'deepseek-flash', contextWindow: 500_000, maxOutputTokens: 8_192 })],
    })
    expect(getContextWindow('deepseek-flash')).toBe(500_000)
    expect(getConfiguredMaxOutputTokens('deepseek-flash')).toBe(8_192)
  })

  it('keeps the curated table ahead of the generated catalog', () => {
    expect(getContextWindow('deepseek-chat')).toBe(200_000)
  })

  it('falls back to the catalog, then the 128K default', () => {
    expect(getContextWindow('agnes-2.5-flash')).toBe(512_000)
    expect(getContextWindow('totally-unknown-model-xyz')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('matches a gateway-prefixed session model to the bare custom id', () => {
    useConfigStore.setState({ customModels: [customModel({ id: 'my-ollama', contextWindow: 8_192 })] })
    expect(getContextWindow('gateway/my-ollama')).toBe(8_192)
  })

  it('applies the saved output cap only when the session has no override', () => {
    useConfigStore.setState({
      customModels: [customModel({ id: 'deepseek-flash', maxOutputTokens: 4_096 })],
    })
    expect(resolveRequestMaxTokens('deepseek-flash', 0)).toBe(4_096)
    expect(resolveRequestMaxTokens('deepseek-flash', 1_024)).toBe(1_024)
    // Catalog-only output stays a reference; it is not sent automatically.
    useConfigStore.setState({ customModels: [] })
    expect(getConfiguredMaxOutputTokens('deepseek-flash')).toBeUndefined()
    expect(resolveRequestMaxTokens('deepseek-flash', 0)).toBe(0)
  })

  it('filters thinking levels by model config, else catalog, else all', () => {
    expect(getReasoningLevels('deepseek-flash')).toEqual(['off', 'low', 'high', 'max'])
    useConfigStore.setState({
      customModels: [customModel({ id: 'deepseek-flash', reasoningLevels: ['off', 'high'] })],
    })
    expect(getReasoningLevels('deepseek-flash')).toEqual(['off', 'high'])
    expect(getReasoningLevels('totally-unknown-model-xyz')).toEqual(ALL_REASONING_LEVELS)
  })

  it('parses the reasoning param map and accepts disabled as off', () => {
    useConfigStore.setState({
      customModels: [customModel({
        id: 'deepseek-flash',
        reasoningParamMap: JSON.stringify({
          disabled: { reasoning_effort: null },
          low: { reasoning_effort: 'low' },
        }),
      })],
    })
    expect(getReasoningParamMap('deepseek-flash', 'off')).toEqual({ reasoning_effort: null })
    expect(getReasoningParamMap('deepseek-flash', 'low')).toEqual({ reasoning_effort: 'low' })
    expect(getReasoningParamMap('deepseek-flash', 'high')).toBeUndefined()

    useConfigStore.setState({ customModels: [customModel({ id: 'deepseek-flash', reasoningParamMap: '{bad json' })] })
    expect(getReasoningParamMap('deepseek-flash', 'low')).toBeUndefined()
  })

  it('upserts configs by id and preserves the original createdAt', () => {
    useConfigStore.setState({ customModels: [], configGroups: [], activeConfigGroupId: null })
    useConfigStore.getState().upsertCustomModel({
      id: 'my-model', name: 'My Model', provider: 'custom', contextWindow: 1_000,
    })
    const created = useConfigStore.getState().customModels[0]
    expect(created.createdAt).toBeGreaterThan(0)

    useConfigStore.getState().upsertCustomModel({
      id: 'my-model', name: 'My Model', provider: 'custom', contextWindow: 2_000, createdAt: 1,
    })
    const list = useConfigStore.getState().customModels
    expect(list).toHaveLength(1)
    expect(list[0].contextWindow).toBe(2_000)
    expect(list[0].createdAt).toBe(created.createdAt)
  })
})
