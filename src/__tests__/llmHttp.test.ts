import { describe, it, expect, afterEach, vi } from 'vitest'
import { llmFetch, friendlyNetworkError } from '@/services/llm/http'

/**
 * Mock the electronAPI LLM bridge. Event callbacks are captured so a test can
 * replay the main-process event sequence (headers → chunks → done/error).
 */
function installBridgeMock() {
  const listeners: Record<string, (payload: any) => void> = {}
  const api: any = {
    llmHttp: vi.fn(async () => ({ ok: true })),
    llmHttpAbort: vi.fn(() => {}),
    onLlmHttpHeaders: vi.fn((cb: any) => { listeners.headers = cb; return () => { delete listeners.headers } }),
    onLlmHttpChunk: vi.fn((cb: any) => { listeners.chunk = cb; return () => { delete listeners.chunk } }),
    onLlmHttpDone: vi.fn((cb: any) => { listeners.done = cb; return () => { delete listeners.done } }),
    onLlmHttpError: vi.fn((cb: any) => { listeners.error = cb; return () => { delete listeners.error } }),
  }
  vi.stubGlobal('window', { electronAPI: api })
  return { api, listeners }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('friendlyNetworkError', () => {
  it('maps raw network errors to a friendly Chinese message', () => {
    expect(friendlyNetworkError('Failed to fetch')).toBe('网络请求失败，请检查网络、代理或 API 地址')
    expect(friendlyNetworkError('fetch failed')).toBe('网络请求失败，请检查网络、代理或 API 地址')
    expect(friendlyNetworkError('getaddrinfo ENOTFOUND api.example.com')).toBe('网络请求失败，请检查网络、代理或 API 地址')
  })

  it('keeps real HTTP / provider errors as-is', () => {
    expect(friendlyNetworkError('获取模型列表失败 (404): Not Found')).toBe('获取模型列表失败 (404): Not Found')
  })

  it('maps cert errors to the bypass hint and keeps the raw reason', () => {
    const msg = friendlyNetworkError('net::ERR_CERT_AUTHORITY_INVALID')
    expect(msg).toContain('跳过证书校验')
    expect(msg).toContain('ERR_CERT_AUTHORITY_INVALID')
  })

  it('separates a TLS handshake failure (wrong port / not HTTPS) from a cert error', () => {
    const msg = friendlyNetworkError('net::ERR_SSL_PROTOCOL_ERROR')
    expect(msg).toContain('TLS 握手失败')
    expect(msg).not.toContain('跳过证书校验')
  })
})

describe('llmFetch', () => {
  it('falls back to native fetch when no electronAPI bridge exists', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'm1' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await llmFetch('https://api.example.com/v1/models', { headers: { Authorization: 'Bearer x' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(true)
    expect(await res.json()).toEqual({ data: [{ id: 'm1' }] })
  })

  it('non-streaming: resolves through the IPC bridge', async () => {
    const { api } = installBridgeMock()
    api.llmHttp.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
      text: '{"data":[{"id":"a"},{"id":"b"}]}',
    })

    const res = await llmFetch('https://api.longcat.chat/v1/models', { headers: { Authorization: 'Bearer ak' } })
    expect(api.llmHttp).toHaveBeenCalledTimes(1)
    const req = api.llmHttp.mock.calls[0][0]
    expect(req.url).toBe('https://api.longcat.chat/v1/models')
    expect(req.stream).toBe(false)

    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    // headers are case-insensitive
    expect(res.headers.get('content-type')).toBe('application/json')
    const data = await res.json()
    expect(data.data).toHaveLength(2)
  })

  it('non-streaming: maps bridge errors to friendly messages', async () => {
    const { api } = installBridgeMock()
    api.llmHttp.mockResolvedValueOnce({ ok: false, error: 'Failed to fetch' })

    await expect(llmFetch('https://api.example.com/v1/models')).rejects.toThrow('网络请求失败')
  })

  it('streaming: replays headers/chunks/done into a ReadableStream', async () => {
    const { api, listeners } = installBridgeMock()
    let requestId = ''
    api.llmHttp.mockImplementation(async (req: any) => { requestId = req.id; return { ok: true } })

    const resPromise = llmFetch(
      'https://api.example.com/v1/chat/completions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      { stream: true },
    )
    expect(requestId).not.toBe('')

    listeners.headers!({ id: requestId, ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream' } })
    const res = await resPromise
    const reader = res.body!.getReader()

    const chunkText = 'data: {"a":1}\n\ndata: [DONE]\n\n'
    listeners.chunk!({ id: requestId, data: btoa(chunkText) })
    listeners.done!({ id: requestId })

    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).toBe(chunkText)

    const tail = await reader.read()
    expect(tail.done).toBe(true)
  })

  it('streaming: rejects when main reports an error before headers', async () => {
    const { api, listeners } = installBridgeMock()
    let requestId = ''
    api.llmHttp.mockImplementation(async (req: any) => { requestId = req.id; return { ok: true } })

    const resPromise = llmFetch('https://api.example.com/v1/models', {}, { stream: true })
    expect(requestId).not.toBe('')

    listeners.error!({ id: requestId, message: '网络请求失败' })
    await expect(resPromise).rejects.toThrow('网络请求失败')
  })

  it('streaming: forwards abort to the main process on signal abort', async () => {
    const { api } = installBridgeMock()
    let requestId = ''
    api.llmHttp.mockImplementation(async (req: any) => { requestId = req.id; return { ok: true } })
    const controller = new AbortController()

    void llmFetch('https://api.example.com/v1/models', { signal: controller.signal }, { stream: true })
    expect(requestId).not.toBe('')

    controller.abort()
    expect(api.llmHttpAbort).toHaveBeenCalledWith(requestId)
  })
})
