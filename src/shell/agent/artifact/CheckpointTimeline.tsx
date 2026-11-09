import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import type { Checkpoint } from '@/types'
import { compareWithHead, openCheckpointDiff, primaryCheckpointFile } from './artifactActions'
import { baseName } from './artifactModel'
import {
  checkpointKindLabel,
  computeCheckpointStats,
  formatClock,
  formatDuration,
  orderCheckpoints,
  runDurationMs,
  summaryLine,
} from './checkpointStats'

/** 统计口径最多读多少个文件的当前内容（大仓库里防止一次开几百个 fd）。 */
const MAX_STAT_PATHS = 60

type Busy = 'all' | string | null

/**
 * 「变更」页签：本次会话的 checkpoint 时间线。
 *
 * 数据全部来自真实 store：
 *  - chatStore.checkpoints（当前会话的写入前快照，AI 每次写文件前捕获）
 *  - chatStore.revertCheckpoint / restoreToBaseline（回退、回到初始状态）
 *  - editorStore.openDiff（查看 diff，复用组件 DiffView）
 *
 * +/− 行数是推出来的：diff(本笔快照, 同一路径的下一笔快照)，最后一笔用磁盘当前
 * 内容。见 checkpointStats.computeCheckpointStats 的口径说明。
 */
export default function CheckpointTimeline() {
  const session = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((item) => item.id === s.activeSessionId) ?? null : null,
  )
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const checkpoints = useChatStore((s) => s.checkpoints)
  const loadCheckpoints = useChatStore((s) => s.loadCheckpoints)
  const revertCheckpoint = useChatStore((s) => s.revertCheckpoint)
  const restoreToBaseline = useChatStore((s) => s.restoreToBaseline)
  const rootPath = useUIStore((s) => s.rootPath)

  const [disk, setDisk] = useState<Map<string, string | null>>(() => new Map())
  const [statsReady, setStatsReady] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const loadedForRef = useRef<string | null>(null)

  const projectPath = session?.projectPath || rootPath || null
  const ordered = useMemo(() => orderCheckpoints(checkpoints), [checkpoints])
  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null

  // 面板可能是这个会话里第一个打开检查点列表的地方（例如从会话恢复后直接看
  // 变更页签）。只在本次挂载的第一轮、且 store 里确实为空时补一次拉取。
  useEffect(() => {
    if (!activeSessionId) return
    if (loadedForRef.current === activeSessionId) return
    loadedForRef.current = activeSessionId
    if (useChatStore.getState().checkpoints.length === 0) void loadCheckpoints(activeSessionId)
  }, [activeSessionId, loadCheckpoints])

  // 读「当前磁盘内容」用于算每一笔的增量。签名为空不发请求；签名只包含 checkpoint
  // 的 id/时间/文件数，流式运行中同一批 checkpoints 不会重复触发。
  const signature = useMemo(
    () => ordered.map((cp) => `${cp.id}:${cp.createdAt}:${cp.files?.length ?? 0}`).join('|'),
    [ordered],
  )

  useEffect(() => {
    let cancelled = false
    const paths = Array.from(
      new Set(
        ordered.flatMap((cp) =>
          (cp.files ?? []).filter((file) => !file.snapshotFailed).map((file) => file.path),
        ),
      ),
    ).slice(0, MAX_STAT_PATHS)

    if (paths.length === 0) {
      setDisk(new Map())
      setStatsReady(true)
      return
    }

    setStatsReady(false)
    void Promise.all(
      paths.map(async (path) => {
        try {
          const result = await window.electronAPI.readFile(path)
          return [path, typeof result?.content === 'string' ? result.content : ''] as const
        } catch {
          // 读不到 = 文件已不存在（回退/删除），按空内容算
          return [path, null] as const
        }
      }),
    ).then((pairs) => {
      if (cancelled) return
      setDisk(new Map(pairs))
      setStatsReady(true)
    })

    return () => {
      cancelled = true
    }
  }, [signature, ordered])

  const stats = useMemo(() => computeCheckpointStats(ordered, disk), [ordered, disk])
  const duration = formatDuration(runDurationMs(session?.agentRuns, ordered))

  const notify = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
    useUIStore.getState().showNotification(message, type)
  }

  const handleViewDiff = (checkpoint: Checkpoint) => {
    void openCheckpointDiff(checkpoint)
  }

  const handleRevertOne = async (checkpoint: Checkpoint) => {
    if (busy) return
    const file = primaryCheckpointFile(checkpoint)
    const name = file ? baseName(file.path) : checkpoint.label
    if (!window.confirm(`确定回退这一笔写入（${name}）吗？文件会恢复到写入前的内容，对话记录保留。`)) return
    setBusy(checkpoint.id)
    try {
      const result = await revertCheckpoint(checkpoint.id)
      if (result?.ok) notify('已回退到这一步', 'success')
      else notify(`回退失败：${result?.error ?? '检查点不可用'}`, 'error')
      // 回退会改动磁盘 —— 让编辑器/预览立刻跟着刷新
      for (const touched of checkpoint.files ?? []) {
        window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: touched.path }))
      }
    } finally {
      setBusy(null)
    }
  }

  const handleRevertAll = async () => {
    if (busy) return

    if (ordered.length === 0) {
      if (!projectPath) {
        notify('没有可回退的写入。', 'info')
        return
      }
      if (!window.confirm('本次会话还没有检查点。要把整个项目恢复到初始状态（基线快照）吗？')) return
      setBusy('all')
      try {
        const message = await restoreToBaseline(projectPath)
        useUIStore.getState().showNotification(message, message.includes('失败') ? 'error' : 'info')
      } finally {
        setBusy(null)
      }
      return
    }

    if (!window.confirm(`确定回退本次会话的全部 ${ordered.length} 笔写入吗？文件会恢复到第一笔写入之前。`)) return
    setBusy('all')
    try {
      // 新 → 旧逐笔回退：每一笔的前像才是「再往前一步」的真实内容
      const targets = [...ordered].reverse()
      let ok = 0
      const touched = new Set<string>()
      for (const checkpoint of targets) {
        const result = await revertCheckpoint(checkpoint.id)
        if (result?.ok) ok++
        for (const file of checkpoint.files ?? []) touched.add(file.path)
      }
      for (const path of touched) {
        window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: path }))
      }
      if (ok === targets.length) notify(`已回退全部 ${ok} 笔写入`, 'success')
      else notify(`已回退 ${ok}/${targets.length} 笔，其余未能恢复`, ok > 0 ? 'info' : 'error')
    } finally {
      setBusy(null)
    }
  }

  const handleCompareHead = () => {
    const file = latest ? primaryCheckpointFile(latest) : null
    const target = file?.path || useEditorStore.getState().activeFilePath
    if (!target) {
      notify('还没有可对比的文件。', 'info')
      return
    }
    void compareWithHead(target, projectPath)
  }

  const totals = stats.totals
  const latestKey = latest?.id ?? null
  const actionsLocked = busy !== null

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 px-5 pt-4 pb-3 flex items-start justify-between gap-3">
        <div className="flex flex-col gap-[3px] min-w-0">
          <div className="text-[14px] leading-[20px] font-medium text-[var(--pure-ink)]">
            本次运行 {totals.writes} 次写入
          </div>
          <div className="text-[12px] leading-[18px] text-[var(--pure-muted)] tabular-nums">
            {totals.writes === 0
              ? '没有文件被修改'
              : statsReady
                ? summaryLine(totals, duration)
                : `${totals.files} 个文件 · 统计中…`}
          </div>
        </div>
        <button
          type="button"
          onClick={handleCompareHead}
          aria-label="对比 HEAD"
          className="pure-focus shrink-0 pt-[2px] text-[12px] leading-[18px] text-[var(--pure-muted)] hover:text-[var(--pure-ink)] transition-colors"
        >
          对比 HEAD
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pure-scroll px-5 pb-3">
        {ordered.length === 0 ? (
          <div className="pt-6 text-[12px] leading-[20px] text-[var(--pure-muted)]">
            本次会话还没有写入变更
          </div>
        ) : (
          <>
            <div className="flex flex-col" role="list" aria-label="检查点时间线">
              {ordered.map((checkpoint) => {
                const file = primaryCheckpointFile(checkpoint)
                const counts = stats.byId.get(checkpoint.id) ?? { added: 0, removed: 0 }
                const fileCount = (checkpoint.files ?? []).filter((entry) => !entry.snapshotFailed).length
                const isLatest = checkpoint.id === latestKey
                return (
                  <div
                    key={checkpoint.id}
                    role="listitem"
                    className="pure-row group rounded-xl px-3 py-3 hover:bg-[var(--pure-hover)] transition-colors"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          aria-hidden="true"
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: isLatest ? 'var(--pure-ink)' : 'var(--pure-muted)' }}
                        />
                        <button
                          type="button"
                          onClick={() => handleViewDiff(checkpoint)}
                          title={file?.path ?? checkpoint.label}
                          aria-label={`查看 ${file ? baseName(file.path) : checkpoint.label} 的 diff`}
                          className="pure-focus min-w-0 truncate text-[13px] leading-[20px] text-[var(--pure-ink)] text-left"
                        >
                          {file ? baseName(file.path) : checkpoint.label}
                        </button>
                      </div>
                      <span className="shrink-0 text-[12px] leading-[18px] text-[var(--pure-muted)] tabular-nums">
                        {fileCount > 1 ? `${fileCount} 个文件 · ` : ''}
                        {`+${counts.added} −${counts.removed}`}
                      </span>
                    </div>

                    <div className="mt-[6px] pl-4 flex items-center justify-between gap-3">
                      <span className="text-[12px] leading-[18px] text-[var(--pure-muted)] tabular-nums truncate">
                        {formatClock(checkpoint.createdAt)} · {checkpointKindLabel(checkpoint)}
                      </span>
                      <div className="pure-row-actions shrink-0 flex items-center gap-3 text-[12px] leading-[18px]">
                        <button
                          type="button"
                          onClick={() => handleViewDiff(checkpoint)}
                          aria-label={`查看 ${file ? baseName(file.path) : checkpoint.label} 的 diff`}
                          className="pure-focus text-[var(--pure-muted)] hover:text-[var(--pure-ink)] transition-colors"
                        >
                          查看 diff
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRevertOne(checkpoint)}
                          disabled={actionsLocked}
                          aria-label={`回退到 ${formatClock(checkpoint.createdAt)} 这一步`}
                          className="pure-focus text-[var(--pure-muted)] hover:text-[var(--pure-ink)] disabled:opacity-40 transition-colors"
                        >
                          回退到此步
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="pt-5 text-center text-[12px] leading-[18px] text-[var(--pure-muted)]">
              回退会恢复文件内容，不撤销对话记录
            </div>
          </>
        )}
      </div>

      <div className="shrink-0 px-5 py-3 flex items-center justify-between gap-3 bg-[var(--pure-canvas)] border-t border-[var(--pure-border)]">
        <button
          type="button"
          onClick={() => void handleRevertAll()}
          disabled={actionsLocked}
          aria-label="全部回退"
          title={ordered.length === 0 ? '恢复到项目初始状态（基线快照）' : '回退本次会话的全部写入'}
          className="pure-focus px-2 py-1.5 rounded-lg text-[13px] leading-[20px] text-[var(--pure-muted)] hover:text-[var(--pure-danger)] disabled:opacity-40 transition-colors"
        >
          全部回退
        </button>
        <button
          type="button"
          onClick={() => latest && void handleRevertOne(latest)}
          disabled={!latest || actionsLocked}
          aria-label="回退到最新一步"
          className="pure-focus px-4 py-2 rounded-xl bg-[var(--pure-ink)] text-[var(--pure-canvas)] text-[13px] leading-[20px] hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          回退到此步
        </button>
      </div>
    </div>
  )
}
