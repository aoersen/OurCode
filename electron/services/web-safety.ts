/**
 * Main-process URL safety + bounded fetch.
 *
 * `read_url` and `web_search` feed model-generated / page-derived URLs into the
 * main process, so every hop is validated before it is fetched:
 *   - only http(s), no embedded credentials, reasonable length
 *   - loopback / private / link-local / metadata addresses are refused
 *   - redirects are followed manually and re-validated (a public URL must not
 *     bounce into 127.0.0.1 or 169.254.169.254)
 *   - response bodies are streamed and hard-capped
 *
 * DNS is resolved before each hop. A hostname could still rebind between that
 * lookup and net.fetch's own resolution; pinning would require a custom socket
 * layer, so the check is deliberately fail-closed on any private address.
 */
import { net } from 'electron'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import * as chardet from 'chardet'
import * as iconv from 'iconv-lite'

export interface SafeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /** Only for user-configured API endpoints (e.g. a local SearXNG). */
  allowPrivate?: boolean
  /** Reject responses whose media type does not match. */
  allowedContentTypes?: RegExp
}

export interface SafeFetchResult {
  ok: boolean
  status: number
  contentType: string
  finalUrl: string
  text: string
  error?: string
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
])

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan']

type IpClass = 'public' | 'private' | 'invalid'

function parseIpv4(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = out * 256 + n
  }
  return out >>> 0
}

const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]

function isPublicIpv4(value: string): boolean {
  const n = parseIpv4(value)
  if (n === null) return false
  for (const [base, prefix] of BLOCKED_V4_RANGES) {
    const baseInt = parseIpv4(base)
    if (baseInt === null) continue
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    if ((n & mask) === (baseInt & mask)) return false
  }
  return true
}

function expandIpv6(value: string): number[] | null {
  let addr = value.toLowerCase()
  if (addr.includes('%')) addr = addr.split('%')[0]
  // Convert a dotted IPv4 tail (::ffff:192.168.1.1) into two hextets.
  if (addr.includes('.')) {
    const idx = addr.lastIndexOf(':')
    if (idx < 0) return null
    const v4 = parseIpv4(addr.slice(idx + 1))
    if (v4 === null) return null
    const hi = ((v4 >>> 16) & 0xffff).toString(16)
    const lo = (v4 & 0xffff).toString(16)
    addr = `${addr.slice(0, idx + 1)}${hi}:${lo}`
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  const groups = [...head, ...Array(missing).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const nums = groups.map((g) => parseInt(g || '0', 16))
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null
  return nums
}

function publicFromHextets(hi: number, lo: number): boolean {
  const v4 = `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`
  return isPublicIpv4(v4)
}

function isPublicIpv6(value: string): boolean {
  const g = expandIpv6(value)
  if (!g) return false
  // :: and ::1
  if (g.every((n) => n === 0)) return false
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return false
  // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast)
  if ((g[0] & 0xfe00) === 0xfc00) return false
  if ((g[0] & 0xffc0) === 0xfe80) return false
  if ((g[0] & 0xff00) === 0xff00) return false
  // 2001:db8::/32 documentation, 2001::/32 Teredo
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0x0000)) return false
  // 0100::/64 discard-only
  if (g[0] === 0x0100 && g.slice(1).every((n) => n === 0)) return false
  // ::a.b.c.d (deprecated IPv4-compatible form; ::1 is already handled above)
  if (g.slice(0, 6).every((n) => n === 0)) return publicFromHextets(g[6], g[7])
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return publicFromHextets(g[6], g[7])
  }
  // 64:ff9b::/96 (NAT64 well-known prefix) embeds IPv4 in the last 32 bits.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) {
    return publicFromHextets(g[6], g[7])
  }
  // 2002::/16 (6to4) embeds IPv4 in groups 1–2.
  if (g[0] === 0x2002) return publicFromHextets(g[1], g[2])
  return true
}

/** Classify a literal IP; hostnames return 'invalid' (resolve them first). */
export function classifyIp(value: string): IpClass {
  const raw = value.trim().replace(/^\[|\]$/g, '')
  if (!raw) return 'invalid'
  const version = isIP(raw)
  if (version === 4) return isPublicIpv4(raw) ? 'public' : 'private'
  if (version === 6) return isPublicIpv6(raw) ? 'public' : 'private'
  return 'invalid'
}

/**
 * Synchronous URL validation. Hostnames are checked against a small local-name
 * denylist here; `assertPublicHttpUrl` adds DNS resolution.
 */
export function validateHttpUrl(raw: string, opts: { allowPrivate?: boolean } = {}): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('无效的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http/https URL')
  }
  if (url.username || url.password) {
    throw new Error('URL 不能包含用户名或密码')
  }
  if (url.href.length > 8192) {
    throw new Error('URL 过长')
  }
  if (opts.allowPrivate) return url

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host) throw new Error('无效的 URL')
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error('已阻止访问内网/本地地址')
  }
  if (isIP(host) && classifyIp(host) !== 'public') {
    throw new Error('已阻止访问内网/本地地址')
  }
  return url
}

/** Validate the URL and every address its hostname currently resolves to. */
export async function assertPublicHttpUrl(raw: string, opts: { allowPrivate?: boolean } = {}): Promise<URL> {
  const url = validateHttpUrl(raw, opts)
  if (opts.allowPrivate) return url
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isIP(host)) return url
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('域名解析失败')
  }
  if (!addresses.length) throw new Error('域名解析失败')
  if (addresses.some((entry) => classifyIp(entry.address) !== 'public')) {
    throw new Error('已阻止访问内网/本地地址')
  }
  return url
}

