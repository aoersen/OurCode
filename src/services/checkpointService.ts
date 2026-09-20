/**
 * Checkpoint capture — snapshots the file(s) a write tool is about to touch so
 * the user can revert. Shared by the main agent loop and subagents so every
 * AI-initiated file mutation is revertable (Windsurf-style checkpoints).
 */
import { v4 as uuidv4 } from 'uuid'
import type { Checkpoint } from '@/types'
import { writeToolPaths } from './tools/writePaths'

export async function captureCheckpoint(
  sessionId: string,
  tc: { name: string; arguments?: Record<string, any> },
  messageId?: string,
): Promise<Checkpoint | null> {
  // Deduped so a file edited twice is captured once, letting the whole batch be
  // reverted in one go.
  const targets = writeToolPaths(tc.name, tc.arguments)
  if (targets.length === 0) return null

  const files: Array<{ path: string; content: string; existed: boolean }> = []
  if (tc.name !== 'create_directory') {
    for (const target of targets) {
      try {
        const { content } = await window.electronAPI.readFile(target)
        files.push({ path: target, content, existed: true })
      } catch {
        // File doesn't exist yet (write_file creating a new file)
        files.push({ path: target, content: '', existed: false })
      }
    }
  }

  if (files.length === 0) return null

  const label = targets.length === 1
    ? `${tc.name} → ${targets[0].split(/[/\\]/).pop() || targets[0]}`
    : `${tc.name} → ${targets.length} 个文件`

  const checkpoint: Checkpoint = {
    id: uuidv4(),
    sessionId,
    createdAt: Date.now(),
    label,
    messageId: messageId || undefined,
    files,
  }

  await window.electronAPI.checkpointCreate(checkpoint)
  return checkpoint
}
