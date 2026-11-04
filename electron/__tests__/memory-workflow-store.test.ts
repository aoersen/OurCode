import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SQLiteStore } from '../services/sqlite-store'

// better-sqlite3 is built for the app's Electron runtime (Node ABI 123); a
// plain Node runner (e.g. Node 24 / ABI 137) cannot load it, so skip there.
let sqliteUsable = true
try {
  new Database(':memory:').close()
} catch {
  sqliteUsable = false
}

describe.skipIf(!sqliteUsable)('SQLiteStore memories & workflows', () => {
  let root: string
  let store: SQLiteStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-workflow-store-test-'))
    store = new SQLiteStore(root)
  })

  afterEach(() => {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  })

  // Regression: a botched edit once left the closing parenthesis of the
  // .run(...) call in the wrong place, binding only 2 of the 6 placeholders.
  // better-sqlite3 then threw "Too few parameter values were provided" for
  // every add — memory:add surfaced it as 浓缩记忆失败.
  it('persists a global memory and reads it back', () => {
    const saved = store.addMemory('不要用 var，统一用 const', 'global')
    expect(saved.projectPath).toBeUndefined()

    const rows = store.getMemories()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: saved.id,
      content: '不要用 var，统一用 const',
      scope: 'global',
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    })
    expect(rows[0].projectPath).toBeUndefined()
  })

  it('persists a project memory with its projectPath', () => {
    const saved = store.addMemory('本项目使用 pnpm', 'project', 'E:/work/demo')

    const [row] = store.getMemories()
    expect(row).toMatchObject({
      id: saved.id,
      content: '本项目使用 pnpm',
      scope: 'project',
      projectPath: 'E:/work/demo',
    })
  })

  it('persists a workflow template', () => {
    const saved = store.addWorkflow({ name: '复盘', description: '每日复盘', prompt: '总结今天的改动' })

    const rows = store.getWorkflows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: saved.id,
      name: '复盘',
      description: '每日复盘',
      prompt: '总结今天的改动',
    })
  })
})