function decodeBody(buffer: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  const encoding = charset || chardet.detect(buffer) || 'utf-8'
  if (/^utf-?8$/i.test(encoding)) return buffer.toString('utf8')
  try {
    return iconv.encodingExists(encoding) ? iconv.decode(buffer, encoding) : buffer.toString('utf8')
  } catch {
    return buffer.toString('utf8')
  }
}

interface RawRequestResult {
  status: number
  headers: Record<string, string[]>
  body: Buffer
  redirectUrl?: string
}

/**
 * One HTTP hop via net.request. `redirect: 'manual'` exposes the target in the
 * `redirect` event; net.fetch's manual mode returns an opaque response whose
 * Location header is not readable, which made every 3xx page look empty.
 */
function requestOnce(
  url: URL,
  options: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number },
): Promise<RawRequestResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let redirectUrl: string | undefined
    const request = net.request({
      method: options.method,
      url: url.toString(),
      redirect: 'manual',
      headers: options.headers,
      // read_url must not inherit cookies from the app's browser session.
      useSessionCookies: false,
    })
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('请求超时')))
      request.abort()
    }, options.timeoutMs)

    request.on('redirect', (statusCode, _method, target) => {
      redirectUrl = target
      finish(() => resolve({ status: statusCode, headers: {}, body: Buffer.alloc(0), redirectUrl: target }))
      request.abort()
    })

    request.on('response', (response) => {
      const status = response.statusCode
      const headers: Record<string, string[]> = {}
      for (const [key, value] of Object.entries(response.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value : [String(value)]
      }
      const contentLength = Number(headers['content-length']?.[0] || 0)
      if (contentLength > options.maxBytes) {
        finish(() => reject(new Error(`响应超过大小上限 (${options.maxBytes} bytes)`)))
        request.abort()
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk) => {
        if (settled) return
        const buffer = Buffer.from(chunk)
        total += buffer.length
        if (total > options.maxBytes) {
          finish(() => reject(new Error(`响应超过大小上限 (${options.maxBytes} bytes)`)))
          request.abort()
          return
        }
        chunks.push(buffer)
      })
      response.on('end', () => finish(() => resolve({ status, headers, body: Buffer.concat(chunks) })))
      response.on('error', (error: Error) => finish(() => reject(error)))
    })

    request.on('error', (error: Error) => {
      // Manual redirects surface here as "Redirect was cancelled" after the
      // redirect event; the captured target is the real result.
      if (redirectUrl) {
        finish(() => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), redirectUrl }))
      } else {
        finish(() => reject(error))
      }
    })

    if (options.body && options.method !== 'GET' && options.method !== 'HEAD') request.write(options.body)
    request.end()
  })
}

/**
 * Bounded fetch with per-hop SSRF validation. Returns an error result instead
 * of throwing so callers can render a useful tool message.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), 120_000)
  const maxBytes = Math.min(Math.max(Number(options.maxBytes) || DEFAULT_MAX_BYTES, 64 * 1024), 16 * 1024 * 1024)
  const maxRedirects = Math.min(Math.max(Number(options.maxRedirects) || DEFAULT_MAX_REDIRECTS, 0), 10)
  const deadline = Date.now() + timeoutMs
  let current = rawUrl
  let method = (options.method || 'GET').toUpperCase()
  let body = options.body
  let headers = options.headers ? { ...options.headers } : undefined

  const stripCredentials = () => {
    if (!headers) return
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      if (!['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) next[key] = value
    }
    headers = next
  }

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return { ok: false, status: 0, contentType: '', finalUrl: current, text: '', error: '请求超时' }
      }
      const url = await assertPublicHttpUrl(current, { allowPrivate: options.allowPrivate })
      const response = await requestOnce(url, {
        method,
        headers,
        body,
        timeoutMs: remaining,
        maxBytes,
      })

      if (response.redirectUrl) {
        if (!response.redirectUrl.trim()) {
          return { ok: false, status: response.status, contentType: '', finalUrl: url.toString(), text: '', error: '重定向缺少目标地址' }
        }
        if (hop === maxRedirects) {
          return { ok: false, status: response.status, contentType: '', finalUrl: url.toString(), text: '', error: '重定向次数过多' }
        }
        // 303 always drops the body; 301/302 historically do the same for POST.
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET'
          body = undefined
        }
        const next = new URL(response.redirectUrl, url)
        if (next.origin !== url.origin) stripCredentials()
        current = next.toString()
        continue
      }

      const contentType = response.headers['content-type']?.[0] || ''
      if (options.allowedContentTypes && response.status >= 200 && response.status < 300) {
        const mediaType = contentType.split(';')[0].trim()
        if (!options.allowedContentTypes.test(mediaType)) {
          return {
            ok: false,
            status: response.status,
            contentType,
            finalUrl: url.toString(),
            text: '',
            error: `不支持的内容类型：${mediaType || '未知'}`,
          }
        }
      }

      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        contentType,
        finalUrl: url.toString(),
        text: decodeBody(response.body, contentType),
      }
    }
    return { ok: false, status: 0, contentType: '', finalUrl: current, text: '', error: '重定向次数过多' }
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      finalUrl: current,
      text: '',
      error: error?.message || '网络请求失败',
    }
  }
}

/**
 * Fetch a web page (not a configured API endpoint): public addresses only and
 * text-ish media types only. PDFs and binaries are rejected with a clear error
 * instead of being decoded as mojibake.
 */
export async function fetchPage(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number; allowPrivate?: boolean } = {},
): Promise<SafeFetchResult> {
  return safeFetch(url, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    allowPrivate: options.allowPrivate,
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; OurCode-ide/0.6; +https://github.com/ourcode)',
      accept: 'text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5',
    },
    allowedContentTypes: /^(text\/html|application\/xhtml\+xml|text\/plain|application\/json|application\/xml|text\/xml)$/i,
  })
}
