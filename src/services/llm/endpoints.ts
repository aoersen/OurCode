// Endpoint path resolution for LLM providers.
//
// Providers are configured with a base URL, and the API path is appended here.
// The same gateway can expose several formats under one host, e.g.:
//   POST {base}/v1/chat/completions   (OpenAI chat completions)
//   POST {base}/v1/responses          (OpenAI Responses API)
//   POST {base}/v1/messages           (Anthropic messages)
//   POST {base}/api/chat              (Ollama)
//   POST {base}/v1beta/models/...     (Gemini generateContent)
//
// To stay backward compatible with existing configs, the resolver accepts both
// styles: a base that already contains the version/format prefix
// (https://api.openai.com/v1, https://api.anthropic.com/v1) and a bare host
// (http://gateway:8000) for which the full standard path is appended.
//
// IMPORTANT: every adapter must build its URLs through these helpers (or the
// provider registry defaults below) so the URL the UI previews is exactly the
// URL that gets requested. Do not hand-roll `base + '/...'` inside adapters.

export type EndpointFormat = 'openai' | 'responses' | 'anthropic' | 'gemini' | 'ollama' | 'azure'

/** Value of ApiConfigGroup.apiFormat: 'auto' means "use the provider's native format". */
export type ApiFormatValue = 'auto' | EndpointFormat

const AZURE_API_VERSION = '2024-06-01'

function trimTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '')
}

function endsWithPath(base: string, suffix: string): boolean {
  return trimTrailingSlash(base).toLowerCase().endsWith(suffix)
}

/** Strip a trailing path segment (e.g. /v1beta, /api) while keeping the rest of the base verbatim. */
function stripTrailingPath(base: string, suffix: string): string {
  const trimmed = trimTrailingSlash(base)
  if (trimmed.toLowerCase().endsWith(suffix)) {
    return trimmed.slice(0, trimmed.length - suffix.length).replace(/\/+$/, '')
  }
  return trimmed
}

