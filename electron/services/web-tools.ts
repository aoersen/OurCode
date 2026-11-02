/**
 * Main-process Search / Fetch providers.
 *
 * DeepSeek is the preferred backend: one hosted call returns reranked results
 * with authority/date signals and a model-ready summary. SearXNG, Bing RSS and
 * DuckDuckGo are key-free fallbacks so the IDE keeps working without config.
 */
import {
  availableSearchProviders,
  buildSearchQuery,
  deepseekToolUrl,
  mapDeepSeekResults,
  mapSearxngResults,
  MAX_DEEPSEEK_QUERY_CHARS,
  mergeSearchResults,
  normalizeCount,
  normalizeLang,
  normalizeSearchQuery,
  parseBingRss,
  parseBraveHtml,
  parseDuckDuckGoHtml,
  resolveSearchChain,
  type HostedFetchInput,
  type HostedFetchResult,
  type WebSearchInput,
  type WebSearchItem,
  type WebSearchProvider,
  type WebSearchResult,
} from '../../shared/webTools'
import { assertPublicHttpUrl, safeFetch } from './web-safety'

const SEARCH_TIMEOUT_MS = 20_000
const SEARCH_MAX_BYTES = 4 * 1024 * 1024
/** Multi-source mode returns partial results instead of waiting for a dead source. */
const MULTI_SOURCE_TIMEOUT_MS = 6_000
const DUCKDUCKGO_MULTI_TIMEOUT_MS = 3_500

const PROVIDER_LABEL: Record<WebSearchProvider, string> = {
  deepseek: 'DeepSeek',
  searxng: 'SearXNG',
  bing: 'Bing',
  brave: 'Brave',
  duckduckgo: 'DuckDuckGo',
}

function apiErrorMessage(status: number, body: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
    detail = parsed?.error?.message || parsed?.message || ''
  } catch {
    detail = body.replace(/\s+/g, ' ').slice(0, 200)
  }
  if (status === 401) return 'API Key 无效或未授权'
  if (status === 402) return '账户余额不足'
  if (status === 403) return '请求被安全策略拒绝'
  if (status === 404) return '目标页面不可用或无法提取正文'
  if (status === 408 || status === 504) return '上游超时'
  if (status === 413) return '请求体过大'
  if (status === 429) return '请求过于频繁（429）'
  if (status >= 500) return `服务端错误（${status}）${detail ? `：${detail}` : ''}`
  return `请求失败（${status}）${detail ? `：${detail}` : ''}`
}

function requestErrorMessage(result: { status: number; text: string; error?: string }): string {
  // Transport failures (DNS/TLS/timeout) have status 0 and no body; the
  // underlying message is far more useful than "请求失败（0）".
  return result.error || apiErrorMessage(result.status, result.text)
}

async function searchDeepSeek(
  input: WebSearchInput,
  count: number,
): Promise<WebSearchItem[]> {
  const apiKey = input.deepseek?.apiKey?.trim()
  if (!apiKey) throw new Error('未配置 DeepSeek API Key')
  const query = buildSearchQuery(normalizeSearchQuery(input.query), {
    site: input.site,
    lang: input.lang,
    after: input.after,
    before: input.before,
  })
  if (query.length > MAX_DEEPSEEK_QUERY_CHARS) {
    throw new Error(`查询词超过 ${MAX_DEEPSEEK_QUERY_CHARS} 字符`)
  }
  const question = normalizeSearchQuery(input.question).slice(0, MAX_DEEPSEEK_QUERY_CHARS)
  const body: Record<string, unknown> = { query, count, need_content: false }
  if (question) body.ori_question = question

  const res = await safeFetch(deepseekToolUrl(input.deepseek?.baseUrl, 'search'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: SEARCH_MAX_BYTES,
    // The endpoint is user-configured (relays / proxies are legitimate).
    allowPrivate: true,
    allowedContentTypes: /^application\/json$/i,
  })
  if (!res.ok) throw new Error(requestErrorMessage(res))
  let parsed: unknown
  try {
    parsed = JSON.parse(res.text)
  } catch {
    throw new Error('DeepSeek 返回了非 JSON 响应')
  }
  return mapDeepSeekResults(parsed).slice(0, count)
}

function searxngSearchUrl(baseUrl: string, query: string, count: number, lang: string): string {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    throw new Error('SearXNG 地址无效')
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('SearXNG 地址仅支持 http/https')
  }
  const trimmed = base.toString().replace(/\/+$/, '')
  const endpoint = /\/search$/i.test(trimmed) ? trimmed : `${trimmed}/search`
  const url = new URL(endpoint)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('count', String(count))
  url.searchParams.set('safesearch', '1')
  url.searchParams.set('categories', 'general')
  if (lang) url.searchParams.set('language', lang)
  return url.toString()
}

