import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatMessage, ChatSession } from '@/types'
import {
  FILE_EDIT_TOOLS,
  changeMarker,
  extractFileChanges,
  formatFileChangeReport,
  groupFileChangesBySession,
} from '@/services/fileChangeHistory'
import { kindOf } from '@/services/permissions/modePolicy'

// The `list_file_changes` tool resolves its sessions through the chat store;
// everything else in this file is pure. Declared at module top so the mock is
// registered before the tool's dynamic import runs.
const hoisted = vi.hoisted(() => ({
  sessions: [] as any[],
  reverted: {} as Record<string, string[]>,
}))

vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ sessions: hoisted.sessions }) },
}))

let seq = 0

function msg(
  content: string,
  toolCalls?: Array<{ name: string; arguments: Record<string, any> }>,
  createdAt = 0,
): ChatMessage {
  seq += 1
  return {
    id: `m${seq}`,
    role: 'assistant',
    content,
    sortOrder: seq,
    contextFiles: [],
    tokenCount: 0,
    createdAt,
    toolCalls: toolCalls?.map((tc, i) => ({ id: `tc${seq}-${i}`, name: tc.name, arguments: tc.arguments })),
  }
}

function session(
  id: string,
  title: string,
  messages: ChatMessage[],
  extra: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    title,
    configGroupId: 'cfg',
    model: '',
    modelParams: {} as any,
    messages,
    createdAt: 0,
    updatedAt: 1000,
    ...extra,
  }
}

/** Session that writes a.ts, edits a.ts, then deletes b.ts. */
function sampleSession(id = 's1', title = '会话一'): ChatSession {
  return session(id, title, [
    msg('', [{ name: 'write_file', arguments: { path: 'C:/proj/a.ts' } }], 100),
    msg('', [{ name: 'edit_file', arguments: { path: 'C:/proj/a.ts' } }], 200),
    msg('', [{ name: 'delete_file', arguments: { path: 'C:\\proj\\b.ts' } }], 300),
  ])
}

describe('extractFileChanges', () => {
  it('counts only file-mutating tools, in message order, with file names', () => {
    const s = session('s1', 't', [
      msg('', [{ name: 'write_file', arguments: { path: 'C:/proj/a.ts' } }], 100),
      msg('', [{ name: 'read_file', arguments: { path: 'C:/proj/read-me.ts' } }], 150),
      msg('', [{ name: 'edit_file', arguments: { filePath: 'C:/proj/b.ts' } }], 200),
      msg('', [{ name: 'create_directory', arguments: { path: 'C:/proj/newdir' } }], 250),
      msg('', [
        { name: 'multi_edit_file', arguments: { edits: [{ path: 'C:/proj/c.ts' }, { path: 'C:/proj/d.ts' }] } },
      ], 300),
    ])

    const changes = extractFileChanges(s)
    expect(changes.map((c) => [c.toolName, c.fileName])).toEqual([
      ['write_file', 'a.ts'],
      ['edit_file', 'b.ts'],
      ['create_directory', 'newdir'],
      ['multi_edit_file', 'c.ts'],
      ['multi_edit_file', 'd.ts'],
    ])
    expect(changes.map((c) => c.time)).toEqual([100, 200, 250, 300, 300])
    expect(changes[0]).toMatchObject({ sessionId: 's1', sessionTitle: 't', filePath: 'C:/proj/a.ts' })
  })

  it('dedupes repeated paths inside one multi_edit_file call but keeps repeated touches across messages', () => {
    const s = sampleSession()
    s.messages.push(
      msg('', [
        {
          name: 'multi_edit_file',
          arguments: { edits: [{ path: 'C:/proj/a.ts' }, { path: 'C:/proj/a.ts' }] },
        },
      ], 400),
    )
    const changes = extractFileChanges(s)
    // write a.ts, edit a.ts, delete b.ts, one deduped multi_edit a.ts = 4
    expect(changes.filter((c) => c.filePath === 'C:/proj/a.ts')).toHaveLength(3)
    expect(changes).toHaveLength(4)
  })

  it('falls back to session.updatedAt when a message has no createdAt', () => {
    const s = session('s1', 't', [msg('', [{ name: 'write_file', arguments: { path: 'C:/x.ts' } }], 0)], {
      updatedAt: 777,
    })
    expect(extractFileChanges(s)[0].time).toBe(777)
  })

  it('ignores tool calls without a usable path', () => {
    const s = session('s1', 't', [msg('', [{ name: 'write_file', arguments: {} }], 1)])
    expect(extractFileChanges(s)).toEqual([])
  })

  it('exposes the same tool set the panel counts', () => {
    expect([...FILE_EDIT_TOOLS].sort()).toEqual([
      'create_directory', 'delete_file', 'edit_file', 'multi_edit_file', 'write_file',
    ])
  })
})

