import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WireLogService } from '../services/wire-log'

let baseDir: string

beforeEach(async () => {
  baseDir = await fs.mkdtemp(join(tmpdir(), 'wire-log-test-'))
})

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true })
})

describe('WireLogService', () => {
  it('appends JSON lines to a per-session file', async () => {
    const store = new WireLogService(baseDir)
    expect(await store.append('sess-1', '{"type":"request"}')).toBe(true)
    expect(await store.append('sess-1', '{"type":"attempt"}')).toBe(true)
    const content = await fs.readFile(join(baseDir, 'sess-1.jsonl'), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toEqual(['{"type":"request"}', '{"type":"attempt"}'])
  })

  it('rejects missing/empty/oversized input', async () => {
    const store = new WireLogService(baseDir, { maxLineBytes: 8 })
    expect(await store.append('', 'x')).toBe(false)
    expect(await store.append('s', '')).toBe(false)
    expect(await store.append('s', 'x'.repeat(32))).toBe(false)
    await expect(fs.stat(join(baseDir, 's.jsonl'))).rejects.toThrow()
  })

  it('sanitizes session ids so they cannot escape the base dir', async () => {
    const store = new WireLogService(baseDir)
    expect(await store.append('../evil', 'line')).toBe(true)
    // The sanitized name stays inside baseDir; nothing leaks into the parent.
    const entries = await fs.readdir(baseDir)
    expect(entries).toEqual(['.._evil.jsonl'])
    const parentEntries = await fs.readdir(join(baseDir, '..'))
    expect(parentEntries.filter((n) => n.includes('evil.jsonl'))).toEqual([])
  })

  it('rotates when the session budget is exceeded (current → .1)', async () => {
    const store = new WireLogService(baseDir, { maxSessionBytes: 40 })
    expect(await store.append('s', 'a'.repeat(20))).toBe(true)
    // 30 more would exceed the 40-byte budget → rotate, then write fresh.
    expect(await store.append('s', 'b'.repeat(30))).toBe(true)
    const rotated = await fs.readFile(join(baseDir, 's.jsonl.1'), 'utf8')
    expect(rotated.trim()).toBe('a'.repeat(20))
    const current = await fs.readFile(join(baseDir, 's.jsonl'), 'utf8')
    expect(current.trim()).toBe('b'.repeat(30))
  })

  it('deleteSession removes current and rotated generations', async () => {
    const store = new WireLogService(baseDir, { maxSessionBytes: 10 })
    await store.append('s', 'x'.repeat(8))
    await store.append('s', 'y'.repeat(8))
    await store.deleteSession('s')
    await expect(fs.stat(join(baseDir, 's.jsonl'))).rejects.toThrow()
    await expect(fs.stat(join(baseDir, 's.jsonl.1'))).rejects.toThrow()
  })

  it('sweep removes files older than the TTL and keeps fresh ones', async () => {
    const store = new WireLogService(baseDir)
    await store.append('old', 'line')
    await store.append('fresh', 'line')
    const oldFile = join(baseDir, 'old.jsonl')
    const freshFile = join(baseDir, 'fresh.jsonl')
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(oldFile, past, past)
    const removed = await store.sweep()
    expect(removed).toBe(1)
    await expect(fs.stat(oldFile)).rejects.toThrow()
    await expect(fs.stat(freshFile)).resolves.toBeTruthy()
  })

  it('sweep is a no-op when the directory does not exist', async () => {
    const store = new WireLogService(join(baseDir, 'missing'))
    expect(await store.sweep()).toBe(0)
  })
})
