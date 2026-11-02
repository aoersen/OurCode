import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:https'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeTlsFetch } from '@electron/services/node-tls-fetch'

/**
 * The llm:http bridge switches to this Node-stack client when a config opts into
 * 「跳过证书校验」, because Chromium's network service caches a failed certificate
 * verification per host and never re-consults setCertificateVerifyProc — so a
 * ticked box could not recover until an app restart (verified on Electron 30).
 * These tests pin the two things that made that path work: self-signed certs are
 * accepted only when asked, and the stream/idle-timeout contract matches what the
 * renderer's SSE reader expects.
 */
const fixtures = join(__dirname, 'fixtures')
const cert = readFileSync(join(fixtures, 'self-signed-cert.pem'))
const key = readFileSync(join(fixtures, 'self-signed-key.pem'))

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer({ cert, key }, (req, res) => {
    if (req.url === '/api/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }))
      return
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      setTimeout(() => { res.write('data: [DONE]\n\n'); res.end() }, 20)
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/api/v1/models' })
      res.end()
      return
    }
    if (req.url === '/slow') return // never answers — exercises the idle timeout
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  base = `https://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('nodeTlsFetch', () => {
  it('rejects a self-signed certificate when verification stays on', async () => {
    await expect(nodeTlsFetch({ url: `${base}/api/v1/models` })).rejects.toThrow()
  })

  it('accepts a self-signed certificate when rejectUnauthorized is false', async () => {
    const res = await nodeTlsFetch({ url: `${base}/api/v1/models`, rejectUnauthorized: false, timeoutMs: 5000 })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text).data[0].id).toBe('m1')
  })

  it('sends the request body and headers', async () => {
    const res = await nodeTlsFetch({
      url: `${base}/api/v1/models`,
      method: 'POST',
      headers: { Authorization: 'Bearer k' },
      body: '{"pin":1}',
      rejectUnauthorized: false,
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(true)
  })

  it('streams chunks through onChunk after onHeaders', async () => {
    const heads: any[] = []
    const text: string[] = []
    const res = await nodeTlsFetch({
      url: `${base}/stream`,
      stream: true,
      rejectUnauthorized: false,
      timeoutMs: 5000,
      onHeaders: (head) => heads.push(head),
      onChunk: (chunk) => text.push(chunk.toString('utf8')),
    })
    expect(heads).toHaveLength(1)
    expect(heads[0].status).toBe(200)
    expect(heads[0].headers['content-type']).toContain('text/event-stream')
    expect(res.ok).toBe(true)
    expect(text.join('')).toContain('data: [DONE]')
  })

  it('follows a redirect before any bytes reach the caller', async () => {
    const heads: any[] = []
    const res = await nodeTlsFetch({
      url: `${base}/redirect`,
      rejectUnauthorized: false,
      timeoutMs: 5000,
      onHeaders: (head) => heads.push(head.status),
    })
    expect(res.status).toBe(200)
    expect(heads).toEqual([200])
    expect(res.text).toContain('m1')
  })

  it('aborts on idle timeout instead of hanging forever', async () => {
    const started = Date.now()
    await expect(nodeTlsFetch({ url: `${base}/slow`, rejectUnauthorized: false, timeoutMs: 250 })).rejects.toThrow('请求超时或已取消')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('honours an external abort signal', async () => {
    const controller = new AbortController()
    const pending = nodeTlsFetch({ url: `${base}/slow`, rejectUnauthorized: false, timeoutMs: 5000, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
})
