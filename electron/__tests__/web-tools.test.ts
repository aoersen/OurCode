import { describe, it, expect } from 'vitest'
import {
  availableSearchProviders,
  buildSearchQuery,
  deepseekToolUrl,
  mapDeepSeekResults,
  mapSearxngResults,
  mergeSearchResults,
  normalizeCount,
  parseBingRss,
  parseBraveHtml,
  parseDuckDuckGoHtml,
  resolveSearchChain,
} from '../../shared/webTools'

describe('buildSearchQuery', () => {
  it('appends validated DeepSeek-style operators', () => {
    expect(buildSearchQuery('  deepseek   api ', {
      site: 'github.com huggingface.co',
      lang: 'zh',
      after: '2025',
      before: '2026-01-01',
    })).toBe('deepseek api site:github.com OR site:huggingface.co lang:zh after:2025 before:2026-01-01')
  })

  it('accepts already-formatted site clauses without duplicating operators', () => {
    expect(buildSearchQuery('deepseek', {
      site: 'site:github.com OR site:huggingface.co',
    })).toBe('deepseek site:github.com OR site:huggingface.co')
  })

  it('drops invalid filters instead of injecting them', () => {
    expect(buildSearchQuery('deepseek', {
      site: '',
      lang: 'zh; rm -rf',
      after: 'yesterday',
      before: '2026-13',
    })).toBe('deepseek')
  })
})

describe('normalizeCount', () => {
  it('defaults, clamps and floors', () => {
    expect(normalizeCount(undefined)).toBe(8)
    expect(normalizeCount(0)).toBe(8)
    expect(normalizeCount(3.9)).toBe(3)
    expect(normalizeCount(999)).toBe(50)
  })
})

describe('deepseekToolUrl', () => {
  it('accepts both documented base URL forms', () => {
    expect(deepseekToolUrl(undefined, 'search')).toBe('https://api.deepseek.com/v1/tools/search')
    expect(deepseekToolUrl('https://api.deepseek.com/v1', 'search')).toBe('https://api.deepseek.com/v1/tools/search')
    expect(deepseekToolUrl('https://api.deepseek.com/v1/', 'fetch')).toBe('https://api.deepseek.com/v1/tools/fetch')
    expect(deepseekToolUrl('https://relay.example.com/openai/v1', 'fetch')).toBe('https://relay.example.com/openai/v1/tools/fetch')
  })
})

describe('resolveSearchChain', () => {
  it('uses the configured order under auto', () => {
    expect(resolveSearchChain({
      provider: 'auto',
      deepseek: { apiKey: 'sk-test' },
      searxng: { baseUrl: 'http://127.0.0.1:8080' },
    })).toEqual(['deepseek', 'searxng', 'bing', 'brave', 'duckduckgo'])
    expect(resolveSearchChain({ provider: 'auto', deepseek: { apiKey: '' } })).toEqual(['bing', 'brave', 'duckduckgo'])
  })

  it('lists every configured source for multi-source mode', () => {
    expect(availableSearchProviders({ deepseek: { apiKey: 'sk-test' }, searxng: { baseUrl: 'http://127.0.0.1:8080' } }))
      .toEqual(['deepseek', 'searxng', 'bing', 'brave', 'duckduckgo'])
    expect(availableSearchProviders({})).toEqual(['bing', 'brave', 'duckduckgo'])
  })

  it('honors an explicit provider without fallback', () => {
    expect(resolveSearchChain({ provider: 'searxng', deepseek: { apiKey: 'sk-test' } })).toEqual(['searxng'])
  })
})