async function searchSearxng(
  input: WebSearchInput,
  count: number,
): Promise<WebSearchItem[]> {
  const baseUrl = input.searxng?.baseUrl?.trim()
  if (!baseUrl) throw new Error('未配置 SearXNG 地址')
  // `lang:`/`after:` are DeepSeek operators; SearXNG takes language as a
  // parameter and would otherwise search for the literal token.
  const query = buildSearchQuery(normalizeSearchQuery(input.query), { site: input.site })
  const url = searxngSearchUrl(baseUrl, query, count, normalizeLang(input.lang))
  const res = await safeFetch(url, {
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: SEARCH_MAX_BYTES,
    allowPrivate: true,
    allowedContentTypes: /^(application\/json|text\/json)$/i,
  })
  if (!res.ok) throw new Error(requestErrorMessage(res))
  let parsed: unknown
  try {
    parsed = JSON.parse(res.text)
  } catch {
    throw new Error('SearXNG 未返回 JSON，请在 settings.yml 的 search.formats 中加入 json')
  }
  return mapSearxngResults(parsed).slice(0, count)
}

/**
 * Bing's `format=rss` endpoint is key-free and returns normal RSS items. It is
 * the practical zero-config backend on networks where DuckDuckGo is blocked.
 */
async function searchBing(
  input: WebSearchInput,
  count: number,
): Promise<WebSearchItem[]> {
  const query = buildSearchQuery(normalizeSearchQuery(input.query), { site: input.site })
  const url = new URL('https://www.bing.com/search')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'rss')
  url.searchParams.set('count', String(Math.max(count, 10)))
  const lang = normalizeLang(input.lang)
  if (lang) url.searchParams.set('setlang', lang)
  const res = await safeFetch(url.toString(), {
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: SEARCH_MAX_BYTES,
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; OurCode-ide/0.6)',
      accept: 'application/rss+xml,application/xml,text/xml',
    },
    allowedContentTypes: /^(application\/rss\+xml|application\/xml|text\/xml)$/i,
  })
  if (!res.ok) throw new Error(requestErrorMessage(res))
  const results = parseBingRss(res.text)
  if (results.length === 0) throw new Error('Bing RSS 没有返回结果')
  return results.slice(0, count)
}

/** DDG's `kl` parameter wants region-language pairs, not bare ISO codes. */
function duckDuckGoRegion(lang: string): string {  const map: Record<string, string> = {
    zh: 'cn-zh',
    'zh-cn': 'cn-zh',
    'zh-tw': 'tw-zh',
    en: 'us-en',
    ja: 'jp-jp',
    ko: 'kr-kr',
    de: 'de-de',
    fr: 'fr-fr',
    es: 'es-es',
    ru: 'ru-ru',
    pt: 'br-pt',
  }
  return map[lang.toLowerCase()] || ''
}

/**
 * Brave's server-rendered results page is another key-free source, useful when
 * Bing RSS is degraded or DuckDuckGo is blocked.
 */
async function searchBrave(
  input: WebSearchInput,
  count: number,
): Promise<WebSearchItem[]> {
  const query = buildSearchQuery(normalizeSearchQuery(input.query), { site: input.site })
  const url = new URL('https://search.brave.com/search')
  url.searchParams.set('q', query)
  url.searchParams.set('source', 'web')
  const res = await safeFetch(url.toString(), {
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: SEARCH_MAX_BYTES,
    headers: {
      // Brave returns a JS-less results page for a normal browser UA.
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      accept: 'text/html',
    },
    allowedContentTypes: /^text\/html$/i,
  })
  if (!res.ok) throw new Error(requestErrorMessage(res))
  const results = parseBraveHtml(res.text)
  if (results.length === 0) throw new Error('Brave 没有返回结果')
  return results.slice(0, count)
}

async function searchDuckDuckGo(
  input: WebSearchInput,
  count: number,
): Promise<WebSearchItem[]> {
  const query = buildSearchQuery(normalizeSearchQuery(input.query), { site: input.site })
  const url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', query)
  const region = duckDuckGoRegion(normalizeLang(input.lang))
  if (region) url.searchParams.set('kl', region)
  const res = await safeFetch(url.toString(), {
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: SEARCH_MAX_BYTES,
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; OurCode-ide/0.6)',
      accept: 'text/html',
    },
    allowedContentTypes: /^text\/html$/i,
  })
  if (!res.ok) throw new Error(requestErrorMessage(res))
  if (/g-recaptcha|anomaly-modal|challenge-form/i.test(res.text)) {
    throw new Error('被 DuckDuckGo 反爬验证拦截，请配置 DeepSeek 或 SearXNG')
  }
  return parseDuckDuckGoHtml(res.text).slice(0, count)
}

