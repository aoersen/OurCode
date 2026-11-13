/**
 * File change history — derived from the file-mutating tool calls recorded in
 * session messages (no separate bookkeeping table). Shared by:
 *   - the 文件变更历史 panel (grouped list + per-file revert state), and
 *   - the `list_file_changes` tool (bounded text report for the agent).
 *
 * Checkpoint snapshots (for diff/revert) live in the main process and are NOT
 * touched here — this module only answers "which files did which session write,
 * and were those changes reverted".
 */
import type { ChatSession } from '@/types'
import { writeToolPaths } from '@/services/tools/writePaths'

/** File-modifying tool names — the same set the 文件变更历史 panel counts. */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit_file',
  'delete_file',
  'create_directory',
])

export interface FileChange {
  sessionId: string
  sessionTitle: string
  /** Session `updatedAt` — used for the group header. */
  sessionTime: number
  filePath: string
  fileName: string
  toolName: string
  messageId: string
  /** When the message that touched the file was created (ms). */
  time: number
}

export interface SessionFileChanges {
  sessionId: string
  title: string
  /** Session `updatedAt`, for the group header. */
  time: number
  changes: FileChange[]
}

/**
 * Extract changed files from one session's messages (tool calls only, in
 * chronological order). One entry per touched file — `multi_edit_file` names
 * several, and each of them is its own row with its own checkpoint snapshot.
 */
export function extractFileChanges(session: ChatSession): FileChange[] {
  const changes: FileChange[] = []
  for (const msg of session.messages) {
    if (!msg.toolCalls) continue
    for (const tc of msg.toolCalls) {
      if (!FILE_EDIT_TOOLS.has(tc.name)) continue
      for (const fp of writeToolPaths(tc.name, tc.arguments)) {
        changes.push({
          sessionId: session.id,
          sessionTitle: session.title,
          sessionTime: session.updatedAt,
          filePath: fp,
          fileName: fp.split(/[/\\]/).pop() || fp,
          toolName: tc.name,
          messageId: msg.id,
          time: msg.createdAt || session.updatedAt,
        })
      }
    }
  }
  return changes
}

export interface GroupFileChangesOptions {
  /** Skip WeChat-bridge sessions (mode='claw') — the panel's behavior. */
  excludeClaw?: boolean
  /** Skip sessions the user archived (search_sessions' privacy stance). */
  excludeArchived?: boolean
}

/** Group changes by session, newest session first (by `updatedAt`). */
export function groupFileChangesBySession(
  sessions: ChatSession[],
  opts: GroupFileChangesOptions = {},
): SessionFileChanges[] {
  const groups: SessionFileChanges[] = []
  for (const session of sessions) {
    if (opts.excludeClaw && session.mode === 'claw') continue
    if (opts.excludeArchived && session.archivedAt) continue
    const changes = extractFileChanges(session)
    if (changes.length === 0) continue
    groups.push({ sessionId: session.id, title: session.title, time: session.updatedAt, changes })
  }
  groups.sort((a, b) => b.time - a.time)
  return groups
}

export type ChangeMarker = 'A' | 'M' | 'D'

/** A/M/D marker for a write tool — one mapping shared by panel and report. */
export function changeMarker(toolName: string): ChangeMarker {
  if (toolName === 'write_file') return 'A'
  if (toolName === 'delete_file') return 'D'
  return 'M'
}

/** Deterministic (locale-independent) short timestamp, e.g. `11月9日 15:21`. */
function formatStamp(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

export interface FormatFileChangeReportOptions {
  /** Overall character budget (default 8000). */
  maxChars?: number
  /** Per-session row cap (default 40). */
  maxChangesPerSession?: number
}

/**
 * Bounded plain-text report for the agent: one block per session (newest
 * first), rows in chronological order, each marked A/M/D and tagged
 * `（已回退）` when a revert record covers the file.
 */
export function formatFileChangeReport(
  groups: SessionFileChanges[],
  revertedBySession: Record<string, string[]> = {},
  opts: FormatFileChangeReportOptions = {},
): string {
  const maxChars = Math.max(400, opts.maxChars ?? 8000)
  const maxChanges = Math.max(1, opts.maxChangesPerSession ?? 40)
  const total = groups.reduce((n, g) => n + g.changes.length, 0)

  const header =
    `共 ${groups.length} 个会话、${total} 条文件变更记录（A=新建/写入，M=修改，D=删除；` +
    `行按时间先后排列；标记（已回退）的改动可用 restore_changes 找回）：`
  const blocks: string[] = []
  let droppedSessions = 0

  for (const group of groups) {
    const reverted = new Set(revertedBySession[group.sessionId] || [])
    const shown = group.changes.slice(0, maxChanges)
    const lines = shown.map((c) => {
      const tags = [reverted.has(c.filePath) ? '（已回退）' : ''].filter(Boolean).join('')
      return `- [${changeMarker(c.toolName)}] ${c.filePath}${tags}`
    })
    if (group.changes.length > shown.length) {
      lines.push(`- …另有 ${group.changes.length - shown.length} 条未显示`)
    }
    const block = `\n■ 会话「${group.title}」 (id: ${group.sessionId}，${formatStamp(group.time)}) — ${group.changes.length} 条\n${lines.join('\n')}`

    // Budget check: drop whole session blocks from the tail once over budget —
    // a truncated list still answers "what changed recently", a cut line does not.
    const tentative = [header, ...blocks, block].join('\n')
    if (tentative.length > maxChars && blocks.length > 0) {
      droppedSessions = groups.length - blocks.length
      break
    }
    blocks.push(block)
  }

  const out = [header, ...blocks].join('\n')
  return droppedSessions > 0
    ? `${out}\n…（输出已截断：另 ${droppedSessions} 个会话未显示，可用 targetSessionId 单独查询）`
    : out
}
