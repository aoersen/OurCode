import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  captureWorkspaceCheckpointForTool,
  finalizeWorkspaceCheckpoint,
} from '@/services/checkpoint/workspaceCheckpoint'

const PROJECT = 'E:/work/demo'

function installMock(overrides: Record<string, any> = {}) {
  const api = {
    checkpointWorkspaceCreate: vi.fn(async (input: any) => ({
      id: 'cp-1',
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      messageId: input.messageId,
      label: input.label,
      createdAt: Date.now(),
      commit: 'abc',
      paths: input.paths || [],
      emptyDirs: [],
      createdDirs: input.createdDirs || [],
      kind: input.kind || 'files',
    })),
    checkpointWorkspaceUpdate: vi.fn(async (_id: string, patch: any) => ({ id: 'cp-1', ...patch })),
    checkpointWorkspaceDiff: vi.fn(async () => []),
    checkpointWorkspaceDiscard: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ isDirectory: false, isFile: true })),
    ...overrides,
  }
  ;(globalThis as any).window = { electronAPI: api }
  return api
}

describe('workspaceCheckpoint helper', () => {
  beforeEach(() => {
    installMock()
  })
  afterEach(() => {
    delete (globalThis as any).window
  })

  it('snapshots run_command as a full command checkpoint', async () => {
    const api = installMock()
    const cp = await captureWorkspaceCheckpointForTool({
      sessionId: 's1',
      projectPath: PROJECT,
      taskId: 'task-1',
      toolCall: { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
    })
    expect(cp?.kind).toBe('command')
    expect(api.checkpointWorkspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'command', paths: [], taskId: 'task-1', toolCallId: 't1' }),
    )
  })

  it('snapshots a directory delete with empty-dir collection', async () => {
    const api = installMock({
      stat: vi.fn(async () => ({ isDirectory: true, isFile: false })),
    })
    const cp = await captureWorkspaceCheckpointForTool({
      sessionId: 's1',
      projectPath: PROJECT,
      toolCall: { id: 't2', name: 'delete_file', arguments: { path: `${PROJECT}/src/legacy` } },
    })
    expect(cp?.kind).toBe('dir-delete')
    expect(api.checkpointWorkspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [`${PROJECT}/src/legacy`],
        collectEmptyDirs: true,
      }),
    )
  })

  it('does not snapshot a single-file delete (per-file checkpoint covers it)', async () => {
    const cp = await captureWorkspaceCheckpointForTool({
      sessionId: 's1',
      projectPath: PROJECT,
      toolCall: { id: 't3', name: 'delete_file', arguments: { path: `${PROJECT}/src/a.ts` } },
    })
    expect(cp).toBeNull()
  })

  it('snapshots create_directory as mkdir with createdDirs', async () => {
    const api = installMock()
    const cp = await captureWorkspaceCheckpointForTool({
      sessionId: 's1',
      projectPath: PROJECT,
      toolCall: { id: 't4', name: 'create_directory', arguments: { path: `${PROJECT}/src/new` } },
    })
    expect(cp?.kind).toBe('mkdir')
    expect(api.checkpointWorkspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mkdir', createdDirs: [`${PROJECT}/src/new`] }),
    )
  })

  it('keeps a directory delete scope at the directory (not the deleted files)', async () => {
    const api = installMock({
      stat: vi.fn(async () => ({ isDirectory: true, isFile: false })),
      checkpointWorkspaceDiff: vi.fn(async () => [
        { path: `${PROJECT}/src/legacy/a.ts`, status: 'deleted' },
      ]),
    })
    const cp = await captureWorkspaceCheckpointForTool({
      sessionId: 's1',
      projectPath: PROJECT,
      toolCall: { id: 't8', name: 'delete_file', arguments: { path: `${PROJECT}/src/legacy` } },
    })
    const finalized = await finalizeWorkspaceCheckpoint(cp)
    expect(finalized?.paths).toEqual([`${PROJECT}/src/legacy`])
    expect(api.checkpointWorkspaceUpdate).not.toHaveBeenCalled()
  })

  it('discards a no-op command checkpoint (avoids whole-workspace restores)', async () => {
    const api = installMock()
    const cp = await captureWorkspaceCheckpointForTool({
      sessionId: 's1',
      projectPath: PROJECT,
      toolCall: { id: 't5', name: 'run_command', arguments: { command: 'git status' } },
    })
    const finalized = await finalizeWorkspaceCheckpoint(cp)
    expect(finalized).toBeNull()
    expect(api.checkpointWorkspaceDiscard).toHaveBeenCalledWith('cp-1')
  })

  it('keeps a background command checkpoint as a full restore point', async () => {
    const api = installMock()
    const cp = await captureWorkspaceCheckpointForTool({
      sessionId: 's1',
      projectPath: PROJECT,
      toolCall: { id: 't6', name: 'run_command', arguments: { command: 'npm run dev', background: true } },
    })
    const finalized = await finalizeWorkspaceCheckpoint(cp, { keepIfEmpty: true })
    expect(finalized).not.toBeNull()
    expect(api.checkpointWorkspaceDiscard).not.toHaveBeenCalled()
  })

  it('records changed paths when a command touched files', async () => {
    const api = installMock({
      checkpointWorkspaceDiff: vi.fn(async () => [
        { path: `${PROJECT}/a.ts`, status: 'modified' },
        { path: `${PROJECT}/b.ts`, status: 'added' },
      ]),
    })
    const cp = await captureWorkspaceCheckpointForTool({
      sessionId: 's1',
      projectPath: PROJECT,
      toolCall: { id: 't7', name: 'run_command', arguments: { command: 'npm run build' } },
    })
    const finalized = await finalizeWorkspaceCheckpoint(cp)
    expect(finalized?.paths).toEqual([`${PROJECT}/a.ts`, `${PROJECT}/b.ts`])
    expect(api.checkpointWorkspaceUpdate).toHaveBeenCalledWith('cp-1', {
      paths: [`${PROJECT}/a.ts`, `${PROJECT}/b.ts`],
    })
  })
})
