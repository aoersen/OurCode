import { useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import type { ChatSession, Checkpoint } from '@/types'
import { writeToolPaths } from '@/services/tools/writePaths'

/** File-modifying tool names */
const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit_file', 'delete_file', 'create_directory'])

interface FileChange {
  sessionId: string
  sessionTitle: string
  sessionTime: number
  filePath: string
  fileName: string
  toolName: string
  messageId: string
  checkpointId?: string
}

/** Extract changed files from a session's messages (toolCalls) */
function extractFileChanges(session: ChatSession): FileChange[] {
  const changes: FileChange[] = []
  for (const msg of session.messages) {
    if (!msg.toolCalls) continue
    for (const tc of msg.toolCalls) {
      if (!FILE_EDIT_TOOLS.has(tc.name)) continue
      // One entry per touched file — multi_edit_file names several, and each of
      // them is its own row with its own checkpoint snapshot.
      for (const fp of writeToolPaths(tc.name, tc.arguments)) {
        changes.push({
          sessionId: session.id,
          sessionTitle: session.title,
          sessionTime: session.updatedAt,
          filePath: fp,
          fileName: fp.split(/[/\\]/).pop() || fp,
          toolName: tc.name,
          messageId: msg.id,
        })
      }
    }
  }
  return changes
}

/** Format time for session headers */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return '今天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** Resolve a change's path to absolute. Tool/checkpoint paths are normally
 *  already absolute (they are the model's own `path` argument), so those must
 *  pass through untouched — prefixing them produced `E:\proj\C:\…` and the diff
 *  then read "(文件不存在)" for a file that exists. */
function resolvePath(relative: string): string {
  const rootPath = useUIStore.getState().rootPath
  if (!rootPath || IS_ABSOLUTE.test(relative)) return relative
  const sep = rootPath.includes('/') ? '/' : '\\'
  if (relative.startsWith(rootPath)) return relative
  return rootPath.replace(/[/\\]$/, '') + sep + relative
}

/** Windows drive-letter, POSIX root and UNC. */
const IS_ABSOLUTE = /^([a-zA-Z]:[\\/]|[\\/])/

/** Find the checkpoint holding the pre-edit snapshot of this file change.
 *  Prefer an exact (messageId + path) match: an assistant message with several
 *  parallel file tools yields one checkpoint PER file that shares the same
 *  messageId, so a messageId-only lookup can resolve to the WRONG file's
 *  snapshot — which used to leave `original` empty and the diff "显示不全". */
function findCheckpointForChange(checkpoints: Checkpoint[], change: FileChange): Checkpoint | undefined {
  return (
    checkpoints.find(
      (c) => c.messageId === change.messageId && c.files.some((f) => f.path === change.filePath),
    ) ||
    checkpoints.find((c) => c.files.some((f) => f.path === change.filePath)) ||
    checkpoints.find((c) => c.messageId === change.messageId)
  )
}

export default function FileChangesPanel() {
  const sessions = useChatStore((s) => s.sessions)
  const loadCheckpoints = useChatStore((s) => s.loadCheckpoints)
  const revertCheckpoint = useChatStore((s) => s.revertCheckpoint)
  // Select the ACTION only — a whole-store subscription would re-render this
  // panel on every editorStore change (each cursor move while this tab is open).
  const openFile = useEditorStore((s) => s.openFile)
  // 已回退文件路径（按会话分组）—— 本地状态而非全局 store：面板跨全部会话展示，
  // 而 store.revertedFiles 只属于当前激活会话。会话/消息变化后重新拉取。
  const [revertedBySession, setRevertedBySession] = useState<Record<string, string[]>>({})

  // Group file changes by session
  const groupedChanges = useMemo(() => {
    const groups: Array<{ sessionId: string; title: string; time: number; changes: FileChange[] }> = []
    const seen = new Map<string, FileChange[]>()

    for (const session of sessions) {
      const changes = extractFileChanges(session)
      if (changes.length === 0) continue
      seen.set(session.id, changes)
    }

    // Sort sessions by time desc
    const sorted = Array.from(seen.entries()).sort((a, b) => {
      const sa = sessions.find((s) => s.id === a[0])
      const sb = sessions.find((s) => s.id === b[0])
      return (sb?.updatedAt || 0) - (sa?.updatedAt || 0)
    })

    for (const [sessionId, changes] of sorted) {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) continue
      groups.push({
        sessionId,
        title: session.title,
        time: session.updatedAt,
        changes,
      })
    }

    return groups
  }, [sessions])

  // Load each session's reverted-file list so rows can show「已回退」+「恢复」。
  // Fired whenever the grouping changes (new session / new messages); failed
  // loads are silently ignored (the row just falls back to 回退/无检查点).
  useEffect(() => {
    let cancelled = false
    const ids = Array.from(new Set(groupedChanges.map((g) => g.sessionId)))
    for (const sessionId of ids) {
      window.electronAPI.checkpointListReverted(sessionId)
        .then((list) => {
          if (!cancelled) {
            setRevertedBySession((prev) => ({ ...prev, [sessionId]: Array.isArray(list) ? list : [] }))
          }
        })
        .catch(() => { /* ignore */ })
    }
    return () => { cancelled = true }
  }, [groupedChanges])

  const isReverted = (change: FileChange) =>
    (revertedBySession[change.sessionId] || []).includes(change.filePath)

  const getStatusIcon = (toolName: string) => {
    switch (toolName) {
      case 'write_file': return { icon: 'A', color: 'var(--green, #16a34a)', label: 'added' }
      case 'edit_file': return { icon: 'M', color: 'var(--yellow, #d97706)', label: 'modified' }
      case 'delete_file': return { icon: 'D', color: 'var(--red, #dc2626)', label: 'deleted' }
      default: return { icon: 'M', color: 'var(--yellow, #d97706)', label: 'modified' }
    }
  }

  /** Refresh the panel-local reverted list for one session from the DB. */
  const refreshReverted = async (sessionId: string) => {
    try {
      const list = await window.electronAPI.checkpointListReverted(sessionId)
      setRevertedBySession((prev) => ({ ...prev, [sessionId]: Array.isArray(list) ? list : [] }))
    } catch { /* ignore */ }
  }

  const handleViewDiff = async (change: FileChange) => {
    await loadCheckpoints(change.sessionId)
    const checkpoint = findCheckpointForChange(useChatStore.getState().checkpoints, change)
    const cpFile = checkpoint?.files.find((f) => f.path === change.filePath)

    // A snapshot whose `existed` is false means the AI created the file — an
    // empty original (whole file shown as added) is the correct diff. Only when
    // no snapshot exists at all do we surface a hint banner.
    let original = ''
    let notice: string | undefined
    let restoreSessionId: string | undefined
    let restorePath: string | undefined
    if (cpFile) {
      original = cpFile.existed ? cpFile.content : ''
    } else if (isReverted(change)) {
      // 已回退的文件：左侧展示回退前的 AI 版本（从恢复快照取回），这样
      // 「回退之后之前写的看不到了」不再成立 —— 差异视图里就能看到并找回。
      // 旧版本产生的回退记录没有保存内容（hasSnapshot=false），跳过。
      const rec = await window.electronAPI.checkpointGetRevertedRecord(change.sessionId, change.filePath)
      if (rec?.hasSnapshot) {
        original = rec.existed ? rec.content : ''
        notice = '该文件的 AI 改动已回退：左侧为回退前 AI 写入的版本，右侧为当前磁盘内容，可点右上角「恢复」找回。'
        restoreSessionId = change.sessionId
        restorePath = change.filePath
      }
    }
    if (!cpFile && !restorePath) {
      notice = '未找到该文件的修改前快照，左侧仅展示当前内容。'
    }

    // Read current file content
    let modified = ''
    const absPath = resolvePath(change.filePath)
    try {
      const result = await window.electronAPI.readFile(absPath)
      modified = result.content
    } catch {
      modified = '(文件不存在)'
    }

    const ext = change.fileName.split('.').pop() || ''
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
      html: 'html', css: 'css', json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml',
    }

    // Show the diff in the CENTRAL editor area (VS Code "Open Changes") instead
    // of a cramped modal over the left sidebar.
    useEditorStore.getState().openDiff({
      path: absPath,
      fileName: change.fileName,
      original,
      modified,
      language: langMap[ext] || ext,
      kind: 'checkpoint',
      checkpointId: checkpoint?.id,
      notice,
      restoreSessionId,
      restorePath,
    })
  }

  const handleRevert = async (change: FileChange) => {
    await loadCheckpoints(change.sessionId)
    const checkpoint = findCheckpointForChange(useChatStore.getState().checkpoints, change)

    if (checkpoint) {
      if (confirm(`确定要回退 "${change.fileName}" 的 AI 改动吗？此操作会恢复到 AI 修改之前的内容。`)) {
        const res = await revertCheckpoint(checkpoint.id)
        if (res?.ok) {
          // 一个检查点可能覆盖多个文件 —— 整组重拉，让所有受影响的行都
          // 变成「已回退」+「恢复」，而不是只标记被点的这一个。
          await refreshReverted(change.sessionId)
        }
        // Force file reload in editor
        window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: resolvePath(change.filePath) }))
      }
    } else if (isReverted(change)) {
      alert('该文件的改动已经回退过了，可用行内「恢复」按钮找回 AI 写入的版本。')
    } else {
      alert('没有找到该文件的检查点记录，无法回退。')
    }
  }

  const handleRestore = async (change: FileChange) => {
    if (!confirm(`确定要恢复 "${change.fileName}" 的 AI 改动吗？此操作会把回退前 AI 写入的版本写回磁盘。`)) return
    try {
      const res = await window.electronAPI.checkpointRestore(change.sessionId, [change.filePath])
      if (res?.ok && (res?.restored ?? 0) > 0) {
        await refreshReverted(change.sessionId)
        // 恢复会在主进程重建一个检查点（可再次回退）—— 若正是当前激活会话，
        // 刷新 store 里的检查点，让消息上的「回滚修改」按钮与汇总框恢复可用。
        if (useChatStore.getState().activeSessionId === change.sessionId) {
          await loadCheckpoints(change.sessionId)
        }
        window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: resolvePath(change.filePath) }))
      } else {
        alert('恢复失败，未找到该文件的回退记录。')
      }
    } catch {
      alert('恢复失败，请重试。')
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Body */}
      <div className="flex-1 overflow-y-auto" data-changes-scroll>
        {groupedChanges.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="text-nova-text-muted opacity-40 mb-3">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
              <path d="M14 2v6h6" />
              <path d="M12.2 17.8l.9-2.6 4.2-4.2 1.7 1.7-4.2 4.2-2.6.9z" />
            </svg>
            <div className="text-nova-text-muted text-xs">暂无 AI 文件变更记录</div>
            <div className="text-nova-text-muted/60 text-[10px] mt-1">开始一个对话让 AI 修改文件后，变更会显示在这里</div>
          </div>
        ) : (
          groupedChanges.map((group) => (
            <div key={group.sessionId} className="space-y-2">
              {/* Session header (Stitch: primary-container chat avatar + title + time) */}
              <div className="flex items-center gap-2.5 px-2">
                <div className="w-8 h-8 rounded-full bg-accent-10 flex items-center justify-center text-primary shrink-0">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 5h16v11H8l-4 4V5z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <h3 className="text-xs font-bold text-nova-text-primary truncate">
                    {group.title}
                  </h3>
                  <p className="text-[11px] text-nova-text-muted">
                    {formatTime(group.time)}
                  </p>
                </div>
              </div>

              {/* File rows (Stitch: hover reveals 查看变更/回退 action pill) */}
              <div className="space-y-0.5 pl-4">
                {group.changes.map((change, i) => {
                  const st = getStatusIcon(change.toolName)
                  const reverted = isReverted(change)
                  return (
                    <div
                      key={`${change.filePath}-${i}`}
                      className="file-row group relative flex items-center justify-between p-2 rounded-xl hover:bg-white/50 dark:hover:bg-white/10 transition-colors cursor-pointer"
                      onClick={() => openFile(resolvePath(change.filePath))}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 overflow-hidden">
                        <span
                          className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-mono font-bold shrink-0"
                          style={{
                            color: st.color,
                            background: `color-mix(in srgb, ${st.color} 10%, transparent)`,
                            border: `1px solid color-mix(in srgb, ${st.color} 20%, transparent)`,
                          }}
                        >
                          {st.icon}
                        </span>
                        <span className={`text-[12px] font-mono text-nova-text-primary truncate ${change.toolName === 'delete_file' ? 'line-through text-nova-text-muted' : ''}`}>
                          {change.fileName}
                        </span>
                        {/* 已回退标记 —— 回退操作在历史里留下可见记录 */}
                        {reverted && (
                          <span className="shrink-0 flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-1.5 py-0.5">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                            已回退
                          </span>
                        )}
                      </div>
                      {/* Hover action pill — slides in from the right */}
                      <div
                        className="absolute right-2 flex items-center gap-2 bg-white/90 dark:bg-white/10 px-2 py-1 rounded-full shadow-sm border border-glass-border opacity-0 translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300"
                        style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}
                      >
                        <button
                          className="text-[11px] text-primary font-medium whitespace-nowrap"
                          title="查看差异"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleViewDiff(change)
                          }}
                        >
                          查看变更
                        </button>
                        <span className="w-px h-3 bg-nova-border" />
                        {reverted ? (
                          <button
                            className="text-[11px] text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 flex items-center gap-0.5 whitespace-nowrap"
                            title="恢复 AI 写入的版本"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleRestore(change)
                            }}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 12a8 8 0 1 1-2.3-5.7" />
                              <path d="M20 3v6h-6" />
                            </svg>
                            恢复
                          </button>
                        ) : (
                          <button
                            className="text-[11px] text-nova-text-muted hover:text-error flex items-center gap-0.5 whitespace-nowrap"
                            title="回滚"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleRevert(change)
                            }}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 12a9 9 0 1 0 3-6.7" />
                              <path d="M3 4v5h5" />
                            </svg>
                            回退
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer (Stitch: 查看完整历史) — only when there are records */}
      {groupedChanges.length > 0 && (
        <div className="p-3 border-t border-glass-border shrink-0">
          <button
            className="w-full py-2.5 rounded-xl text-primary font-bold text-xs hover:bg-accent-10 transition-colors flex items-center justify-center gap-1.5"
            onClick={() => {
              const ui = useUIStore.getState()
              if (ui.activeSidebarTab === 'changes' && ui.isSidebarVisible) {
                // Scroll the list to the top — "full history" lands on the latest group
                const el = document.querySelector('[data-changes-scroll]')
                el?.scrollTo({ top: 0, behavior: 'smooth' })
              }
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
            </svg>
            查看完整历史
          </button>
        </div>
      )}
    </div>
  )
}
