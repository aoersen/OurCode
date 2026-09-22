import { create } from 'zustand'
import { ApiConfigGroup, ModelInfo, ModelParams, CustomModel, DEFAULT_MODEL_PARAMS, lookupModelMetadata } from '@/types'
import { fetchModels as llmFetchModels, sendLLMRequest } from '@/services/llm/LLMClient'
import { buildChatUrl, buildModelsUrl, resolveFormat } from '@/services/llm/endpoints'
import { v4 as uuidv4 } from 'uuid'

/** Resolve environment variable references in API key (e.g. $OPENAI_API_KEY) */
async function resolveEnvVars(value: string): Promise<string> {
  if (!value || !value.startsWith('$')) return value
  const envVarName = value.slice(1)
  try {
    const resolved = await window.electronAPI.resolveEnvVar(envVarName)
    return resolved || value
  } catch {
    return value
  }
}

/** One check inside a connection test (model list / chat probe). */
export interface ConnectionStep {
  name: string
  ok: boolean
  detail: string
  url?: string
  ms?: number
}

/** Full result of a connection test, with per-step detail so the UI can show progress. */
export interface ConnectionTestResult {
  success: boolean
  message: string
  steps: ConnectionStep[]
}

/** Connection tests are probes — 15s per call is enough, no need for the full 30s. */
const TEST_TIMEOUT_MS = 15_000

/** localStorage keys for cross-restart state restoration */
const LAST_GROUP_KEY = 'lastActiveConfigGroupId'
const LAST_MODEL_KEY = 'lastModelByGroup'
const MODELS_CACHE_KEY = 'modelsCache_v2'

/** Last model selected for a config group (restored when creating a new session). */
export function getLastModelForGroup(groupId: string): string {
  try {
    const map = JSON.parse(localStorage.getItem(LAST_MODEL_KEY) || '{}')
    return map[groupId] || ''
  } catch {
    return ''
  }
}

export function setLastModelForGroup(groupId: string, modelId: string): void {
  if (!groupId) return
  try {
    const map = JSON.parse(localStorage.getItem(LAST_MODEL_KEY) || '{}')
    map[groupId] = modelId
    localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(map))
  } catch { /* ignore */ }
}

function enrichModel(id: string, _provider: string): ModelInfo {
  const favorites = useConfigStore.getState().favoriteModelIds
  const custom = useConfigStore.getState().customModels.find((c) => c.id === id)
  const meta = lookupModelMetadata(id)
  return {
    id,
    name: custom?.name || id,
    isFree: id.includes('free') || id.includes('gpt-3.5') || id.includes('llama') || id.includes('mistral') || id.includes('gemma'),
    isFavorite: favorites.includes(id),
    contextWindow: custom?.contextWindow || meta?.contextWindow,
    vision: custom?.vision ?? meta?.vision,
    functionCall: custom?.functionCall ?? meta?.functionCall,
  }
}

/** Merge API-fetched models with the user's manually-added custom models for this provider. */
function mergeWithCustom(ids: string[], provider: string): ModelInfo[] {
  const apiModels = ids.map((id) => enrichModel(id, provider))
  const customForGroup = useConfigStore.getState().customModels
    .filter((c) => c.provider === provider)
    .map((c) => enrichModel(c.id, provider))
  const existingIds = new Set(apiModels.map((m) => m.id))
  return [...apiModels, ...customForGroup.filter((m) => !existingIds.has(m.id))]
}

/** Effective chat URL a config would POST to (for previews and test reporting). */
function chatRequestUrl(group: ApiConfigGroup, model?: string): string {
  const fmt = resolveFormat(group.provider, group.apiFormat)
  const url = buildChatUrl(group.baseUrl, fmt, model)
  return fmt === 'gemini' ? `${url}?key=…` : url
}

/** Effective model-list URL a config would GET (null when unsupported). */
function modelsRequestUrl(group: ApiConfigGroup): string | null {
  const fmt = resolveFormat(group.provider, group.apiFormat)
  const url = buildModelsUrl(group.baseUrl, fmt)
  if (!url) return null
  return fmt === 'gemini' ? `${url}?key=…` : url
}

