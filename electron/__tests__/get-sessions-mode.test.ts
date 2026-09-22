import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SQLiteStore } from '../services/sqlite-store'
import type { ChatSession } from '../../shared/types'

// better-sqlite3 ships a native binary built for the app's Electron runtime.
// Skip when the host Node ABI cannot load it (e.g. system Node under a
// generic shell that isn't the project's bundled Electron).
let sqliteUsable = true
try {
  new Database(':memory:').close()
} catch {
  sqliteUsable = false
}

describe.skipIf(!sqliteUsable)('SQLiteStore.getSessions — one-company history fallback', () => {
  let root: string
  let store: SQLiteStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'get-sessions-mode-test-'))
    store = new SQLiteStore(root)
    // FK target required by saveSession.
    store.saveConfigGroup({
      id: 'group-1',
      name: 'test-group',
      baseUrl: '',
      apiKey: 'test-key',
      systemPrompt: '',
      defaultModel: '',
      provider: 'openai',
      customHeaders: {},
      createdAt: 0,
      updatedAt: 0,
    })
  })

  afterEach(() => {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  })

  function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
    return {
      id: 'sess-1',
      title: '新对话',
      configGroupId: 'group-1',
      model: '',
      modelParams: {},
      messages: [],
      createdAt: 1000,
      updatedAt: 1000,
      ...overrides,
    }
  }

  it('returns empty when the database has no sessions at all', () => {
    expect(store.getSessions('main')).toHaveLength(0)
    expect(store.getSessions('office')).toHaveLength(0)
    expect(store.getSessions()).toHaveLength(0)
  })

  it('legacy main sessions stay in the main window only — office is a fresh namespace', () => {
    // Simulate a user who has used the app for a while in the main window
    // (every legacy session got mode='main' stamped by the column-add migration).
    store.saveSession(makeSession({ id: 'legacy-1', title: '昨天的对话', mode: 'main' }))
    store.saveSession(makeSession({ id: 'legacy-2', title: '上周的对话', mode: 'main' }))

    // Main window sees its own history.
    const mainIds = store.getSessions('main').map((s) => s.id)
    expect(mainIds).toEqual(expect.arrayContaining(['legacy-1', 'legacy-2']))

    // Opening a company must NOT drag the main-window conversations along —
    // office window starts from a clean slate.
    const officeIds = store.getSessions('office').map((s) => s.id)
    expect(officeIds).toHaveLength(0)
  })

  it('main and office sessions are strictly isolated in both directions', () => {
    store.saveSession(makeSession({ id: 'legacy-1', title: '历史', mode: 'main' }))
    store.saveSession(makeSession({ id: 'office-new', title: '新公司任务', mode: 'office' }))

    const mainIds = store.getSessions('main').map((s) => s.id)
    const officeIds = store.getSessions('office').map((s) => s.id)

    // 一人公司与对话模式互不互通:main 看不到公司会话,office 也看不到 main 会话。
    expect(mainIds).toEqual(['legacy-1'])
    expect(officeIds).toEqual(['office-new'])
  })

  it('office window never shows a session whose mode is some unknown third value', () => {
    // The CHECK-style filter must not let stray rows leak through.
    store.saveSession(makeSession({ id: 'garbage', title: '?', mode: 'weird' as any }))
    expect(store.getSessions('office')).toHaveLength(0)
  })

  it('passing no mode returns everything (legacy callers and tests)', () => {
    store.saveSession(makeSession({ id: 'a', mode: 'main' }))
    store.saveSession(makeSession({ id: 'b', mode: 'office' }))
    const all = store.getSessions().map((s) => s.id)
    expect(all).toEqual(expect.arrayContaining(['a', 'b']))
  })
})
