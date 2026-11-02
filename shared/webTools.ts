/**
 * Shared contracts for the web tools (`web_search` / `read_url`).
 *
 * Search/Fetch providers live in the main process (no CORS, one place for
 * keys), while the renderer only formats results. Everything that can be
 * tested without network or Electron lives here: query construction, result
 * mapping and provider fallback order.
 */

export type WebSearchProvider = 'deepseek' | 'searxng' | 'bing' | 'brave' | 'duckduckgo'
export type WebSearchProviderChoice = 'auto' | 'multi' | WebSearchProvider
export type WebFetchProviderChoice = 'auto' | 'local' | 'deepseek'

export interface DeepSeekToolsConfig {
  /** Empty = no hosted DeepSeek calls. */
  apiKey?: string
  /** Defaults to https://api.deepseek.com; `/v1` is optional. */
  baseUrl?: string
}

export interface SearxngConfig {
  /** Base URL of a SearXNG instance with the JSON format enabled. */
  baseUrl?: string
}

export interface WebSearchInput {
  query: string
  count?: number
  /** Original user question; DeepSeek uses it for query understanding. */
  question?: string
  site?: string
  lang?: string
  /** YYYY or YYYY-MM-DD. */
  after?: string
  /** YYYY or YYYY-MM-DD. */
  before?: string
  provider?: WebSearchProviderChoice
  deepseek?: DeepSeekToolsConfig
  searxng?: SearxngConfig
}

export interface WebSearchItem {
  title: string
  url: string
  snippet: string
  /** Longer query-specific summary (DeepSeek), meant to be read by a model. */
  summary?: string
  content?: string
  date?: string | null
  /** 0–4, -1 when unknown (DeepSeek only). */
  authority?: number
  /** 0–3 relevance/authority/freshness blend (DeepSeek only). */
  score?: number
  siteName?: string | null
  source: WebSearchProvider
}

export interface WebSearchResult {
  ok: boolean
  provider: WebSearchProvider | null
  /** Providers that contributed results (multi-source mode). */
  providers?: WebSearchProvider[]
  /** True when results were merged from more than one source. */
  merged?: boolean
  results: WebSearchItem[]
  /** Failed providers, in fallback order, with the reason. */
  warnings: string[]
  error?: string
}

export interface HostedFetchInput {
  url: string
  apiKey?: string
  baseUrl?: string
}

export interface HostedFetchResult {
  ok: boolean
  title?: string
  content?: string
  status?: number
  error?: string
}

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_SEARCH_COUNT = 8
export const MAX_SEARCH_COUNT = 50
/** DeepSeek Search rejects queries longer than this. */
export const MAX_DEEPSEEK_QUERY_CHARS = 128

/** Collapse whitespace so a model can't smuggle newlines into query operators. */
export function normalizeSearchQuery(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function normalizeCount(value: unknown, fallback = DEFAULT_SEARCH_COUNT): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, MAX_SEARCH_COUNT)
}

/** Only accept real calendar dates in the shapes DeepSeek documents. */
export function normalizeDateFilter(value: unknown): string {
  const v = String(value ?? '').trim()
  if (/^\d{4}$/.test(v)) return v
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v)
  if (!match) return ''
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return ''
  if (match[3]) {
    const day = Number(match[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return ''
    }
  }
  return v
}

export function normalizeLang(value: unknown): string {
  const v = String(value ?? '').trim()
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(v) ? v : ''
}

/**
 * Build the provider-neutral query string. DeepSeek and DuckDuckGo understand
 * these operators directly; SearXNG passes site: through to its engines.
 */
