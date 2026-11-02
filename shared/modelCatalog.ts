/**
 * Model / provider catalog — decoded view over model-catalog.json.
 *
 * The JSON is generated from https://models.dev/api.json by
 * `node scripts/generate-model-catalog.mjs`; rows are position-encoded to keep
 * the bundle small. This module is the only place that knows the encoding.
 *
 * Lookup is deliberately forgiving: users type model ids by hand and vendors
 * spell the same model differently (dates, `:free`, `provider/` prefixes), so
 * exact → normalized → prefix matching all resolve to the same spec.
 */
import rawCatalog from './model-catalog.json'

export type ModelModality = 'text' | 'image' | 'audio' | 'video' | 'pdf'

/** Capabilities that change how a model can be driven. */
export type ModelCapability =
  | 'tool_call'
  | 'structured_output'
  | 'reasoning'
  | 'attachment'
  | 'web_search'
  | 'system_messages'
  | 'streaming'

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'max'

/** Wire protocol the vendor speaks natively. `unsupported` = proprietary auth
 *  (Bedrock/Vertex) that cannot be reached with this app's key-based configs. */
export type CatalogWireFormat = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'azure' | 'unsupported'

export interface CatalogModel {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  inputModalities: ModelModality[]
  outputModalities: ModelModality[]
  capabilities: ModelCapability[]
  reasoningLevels: ReasoningLevel[]
  /** YYYY-MM, when the vendor published the model. */
  releaseDate?: string
}

export interface CatalogProvider {
  id: string
  name: string
  /** Default OpenAI-compatible base URL ('' when unknown or account-specific). */
  api: string
  doc: string
  format: CatalogWireFormat
  /** Up to 8 recent chat model ids, used as suggestions when picking a preset. */
  suggestedModels: string[]
}

const MODALITIES: ModelModality[] = ['text', 'image', 'audio', 'video', 'pdf']
const CAPABILITIES: ModelCapability[] = ['tool_call', 'structured_output', 'reasoning', 'attachment']
const EFFORTS: ReasoningLevel[] = ['low', 'medium', 'high', 'max']

type ModelRow = Array<string | number>
type ProviderRow = [string, string, string, CatalogWireFormat, string[]]

const catalog = rawCatalog as unknown as {
  meta: { source: string; generatedAt: string; modelCount: number; providerCount: number }
  models: Record<string, ModelRow>
  providers: Record<string, ProviderRow>
}

function bits<T extends string>(mask: number, values: T[]): T[] {
  return values.filter((_, i) => (mask & (1 << i)) !== 0)
}

function decodeModel(id: string, row: ModelRow): CatalogModel {
  const reasoning = ((row[5] as number) || 0) & 4
  const efforts = bits((row[6] as number) || 0, EFFORTS)
  return {
    id,
    name: (row[0] as string) || id,
    contextWindow: (row[1] as number) || 0,
    maxOutputTokens: (row[2] as number) || 0,
    inputModalities: bits((row[3] as number) || 0, MODALITIES),
    outputModalities: bits((row[4] as number) || 0, MODALITIES),
    capabilities: bits((row[5] as number) || 0, CAPABILITIES),
    // Toggle-only reasoning models have no effort list; `high` is what the app
    // sends when thinking is on, so it is the only selectable non-off level.
    reasoningLevels: reasoning ? (efforts.length > 0 ? ['off', ...efforts] : ['off', 'high']) : ['off'],
    releaseDate: (row[7] as string) || undefined,
  }
}

function decodeProvider(id: string, row: ProviderRow): CatalogProvider {
  return {
    id,
    name: row[0] || id,
    api: row[1] || '',
    doc: row[2] || '',
    format: row[3] || 'openai',
    suggestedModels: Array.isArray(row[4]) ? row[4] : [],
  }
}

/** lowercase id → canonical id, built once (the catalog is a static asset). */
const lowerIndex = new Map<string, string>()
for (const id of Object.keys(catalog.models)) lowerIndex.set(id.toLowerCase(), id)

const providerCache = new Map<string, CatalogProvider>()
for (const [id, row] of Object.entries(catalog.providers)) providerCache.set(id, decodeProvider(id, row))

const lookupCache = new Map<string, CatalogModel | null>()

/** Strip decorations vendors/platforms add around the same underlying model id. */
function normalizeModelId(raw: string): string {
  let id = raw.trim().toLowerCase()
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  id = id.replace(/:(free|nitro|extended|online|beta)$/g, '')
  id = id.replace(/@.*$/, '')
  id = id.replace(/[-_](20\d{2})[-_]?(\d{2})[-_]?(\d{2})$/, '')
  id = id.replace(/-latest$/, '')
  return id
}

