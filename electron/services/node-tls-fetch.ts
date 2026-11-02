// Node-stack HTTP client used by the llm:http bridge when a config opts into
// `skipTlsVerify`.
//
// Why not net.fetch: Chromium caches a *failed* certificate verification per
// host+cert inside the network service, and no Electron API flushes it. Once an
// intranet endpoint has failed once in a session, `session.setCertificateVerifyProc`
// is never consulted again for that host (measured on Electron 30: still failing
// 99s later, proc silent), so ticking「跳过证书校验」could not recover until an app
// restart. Node's https does its own handshake every request, so
// `rejectUnauthorized: false` takes effect immediately.
//
// The shape mirrors the subset of fetch the bridge needs: status/statusText/
// headers + a text body, with optional streaming callbacks and an idle timeout.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders, RequestOptions } from 'node:http'

export interface NodeTlsFetchHead {
  status: number
  statusText: string
  headers: Record<string, string>
}

export interface NodeTlsFetchResult extends NodeTlsFetchHead {
  ok: boolean
  text: string
}

export interface NodeTlsFetchOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Idle timeout (re-armed on every received chunk); 0/undefined disables it. */
  timeoutMs?: number
  /** True when the caller reads the body from onChunk (SSE). */
  stream?: boolean
  /** false = accept self-signed / private-CA certificates. */
  rejectUnauthorized?: boolean
  signal?: AbortSignal
  onHeaders?: (head: NodeTlsFetchHead) => void
  onChunk?: (chunk: Buffer) => void
}

const MAX_REDIRECTS = 5
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

function normalizeHeaders(raw: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    out[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

/**
 * Perform one request on the Node stack. Resolves with the head + body text
 * (streamed bodies resolve with an empty text once the stream has been drained
 * through onChunk).
 */
export function nodeTlsFetch(options: NodeTlsFetchOptions): Promise<NodeTlsFetchResult> {
  return run(options, 0)
}

function run(options: NodeTlsFetchOptions, redirects: number): Promise<NodeTlsFetchResult> {
  const { url, stream, onHeaders, onChunk } = options
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return Promise.reject(new Error('无效的 URL'))
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Promise.reject(new Error('仅支持 http/https URL'))
  }

  const isHttps = parsed.protocol === 'https:'
  const headers: Record<string, string> = { ...(options.headers || {}) }
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
  if (options.body && !hasContentType) headers['content-type'] = 'application/json'
  if (options.body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(Buffer.byteLength(options.body))
  }

  const requestOptions: RequestOptions = {
    method: options.method || 'GET',
    headers,
    ...(isHttps ? { rejectUnauthorized: options.rejectUnauthorized !== false } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }

  return new Promise<NodeTlsFetchResult>((resolve, reject) => {
    const send = isHttps ? httpsRequest : httpRequest
    const req = send(parsed, requestOptions, (res) => {
      const head: NodeTlsFetchHead = {
        status: res.statusCode ?? 0,
        statusText: res.statusMessage || '',
        headers: normalizeHeaders(res.headers),
      }

      // Redirects are re-issued before anything is handed to the caller, so a
      // streamed request never forwards the redirect body.
      if (REDIRECT_CODES.has(head.status) && res.headers.location) {
        res.resume()
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('重定向次数过多'))
          return
        }
        const next = new URL(res.headers.location, parsed).toString()
        const downgradeToGet = head.status === 303 || (head.status !== 307 && head.status !== 308 && requestOptions.method === 'POST')
        void run({
          ...options,
          url: next,
          ...(downgradeToGet ? { method: 'GET', body: undefined } : {}),
        }, redirects + 1).then(resolve, reject)
        return
      }

      arm()
      onHeaders?.(head)

      if (!stream) {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => { arm(); chunks.push(chunk) })
        res.on('end', () => resolve({ ...head, ok: head.status >= 200 && head.status < 300, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
        return
      }

      res.on('data', (chunk: Buffer) => { arm(); onChunk?.(chunk) })
      res.on('end', () => resolve({ ...head, ok: head.status >= 200 && head.status < 300, text: '' }))
      res.on('error', reject)
    })

    // Idle timeout: destroy the socket so the caller's retry/abort path runs.
    let timer: NodeJS.Timeout | null = null
    const arm = (): void => {
      const ms = options.timeoutMs || 0
      if (timer) clearTimeout(timer)
      timer = ms > 0 ? setTimeout(() => { req.destroy(new Error('请求超时或已取消')) }, ms) : null
    }
    const clear = (): void => { if (timer) { clearTimeout(timer); timer = null } }

    req.on('error', (err: Error) => { clear(); reject(err) })
    req.on('close', clear)
    arm()

    if (options.signal) {
      const onAbort = (): void => { req.destroy(new Error('请求超时或已取消')) }
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (options.body) req.write(options.body)
    req.end()
  })
}