async function runProvider(
  provider: WebSearchProvider,
  input: WebSearchInput,
  count: number,
): Promise<WebSearchItem[]> {
  if (provider === 'deepseek') return searchDeepSeek(input, count)
  if (provider === 'searxng') return searchSearxng(input, count)
  if (provider === 'bing') return searchBing(input, count)
  if (provider === 'brave') return searchBrave(input, count)
  return searchDuckDuckGo(input, count)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('请求超时')), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Query every available source in parallel, then merge/dedupe round-robin.
 * A dead source only contributes a warning; the merged result still returns
 * after the soft timeout instead of failing the whole search.
 */
async function searchMulti(input: WebSearchInput, count: number): Promise<WebSearchResult> {
  const sources = availableSearchProviders(input)
  const outcomes = await Promise.all(sources.map(async (provider) => {
    const timeout = provider === 'duckduckgo' ? DUCKDUCKGO_MULTI_TIMEOUT_MS : MULTI_SOURCE_TIMEOUT_MS
    try {
      const results = await withTimeout(runProvider(provider, input, count), timeout)
      return { provider, results, error: undefined as string | undefined }
    } catch (error) {
      return {
        provider,
        results: [] as WebSearchItem[],
        error: error instanceof Error ? error.message : '搜索失败',
      }
    }
  }))

  const warnings = outcomes
    .filter((outcome) => outcome.error)
    .map((outcome) => `${PROVIDER_LABEL[outcome.provider]}：${outcome.error}`)
  const successful = outcomes.filter((outcome) => outcome.results.length > 0)
  if (successful.length === 0) {
    return {
      ok: false,
      provider: null,
      results: [],
      warnings,
      error: warnings.join('；') || '所有来源均无结果',
    }
  }
  return {
    ok: true,
    provider: successful[0].provider,
    providers: successful.map((outcome) => outcome.provider),
    merged: true,
    results: mergeSearchResults(successful, count),
    warnings,
  }
}

/** Search with the configured fallback chain; the first non-empty result wins. */
export async function searchWeb(input: WebSearchInput): Promise<WebSearchResult> {
  const rawQuery = normalizeSearchQuery(input.query)
  if (!rawQuery) {
    return { ok: false, provider: null, results: [], warnings: [], error: 'query 不能为空' }
  }
  if (rawQuery.length > 512) {
    return { ok: false, provider: null, results: [], warnings: [], error: '查询词过长（最多 512 字符）' }
  }
  const count = normalizeCount(input.count)
  const choice = input.provider ?? 'auto'
  const hasPrimary = !!input.deepseek?.apiKey?.trim() || !!input.searxng?.baseUrl?.trim()

  // Zero-config (and explicit multi) searches aggregate the key-free sources.
  // With a configured primary, auto keeps the cheaper fallback-chain behavior.
  if (choice === 'multi' || (choice === 'auto' && !hasPrimary)) {
    return searchMulti(input, count)
  }

  const chain = resolveSearchChain(input)
  const warnings: string[] = []

  for (const provider of chain) {
    try {
      const results = await runProvider(provider, input, count)
      if (results.length > 0) {
        return { ok: true, provider, results, warnings }
      }
      warnings.push(`${PROVIDER_LABEL[provider]}：无结果`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '搜索失败'
      warnings.push(`${PROVIDER_LABEL[provider]}：${message}`)
    }
  }

  return {
    ok: false,
    provider: null,
    results: [],
    warnings,
    error: warnings.join('；') || '搜索失败',
  }
}

/** Hosted Fetch: page → Markdown. Falls back to the local extractor in the renderer. */
export async function fetchHosted(input: HostedFetchInput): Promise<HostedFetchResult> {
  const apiKey = input.apiKey?.trim()
  if (!apiKey) return { ok: false, error: '未配置 DeepSeek API Key' }
  const raw = String(input.url || '').trim()
  if (!raw) return { ok: false, error: 'URL 不能为空' }

  try {
    // Never ship intranet URLs to the hosted service; this also mirrors the
    // public-only rule used by the local fetcher.
    await assertPublicHttpUrl(raw)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无效的 URL' }
  }

  const res = await safeFetch(deepseekToolUrl(input.baseUrl, 'fetch'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ url: raw }),
    timeoutMs: 30_000,
    maxBytes: 8 * 1024 * 1024,
    allowPrivate: true,
    allowedContentTypes: /^application\/json$/i,
  })
  if (!res.ok) return { ok: false, status: res.status, error: requestErrorMessage(res) }

  let parsed: { title?: unknown; content?: unknown }
  try {
    parsed = JSON.parse(res.text) as { title?: unknown; content?: unknown }
  } catch {
    return { ok: false, status: res.status, error: 'DeepSeek 返回了非 JSON 响应' }
  }
  const content = typeof parsed.content === 'string' ? parsed.content : ''
  if (!content.trim()) return { ok: false, status: res.status, error: '未能从页面提取正文' }
  return {
    ok: true,
    title: typeof parsed.title === 'string' ? parsed.title : '',
    content,
  }
}
