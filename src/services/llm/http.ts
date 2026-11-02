// Drop-in fetch replacement for LLM HTTP requests.
//
// The renderer is sandboxed, so its fetch() is subject to CORS. Third-party
// OpenAI-compatible relays (longcat, one-api, new-api, ...) often omit CORS
// headers, which makes renderer-side LLM calls fail with a cryptic
// "Failed to fetch". This wrapper routes requests through the main process
// (net.fetch, no CORS) via the llm:http IPC bridge. When electronAPI.llmHttp
// is unavailable (vitest env, plain-browser dev server) it falls back to the
// native fetch so existing tests and dev flows keep working.
//
// The returned object mirrors the subset of the fetch Response API the LLM
// adapters use: ok / status / statusText / headers.get / text() / json() /
// arrayBuffer() / body (a ReadableStream for streaming responses).

export interface LlmFetchResponse {
  ok: boolean
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  text(): Promise<string>
  json(): Promise<any>
  arrayBuffer(): Promise<ArrayBuffer>
  body: ReadableStream<Uint8Array> | null
}

export interface LlmFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface LlmFetchOptions {
  /** True when the caller will read the SSE stream from response.body. */
  stream?: boolean
  /** Skip TLS certificate verification for this request (intranet / self-signed certs). */
  skipTlsVerify?: boolean
}

/** Map raw network errors (CORS, DNS, refused...) to a friendly message. */
export function friendlyNetworkError(message: string): string {
  const lower = (message || '').toLowerCase()
  if (!message) return '网络请求失败，请检查网络、代理或 API 地址'
  if (
    lower.includes('failed to fetch') ||
    lower.includes('fetch failed') ||
    lower.includes('networkerror') ||
    lower.includes('load failed') ||
    lower.includes('getaddrinfo') ||
    lower.includes('econnrefused') ||
    lower.includes('socket hang up')
  ) {
    return '网络请求失败，请检查网络、代理或 API 地址'
  }
  if (lower.includes('certificate') || lower.includes('err_cert') || lower.includes('tls') || lower.includes('ssl')) {
    // A handshake failure is not always a bad cert (the port may not speak TLS at
    // all), so keep the raw reason — without it "跳过证书校验" looks broken when
    // the real cause is the protocol/port.
    if (lower.includes('protocol') || lower.includes('wrong_version') || lower.includes('version')) {
      return `TLS 握手失败：该端口可能不是 HTTPS，或网关 / 代理中断了 TLS 连接（原始错误：${message}）`
    }
    return `HTTPS 证书校验失败：内网自签名 / 私有 CA 证书请在该配置中勾选「跳过证书校验」（原始错误：${message}）`
  }
  return message
}

// Sent to the main process as the per-request timeout; for streaming requests
// the main process treats it as an idle (no-data) timeout, re-armed per chunk.
const DEFAULT_TIMEOUT_MS = 600_000 // 10 min

let idCounter = 0
function nextRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  idCounter += 1
  return `llm-${Date.now()}-${idCounter}`
}

function getElectronApi(): any {
  return typeof window !== 'undefined' ? (window as any).electronAPI : null
}

function buildHeaderMap(headers: Record<string, string> | undefined): { get(name: string): string | null } {
  const lower = new Map<string, string>()
  for (const [key, value] of Object.entries(headers || {})) {
    lower.set(key.toLowerCase(), String(value))
  }
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null }
}

function decodeBase64Chunk(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function concatChunks(chunks: Uint8Array[]): string {
  let total = 0
  for (const c of chunks) total += c.length
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { merged.set(c, offset); offset += c.length }
  return new TextDecoder().decode(merged)
}

function nativeFetch(url: string, init: LlmFetchInit): Promise<LlmFetchResponse> {
  return fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  }).then((res) => ({
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body: res.body,
    text: () => res.text(),
    json: () => res.json(),
    arrayBuffer: () => res.arrayBuffer(),
  }))
}

export function llmFetch(url: string, init: LlmFetchInit = {}, options: LlmFetchOptions = {}): Promise<LlmFetchResponse> {
  const api = getElectronApi()
  if (!api || typeof api.llmHttp !== 'function') {
    return nativeFetch(url, init)
  }

  const id = nextRequestId()
  const request = {
    id,
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
    stream: !!options.stream,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipTlsVerify: options.skipTlsVerify,
  }

  // Shared abort handler: cancels the request in the main process. Wired up for
  // both the non-streaming path (below) and the streaming path (llmFetchStream).
  const onAbort = () => { api.llmHttpAbort(id) }

  if (!options.stream) {
    // Non-streaming path: the invoke resolves with the whole body, so the
    // AbortSignal has to be wired manually (llm:httpAbort cancels the request
    // in the main process) — otherwise a "test connection" or model fetch
    // against a hanging host ignores the signal and runs until the 120s
    // main-side timeout.
    if (init.signal?.aborted) {
      return Promise.reject(new Error('请求已取消'))
    }
    init.signal?.addEventListener('abort', onAbort)
    return api.llmHttp(request).then((res: any) => {
      if (!res || typeof res !== 'object') throw new Error('LLM 请求失败：主进程无响应')
      if (res.error) throw new Error(friendlyNetworkError(res.error))
      const text = res.text || ''
      return {
        ok: !!res.ok,
        status: res.status ?? 0,
        statusText: res.statusText || '',
        headers: buildHeaderMap(res.headers),
        body: null,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(text ? JSON.parse(text) : {}),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
      }
    }).catch((err: any) => {
      if (init.signal?.aborted) throw new Error('请求已取消')
      throw err
    }).finally(() => {
      if (init.signal) init.signal.removeEventListener('abort', onAbort)
    })
  }

  return llmFetchStream(api, id, url, init, options)
}