function hostOf(base: string): string {
  try {
    return new URL(base).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Hosts that serve OpenAI-style chat completions directly at the host root. */
const HOSTS_WITHOUT_VERSION = new Set([
  'api.perplexity.ai',
  'models.inference.ai.azure.com',
  'api.githubcopilot.com',
])

/**
 * Root to which `/chat/completions` / `/models` should be appended for
 * OpenAI-style formats.
 *
 * Vendors spell their base URL differently: `…/v1` (OpenAI), `…/api/paas/v4`
 * (Zhipu), `…/api/v3` (Volcengine), `…/v1/openai` (DeepInfra), `…/openai`
 * (LongCat) or no version at all (Perplexity). Treating every non-`/v1` base as
 * a bare host would produce `…/v4/v1/chat/completions`, so detect the version
 * segment instead of hard-coding `/v1`.
 */
function openAiRoot(base: string): string {
  const b = trimTrailingSlash(base)
  const lower = b.toLowerCase()
  // Version already present, optionally followed by /openai (or /openai then
  // the version, as some relays expose).
  if (/\/v\d+[a-z]*(\/openai)?$/.test(lower)) return b
  if (/\/openai\/v\d+[a-z]*$/.test(lower)) return b
  // Vendor root without a version segment: /openai → /openai/v1 (LongCat).
  if (lower.endsWith('/openai')) return `${b}/v1`
  if (HOSTS_WITHOUT_VERSION.has(hostOf(b))) return b
  return `${b}/v1`
}

/**
 * Build the final chat-request URL for a request format.
 *
 * @param baseUrl user-configured base URL (host, possibly with a path prefix)
 * @param format  which wire protocol the URL should target
 * @param model   model id (required for gemini / azure; used for the preview, real requests always pass it)
 */
export function buildChatUrl(baseUrl: string, format: EndpointFormat, model?: string): string {
  const base = trimTrailingSlash(baseUrl)

  switch (format) {
    case 'openai': // POST /chat/completions
      if (endsWithPath(base, '/chat/completions')) return base
      return `${openAiRoot(base)}/chat/completions`

    case 'responses': // POST /responses
      if (endsWithPath(base, '/responses')) return base
      return `${openAiRoot(base)}/responses`

    case 'anthropic': // POST /v1/messages (official) or /anthropic/v1/messages (gateway)
      if (endsWithPath(base, '/messages')) return base
      if (endsWithPath(base, '/anthropic/v1')) return `${base}/messages`
      if (endsWithPath(base, '/v1')) return `${base}/messages`
      // Bare host: api.anthropic.com serves under /v1, relays usually under /anthropic/v1
      return hostOf(base) === 'api.anthropic.com'
        ? `${base}/v1/messages`
        : `${base}/anthropic/v1/messages`

    case 'gemini': // POST /v1beta/models/{model}:generateContent
      return `${stripTrailingPath(base, '/v1beta')}/v1beta/models/${model || '{model}'}:generateContent`

    case 'ollama': // POST /api/chat
      return `${stripTrailingPath(base, '/api')}/api/chat`

    case 'azure': { // POST /openai/deployments/{deployment}/chat/completions?api-version=...
      const b = stripTrailingPath(base, '/openai')
      return `${b}/openai/deployments/${model || '{deployment}'}/chat/completions?api-version=${AZURE_API_VERSION}`
    }
  }
}

/**
 * Build the model-list URL for a format. Returns null when the format has no
 * public model-list endpoint (Anthropic), so callers can fall back to manual
 * entry / a hardcoded list.
 */
export function buildModelsUrl(baseUrl: string, format: EndpointFormat): string | null {
  const base = trimTrailingSlash(baseUrl)

  switch (format) {
    case 'openai': // GET /models
    case 'responses': {
      if (endsWithPath(base, '/models')) return base
      // A user may have pasted a full chat endpoint as the base URL; recover the
      // base before appending the models path so the derived URL stays sane.
      const stripped = stripTrailingPath(stripTrailingPath(base, '/chat/completions'), '/responses')
      return `${openAiRoot(stripped)}/models`
    }

    case 'gemini': // GET /v1beta/models
      return `${stripTrailingPath(base, '/v1beta')}/v1beta/models`

    case 'ollama': // GET /api/tags
      return `${stripTrailingPath(base, '/api')}/api/tags`

    case 'azure': // GET /openai/deployments?api-version=...
      return `${stripTrailingPath(base, '/openai')}/openai/deployments?api-version=${AZURE_API_VERSION}`

    case 'anthropic':
      return null
  }
}

/** Backward-compatible alias (old name was buildEndpointUrl). */
export function buildEndpointUrl(baseUrl: string, format: EndpointFormat, model?: string): string {
  return buildChatUrl(baseUrl, format, model)
}

// ───────────────────────── Provider registry ─────────────────────────
//
// One row per selectable provider: its native wire format, sensible default
// base URL, whether it exposes a model-list endpoint, fallback model ids and
// a short description. The settings UI renders these and uses them to prefill
// new configs; the adapters resolve the effective format through
// `resolveFormat`, so a provider and its format can never drift apart.

export interface ProviderMeta {
  value: string
  label: string
  icon: string
  color: string
  nativeFormat: EndpointFormat
  defaultBaseUrl: string
  supportsModelsApi: boolean
  defaultModels: string[]
  description: string
}

export const PROVIDER_REGISTRY: ProviderMeta[] = [
  {
    value: 'openai', label: 'OpenAI', icon: 'O', color: '#10a37f',
    nativeFormat: 'openai', defaultBaseUrl: 'https://api.openai.com/v1',
    supportsModelsApi: true,
    defaultModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'],
    description: 'OpenAI 官方 API（Chat Completions 格式）',
  },
  {
    value: 'responses', label: 'OpenAI Responses', icon: 'R', color: '#10a37f',
    nativeFormat: 'responses', defaultBaseUrl: 'https://api.openai.com/v1',
    supportsModelsApi: true,
    defaultModels: ['gpt-4o', 'gpt-4o-mini'],
    description: 'OpenAI 新版 Responses API',
  },
  {
    value: 'anthropic', label: 'Anthropic', icon: 'A', color: '#d47757',
    nativeFormat: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com',
    supportsModelsApi: false,
    defaultModels: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
    description: 'Claude 官方 API（Messages 格式）',
  },
  {
    value: 'gemini', label: 'Gemini', icon: 'G', color: '#4285f4',
    nativeFormat: 'gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    supportsModelsApi: true,
    defaultModels: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    description: 'Google Gemini（generateContent 格式）',
  },
  {
    value: 'deepseek', label: 'DeepSeek', icon: 'D', color: '#4f46e5',
    nativeFormat: 'openai', defaultBaseUrl: 'https://api.deepseek.com',
    supportsModelsApi: true,
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    description: 'DeepSeek（OpenAI 兼容格式）',
  },
  {
    value: 'groq', label: 'Groq', icon: 'Q', color: '#f97316',
    nativeFormat: 'openai', defaultBaseUrl: 'https://api.groq.com/openai/v1',
    supportsModelsApi: true,
    defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    description: 'Groq LPU 推理（OpenAI 兼容格式）',
  },
  {
    value: 'azure', label: 'Azure OpenAI', icon: 'Z', color: '#0078d4',
    nativeFormat: 'azure', defaultBaseUrl: 'https://<资源名>.openai.azure.com',
    supportsModelsApi: true,
    defaultModels: ['gpt-4o'],
    description: 'Azure OpenAI（Deployments 格式，模型填部署名）',
  },
  {
    value: 'ollama', label: 'Ollama', icon: 'L', color: '#fbbf24',
    nativeFormat: 'ollama', defaultBaseUrl: 'http://localhost:11434',
    supportsModelsApi: true,
    defaultModels: ['llama3.2', 'qwen2.5', 'deepseek-r1'],
    description: '本地 Ollama（/api/chat 格式）',
  },
  {
    value: 'custom', label: '自定义', icon: '⚙', color: '#a1a1aa',
    nativeFormat: 'openai', defaultBaseUrl: '',
    supportsModelsApi: true,
    defaultModels: [],
    description: '任意 OpenAI 兼容网关 / 中转站',
  },
]

export function getProviderMeta(provider: string): ProviderMeta | undefined {
  return PROVIDER_REGISTRY.find((p) => p.value === provider)
}

/** Human-readable labels + endpoint examples for each wire format. */
export const FORMAT_META: Record<EndpointFormat, { label: string; desc: string }> = {
  openai: { label: 'Chat Completions', desc: '/chat/completions' },
  responses: { label: 'Responses', desc: '/responses' },
  anthropic: { label: 'Anthropic Messages', desc: '/v1/messages' },
  gemini: { label: 'Gemini', desc: '/v1beta/models/{model}:generateContent' },
  ollama: { label: 'Ollama', desc: '/api/chat' },
  azure: { label: 'Azure OpenAI', desc: '/openai/deployments/{deployment}/chat/completions' },
}

/** Effective wire format for a config: explicit override wins, else the provider's native format. */
export function resolveFormat(provider: string, apiFormat?: string): EndpointFormat {
  if (apiFormat && apiFormat !== 'auto') {
    const fmt = apiFormat as EndpointFormat
    if (FORMAT_META[fmt]) return fmt
  }
  return getProviderMeta(provider)?.nativeFormat ?? 'openai'
}