/** Attach a practical hint when a probe 404s — usually a wrong base-URL path. */
function detailWithHint(message: string): string {
  if (/\b404\b/.test(message)) {
    return `${message}（提示：404 通常是 base URL 路径不对，很多中转站接口在 /openai/v1 下而非 /v1）`
  }
  return message
}

export interface ConfigState {
  configGroups: ApiConfigGroup[]
  activeConfigGroupId: string | null
  models: ModelInfo[]
  isLoadingModels: boolean
  modelParams: ModelParams
  favoriteModelIds: string[]
  modelsCache: Record<string, { models: string[]; timestamp: number }> // groupId -> cached models
  modelsError: string | null // error message from last model fetch
  customModels: CustomModel[] // user-added custom models

  // Actions
  loadConfigGroups: () => Promise<void>
  createConfigGroup: (group: Partial<ApiConfigGroup>) => Promise<ApiConfigGroup>
  updateConfigGroup: (id: string, updates: Partial<ApiConfigGroup>) => Promise<void>
  deleteConfigGroup: (id: string) => Promise<void>
  setActiveConfigGroup: (id: string) => void
  getActiveConfigGroup: () => ApiConfigGroup | undefined
  /**
   * 取「会话所属」的配置组：session 绑定的配置组优先（它的 baseUrl/key 才与会话
   * 里的模型名匹配）；会话没有绑定组（旧会话/与会话无关的界面操作）时回退到
   * 当前活动组。辅助调用（标题生成/记忆浓缩/read_url 等）一律走这里，直接用
   * getActiveConfigGroup() 会把 A 组的模型名发到 B 组的端点 → 400。
   */
  getConfigGroupFor: (id?: string | null) => ApiConfigGroup | undefined

  fetchModels: (configGroupId?: string) => Promise<void>
  /** Fetch models for an arbitrary (possibly unsaved) config — used by the settings editor. */
  fetchModelsForGroup: (group: ApiConfigGroup) => Promise<ModelInfo[]>
  setModelParams: (params: Partial<ModelParams>) => void
  toggleFavorite: (modelId: string) => void
  addCustomModel: (model: Omit<CustomModel, 'id' | 'createdAt'>) => void
  removeCustomModel: (modelId: string) => void

  /** Test a saved config group by id */
  testConnection: (configGroupId: string, onStep?: (step: ConnectionStep) => void) => Promise<ConnectionTestResult>
  /** Test an arbitrary (possibly unsaved) config group — used by the settings editor */
  testConnectionGroup: (group: ApiConfigGroup, onStep?: (step: ConnectionStep) => void) => Promise<ConnectionTestResult>
  exportConfigGroups: (password?: string) => Promise<string>
  importConfigGroups: (data: string, password?: string) => Promise<void>
  reorderConfigGroups: (fromIndex: number, toIndex: number) => void
  resetStore: () => void
}

/** Persist & restore models cache so restarts avoid a full model-list API call. */
function loadModelsCache(): Record<string, { models: string[]; timestamp: number }> {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    // Basic shape guard — skip entirely malformed payloads
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Filter out individual corrupted entries instead of discarding everything
    const clean: Record<string, { models: string[]; timestamp: number }> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as any
      if (Array.isArray(entry?.models) && typeof entry?.timestamp === 'number') {
        clean[key] = entry
      }
    }
    return clean
  } catch {
    return {}
  }
}