export function buildSearchQuery(
  query: unknown,
  filters: { site?: unknown; lang?: unknown; after?: unknown; before?: unknown } = {},
): string {
  const parts = [normalizeSearchQuery(query)]
  const site = String(filters.site ?? '').trim()
  if (site) {
    // Accept both "a.com b.com" and "a.com OR b.com" / "site:a.com".
    const domains = site
      .split(/[\s,]+/)
      .map((domain) => domain.replace(/^site:/i, '').replace(/^["']|["']$/g, ''))
      .filter((domain) => domain && domain.toUpperCase() !== 'OR')
    if (domains.length === 1) parts.push(`site:${domains[0]}`)
    else if (domains.length > 1) parts.push(domains.map((d) => `site:${d}`).join(' OR '))
  }
  const lang = normalizeLang(filters.lang)
  if (lang) parts.push(`lang:${lang}`)
  const after = normalizeDateFilter(filters.after)
  if (after) parts.push(`after:${after}`)
  const before = normalizeDateFilter(filters.before)
  if (before) parts.push(`before:${before}`)
  return parts.filter(Boolean).join(' ').trim()
}

/**
 * Hosted fetch endpoint. Accepts either `https://api.deepseek.com` or the
 * common `https://api.deepseek.com/v1` base form.
 */
export function deepseekToolUrl(baseUrl: string | undefined, kind: 'search' | 'fetch'): string {
  const raw = (baseUrl || DEFAULT_DEEPSEEK_BASE_URL).trim().replace(/\/+$/, '')
  const withoutV1 = /\/v1$/i.test(raw) ? raw.replace(/\/v1$/i, '') : raw
  const base = withoutV1 || DEFAULT_DEEPSEEK_BASE_URL
  return `${base}/v1/tools/${kind}`
}

/**
 * The providers to try, in order. `auto` uses the cheapest configured option:
 * DeepSeek when a key exists, then a self-hosted SearXNG, then DuckDuckGo.
 */
export function resolveSearchChain(input: Pick<WebSearchInput, 'provider' | 'deepseek' | 'searxng'>): WebSearchProvider[] {
  const choice = input.provider ?? 'auto'
  // Persisted preferences can be edited/corrupted outside this type; an
  // unknown value must not produce an empty or fake provider chain.
  if (choice === 'deepseek' || choice === 'searxng' || choice === 'bing' || choice === 'brave' || choice === 'duckduckgo') return [choice]
  const chain: WebSearchProvider[] = []
  if (input.deepseek?.apiKey?.trim()) chain.push('deepseek')
  if (input.searxng?.baseUrl?.trim()) chain.push('searxng')
  // Bing RSS and Brave HTML are key-free and reachable on networks where
  // DuckDuckGo is blocked; DuckDuckGo stays as the final fallback.
  chain.push('bing')
  chain.push('brave')
  chain.push('duckduckgo')
  return chain
}

/** Every source that can run with the current config, in priority order. */
export function availableSearchProviders(
  input: Pick<WebSearchInput, 'deepseek' | 'searxng'>,
): WebSearchProvider[] {
  const providers: WebSearchProvider[] = []
  if (input.deepseek?.apiKey?.trim()) providers.push('deepseek')
  if (input.searxng?.baseUrl?.trim()) providers.push('searxng')
  providers.push('bing', 'brave', 'duckduckgo')
  return providers
}

/** Filter out non-http(s) URLs (javascript:, data:, file: …) from any provider. */
export function httpUrlOrEmpty(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Map `/v1/tools/search` JSON into the renderer-facing shape. */
export function mapDeepSeekResults(raw: unknown): WebSearchItem[] {
  const rows = (raw as { results?: unknown } | null)?.results
  if (!Array.isArray(rows)) return []
  const out: WebSearchItem[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const url = httpUrlOrEmpty(item.url)
    if (!url) continue
    out.push({
      title: asString(item.title) || url,
      url,
      snippet: asString(item.snippet),
      summary: asString(item.summary) || undefined,
      content: asString(item.content) || undefined,
      date: typeof item.date === 'string' ? item.date : null,
      authority: asNumber(item.authority),
      score: asNumber(item.rerank_score),
      siteName: typeof item.site_name === 'string' ? item.site_name : null,
      source: 'deepseek',
    })
  }
  return out
}

/** Map SearXNG's `format=json` results. */
export function mapSearxngResults(raw: unknown): WebSearchItem[] {
  const rows = (raw as { results?: unknown } | null)?.results
  if (!Array.isArray(rows)) return []
  const out: WebSearchItem[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const url = httpUrlOrEmpty(item.url)
    if (!url) continue
    out.push({
      title: asString(item.title) || url,
      url,
      snippet: asString(item.content) || asString(item.snippet),
      date: asString(item.publishedDate) || null,
      score: asNumber(item.score),
      siteName: asString(item.engine) || null,
      source: 'searxng',
    })
  }
  return out
}

const RSS_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function isoFromParts(
  year: string,
  month: string,
  day: string,
  hour?: string,
  minute?: string,
  second?: string,
): string | null {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  const h = Number(hour ?? 0)
  const min = Number(minute ?? 0)
  const s = Number(second ?? 0)
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || s > 59) return null
  const date = new Date(Date.UTC(y, m - 1, d, h, min, s))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return date.toISOString()
}

/**
 * Bing RSS emits localized dates (e.g. "周日, 01 11月 2026 18:08:00 GMT"),
 * which Date.parse cannot read. Parse the two common forms, then fall back.
 */
export function normalizeRssDate(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const zh = /(\d{1,2})\s+(\d{1,2})月\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(raw)
  if (zh) return isoFromParts(zh[3], zh[2], zh[1], zh[4], zh[5], zh[6])
  const en = /(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(raw)
  if (en) {
    const month = RSS_MONTHS[en[2].toLowerCase()]
    if (month) return isoFromParts(en[3], String(month), en[1], en[4], en[5], en[6])
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/**
 * Parse Brave's server-rendered results page. Each organic result is a
 * `snippet` block with `data-type="web"`, an absolute result link, a
 * `search-snippet-title` element and a `content` paragraph. Ads use a
 * different data-type and are skipped by only matching `web`.
 */
export function parseBraveHtml(html: string): WebSearchItem[] {
  if (!html || !/search-snippet-title/i.test(html)) return []
  const starts = Array.from(html.matchAll(/<div\b[^>]*class="snippet(?:\s[^"]*)?"[^>]*data-type="web"[^>]*>/gi))
  const out: WebSearchItem[] = []
  const seen = new Set<string>()
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1].index! : Math.min(html.length, start.index! + 12_000)
    const block = html.slice(start.index!, end)

    const anchor = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i.exec(block)
    if (!anchor) continue
    const url = httpUrlOrEmpty(decodeHtmlEntities(anchor[1]))
    if (!url || seen.has(url)) continue

    const titleOpen = /<div\b[^>]*class="[^"]*search-snippet-title[^"]*"[^>]*>/i.exec(block)
    if (!titleOpen) continue
    const attrTitle = /title="([^"]*)"/i.exec(titleOpen[0])?.[1]
    let title = attrTitle ? decodeHtmlEntities(attrTitle) : ''
    if (!title) {
      const contentStart = titleOpen.index! + titleOpen[0].length
      const close = block.indexOf('</div>', contentStart)
      if (close >= 0) title = stripTags(block.slice(contentStart, close))
    }
    title = title.replace(/\s+/g, ' ').trim()
    if (!title) continue

    // Match the class token exactly: "content ..." yes, "result-content" no.
    const contentMatch = /<div\b[^>]*class="(?:[^"]*\s)?content(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/div>/i.exec(block)
    seen.add(url)
    out.push({
      title,
      url,
      snippet: contentMatch ? stripTags(contentMatch[1]) : '',
      source: 'brave',
    })
  }
  return out
}

function canonicalResultUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(utm_|fbclid$|gclid$|spm$|from$|ref$)/i.test(key)) url.searchParams.delete(key)
    }
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${url.search}`
  } catch {
    return value.toLowerCase()
  }
}

/**
 * Round-robin merge so every source contributes its top results; duplicates
 * (same canonical URL) keep the highest-priority version.
 */
export function mergeSearchResults(
  groups: Array<{ provider: WebSearchProvider; results: WebSearchItem[] }>,
  limit: number,
): WebSearchItem[] {
  const queues = groups
    .filter((group) => group.results.length > 0)
    .map((group) => ({ provider: group.provider, items: [...group.results] }))
  const seen = new Set<string>()
  const out: WebSearchItem[] = []
  let progressed = true
  while (out.length < limit && progressed) {
    progressed = false
    for (const queue of queues) {
      if (out.length >= limit) break
      while (queue.items.length > 0) {
        const item = queue.items.shift()!
        const key = canonicalResultUrl(item.url)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
        progressed = true
        break
      }
    }
  }
  return out
}

function stripCdata(value: string): string {
  const trimmed = value.trim()
  const match = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed)
  return match ? match[1] : trimmed
}

function rssTag(item: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(item)
  return match ? stripTags(stripCdata(match[1])) : ''
}

/**
 * Parse Bing's key-free `format=rss` search output. It is a normal RSS feed
 * (title/link/description/pubDate), which is far less brittle than scraping a
 * results page and works where DuckDuckGo is unreachable.
 */
export function parseBingRss(xml: string): WebSearchItem[] {
  if (!xml || !/<rss\b/i.test(xml)) return []
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || []
  const out: WebSearchItem[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const url = httpUrlOrEmpty(rssTag(item, 'link'))
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({
      title: rssTag(item, 'title') || url,
      url,
      snippet: rssTag(item, 'description'),
      date: normalizeRssDate(rssTag(item, 'pubDate')),
      source: 'bing',
    })
  }
  return out
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const hex = code[1]?.toLowerCase() === 'x'
      const num = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(num) && num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : match
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match
  })
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** DDG wraps outbound links in /l/?uddg=…; unwrap before handing them to the model. */
function normalizeDdgUrl(href: string): string {
  const decoded = decodeHtmlEntities(href)
  const absolute = decoded.startsWith('//') ? `https:${decoded}` : decoded
  try {
    const url = new URL(absolute)
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg')
      if (target) return httpUrlOrEmpty(target)
    }
    return httpUrlOrEmpty(absolute)
  } catch {
    return ''
  }
}

/**
 * Parse the no-JS DuckDuckGo results page. Kept as the zero-config fallback;
 * it is inherently brittle, so failures surface as "no results" and the
 * caller still reports which provider ran.
 */
export function parseDuckDuckGoHtml(html: string): WebSearchItem[] {
  if (!html || /g-recaptcha|anomaly-modal|challenge-form/i.test(html)) return []
  // Split on a zero-width lookahead so each block keeps its opening tag — the
  // class attribute is what tells sponsored rows apart from organic ones.
  const blocks = html.split(/(?=<div\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>)/i)
  const out: WebSearchItem[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    const open = /^<div\b[^>]*class="([^"]*)"/i.exec(block.trimStart())
    if (!open) continue
    if (/\bresult--ad\b/i.test(open[1])) continue
    const anchor = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!anchor) continue
    const openTag = anchor[0].slice(0, anchor[0].indexOf('>') + 1)
    const href = /href="([^"]+)"/i.exec(openTag)?.[1] || ''
    const title = stripTags(anchor[1])
    const url = normalizeDdgUrl(href)
    if (!url || !title || seen.has(url)) continue
    const snippetMatch = /<(?:a|div|span)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(block)
    seen.add(url)
    out.push({
      title,
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : '',
      source: 'duckduckgo',
    })
  }
  return out
}