describe('mapDeepSeekResults', () => {
  it('normalizes fields and filters unsafe URLs', () => {
    const items = mapDeepSeekResults({
      results: [
        {
          title: 'Docs',
          url: 'https://example.com/docs',
          snippet: 'short',
          summary: 'long summary',
          rerank_score: 2.1,
          authority: 3,
          date: '2026-01-02T00:00:00Z',
          site_name: 'Example',
        },
        { title: 'XSS', url: 'javascript:alert(1)' },
        { title: 'No URL' },
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'Docs',
      url: 'https://example.com/docs',
      snippet: 'short',
      summary: 'long summary',
      score: 2.1,
      authority: 3,
      date: '2026-01-02T00:00:00Z',
      siteName: 'Example',
      source: 'deepseek',
    })
  })

  it('tolerates a malformed payload', () => {
    expect(mapDeepSeekResults(null)).toEqual([])
    expect(mapDeepSeekResults({ results: 'nope' })).toEqual([])
  })
})

describe('mapSearxngResults', () => {
  it('maps content/publishedDate/engine', () => {
    const items = mapSearxngResults({
      results: [{
        title: 'SearXNG result',
        url: 'https://example.org/page',
        content: 'snippet text',
        publishedDate: '2026-02-03',
        score: 1.5,
        engine: 'brave',
      }],
    })
    expect(items[0]).toMatchObject({
      title: 'SearXNG result',
      url: 'https://example.org/page',
      snippet: 'snippet text',
      date: '2026-02-03',
      score: 1.5,
      siteName: 'brave',
      source: 'searxng',
    })
  })
})

describe('parseBingRss', () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>Bing</title>
    <item>
      <title><![CDATA[Bing <b>Result</b>]]></title>
      <link>https://example.com/a?x=1&amp;y=2</link>
      <description>Description &amp; more</description>
      <pubDate>周日, 01 11月 2026 18:08:00 GMT</pubDate>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/b</link>
      <description>Second description</description>
      <pubDate>Sun, 02 Nov 2026 03:04:05 GMT</pubDate>
    </item>
  </channel></rss>`

  it('parses RSS items, entities, CDATA and localized dates', () => {
    const items = parseBingRss(xml)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: 'Bing Result',
      url: 'https://example.com/a?x=1&y=2',
      snippet: 'Description & more',
      date: '2026-11-01T18:08:00.000Z',
      source: 'bing',
    })
    expect(items[1]).toMatchObject({
      title: 'Second',
      url: 'https://example.com/b',
      date: '2026-11-02T03:04:05.000Z',
    })
  })

  it('rejects non-RSS payloads', () => {
    expect(parseBingRss('<html><body>captcha</body></html>')).toEqual([])
    expect(parseBingRss('')).toEqual([])
  })
})

describe('parseBraveHtml', () => {
  const html = `
    <div class="snippet svelte-jmfu5f" data-pos="1" data-type="web">
      <div class="result-body"><a href="https://example.com/a?x=1&amp;y=2" target="_self" class="l1">
        <div class="title search-snippet-title line-clamp-1" title="Example &amp; Docs">Example</div></a>
        <div class="generic-snippet"><div class="content desktop-default-regular t-primary">Snippet &amp; text</div></div>
      </div>
    </div>
    <div class="snippet svelte-jmfu5f" data-pos="2" data-type="web">
      <div class="result-body"><a href="https://example.com/b" class="l1">
        <div class="title search-snippet-title" title="Second">Second</div></a>
        <div class="generic-snippet"><div class="content t-primary">Second snippet</div></div>
      </div>
    </div>
    <div class="snippet svelte-jmfu5f" data-pos="3" data-type="ad">
      <a href="https://ad.example.com" class="l1"><div class="title search-snippet-title" title="Ad">Ad</div></a>
    </div>
  `

  it('parses organic web results and skips ads', () => {
    const items = parseBraveHtml(html)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: 'Example & Docs',
      url: 'https://example.com/a?x=1&y=2',
      snippet: 'Snippet & text',
      source: 'brave',
    })
    expect(items[1]).toMatchObject({ title: 'Second', url: 'https://example.com/b', snippet: 'Second snippet' })
  })

  it('returns nothing for a non-result page', () => {
    expect(parseBraveHtml('<html><body>captcha</body></html>')).toEqual([])
  })
})

describe('mergeSearchResults', () => {
  const item = (url: string, source: 'bing' | 'brave') => ({
    title: url,
    url,
    snippet: '',
    source,
  })

  it('round-robins sources and dedupes canonical URLs', () => {
    const merged = mergeSearchResults([
      { provider: 'bing', results: [item('https://example.com/a', 'bing'), item('https://example.com/b', 'bing')] },
      { provider: 'brave', results: [item('https://www.example.com/a/', 'brave'), item('https://example.com/c', 'brave')] },
    ], 3)
    expect(merged.map((entry) => entry.url)).toEqual([
      'https://example.com/a',
      'https://example.com/c',
      'https://example.com/b',
    ])
  })

  it('respects the limit', () => {
    const merged = mergeSearchResults([
      { provider: 'bing', results: [item('https://example.com/a', 'bing')] },
      { provider: 'brave', results: [item('https://example.com/b', 'brave')] },
    ], 1)
    expect(merged).toHaveLength(1)
  })
})

describe('parseDuckDuckGoHtml', () => {
  const html = `
    <div class="result results_links web-result">
      <div class="result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fq%3D1&amp;rut=abc">Example <b>Docs</b></a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">A <b>snippet</b> &amp; more</a>
      </div>
    </div>
    <div class="result results_links result--ad">
      <a class="result__a" href="https://ad.example.com">Sponsored</a>
    </div>
  `

  it('unwraps redirects and strips markup/entities', () => {
    const items = parseDuckDuckGoHtml(html)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'Example Docs',
      url: 'https://example.com/docs?q=1',
      snippet: 'A snippet & more',
      source: 'duckduckgo',
    })
  })

  it('returns nothing for a captcha/challenge page', () => {
    expect(parseDuckDuckGoHtml('<form class="challenge-form"></form>')).toEqual([])
  })
})