/**
 * Resolve a model id to its catalog spec.
 *
 * Order: exact (case-insensitive) → normalized exact → longest catalog key the
 * id starts with → shortest catalog key that extends the id. Results (including
 * misses) are cached because this runs on every turn for context budgeting.
 */
export function getCatalogModel(modelId: string): CatalogModel | undefined {
  if (!modelId) return undefined
  const cached = lookupCache.get(modelId)
  if (cached !== undefined) return cached ?? undefined

  const resolve = (): CatalogModel | undefined => {
    const exact = lowerIndex.get(modelId.trim().toLowerCase())
    if (exact) return decodeModel(exact, catalog.models[exact])

    const normalized = normalizeModelId(modelId)
    if (!normalized) return undefined
    const normalizedExact = lowerIndex.get(normalized)
    if (normalizedExact) return decodeModel(normalizedExact, catalog.models[normalizedExact])

    let bestPrefix: string | undefined
    let bestReverse: string | undefined
    for (const key of lowerIndex.keys()) {
      if (normalized.startsWith(`${key}-`) || normalized.startsWith(`${key}.`)) {
        if (!bestPrefix || key.length > bestPrefix.length) bestPrefix = key
      } else if (key.startsWith(`${normalized}-`) || key.startsWith(`${normalized}.`)) {
        if (!bestReverse || key.length < bestReverse.length) bestReverse = key
      }
    }
    const match = bestPrefix || bestReverse
    return match ? decodeModel(lowerIndex.get(match)!, catalog.models[lowerIndex.get(match)!]) : undefined
  }

  const result = resolve() ?? null
  lookupCache.set(modelId, result)
  return result ?? undefined
}

export function getCatalogProvider(providerId: string): CatalogProvider | undefined {
  return providerCache.get(providerId) ?? providerCache.get(providerId.toLowerCase())
}

/** Vendors users look for first in the provider preset picker. */
const MAJOR_PROVIDER_IDS = [
  'openai', 'anthropic', 'google', 'deepseek', 'xai', 'moonshotai', 'zhipuai', 'zai',
  'alibaba', 'minimax', 'longcat', 'agnes', 'groq', 'mistral', 'cohere', 'perplexity',
  'cerebras', 'nvidia', 'siliconflow', 'volcengine', 'stepfun-ai', 'xiaomi',
  'tencent-tokenhub', 'modelscope', 'qiniu-ai', 'openrouter', 'ollama', 'lmstudio',
]

/** All providers, major vendors first, then those with a usable endpoint, then alphabetical. */
export function listCatalogProviders(): CatalogProvider[] {
  const rank = (p: CatalogProvider) => {
    const index = MAJOR_PROVIDER_IDS.indexOf(p.id)
    return index >= 0 ? index : MAJOR_PROVIDER_IDS.length
  }
  return [...providerCache.values()].sort((a, b) => {
    const aUsable = a.api && a.format !== 'unsupported' ? 0 : 1
    const bUsable = b.api && b.format !== 'unsupported' ? 0 : 1
    return rank(a) - rank(b) || aUsable - bUsable || a.name.localeCompare(b.name)
  })
}

/** Filter provider presets by name, id or endpoint (for the search box). */
export function searchCatalogProviders(query: string): CatalogProvider[] {
  const q = query.trim().toLowerCase()
  const all = listCatalogProviders()
  if (!q) return all
  return all.filter((p) =>
    p.name.toLowerCase().includes(q) || p.id.includes(q) || p.api.toLowerCase().includes(q),
  )
}

export const MODEL_CATALOG_META = catalog.meta

/** Default request fields a model spec can fill in the editor. */
export interface ModelDefaults {
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities: ModelModality[]
  outputModalities: ModelModality[]
  capabilities: ModelCapability[]
  reasoningLevels: ReasoningLevel[]
}

/** Catalog defaults for a model id, or undefined when the id is unknown. */
export function getModelDefaults(modelId: string): ModelDefaults | undefined {
  const spec = getCatalogModel(modelId)
  if (!spec) return undefined
  return {
    contextWindow: spec.contextWindow || undefined,
    maxOutputTokens: spec.maxOutputTokens || undefined,
    inputModalities: spec.inputModalities,
    outputModalities: spec.outputModalities,
    capabilities: spec.capabilities,
    reasoningLevels: spec.reasoningLevels,
  }
}
