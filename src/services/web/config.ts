/**
 * Resolve the web-tool settings once per call. The DeepSeek key is explicit
 * when the user sets one; otherwise an official DeepSeek config group's key is
 * reused so search works without a second setup step. A relay key is never
 * forwarded to api.deepseek.com automatically.
 */
import { useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  type DeepSeekToolsConfig,
  type SearxngConfig,
  type WebFetchProviderChoice,
  type WebSearchProviderChoice,
} from '@shared/webTools'

export interface ResolvedWebToolsConfig {
  searchProvider: WebSearchProviderChoice
  fetchProvider: WebFetchProviderChoice
  deepseek: DeepSeekToolsConfig
  searxng: SearxngConfig
}

function isOfficialDeepSeek(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'deepseek.com' || host.endsWith('.deepseek.com')
  } catch {
    return false
  }
}

function officialDeepSeekGroup() {
  // Match by host, not by the provider label: users commonly add DeepSeek as a
  // generic OpenAI-compatible group and still expect its key to be reused.
  return useConfigStore.getState().configGroups.find((group) => (
    !!group.apiKey?.trim()
    && isOfficialDeepSeek(group.baseUrl)
  ))
}

export function resolveWebToolsConfig(): ResolvedWebToolsConfig {
  const prefs = useEditorStore.getState().preferences
  const explicitKey = (prefs.webSearchDeepseekApiKey || '').trim()
  const explicitBase = (prefs.webSearchDeepseekBaseUrl || '').trim()
  const group = officialDeepSeekGroup()

  let apiKey = ''
  let baseUrl = DEFAULT_DEEPSEEK_BASE_URL
  if (explicitKey) {
    apiKey = explicitKey
    baseUrl = explicitBase || DEFAULT_DEEPSEEK_BASE_URL
  } else if (group) {
    apiKey = group.apiKey.trim()
    baseUrl = group.baseUrl || DEFAULT_DEEPSEEK_BASE_URL
  } else {
    baseUrl = explicitBase || DEFAULT_DEEPSEEK_BASE_URL
  }

  return {
    searchProvider: prefs.webSearchProvider || 'auto',
    fetchProvider: prefs.webFetchProvider || 'auto',
    deepseek: { apiKey, baseUrl },
    searxng: { baseUrl: (prefs.webSearchSearxngUrl || '').trim() || undefined },
  }
}
