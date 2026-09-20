import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SQLiteStore } from '../services/sqlite-store'
import type { ChatSession } from '../../shared/types'

// better-sqlite3 ships a native binary built for the app's Electron runtime
// (Node ABI 123). Under a plain Node runner (e.g. system Node 24 / ABI 137)
// construction throws — skip the suite there instead of failing CI.
let sqliteUsable = true
try {
  new Database(':memory:').close()
} catch {
  sqliteUsable = false
}

describe.skipIf(!sqliteUsable)('SQLiteStore session persistence', () => {
  let root: string
  let store: SQLiteStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'session-persistence-test-'))
    store = new SQLiteStore(root)
    // chat_sessions.config_group_id is a FOREIGN KEY to api_config_groups and
    // better-sqlite3 enforces it — the tests' sessions reference 'group-1', so
    // that row must exist or every saveSession fails with a FK violation. (The
    // app always creates config groups before sessions; only the test setup
    // omitted it. This kept the suite green only because it was skipped in
    // environments where the native module couldn't load.)
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
    const base: ChatSession = {
      id: 'sess-1',
      title: '新对话',
      configGroupId: 'group-1',
      model: '',
      modelParams: {},
      messages: [],
      createdAt: 1000,
      updatedAt: 1000,
    }
    return { ...base, ...overrides }
  }

  it('persists projectEditMode (完全访问) and lastUserMessageAt across save/load', () => {
    const session = makeSession({
      projectEditMode: 'full_access',
      lastUserMessageAt: 5_000,
    })
    store.saveSession(session)

    const [loaded] = store.getSessions()
    expect(loaded.projectEditMode).toBe('full_access')
    expect(loaded.lastUserMessageAt).toBe(5_000)
  })

  it('isolates office-mode sessions from conversation-mode sessions (mode column)', () => {
    // 对话窗口会话（无 mode / mode='main'）与一人公司窗口会话（mode='office'）
    // 必须互不显示 —— getSessions(mode) 按 mode 过滤。
    store.saveSession(makeSession({ id: 'sess-main', mode: 'main', title: '对话会话' }))
    store.saveSession(makeSession({ id: 'sess-office', mode: 'office', title: '办公室任务' }))

    const mainOnly = store.getSessions('main')
    const officeOnly = store.getSessions('office')
    const all = store.getSessions()

    expect(mainOnly.map((s) => s.id)).toEqual(['sess-main'])
    expect(officeOnly.map((s) => s.id)).toEqual(['sess-office'])
    // 未带 mode 保存的会话默认归为 'main'（兼容旧数据/未升级渲染进程）。
    store.saveSession(makeSession({ id: 'sess-legacy' }))
    expect(store.getSessions('main').some((s) => s.id === 'sess-legacy')).toBe(true)
    expect(store.getSessions('office').some((s) => s.id === 'sess-legacy')).toBe(false)
    // 全量读取（备份/checkpoint 清理等）仍能看到两个模式。
    expect(all.map((s) => s.id).sort()).toEqual(['sess-legacy', 'sess-main', 'sess-office'])
  })

  it('round-trips every project edit mode value', () => {
    for (const mode of ['confirm_before_change', 'auto_edit', 'plan', 'full_access'] as const) {
      store.saveSession(makeSession({ id: `sess-${mode}`, projectEditMode: mode }))
      const loaded = store.getSessions().find((s) => s.id === `sess-${mode}`)
      expect(loaded?.projectEditMode).toBe(mode)
    }
  })

  it('updates the persisted columns on re-save (UPDATE path)', () => {
    const session = makeSession({ projectEditMode: 'confirm_before_change', lastUserMessageAt: 1_000 })
    store.saveSession(session)
    // Second save — must hit the UPDATE branch, not INSERT.
    store.saveSession({ ...session, projectEditMode: 'full_access', lastUserMessageAt: 9_000 })

    const [loaded] = store.getSessions()
    expect(loaded.projectEditMode).toBe('full_access')
    expect(loaded.lastUserMessageAt).toBe(9_000)
  })

  it('persists targetMode across save/load (INSERT and UPDATE)', () => {
    // INSERT path：目标模式标志必须落盘——办公室会话重启后不能回退成普通 agent 对话。
    store.saveSession(makeSession({ id: 'tm-1', mode: 'office', targetMode: true }))
    expect(store.getSessions('office').find((s) => s.id === 'tm-1')?.targetMode).toBe(true)
    // 非目标模式会话不落标志
    store.saveSession(makeSession({ id: 'tm-2', mode: 'main' }))
    expect(store.getSessions('main').find((s) => s.id === 'tm-2')?.targetMode).toBeUndefined()

    // UPDATE path：关闭目标模式后重新保存必须清掉标志。
    const [loaded] = store.getSessions('office')
    store.saveSession({ ...loaded, targetMode: false })
    expect(store.getSessions('office').find((s) => s.id === 'tm-1')?.targetMode).toBeUndefined()
  })

  it('falls back to the default mode when the renderer omits it, and keeps the sort anchor unset', () => {
    const session = makeSession()
    delete (session as any).projectEditMode
    delete (session as any).lastUserMessageAt
    store.saveSession(session)

    const [loaded] = store.getSessions()
    // The DB default (confirm_before_change) doubles as the UI fallback; the
    // sort anchor stays unset so the renderer derives it from messages.
    expect(loaded.projectEditMode).toBe('confirm_before_change')
    expect(loaded.lastUserMessageAt).toBeUndefined()
  })

  it('round-trips per-round request timing and per-tool timing on messages', () => {
    const session = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'hi',
          sortOrder: 0,
          contextFiles: [],
          tokenCount: 1,
          createdAt: 1000,
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'answer',
          sortOrder: 1,
          contextFiles: [],
          tokenCount: 2,
          createdAt: 2000,
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: '/a.ts' }, startedAt: 2100 }],
          toolResults: [{ toolCallId: 'c1', name: 'read_file', result: 'ok', startedAt: 2100, finishedAt: 2350, durationMs: 250 }],
          requestStartedAt: 2000,
          requestDurationMs: 500,
          ttftMs: 120,
          requestTokensIn: 100,
          requestTokensOut: 20,
        },
      ],
    })
    store.saveSession(session)

    const [loaded] = store.getSessions()
    const asst = loaded.messages.find((m) => m.role === 'assistant')!
    expect(asst.requestStartedAt).toBe(2000)
    expect(asst.requestDurationMs).toBe(500)
    expect(asst.ttftMs).toBe(120)
    expect(asst.requestTokensIn).toBe(100)
    expect(asst.requestTokensOut).toBe(20)
    expect(asst.toolCalls![0].startedAt).toBe(2100)
    expect(asst.toolResults![0].durationMs).toBe(250)
    expect(asst.toolResults![0].startedAt).toBe(2100)
    expect(asst.toolResults![0].finishedAt).toBe(2350)
  })

  it('migrates old-schema databases by adding the two new columns', async () => {
    // Build a DB with the OLD chat_sessions schema (no new columns), insert a
    // row, then open it with SQLiteStore — migrateTables must add the columns
    // without throwing and existing rows get the defaults. Uses its OWN temp
    // dir: the beforeEach store already created a full-schema DB under `root`,
    // and this test must start from a genuinely old-schema database.
    const dbDir = mkdtempSync(join(tmpdir(), 'migration-test-'))
    try {
      // SQLiteStore places the DB at <userDataPath>/data/ourcode.db and creates
      // the `data` dir itself — the old-schema DB must live at the SAME path or
      // the migration would run on a different (empty) file. (The original test
      // used `join(root, 'data')` for dbDir and `new SQLiteStore(root)`, which
      // happened to coincide; a fresh dir needs the data/ segment explicitly.)
      mkdirSync(join(dbDir, 'data'), { recursive: true })
      const dbPath = join(dbDir, 'data', 'ourcode.db')
      const old = new Database(dbPath)
      old.exec(`
        CREATE TABLE chat_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '新对话',
          config_group_id TEXT NOT NULL,
          model TEXT DEFAULT '',
          model_params TEXT DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO chat_sessions (id, title, config_group_id, model, model_params, created_at, updated_at)
        VALUES ('old-1', '旧会话', 'group-1', '', '{}', 100, 100);
      `)
      old.close()

      const migrated = new SQLiteStore(dbDir)
      // Capture the reader instance so it is actually closed (the old chained
      // `new Database(dbPath).prepare(...)` leaked a handle → EBUSY on cleanup).
      const colsDb = new Database(dbPath)
      const cols = colsDb.prepare('PRAGMA table_info(chat_sessions)').all() as any[]
      colsDb.close()

      expect(cols.some((c: any) => c.name === 'project_edit_mode')).toBe(true)
      expect(cols.some((c: any) => c.name === 'last_user_message_at')).toBe(true)

      const [loaded] = migrated.getSessions()
      expect(loaded.id).toBe('old-1')
      // Old rows get the migration default (valid value — the UI default), and
      // the sort anchor is 0 → unset so the renderer derives it from messages.
      expect(loaded.projectEditMode).toBe('confirm_before_change')
      expect(loaded.lastUserMessageAt).toBeUndefined()
      migrated.close()
    } finally {
      // Windows releases closed file handles asynchronously — retry the delete
      // (same pattern as mcp-manager.test.ts's cleanup) instead of failing.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          rmSync(dbDir, { recursive: true, force: true })
          break
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
    }
  })

  describe('image attachments', () => {
    const att = { id: 'a1', name: 'shot.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }

    function withAttachment(attachments?: unknown[]) {
      return makeSession({
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: '看图',
            sortOrder: 0,
            contextFiles: [],
            tokenCount: 0,
            createdAt: 1000,
            ...(attachments ? { attachments } : {}),
          } as any,
        ],
      })
    }

    it('round-trips base64 attachments on a user message', () => {
      store.saveSession(withAttachment([att]))
      const loaded = store.getSessions().find((s) => s.id === 'sess-1')!
      expect(loaded.messages[0].attachments).toEqual([att])
    })

    it('keeps the stored payload when a later save omits it', () => {
      // The renderer strips base64 after the first durable save (every agent
      // round re-saves the whole session) — the UPSERT must not blank it out.
      store.saveSession(withAttachment([att]))
      store.saveSession(withAttachment())
      const loaded = store.getSessions().find((s) => s.id === 'sess-1')!
      expect(loaded.messages[0].attachments).toEqual([att])
    })

    it('leaves attachments unset for messages that never had one', () => {
      store.saveSession(makeSession({ messages: [{ id: 'm1', role: 'user', content: 'hi', sortOrder: 0, contextFiles: [], tokenCount: 0, createdAt: 1000 } as any] }))
      const loaded = store.getSessions().find((s) => s.id === 'sess-1')!
      expect(loaded.messages[0].attachments).toBeUndefined()
    })

    it('migrates an old chat_messages table by adding the attachments column', () => {
      // A pre-vision database has no `attachments` column; the UPSERT above
      // names it, so opening such a DB must ALTER it in before the first save.
      const dbDir = mkdtempSync(join(tmpdir(), 'attachment-migration-test-'))
      try {
        mkdirSync(join(dbDir, 'data'), { recursive: true })
        const dbPath = join(dbDir, 'data', 'ourcode.db')
        const old = new Database(dbPath)
        old.exec(`
          CREATE TABLE chat_sessions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话', config_group_id TEXT NOT NULL,
            model TEXT DEFAULT '', model_params TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE chat_messages (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0, context_files TEXT DEFAULT '[]', token_count INTEGER DEFAULT 0,
            thinking TEXT DEFAULT '', tool_calls TEXT DEFAULT '[]', tool_results TEXT DEFAULT '[]',
            edited_at INTEGER DEFAULT 0, created_at INTEGER NOT NULL
          );
          INSERT INTO chat_sessions (id, title, config_group_id, model, model_params, created_at, updated_at)
          VALUES ('group-session', '旧会话', 'group-1', '', '{}', 100, 100);
          INSERT INTO chat_messages (id, session_id, role, content, sort_order, created_at)
          VALUES ('old-m1', 'group-session', 'user', '旧的', 0, 100);
        `)
        old.close()

        const migrated = new SQLiteStore(dbDir)
        try {
          migrated.saveSession({ ...makeSession({ id: 'group-session' }), messages: [
            { id: 'old-m1', role: 'user', content: '旧的', sortOrder: 0, contextFiles: [], tokenCount: 0, createdAt: 100 } as any,
            { id: 'new-m2', role: 'user', content: '带图', sortOrder: 1, contextFiles: [], tokenCount: 0, createdAt: 200, attachments: [att] } as any,
          ] })
          const loaded = migrated.getSessions().find((s) => s.id === 'group-session')!
          expect(loaded.messages.find((m) => m.id === 'old-m1')?.attachments).toBeUndefined()
          expect(loaded.messages.find((m) => m.id === 'new-m2')?.attachments).toEqual([att])
        } finally {
          migrated.close()
        }
      } finally {
        rmSync(dbDir, { recursive: true, force: true })
      }
    })
  })

  describe('compaction durable lock', () => {
    it('persists compactionInProgress and clears a stale lock on load', async () => {
      const session = makeSession()
      store.saveSession(session)

      // Simulate a crash mid-compaction: lock left at 1 in the DB.
      store.db.exec("UPDATE chat_sessions SET compaction_in_progress = 1 WHERE id = 'sess-1'")

      // Re-open the store (new instance = app restart) → stale lock is cleared.
      const reopened = new SQLiteStore(root)
      try {
        const loaded = reopened.getSessions().find((s) => s.id === 'sess-1')!
        expect(loaded.compactionInProgress).toBe(false)
        const row = reopened.db.prepare("SELECT compaction_in_progress FROM chat_sessions WHERE id = 'sess-1'").get() as any
        expect(row.compaction_in_progress).toBe(0)
      } finally {
        reopened.close()
      }
    })

    it('persists a held lock to the DB row (crash-detection value)', async () => {
      const session = { ...makeSession(), compactionInProgress: true }
      store.saveSession(session)
      // Before any load: the row must still be 1 so a real crash would be caught.
      const row = store.db.prepare("SELECT compaction_in_progress FROM chat_sessions WHERE id = 'sess-1'").get() as any
      expect(row.compaction_in_progress).toBe(1)
      // Loading clears it (the lock only guards against a crash in a process that
      // has since exited).
      store.getSessions()
      const after = store.db.prepare("SELECT compaction_in_progress FROM chat_sessions WHERE id = 'sess-1'").get() as any
      expect(after.compaction_in_progress).toBe(0)
    })
  })
})
