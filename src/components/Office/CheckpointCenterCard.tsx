/**
 * 右栏「恢复点」卡：一人公司默认放行，所以安全网是 checkpoint 而不是审批。
 *
 * 列表 = 最近的整树快照（命令/目录删除/MCP）+ 最近的文件写快照。
 * 用户可以恢复单次操作、单条快照，或整个任务；所有恢复都会先自动备份。
 */
import { useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import type { WorkspaceCheckpoint } from '@shared/types'
import { MONO } from './officeTheme'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function shortFile(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/') || path
}

export default function CheckpointCenterCard({ active = true }: { active?: boolean }) {
  const t = useI18n()
  const sessionId = useChatStore((s) => s.activeSessionId)
  const workspaceCheckpoints = useChatStore((s) => s.workspaceCheckpoints)
  const fileCheckpoints = useChatStore((s) => s.checkpoints)
  const session = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!active || !sessionId) return
    void useChatStore.getState().loadWorkspaceCheckpoints(sessionId)
  }, [active, sessionId])

  const workspaceRows = useMemo(
    () => [...workspaceCheckpoints].filter((c) => c.kind !== 'restore-safety').sort((a, b) => b.createdAt - a.createdAt).slice(0, 8),
    [workspaceCheckpoints],
  )
  const fileRows = useMemo(
    () => [...fileCheckpoints].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
    [fileCheckpoints],
  )

  const notify = (message: string) => {
    const failed = message.startsWith('恢复失败')
    useUIStore.getState().showNotification(message, failed ? 'error' : 'success')
  }

  const run = async (fn: () => Promise<string>) => {
    if (busy) return
    setBusy(true)
    try {
      notify(await fn())
    } catch (error) {
      notify(`恢复失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const restoreLast = () => run(() => useChatStore.getState().restoreChanges({
    scope: 'last',
    sessionId: sessionId || undefined,
  }))

  const restoreTask = () => {
    if (!session?.targetMode || session.workerRole) {
      notify('当前会话不是一人公司任务，无法按任务恢复。')
      return
    }
    if (!window.confirm(t('office.restoreTaskConfirm'))) return
    void run(() => useChatStore.getState().restoreChanges({
      scope: 'task',
      sessionId: sessionId || undefined,
      taskId: session.id,
    }))
  }

  const restoreWorkspace = (cp: WorkspaceCheckpoint) => {
    if (!window.confirm(t('office.restoreConfirm', { label: cp.label }))) return
    void run(() => useChatStore.getState().restoreChanges({
      scope: 'checkpoint',
      sessionId: sessionId || undefined,
      checkpointId: cp.id,
    }))
  }

  const restoreFileCheckpoint = (id: string) => {
    void run(async () => {
      const res = await useChatStore.getState().revertCheckpoint(id)
      return res?.ok ? t('office.restoreDone') : `恢复失败：${res?.error || '检查点不可用'}`
    })
  }

  const disabled = busy || !sessionId
  const hasAny = workspaceRows.length > 0 || fileRows.length > 0

  return (
    <div
      data-testid="office-checkpoint-card"
      className="shrink-0 rounded-xl border px-3.5 py-3"
      style={{ background: '#fff', borderColor: 'rgba(15,23,42,0.08)', borderLeft: '2px solid #0058BC' }}
    >
      <div className="flex items-baseline justify-between mb-1.5 gap-2">
        <span className="text-[13px] font-bold" style={{ color: '#0f172a' }}>
          {t('office.restoreCard')}
        </span>
        <button
          onClick={restoreLast}
          disabled={disabled || !hasAny}
          className="rounded-md px-2 py-0.5 transition-colors"
          style={{
            fontSize: 11,
            background: disabled || !hasAny ? MONO.hover : '#0058BC',
            color: disabled || !hasAny ? MONO.t3 : '#fff',
            cursor: disabled || !hasAny ? 'default' : 'pointer',
          }}
        >
          {busy ? t('office.restoring') : t('office.restoreLast')}
        </button>
      </div>

      {!hasAny ? (
        <div className="text-xs py-1.5" style={{ color: '#94a3b8' }}>
          {t('office.restoreEmpty')}
        </div>
      ) : (
        <>
          {workspaceRows.map((cp) => (
            <div
              key={cp.id}
              className="flex items-center gap-2 py-1.5"
              style={{ borderTop: '1px solid rgba(15,23,42,0.08)' }}
            >
              <span className="text-[10px] shrink-0" style={{ color: MONO.t3, fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace" }}>
                {fmtTime(cp.createdAt)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate" style={{ color: MONO.t1 }} title={cp.paths.join('\n')}>
                  {cp.label}
                </div>
                <div className="text-[10px] truncate" style={{ color: MONO.t3 }}>
                  {cp.paths.length > 0
                    ? cp.paths.map(shortFile).slice(0, 3).join('、') + (cp.paths.length > 3 ? '…' : '')
                    : cp.kind === 'command' ? t('office.restoreWholeTree') : t('office.restoreNoPaths')}
                </div>
              </div>
              <button
                onClick={() => restoreWorkspace(cp)}
                disabled={disabled}
                className="shrink-0 rounded-md px-1.5 py-0.5"
                style={{
                  fontSize: 11,
                  border: '1px solid rgba(15,23,42,0.12)',
                  color: disabled ? MONO.t3 : '#0058BC',
                  background: 'transparent',
                  cursor: disabled ? 'default' : 'pointer',
                }}
              >
                {t('office.restore')}
              </button>
            </div>
          ))}

          {fileRows.length > 0 && (
            <div className="pt-1.5 mt-1" style={{ borderTop: '1px solid rgba(15,23,42,0.08)' }}>
              <div className="text-[10px] mb-1" style={{ color: MONO.t3 }}>
                {t('office.restoreFileSection')}
              </div>
              {fileRows.map((cp) => (
                <div key={cp.id} className="flex items-center gap-2 py-1">
                  <span className="text-[10px] shrink-0" style={{ color: MONO.t3, fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace" }}>
                    {fmtTime(cp.createdAt)}
                  </span>
                  <span className="flex-1 text-xs truncate" style={{ color: MONO.t1 }} title={cp.files.map((f) => f.path).join('\n')}>
                    {cp.files.map((f) => shortFile(f.path)).slice(0, 2).join('、')}
                    {cp.files.length > 2 ? '…' : ''}
                  </span>
                  <button
                    onClick={() => restoreFileCheckpoint(cp.id)}
                    disabled={disabled}
                    className="shrink-0 rounded-md px-1.5 py-0.5"
                    style={{
                      fontSize: 11,
                      border: '1px solid rgba(15,23,42,0.12)',
                      color: disabled ? MONO.t3 : '#0058BC',
                      background: 'transparent',
                      cursor: disabled ? 'default' : 'pointer',
                    }}
                  >
                    {t('office.restore')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {session?.targetMode && !session.workerRole && (
            <button
              onClick={restoreTask}
              disabled={disabled}
              className="mt-2 w-full rounded-md py-1"
              style={{
                fontSize: 11,
                border: '1px solid rgba(217,119,6,0.35)',
                color: disabled ? MONO.t3 : '#B45309',
                background: 'rgba(217,119,6,0.06)',
                cursor: disabled ? 'default' : 'pointer',
              }}
            >
              {t('office.restoreTask')}
            </button>
          )}
        </>
      )}
    </div>
  )
}