function saveModelsCache(cache: Record<string, { models: string[]; timestamp: number }>): void {
  try {
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(cache))
  } catch { /* ignore */ }
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  configGroups: [],
  activeConfigGroupId: null,
  models: [],
  isLoadingModels: false,
  modelParams: DEFAULT_MODEL_PARAMS,
  favoriteModelIds: JSON.parse(localStorage.getItem('favoriteModelIds') || '[]'),
  modelsCache: loadModelsCache(),
  modelsError: null,
  customModels: JSON.parse(localStorage.getItem('customModels') || '[]'),

  loadConfigGroups: async () => {
    try {
      const groups = await window.electronAPI.getConfigGroups()
      // Resolve environment variable references in API keys
      const resolvedGroups = await Promise.all(
        groups.map(async (g) => ({
          ...g,
          apiKey: await resolveEnvVars(g.apiKey),
        }))
      )
      set({ configGroups: resolvedGroups })
      // Restore the previously active config group across restarts (only on the
      // first load — a group already selected by the user in this session wins).
      if (resolvedGroups.length > 0 && !get().activeConfigGroupId) {
        const lastGroupId = localStorage.getItem(LAST_GROUP_KEY)
        const restored = resolvedGroups.find((g) => g.id === lastGroupId)
        set({ activeConfigGroupId: restored ? restored.id : resolvedGroups[0].id })
      }
    } catch (error) {
      console.error('加载配置组失败:', error instanceof Error ? error.message : 'Unknown error')
    }
  },

  createConfigGroup: async (groupData) => {
    const group = {
      id: uuidv4(),
      name: groupData.name || '新配置组',
      baseUrl: groupData.baseUrl || 'https://api.openai.com/v1',
      apiKey: (groupData.apiKey || '').trim(),
      systemPrompt: groupData.systemPrompt || '',
      defaultModel: groupData.defaultModel || '',
      provider: groupData.provider || 'openai' as const,
      apiFormat: groupData.apiFormat,
      customHeaders: groupData.customHeaders || {},
      color: groupData.color,
      skipTlsVerify: groupData.skipTlsVerify ?? false,
      // Append after existing groups so the persisted order stays intuitive
      sortOrder: groupData.sortOrder ?? get().configGroups.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const saved = await window.electronAPI.saveConfigGroup(group)
    localStorage.setItem(LAST_GROUP_KEY, saved.id)
    set((s) => ({
      configGroups: [saved, ...s.configGroups],
      activeConfigGroupId: saved.id,
    }))
    return saved
  },

  updateConfigGroup: async (id, updates) => {
    const group = get().configGroups.find((g) => g.id === id)
    if (!group) return

    const updated = {
      ...group,
      ...updates,
      apiKey: updates.apiKey !== undefined ? (updates.apiKey || '').trim() : group.apiKey,
    }
    await window.electronAPI.saveConfigGroup(updated)
    set((s) => ({
      configGroups: s.configGroups.map((g) => (g.id === id ? updated : g)),
    }))
  },

  deleteConfigGroup: async (id) => {
    await window.electronAPI.deleteConfigGroup(id)
    set((s) => {
      const newGroups = s.configGroups.filter((g) => g.id !== id)
      return {
        configGroups: newGroups,
        activeConfigGroupId: s.activeConfigGroupId === id
          ? newGroups[0]?.id || null
          : s.activeConfigGroupId,
      }
    })
  },

  setActiveConfigGroup: (id) => {
    localStorage.setItem(LAST_GROUP_KEY, id)
    set({ activeConfigGroupId: id, models: [] })
    get().fetchModels(id)
  },

  getActiveConfigGroup: () => {
    const { configGroups, activeConfigGroupId } = get()
    return configGroups.find((g) => g.id === activeConfigGroupId)
  },

  getConfigGroupFor: (id) => {
    const { configGroups } = get()
    if (id) {
      const hit = configGroups.find((g) => g.id === id)
      if (hit) return hit
    }
    return get().getActiveConfigGroup()
  },

  fetchModels: async (configGroupId) => {
    const groupId = configGroupId || get().activeConfigGroupId
    const group = get().configGroups.find((g) => g.id === groupId)
    if (!group) return

    // Check cache (1 hour TTL)
    const cache = get().modelsCache[groupId!]
    const CACHE_TTL = 60 * 60 * 1000 // 1 hour
    if (cache && (Date.now() - cache.timestamp) < CACHE_TTL) {
      const merged = mergeWithCustom(cache.models, group.provider)
      set({ models: merged, modelsError: null })
      return
    }

    set({ isLoadingModels: true, modelsError: null })

    try {
      const modelIds = await llmFetchModels(group)
      const merged = mergeWithCustom(modelIds, group.provider)

      // Update cache
      const updatedCache = { ...get().modelsCache, [groupId!]: { models: modelIds, timestamp: Date.now() } }
      saveModelsCache(updatedCache)
      set({
        models: merged,
        isLoadingModels: false,
        modelsError: null,
        modelsCache: updatedCache,
      })
    } catch (error: any) {
      console.error('获取模型列表失败:', error)
      set({ isLoadingModels: false, modelsError: error.message || '获取模型列表失败' })
    }
  },

  fetchModelsForGroup: async (group) => {
    const modelIds = await llmFetchModels(group, TEST_TIMEOUT_MS)
    return mergeWithCustom(modelIds, group.provider)
  },

  setModelParams: (params) => {
    set((s) => ({
      modelParams: { ...s.modelParams, ...params },
    }))
  },

  toggleFavorite: (modelId) => {
    const { favoriteModelIds } = get()
    const newFavorites = favoriteModelIds.includes(modelId)
      ? favoriteModelIds.filter((id) => id !== modelId)
      : [...favoriteModelIds, modelId]
    localStorage.setItem('favoriteModelIds', JSON.stringify(newFavorites))
    set((s) => ({
      favoriteModelIds: newFavorites,
      models: s.models.map((m) =>
        m.id === modelId ? { ...m, isFavorite: !m.isFavorite } : m
      ),
    }))
  },

  addCustomModel: (modelData) => {
    const model: CustomModel = {
      ...modelData,
      id: modelData.name,
      createdAt: Date.now(),
    }
    set((s) => {
      const updated = [...s.customModels, model]
      localStorage.setItem('customModels', JSON.stringify(updated))
      return { customModels: updated }
    })
    // Re-fetch to merge
    get().fetchModels()
  },

  removeCustomModel: (modelId) => {
    set((s) => {
      const updated = s.customModels.filter((m) => m.id !== modelId)
      localStorage.setItem('customModels', JSON.stringify(updated))
      return {
        customModels: updated,
        models: s.models.filter((m) => m.id !== modelId),
      }
    })
  },

  testConnectionGroup: async (group, onStep) => {
    return runConnectionTest({
      ...group,
      apiKey: await resolveEnvVars(group.apiKey || ''),
    }, onStep)
  },

  testConnection: async (configGroupId, onStep) => {
    const group = get().configGroups.find((g) => g.id === configGroupId)
    if (!group) return { success: false, message: '未找到配置组', steps: [] }
    return runConnectionTest(group, onStep)
  },

  exportConfigGroups: async (password?: string) => {
    const groups = await Promise.all(get().configGroups.map(async (g) => ({
      ...g,
      apiKey: password
        ? await window.electronAPI.encryptForExport(g.apiKey, password)
        : '***',
    })))
    return JSON.stringify(groups, null, 2)
  },

  importConfigGroups: async (data, password?: string) => {
    try {
      const groups = JSON.parse(data) as Partial<ApiConfigGroup>[]
      for (const group of groups) {
        if (!group.name || !group.baseUrl) continue

        let apiKey = group.apiKey || ''

        // If key looks encrypted (contains ':'), try to decrypt
        if (apiKey && apiKey !== '***' && apiKey.includes(':') && password) {
          try {
            apiKey = await window.electronAPI.decryptForImport(apiKey, password)
          } catch {
            console.error('解密API Key失败，跳过该配置组')
            continue
          }
        }

        // Skip if key is masked and no password provided
        if (!apiKey || apiKey === '***') continue

        await get().createConfigGroup({ ...group, apiKey })
      }
    } catch (error) {
      console.error('导入配置组失败:', error instanceof Error ? error.message : 'Unknown error')
    }
  },

  reorderConfigGroups: (fromIndex, toIndex) => {
    set((s) => {
      const groups = [...s.configGroups]
      const [moved] = groups.splice(fromIndex, 1)
      groups.splice(toIndex, 0, moved)
      // Persist new order
      groups.forEach((g, i) => {
        g.sortOrder = i
        window.electronAPI.saveConfigGroup(g)
      })
      return { configGroups: groups }
    })
  },

  resetStore: () => {
    localStorage.removeItem('favoriteModelIds')
    localStorage.removeItem('promptHistory')
    localStorage.removeItem('customModels')
    localStorage.removeItem(LAST_GROUP_KEY)
    localStorage.removeItem(LAST_MODEL_KEY)
    localStorage.removeItem(MODELS_CACHE_KEY)
    set({
      configGroups: [],
      activeConfigGroupId: null,
      models: [],
      modelParams: DEFAULT_MODEL_PARAMS,
      favoriteModelIds: [],
      modelsCache: {},
      modelsError: null,
      customModels: [],
    })
  },
}))