describe('groupFileChangesBySession', () => {
  it('groups by session, newest updatedAt first, skipping sessions without changes', () => {
    const older = sampleSession('s-old', '旧会话')
    older.updatedAt = 1000
    const newer = session('s-new', '新会话', [
      msg('', [{ name: 'write_file', arguments: { path: 'C:/proj/new.ts' } }], 5),
    ], { updatedAt: 2000 })
    const untouched = session('s-none', '没改过文件', [msg('hello', undefined, 1)])

    const groups = groupFileChangesBySession([older, untouched, newer])
    expect(groups.map((g) => g.sessionId)).toEqual(['s-new', 's-old'])
    expect(groups[1].changes).toHaveLength(3)
  })

  it('excludeClaw drops WeChat-bridge sessions', () => {
    const claw = sampleSession('s-claw', '爪')
    claw.mode = 'claw'
    const main = sampleSession('s-main', '主')
    const groups = groupFileChangesBySession([claw, main], { excludeClaw: true })
    expect(groups.map((g) => g.sessionId)).toEqual(['s-main'])
  })

  it('excludeArchived drops archived sessions', () => {
    const archived = sampleSession('s-arc', '归档')
    archived.archivedAt = 1
    const groups = groupFileChangesBySession([archived, sampleSession('s-live', '在列')], {
      excludeArchived: true,
    })
    expect(groups.map((g) => g.sessionId)).toEqual(['s-live'])
    // Without the flag (panel behavior) archived sessions still show.
    expect(groupFileChangesBySession([archived]).map((g) => g.sessionId)).toEqual(['s-arc'])
  })
})

describe('changeMarker', () => {
  it('maps write/delete/edit tools to A/M/D', () => {
    expect(changeMarker('write_file')).toBe('A')
    expect(changeMarker('delete_file')).toBe('D')
    expect(changeMarker('edit_file')).toBe('M')
    expect(changeMarker('multi_edit_file')).toBe('M')
    // create_directory and unknown tools default to M (panel behavior).
    expect(changeMarker('create_directory')).toBe('M')
    expect(changeMarker('something_else')).toBe('M')
  })
})

describe('formatFileChangeReport', () => {
  it('renders session headers, markers and revert tags', () => {
    const groups = groupFileChangesBySession([sampleSession()])
    const out = formatFileChangeReport(groups, { s1: ['C:/proj/a.ts'] })
    expect(out).toContain('共 1 个会话、3 条文件变更记录')
    expect(out).toContain('会话「会话一」 (id: s1')
    expect(out).toContain('- [A] C:/proj/a.ts（已回退）')
    expect(out).toContain('- [M] C:/proj/a.ts（已回退）')
    expect(out).toContain('- [D] C:\\proj\\b.ts')
    // Non-reverted rows carry no tag.
    expect(out).not.toContain('C:\\proj\\b.ts（已回退）')
  })

  it('caps rows per session and notes the remainder', () => {
    const groups = groupFileChangesBySession([sampleSession()])
    const out = formatFileChangeReport(groups, {}, { maxChangesPerSession: 2 })
    expect(out).toContain('- [A] C:/proj/a.ts')
    expect(out).toContain('- [M] C:/proj/a.ts')
    expect(out).not.toContain('- [D] C:\\proj\\b.ts')
    expect(out).toContain('…另有 1 条未显示')
  })

  it('drops whole trailing session blocks when over budget', () => {
    const manyChanges = (id: string, title: string, updatedAt: number) =>
      session(
        id,
        title,
        Array.from({ length: 20 }, (_, i) =>
          msg('', [{ name: 'write_file', arguments: { path: `C:/proj/f${i}.ts` } }], i),
        ),
        { updatedAt },
      )
    const groups = groupFileChangesBySession([
      manyChanges('s1', '会话一', 3000),
      manyChanges('s2', '会话二', 2000),
      manyChanges('s3', '会话三', 1000),
    ])
    // Budget fits the header plus ~one big block; trailing blocks are dropped whole.
    const out = formatFileChangeReport(groups, {}, { maxChars: 500 })
    expect(out).toContain('共 3 个会话、60 条文件变更记录')
    expect(out).toContain('会话「会话一」')
    expect(out).not.toContain('会话「会话三」')
    expect(out).toMatch(/输出已截断：另 \d 个会话未显示/)
    // No torn lines: every emitted change row is complete (file names intact).
    for (const line of out.split('\n').filter((l) => l.startsWith('- ['))) {
      expect(line).toMatch(/^- \[[AMD]\] C:\/proj\/f\d+\.ts$/)
    }
  })
})