/**
 * Streaming path: main forwards { ok, status, headers } first (llm:httpHeaders),
 * then body chunks as base64 (llm:httpChunk), then llm:httpDone / llm:httpError.
 * The outer promise resolves once the headers arrive; the returned Response's
 * body is a ReadableStream fed by those IPC events, so the adapters' existing
 * SSE parsing works unchanged.
 */
function llmFetchStream(api: any, id: string, url: string, init: LlmFetchInit, options: LlmFetchOptions): Promise<LlmFetchResponse> {
  return new Promise((resolve, reject) => {
    let started = false
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let buffered: Uint8Array[] = []
    let settled = false
    let streamEnded = false
    const allChunks: Uint8Array[] = []
    let resolveBodyText: (t: string) => void = () => {}
    let rejectBodyText: (e: Error) => void = () => {}

    const resolveResponse = (resp: LlmFetchResponse) => { if (!settled) { settled = true; resolve(resp) } }
    const rejectResponse = (err: Error) => { if (!settled) { settled = true; reject(err) } }

    const onAbort = () => { api.llmHttpAbort(id) }

    function cleanup() {
      unsubHeaders(); unsubChunk(); unsubDone(); unsubError()
      if (init.signal) init.signal.removeEventListener('abort', onAbort)
    }

    function errorStream(err: Error) {
      if (controller) {
        try { controller.error(err) } catch { /* already closed */ }
      }
    }

    function onHeaders(payload: any) {
      if (!payload || payload.id !== id || streamEnded) return
      unsubHeaders()

      const bodyTextPromise = new Promise<string>((res, rej) => { resolveBodyText = res; rejectBodyText = rej })
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
          started = true
          for (const chunk of buffered) c.enqueue(chunk)
          buffered = []
        },
        cancel() {
          // Renderer released the reader early (abort / stop) — tell main to
          // stop reading the response body.
          api.llmHttpAbort(id)
        },
      })

      resolveResponse({
        ok: !!payload.ok,
        status: payload.status ?? 0,
        statusText: payload.statusText || '',
        headers: buildHeaderMap(payload.headers),
        body: stream,
        text: () => bodyTextPromise,
        json: () => bodyTextPromise.then((t) => JSON.parse(t)),
        arrayBuffer: () => bodyTextPromise.then((t) => new TextEncoder().encode(t).buffer),
      })
    }

    function onChunk(payload: any) {
      if (!payload || payload.id !== id) return
      const bytes = decodeBase64Chunk(payload.data)
      allChunks.push(bytes)
      if (started && controller) {
        try { controller.enqueue(bytes) } catch { /* ignore */ }
      } else {
        buffered.push(bytes)
      }
    }

    function onDone(payload: any) {
      if (!payload || payload.id !== id || streamEnded) return
      streamEnded = true
      cleanup()
      if (started && controller) {
        try { controller.close() } catch { /* ignore */ }
      }
      resolveBodyText(concatChunks(allChunks))
    }

    function onError(payload: any) {
      if (!payload || payload.id !== id || streamEnded) return
      streamEnded = true
      cleanup()
      const err = new Error(friendlyNetworkError(payload.message))
      errorStream(err)
      rejectBodyText(err)
      // If the error arrived before headers (invalid URL / DNS failure), the
      // outer promise is still pending — reject it too.
      rejectResponse(err)
    }

    const unsubHeaders = api.onLlmHttpHeaders(onHeaders)
    const unsubChunk = api.onLlmHttpChunk(onChunk)
    const unsubDone = api.onLlmHttpDone(onDone)
    const unsubError = api.onLlmHttpError(onError)

    if (init.signal) {
      if (init.signal.aborted) {
        onAbort()
        cleanup()
        rejectResponse(new Error('请求已取消'))
        return
      }
      init.signal.addEventListener('abort', onAbort)
    }

    // Kick off the request in main. The invoke resolves only when streaming
    // finishes; failures before headers (invalid URL, DNS) arrive as { error }.
    api.llmHttp({ id, url, method: init.method, headers: init.headers, body: init.body, stream: true, timeoutMs: DEFAULT_TIMEOUT_MS, skipTlsVerify: options.skipTlsVerify })
      .then((res: any) => {
        if (res && res.error) {
          cleanup()
          rejectResponse(new Error(friendlyNetworkError(res.error)))
        }
      })
      .catch((err: any) => {
        cleanup()
        rejectResponse(new Error(friendlyNetworkError(err?.message || 'LLM 请求失败')))
      })
  })
}
