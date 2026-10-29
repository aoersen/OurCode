/**
 * Renderer-side bridge for whole-tree checkpoints.
 *
 * Only the operations the per-file checkpoint cannot cover take a workspace
 * snapshot: run_command, directory deletes, mkdir and MCP tools. Plain
 * write/edit tools keep their fast per-file snapshot.
 */
import type { WorkspaceCheckpoint, WorkspaceCheckpointKind } from '@shared/types'
import type { ToolCall } from '@/services/tools/types'

export interface WorkspaceCheckpointContext {
  sessionId: string
  projectPath: string
  taskId?: string
  messageId?: string
  toolCall: Pick<ToolCall, 'id' | 'name' | 'arguments'>
}

function shortPath(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p
}

function labelFor(name: string, args: Record<string, any> | undefined): string {
  const a = args || {}
  if (name === 'run_command') {
    const cmd = String(a.command || '').replace(/\s+/g, ' ').trim()
    return `run_command → ${cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd}`
  }
  if (name === 'delete_file') return `delete_file → ${shortPath(String(a.path || ''))}`
  if (name === 'create_directory') return `create_directory → ${shortPath(String(a.path || ''))}`
  if (name.startsWith('mcp__')) return `${name} → 工作区快照`
  return `${name} → 工作区快照`
}

/**
 * Take the pre-operation snapshot, or return null when the operation is
 * already covered by a per-file checkpoint / needs no snapshot.
 */
export async function captureWorkspaceCheckpointForTool(
  ctx: WorkspaceCheckpointContext,
): Promise<WorkspaceCheckpoint | null> {
  const api = window.electronAPI
  if (!api?.checkpointWorkspaceCreate) return null
  const { name, arguments: args } = ctx.toolCall
  const a = args || {}

  let paths: string[] = []
  let createdDirs: string[] = []
  let kind: WorkspaceCheckpointKind = 'files'
  let collectEmptyDirs = false

  if (name === 'run_command') {
    kind = 'command'
    // Full snapshot; the post-hook fills in the changed paths.
  } else if (name === 'delete_file') {
    const p = String(a.path || '')
    if (!p) return null
    let st: { isDirectory?: boolean } | null = null
    try {
      st = await api.stat(p)
    } catch {
      // Cannot stat → don't guess; the tool will fail on its own.
      return null
    }
    // A single-file delete is already covered by captureCheckpoint.
    if (!st?.isDirectory) return null
    paths = [p]
    collectEmptyDirs = true
    kind = 'dir-delete'
  } else if (name === 'create_directory') {
    const p = String(a.path || '')
    if (!p) return null
    paths = [p]
    createdDirs = [p]
    kind = 'mkdir'
  } else if (name.startsWith('mcp__')) {
    kind = 'files'
  } else {
    return null
  }

  try {
    return await api.checkpointWorkspaceCreate({
      sessionId: ctx.sessionId,
      projectPath: ctx.projectPath,
      taskId: ctx.taskId,
      toolCallId: ctx.toolCall.id,
      messageId: ctx.messageId,
      label: labelFor(name, a),
      kind,
      paths,
      createdDirs,
      collectEmptyDirs,
    })
  } catch {
    // Snapshot failure must not silently allow an unrecoverable operation.
    // The caller turns this into a denial (see captureForToolOrThrow).
    throw new Error('工作区快照失败，已拒绝执行该操作（无法保证可回滚）')
  }
}

/** Post-operation: record the changed paths, or discard a no-op snapshot. */
export async function finalizeWorkspaceCheckpoint(
  cp: WorkspaceCheckpoint | null,
  opts: { keepIfEmpty?: boolean } = {},
): Promise<WorkspaceCheckpoint | null> {
  if (!cp) return null
  const api = window.electronAPI
  if (!api?.checkpointWorkspaceDiff || !api?.checkpointWorkspaceUpdate) return cp
  if (cp.kind === 'mkdir') return cp
  // A directory delete keeps the DIRECTORY as its restore scope. Narrowing it
  // to the deleted files would leave files created inside it after the delete
  // untouched; restoring the delete should return the directory to its
  // pre-delete state.
  if (cp.kind === 'dir-delete') return cp
  // A background command keeps writing after the tool returns; keep the
  // full-tree pre-command restore point instead of narrowing it to whatever
  // had changed at post-hook time.
  if (opts.keepIfEmpty) return cp
  try {
    const diff = await api.checkpointWorkspaceDiff(cp.id)
    if (diff.length === 0) {
      // A command (or a read-only MCP call) that changed nothing must not keep
      // an empty-scope checkpoint: restoring it would roll the whole workspace
      // back. Background commands are the exception — their writes may arrive
      // after the tool returns, so the pre-command snapshot stays.
      const fullTree = cp.kind === 'command' || (cp.kind === 'files' && cp.paths.length === 0)
      if (fullTree && !opts.keepIfEmpty) {
        await api.checkpointWorkspaceDiscard?.(cp.id)
        return null
      }
      return cp
    }
    const paths = Array.from(new Set(diff.map((d) => d.path)))
    return await api.checkpointWorkspaceUpdate(cp.id, { paths })
  } catch {
    return cp
  }
}