describe('list_file_changes tool', () => {
  let registry: Array<{ name: string; execute: (a: Record<string, any>, c?: any) => Promise<string> }>

  beforeEach(async () => {
    hoisted.sessions = []
    hoisted.reverted = {}
    // The tool reads revert records through window.electronAPI (main process).
    ;(globalThis as any).window = {
      electronAPI: {
        checkpointListReverted: async (id: string) => hoisted.reverted[id] || [],
      },
    }
    const { createToolRegistry } = await import('@/services/tools/ToolRegistry')
    registry = createToolRegistry() as any
  })

  afterEach(() => {
    delete (globalThis as any).window
  })

  const tool = () => registry.find((t) => t.name === 'list_file_changes')!

  it('is registered with no approval requirement and optional targeting params', () => {
    const t = tool()
    expect(t).toBeTruthy()
    expect((t as any).requiresApproval).toBeFalsy()
    // Classified interactive → read-only, never routed through approval dialogs
    // (including plan mode, where only read-only tools are exposed).
    expect(kindOf('list_file_changes')).toBe('interactive')
    const params = (t as any).parameters
    expect(params.properties).toHaveProperty('targetSessionId')
    expect(params.properties).toHaveProperty('targetTitle')
    expect(params.properties).toHaveProperty('allSessions')
    expect(params.properties).toHaveProperty('maxSessions')
    expect(params.required).toEqual([])
  })

  it('defaults to the calling session and includes revert state', async () => {
    hoisted.sessions = [sampleSession('s1', '会话一'), sampleSession('s2', '会话二')]
    hoisted.reverted = { s1: ['C:/proj/a.ts'] }
    const out = await tool().execute({}, { sessionId: 's1' })
    expect(out).toContain('共 1 个会话、3 条文件变更记录')
    expect(out).toContain('会话「会话一」')
    expect(out).not.toContain('会话「会话二」')
    expect(out).toContain('- [A] C:/proj/a.ts（已回退）')
  })

  it('targets another session by id prefix or title', async () => {
    hoisted.sessions = [sampleSession('s1', '会话一'), sampleSession('s2', '会话二')]
    const byId = await tool().execute({ targetSessionId: 's2' })
    expect(byId).toContain('会话「会话二」')
    expect(byId).not.toContain('会话「会话一」')

    const byTitle = await tool().execute({ targetTitle: '会话二' })
    expect(byTitle).toContain('会话「会话二」')
  })

  it('reports a friendly error for an unknown target', async () => {
    hoisted.sessions = [sampleSession('s1', '会话一')]
    const out = await tool().execute({ targetSessionId: 'nope' })
    expect(out).toContain('Error: 找不到目标会话')
  })

  it('reports a friendly message when the session has no file changes', async () => {
    hoisted.sessions = [session('s-empty', '空会话', [msg('hi', undefined, 1)])]
    const out = await tool().execute({}, { sessionId: 's-empty' })
    expect(out).toContain('没有文件变更记录')
  })

  it('allSessions=: lists recent sessions, skipping claw and archived, capped by maxSessions', async () => {
    const claw = sampleSession('s-claw', '爪会话')
    claw.mode = 'claw'
    const archived = sampleSession('s-arc', '归档会话')
    archived.archivedAt = 1
    const live = sampleSession('s-live', '在列会话')
    live.updatedAt = 5000
    hoisted.sessions = [claw, archived, live]

    const out = await tool().execute({ allSessions: true, maxSessions: 1 })
    expect(out).toContain('会话「在列会话」')
    expect(out).not.toContain('爪会话')
    expect(out).not.toContain('归档会话')
  })
})