/**
 * Run a real connection test against a config group.
 *
 * Two checks, so a misconfigured URL *and* a wrong model name both surface
 * instead of failing silently:
 *   1. Model list (GET /models) — best-effort, some providers lack it.
 *   2. A real 1-round chat request using the default model (or the first
 *      model from the list) — this is the actual path chat messages take,
 *      and catches errors like "Unsupported model" or a bad base URL.
 * Success is decided by the chat probe when a model is known, otherwise by
 * the model-list call.
 */
async function runConnectionTest(group: ApiConfigGroup, onStep?: (step: ConnectionStep) => void): Promise<ConnectionTestResult> {
  const steps: ConnectionStep[] = []
  const fmt = resolveFormat(group.provider, group.apiFormat)

  const pushStep = (step: ConnectionStep) => {
    steps.push(step)
    onStep?.(step)
  }

  // 1) Model list (best-effort)
  let models: string[] = []
  const modelsUrl = modelsRequestUrl(group)
  if (!modelsUrl) {
    pushStep({ name: '模型列表', ok: true, detail: '该格式无模型列表接口，使用内置默认列表', url: modelsUrl || undefined })
  } else {
    const t0 = Date.now()
    try {
      models = await llmFetchModels(group, TEST_TIMEOUT_MS)
      pushStep({ name: '模型列表', ok: true, detail: `获取到 ${models.length} 个模型`, url: modelsUrl, ms: Date.now() - t0 })
    } catch (error: any) {
      pushStep({ name: '模型列表', ok: false, detail: detailWithHint(error?.message || '未知错误'), url: modelsUrl, ms: Date.now() - t0 })
    }
  }

  // 2) Real chat request to verify the endpoint + model name
  const chatModel = group.defaultModel || models[0]
  if (chatModel) {
    const t0 = Date.now()
    try {
      await sendChatProbe(group, chatModel)
      pushStep({ name: '对话请求', ok: true, detail: `${chatModel} 响应正常`, url: chatRequestUrl(group, chatModel), ms: Date.now() - t0 })
    } catch (error: any) {
      pushStep({ name: '对话请求', ok: false, detail: detailWithHint(error?.message || '未知错误'), url: chatRequestUrl(group, chatModel), ms: Date.now() - t0 })
    }
  } else {
    pushStep({ name: '对话请求', ok: false, detail: '未提供模型（请填写默认模型或先获取模型列表）', url: chatRequestUrl(group) })
  }

  const chatStep = steps[1]
  const success = chatModel ? (chatStep?.ok ?? false) : (steps[0]?.ok ?? false)
  return {
    success,
    message: success
      ? '连接成功'
      : `连接失败（${fmt} 格式）`,
    steps,
  }
}

/** Minimal non-streaming chat request that exercises the real request path. */
async function sendChatProbe(group: ApiConfigGroup, model: string): Promise<void> {
  for await (const chunk of sendLLMRequest(
    {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      temperature: 0,
      maxTokens: 16,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
    },
    group,
    TEST_TIMEOUT_MS,
  )) {
    if (chunk.done) break
  }
}
