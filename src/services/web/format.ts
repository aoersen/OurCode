import type { WebSearchResult } from '@shared/webTools'

const PROVIDER_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  searxng: 'SearXNG',
  bing: 'Bing',
  brave: 'Brave',
  duckduckgo: 'DuckDuckGo',
}

/**
 * Format a normalized search response for the model. DeepSeek returns a
 * query-specific `summary` meant for this exact use; prefer it over the short
 * UI snippet. Fallback notes stay visible so a degraded provider is never
 * mistaken for the configured one.
 */
export function formatWebSearchResult(query: string, result: WebSearchResult): string {
  const lines: string[] = []
  if (!result.ok || result.results.length === 0) {
    lines.push(`Web search failed for "${query}": ${result.error || '没有结果'}`)
    if (result.warnings.length > 0) lines.push(`Attempts: ${result.warnings.join('; ')}`)
    return lines.join('\n')
  }

  const provider = result.merged
    ? `multi-source: ${(result.providers || []).map((id) => PROVIDER_LABEL[id] || id).join(' + ')}`
    : result.provider
      ? (PROVIDER_LABEL[result.provider] || result.provider)
      : 'unknown'
  lines.push(`Web search results for "${query}" (via ${provider}, ${result.results.length} results):`)
  if (result.warnings.length > 0) {
    lines.push(`Note (partial sources): ${result.warnings.join('; ')}`)
  }

  result.results.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title || '(untitled)'}`)
    lines.push(`   URL: ${item.url}`)
    const meta: string[] = []
    if (item.date) meta.push(`date: ${item.date.slice(0, 10)}`)
    if (typeof item.authority === 'number' && item.authority >= 0) meta.push(`authority: ${item.authority}/4`)
    if (typeof item.score === 'number') meta.push(`score: ${item.score.toFixed(2)}`)
    if (item.siteName) meta.push(`site: ${item.siteName}`)
    if (result.merged) meta.push(`source: ${PROVIDER_LABEL[item.source] || item.source}`)
    if (meta.length > 0) lines.push(`   ${meta.join(' | ')}`)
    const body = (item.summary || item.snippet || '').replace(/\s+/g, ' ').trim()
    if (body) lines.push(`   ${body}`)
  })

  lines.push('')
  lines.push('Use read_url on promising URLs when you need the full page.')
  return lines.join('\n')
}
