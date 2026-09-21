import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SQLiteStore } from '../services/sqlite-store'
import type { ChatSession, SubAgentProgress } from '../../shared/types'

// better-sqlite3 的 native 二进制是按 Electron 的 Node ABI 编的；在纯 Node
// 环境下 new Database 会直接抛错 —— 那种情况下跳过而不是判失败。
let sqliteUsable = true
try {
  new Database(':memory:').close()
} catch {
  sqliteUsable = false
}

function makeSession(id: string): Omit<ChatSession, 'createdAt' | 'updatedAt'> {
  return {
    id,
    title: id,
    configGroupId: 'group-1',
    model: 'test-model',
    messages: [],
    lastRunTokens: 0,
    agentMode: 'agent',
    projectEditMode: 'confirm_before_change',
    todos: [],
    planStatus: 'none',
    projectPath: '',
    targetMode: true,
  } as unknown as Omit<ChatSession, 'createdAt' | 'updatedAt'>
}

function makeRun(sessionId: string, startedAt: number): SubAgentProgress {
  return {
    status: 'done',
    sessionId,
    name: 'tm-developer',
    task: '实现登录页',
    description: '',
    startedAt,
    thinking: '',
    steps: [{ id: 'step-1', name: 'edit_file', arguments: { path: 'src/App.tsx' }, status: 'success', result: 'ok' }],
    toolCallCount: 1,
    tokenCount: 1200,
  }
}

describe.skipIf(!sqliteUsable)('SQLiteStore subagent run records', () => {
  let root: string
  let store: SQLiteStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'subagent-runs-test-'))
    store = new SQLiteStore(root)
    store.saveConfigGroup({
      id: 'group-1',
      name: 'test-group',
      baseUrl: '',
      apiKey: 'test-key',
      systemPrompt: '',
      defaultModel: '',
      provider: 'openai',
      customHeaders: {},
      color: '',
      sortOrder: 0,
    } as never)
    store.saveSession(makeSession('s-1'))
    store.saveSession(makeSession('s-2'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('round-trips a run record keyed by the parent tool call id', () => {
    store.saveSubagentRun('call-1', makeRun('s-1', 1000))
    const rows = store.getSubagentRuns(['s-1'])
    expect(rows).toHaveLength(1)
    expect(rows[0].toolCallId).toBe('call-1')
    expect(rows[0].record.task).toBe('实现登录页')
    expect(rows[0].record.steps[0].arguments.path).toBe('a.tsx')
  })

  it('re-saving the same tool call updates in place instead of duplicating', () => {
    store.saveSubagentRun('call-1', { ...makeRun('s-1', 1000), status: 'done' })
    store.saveSubagentRun('call-1', { ...makeRun('s-1', 1000), status: 'stopped' })
    const rows = store.getSubagentRuns(['s-1'])
    expect(rows).toHaveLength(1)
    expect(rows[0].record.status).toBe('stopped')
  })

  it('scopes reads to the requested sessions and tolerates unknown ids', () => {
    store.saveSubagentRun('call-1', makeRun('s-1', 1000))
    store.saveSubagentRun('call-2', makeRun('s-2', 2000))
    expect(store.getSubagentRuns(['s-2'])).toHaveLength(1)
    expect(store.getSubagentRuns([])).toEqual([])
    expect(store.getSubagentRuns(['', 'nope'])).toEqual([])
  })

  it('keeps only the newest records per session', () => {
    const total = 70
    for (let i = 0; i < total; i++) {
      store.saveSubagentRun(`call-${i}`, makeRun('s-1', 1000 + i * 1000))
    }
    const rows = store.getSubagentRuns(['s-1'])
    expect(rows.length).toBe(60)
    // 留下的是最近启动的，不是最早那批
    const started = rows.map((r) => r.record.startedAt).sort((a, b) => a - b)
    expect(started[0]).toBe(1000 + (total - 60) * 1000)
  })

  it('drops a session’s records when the session is deleted', () => {
    store.saveSubagentRun('call-1', makeRun('s-1', 1000))
    store.deleteSession('s-1')
    expect(store.getSubagentRuns(['s-1'])).toEqual([])
  })

  it('ignores rows whose record payload is unusable', () => {
    const db = new Database(join(root, 'data', 'ourcode.db'))
    db.prepare(
      'INSERT INTO subagent_runs (tool_call_id, session_id, status, started_at, ended_at, record) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('broken-1', 's-1', 'done', 1000, 1001, 'not json')
    db.prepare(
      'INSERT INTO subagent_runs (tool_call_id, session_id, status, started_at, ended_at, record) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('broken-2', 's-1', 'done', 1000, 1001, JSON.stringify({ status: 'done' }))
    db.prepare(
      'INSERT INTO subagent_runs (tool_call_id, session_id, status, started_at, ended_at, record) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('good', 's-1', 'done', 1000, 1001, JSON.stringify(makeRun('s-1', 1000)))
    db.close()
    const rows = store.getSubagentRuns(['s-1'])
    expect(rows.map((r) => r.toolCallId)).toEqual(['good'])
  })
})
