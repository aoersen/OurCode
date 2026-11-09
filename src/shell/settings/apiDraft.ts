/**
 * 「API 与模型」的草稿模型 —— 纯函数，node 环境可单测。
 *
 * 旧弹窗把「正在编辑的配置」放在一个 Partial<ApiConfigGroup> 里，字段含义
 * （名称必填、同名拒绝、Ollama/自建中继可无密钥、请求头 `Header: Value`、
 * 格式覆盖 warning）全部散在组件里。新壳把这些规则收敛到本文件，组件只负责
 * 渲染与调用 store / IPC，因此规则可以逐条单测。
 */
import type { ApiConfigGroup } from '@/types'
import type { CatalogProvider, CatalogWireFormat } from '@shared/modelCatalog'
import { getProviderMeta, type EndpointFormat } from '@/services/llm/endpoints'

export interface ApiDraft {
  id?: string
  name: string
  baseUrl: string
  apiKey: string
  defaultModel: string
  provider: ApiConfigGroup['provider']
  apiFormat?: ApiConfigGroup['apiFormat']
  customHeaders: Record<string, string>
  skipTlsVerify: boolean
  color?: string
  systemPrompt?: string
  sortOrder?: number
  createdAt?: number
  updatedAt?: number
}

/** 请求格式的四个选项：跟随默认 + 三种显式覆盖（与旧面板一致）。 */
export const FORMAT_OVERRIDES: ReadonlyArray<{ value: 'auto' | EndpointFormat; label: string }> = [
  { value: 'auto', label: '跟随默认' },
  { value: 'openai', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
]

/** 厂商目录 id → 应用内置 provider（其余走 custom）。 */
export const CATALOG_BUILTIN_PROVIDER: Record<string, ApiConfigGroup['provider']> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gemini',
  deepseek: 'deepseek',
  groq: 'groq',
  ollama: 'ollama',
  azure: 'azure',
}

/** 目录里的线格式 → 自定义厂商的显式 apiFormat。 */
export const CATALOG_FORMAT: Record<CatalogWireFormat, NonNullable<ApiConfigGroup['apiFormat']>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  ollama: 'ollama',
  azure: 'azure',
  unsupported: 'openai',
}

export const MODALITY_LABELS: Record<string, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
  pdf: 'PDF',
}

/** 新建配置时的初始草稿：名称与地址按提供商默认值预填（旧面板同款）。 */
export function emptyDraftForProvider(provider: string): ApiDraft {
  const meta = getProviderMeta(provider)
  return {
    name: `${meta?.label || provider} 配置`,
    baseUrl: meta?.defaultBaseUrl || '',
    apiKey: '',
    defaultModel: '',
    provider: provider as ApiConfigGroup['provider'],
    apiFormat: 'auto',
    customHeaders: {},
    skipTlsVerify: false,
    systemPrompt: '',
    color: meta?.color,
  }
}

export function draftFromGroup(group: ApiConfigGroup): ApiDraft {
  return {
    id: group.id,
    name: group.name,
    baseUrl: group.baseUrl,
    apiKey: group.apiKey,
    defaultModel: group.defaultModel,
    provider: group.provider,
    apiFormat: group.apiFormat,
    customHeaders: { ...(group.customHeaders || {}) },
    skipTlsVerify: group.skipTlsVerify === true,
    color: group.color,
    systemPrompt: group.systemPrompt,
    sortOrder: group.sortOrder,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  }
}

// ── 请求头文本 ⇄ 对象 ────────────────────────────────────────────────────

/** 每行 `Header: Value`；空行、缺值的行被忽略（旧面板同款口径）。 */
export function parseHeadersText(text: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (!key || !value) continue
    map[key] = value
  }
  return map
}

export function formatHeadersText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

export function countHeaderLines(text: string): number {
  return Object.keys(parseHeadersText(text)).length
}

// ── 校验 ────────────────────────────────────────────────────────────────

export type DraftCheck = { ok: true } | { ok: false; error: string }

function trimmed(value: string | undefined | null): string {
  return (value ?? '').trim()
}

/** 只有 Ollama / 自建中继允许空密钥（旧面板同款例外）。 */
export function requiresApiKey(provider: string): boolean {
  return provider !== 'ollama' && provider !== 'custom'
}

/** 保存前校验：名称必填、地址必填、名称不可与别的配置重名。 */
export function validateDraftForSave(
  draft: Pick<ApiDraft, 'name' | 'baseUrl' | 'id'>,
  groups: ReadonlyArray<{ id?: string; name: string }>,
): DraftCheck {
  if (!trimmed(draft.name)) return { ok: false, error: '请填写配置名称' }
  if (!trimmed(draft.baseUrl)) return { ok: false, error: '请填写 API 基础 URL' }
  const duplicate = groups.some((group) => group.id !== draft.id && trimmed(group.name) === trimmed(draft.name))
  if (duplicate) return { ok: false, error: '配置名称已存在' }
  return { ok: true }
}

/** 测试连接前校验：地址必填，除 Ollama / 自建中继外密钥必填。 */
export function validateDraftForTest(draft: Pick<ApiDraft, 'baseUrl' | 'apiKey' | 'provider'>): DraftCheck {
  if (!trimmed(draft.baseUrl)) return { ok: false, error: '请先填写 API 基础 URL' }
  if (requiresApiKey(draft.provider || 'openai') && !trimmed(draft.apiKey)) {
    return { ok: false, error: '请先填写 API 密钥' }
  }
  return { ok: true }
}

// ── 脏值比较 ────────────────────────────────────────────────────────────

export type ApiDraftField =
  | 'name'
  | 'baseUrl'
  | 'apiKey'
  | 'defaultModel'
  | 'provider'
  | 'apiFormat'
  | 'customHeaders'
  | 'skipTlsVerify'
  | 'systemPrompt'

export const API_DRAFT_FIELD_LABELS: Record<ApiDraftField, string> = {
  name: '名称',
  baseUrl: '基础 URL',
  apiKey: '密钥',
  defaultModel: '默认模型',
  provider: '提供商',
  apiFormat: '请求格式',
  customHeaders: '请求头',
  skipTlsVerify: '证书校验',
  systemPrompt: '系统提示词',
}

export interface ApiDraftDiff {
  dirty: boolean
  fields: ApiDraftField[]
}

function canonicalHeaders(headers: Record<string, string> | undefined): string {
  const entries = Object.entries(headers ?? {})
    .map(([key, value]) => [trimmed(key), trimmed(value)] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(entries)
}

function canonicalFormat(format: string | undefined): string {
  return format && format !== 'auto' ? format : 'auto'
}

/**
 * 已保存配置与草稿的差异。字符串一律按 trim 后比较、请求头按「键排序后的
 * 键值对」比较，避免尾部空格或书写顺序把表单误标成「有未保存修改」。
 */
export function draftDiff(saved: ApiDraft | null | undefined, draft: ApiDraft | null | undefined): ApiDraftDiff {
  if (!saved || !draft) return { dirty: false, fields: [] }
  const fields: ApiDraftField[] = []
  if (trimmed(saved.name) !== trimmed(draft.name)) fields.push('name')
  if (trimmed(saved.baseUrl) !== trimmed(draft.baseUrl)) fields.push('baseUrl')
  if (trimmed(saved.apiKey) !== trimmed(draft.apiKey)) fields.push('apiKey')
  if (trimmed(saved.defaultModel) !== trimmed(draft.defaultModel)) fields.push('defaultModel')
  if (saved.provider !== draft.provider) fields.push('provider')
  if (canonicalFormat(saved.apiFormat) !== canonicalFormat(draft.apiFormat)) fields.push('apiFormat')
  if (canonicalHeaders(saved.customHeaders) !== canonicalHeaders(draft.customHeaders)) fields.push('customHeaders')
  if ((saved.skipTlsVerify === true) !== (draft.skipTlsVerify === true)) fields.push('skipTlsVerify')
  if (trimmed(saved.systemPrompt) !== trimmed(draft.systemPrompt)) fields.push('systemPrompt')
  return { dirty: fields.length > 0, fields }
}

/** 「未保存的修改：名称、基础 URL」里的那串字段名。 */
export function describeDraftDiff(diff: ApiDraftDiff): string {
  return diff.fields.map((field) => API_DRAFT_FIELD_LABELS[field] ?? field).join('、')
}

/** 显式覆盖的格式与提供商原生格式不一致时，旧面板会提示确认。 */
export function isFormatOverrideRisky(draft: Pick<ApiDraft, 'provider' | 'apiFormat'>): boolean {
  if (!draft.apiFormat || draft.apiFormat === 'auto') return false
  const nativeFormat = getProviderMeta(draft.provider || '')?.nativeFormat || 'openai'
  return draft.apiFormat !== nativeFormat
}

// ── 厂商目录预设 ─────────────────────────────────────────────────────────

export type CatalogPreset = Pick<CatalogProvider, 'id' | 'name' | 'api' | 'format' | 'suggestedModels'>

/**
 * 套用厂商目录预设（243 个可用接入点）。命名规则沿用旧面板：
 * 新建时才改写自动生成的「<提供商> 配置」，用户手写过的名称保持不动。
 */
export function applyCatalogPreset(
  draft: ApiDraft,
  preset: CatalogPreset,
  options: { isCreating: boolean } = { isCreating: false },
): ApiDraft {
  if (!preset.api) return draft
  const builtin = CATALOG_BUILTIN_PROVIDER[preset.id]
  const autoName = `${getProviderMeta(draft.provider || '')?.label || ''} 配置`
  const keepName =
    !options.isCreating ||
    (trimmed(draft.name).length > 0 && draft.name !== autoName && draft.name !== '自定义 配置')
  return {
    ...draft,
    name: keepName ? draft.name : `${preset.name} 配置`,
    provider: builtin || 'custom',
    apiFormat: builtin ? 'auto' : CATALOG_FORMAT[preset.format],
    baseUrl: preset.api,
    defaultModel: draft.defaultModel || preset.suggestedModels[0] || '',
  }
}

// ── 模型信息的展示 ───────────────────────────────────────────────────────

/** 128000 → 128K；1048576 → 1M（旧面板同款）。 */
export function formatTokenCount(value?: number): string {
  if (!value || value <= 0) return '—'
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

export interface ModelSpecInput {
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: string[]
}

/** 「上下文 128K · 输出 8K · 输入 文本/图片」；没有任何规格时返回空串。 */
export function modelSpecLine(model: ModelSpecInput | null | undefined): string {
  if (!model) return ''
  const parts: string[] = []
  if (model.contextWindow) parts.push(`上下文 ${formatTokenCount(model.contextWindow)}`)
  if (model.maxOutputTokens) parts.push(`输出 ${formatTokenCount(model.maxOutputTokens)}`)
  if (model.inputModalities && model.inputModalities.length > 0) {
    parts.push(`输入 ${model.inputModalities.map((item) => MODALITY_LABELS[item] ?? item).join('/')}`)
  }
  return parts.join(' · ')
}
