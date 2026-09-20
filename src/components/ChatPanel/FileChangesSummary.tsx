import { useMemo, useState } from 'react'
import type { Checkpoint } from '@/types'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'

interface FileChangesSummaryProps {
  sessionId: string
  /** Checkpoints belonging to the active session (AI write-tool snapshots). */
  checkpoints: Checkpoint[]
}

/** 会话结束后的「文件改动」汇总框 —— 中性灰 · 极简纯净版（Stitch 设计稿 V2
 *  落地方案）：默认透明无边框、不抢眼（「回退全部改动」按钮也是中性灰），
 *  鼠标指到整框时才浮现 slate 灰底 + 发丝线边框、按钮才显出红色。头部左侧
 *  标题行可点击展开/收起文件列表，右侧放「回退全部改动」按钮（不出框）；
 *  文件行显示完整路径，行内 hover 浮现单个回退按钮，回退过的文件行保留
 *  （标「已回退」）但按钮消失，全部回退后「回退全部改动」隐藏。
 *
 *  文件列表与「已回退」状态都从 store 派生（checkpoints = 未回退的快照，
 *  revertedFiles = 已回退的文件路径），不放在组件本地 state —— 否则切换会话
 *  重新挂载时本地状态重置，回退过的文件会整框消失（或又显示成「未回退」）。 */
export default function FileChangesSummary({ sessionId, checkpoints }: FileChangesSummaryProps) {
  const t = useI18n()
  const revertPathInSession = useChatStore((s) => s.revertPathInSession)
  const restoreRevertedPath = useChatStore((s) => s.restoreRevertedPath)
  const restoreRevertedPaths = useChatStore((s) => s.restoreRevertedPaths)
  const requestRevertAllConfirm = useChatStore((s) => s.requestRevertAllConfirm)
  const revertedFiles = useChatStore((s) => s.revertedFiles)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  // 点「回退全部改动」改为内嵌确认（InlineDecisionArea 吸底展示在消息区最底部、
  // 模式栏上方，不再弹窗），确认后才执行。

  // 本会话的检查点（父组件通常已按会话过滤，这里再兜底一次以防串会话）。
  const sessionCheckpoints = useMemo(
    () => checkpoints.filter((c) => c.sessionId === sessionId),
    [checkpoints, sessionId],
  )

  // 仍可回退的文件路径（有未回退检查点即算可回退）。
  const pendingPaths = useMemo(() => {
    const set = new Set<string>()
    for (const cp of sessionCheckpoints) {
      for (const f of cp.files || []) {
        if (f.path) set.add(f.path)
      }
    }
    return set
  }, [sessionCheckpoints])

  // 本会话出现过的全部改动文件（去重）：检查点里的文件在前，已回退的文件补在
  // 后面。回退后该文件从 checkpoints 移入 revertedFiles，因此行不会消失。
  const allPaths = useMemo(() => {
    const seen = new Set<string>()
    const paths: string[] = []
    for (const cp of sessionCheckpoints) {
      for (const f of cp.files || []) {
        if (f.path && !seen.has(f.path)) {
          seen.add(f.path)
          paths.push(f.path)
        }
      }
    }
    for (const p of revertedFiles) {
      if (!seen.has(p)) {
        seen.add(p)
        paths.push(p)
      }
    }
    return paths
  }, [sessionCheckpoints, revertedFiles])

  const openFile = (p: string) => useEditorStore.getState().openFile(p)

  const notify = (ok: number, failed: number) => {
    if (failed > 0) {
      useUIStore.getState().showNotification(t('chat.filesChangedRevertFailed', { count: failed }), 'error')
    } else if (ok > 0) {
      useUIStore.getState().showNotification(t('chat.filesChangedReverted', { count: ok }), 'success')
    } else {
      useUIStore.getState().showNotification(t('chat.filesChangedEmpty'), 'info')
    }
  }

  /** 回退单个文件：回退所有包含该文件快照的检查点，返回该文件是否全部回退
   *  成功（任一 checkpoint 失败则该文件保持可回退，可重试）。委托给 store 的
   *  revertPathInSession（从 store 读最新检查点，避免重复回退已被消耗的检查点）。 */
  const revertFile = (path: string) => revertPathInSession(sessionId, path)

  /** 回退单个文件（行内回退按钮，非确认框）。 */
  const handleRevertFile = async (path: string) => {
    if (busy || !pendingPaths.has(path)) return
    setBusy(true)
    try {
      if (await revertFile(path)) {
        notify(1, 0)
      } else {
        notify(0, 1)
      }
    } finally {
      setBusy(false)
    }
  }

  /** 恢复单个文件（撤销回退，找回 AI 写的版本）。 */
  const handleRestoreFile = async (path: string) => {
    if (busy || pendingPaths.has(path)) return
    setBusy(true)
    try {
      if (await restoreRevertedPath(sessionId, path)) {
        useUIStore.getState().showNotification(t('chat.filesChangedRestored', { count: 1 }), 'success')
      } else {
        useUIStore.getState().showNotification(t('chat.filesChangedRestoreFailed', { count: 1 }), 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  /** 恢复全部已回退的文件。 */
  const handleRestoreAll = async () => {
    if (busy) return
    const reverted = allPaths.filter((p) => !pendingPaths.has(p))
    if (reverted.length === 0) return
    setBusy(true)
    try {
      const { ok, failed } = await restoreRevertedPaths(sessionId, reverted)
      if (failed > 0) {
        useUIStore.getState().showNotification(t('chat.filesChangedRestoreFailed', { count: failed }), 'error')
      } else if (ok > 0) {
        useUIStore.getState().showNotification(t('chat.filesChangedRestored', { count: ok }), 'success')
      }
    } finally {
      setBusy(false)
    }
  }

  if (allPaths.length === 0) return null

  const pendingCount = allPaths.filter((p) => pendingPaths.has(p)).length

  return (
    // 不抢眼：默认透明无边框（只有标题文字），hover 才浮现卡片底色与发丝线边框。
    <div className="shrink-0 animate-fade-in rounded-xl border border-transparent hover:bg-slate-50/50 dark:hover:bg-white/5 hover:border-slate-200/60 dark:hover:border-white/10 transition-colors overflow-hidden">
      {/* 头部：左侧点击展开/收起，右侧「回退全部改动」（不出框） */}
      <div className="px-4 py-3 flex items-center gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className={`flex items-center gap-2 min-w-0 flex-1 cursor-pointer transition-colors rounded ${
            expanded ? '' : 'hover:bg-slate-100/50 dark:hover:bg-white/5'
          }`}
        >
          <span className="material-symbols-outlined text-[15px] leading-none text-slate-500 dark:text-nova-text-muted shrink-0" aria-hidden>description</span>
          <span className="text-sm font-medium text-slate-800 dark:text-nova-text-primary truncate">
            {t('chat.filesChangedTitle', { count: allPaths.length })}
          </span>
          <span
            className={`material-symbols-outlined text-[18px] leading-none text-slate-400 dark:text-nova-text-muted shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            aria-hidden
          >
            expand_more
          </span>
        </button>
        {pendingCount > 0 && (
          <button
            onClick={() => requestRevertAllConfirm(sessionId, allPaths.filter((p) => pendingPaths.has(p)))}
            disabled={busy}
            // 默认中性灰（不抢眼），hover 才显红 —— 颜色只在鼠标指到时浮现。
            className="inline-flex items-center justify-center gap-1.5 text-slate-500 hover:text-red-600 dark:text-nova-text-muted dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 border border-transparent hover:border-red-200 dark:hover:border-red-500/30 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors shrink-0 disabled:opacity-50"
          >
            {busy ? (
              <span className="w-4 h-4 border-2 border-slate-400/30 border-t-slate-600 dark:border-nova-text-muted/30 dark:border-t-nova-text-muted rounded-full animate-spin inline-block" />
            ) : (
              <span className="material-symbols-outlined text-[15px] leading-none" aria-hidden>undo</span>
            )}
            {t('chat.filesChangedRevertAll')}
          </button>
        )}
        {/* 全部回退完后出现「恢复全部改动」—— 撤销回退、找回 AI 写的版本。 */}
        {pendingCount === 0 && revertedFiles.length > 0 && (
          <button
            onClick={() => void handleRestoreAll()}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1.5 text-slate-500 hover:text-emerald-600 dark:text-nova-text-muted dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 border border-transparent hover:border-emerald-200 dark:hover:border-emerald-500/30 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors shrink-0 disabled:opacity-50"
          >
            {busy ? (
              <span className="w-4 h-4 border-2 border-slate-400/30 border-t-slate-600 dark:border-nova-text-muted/30 dark:border-t-nova-text-muted rounded-full animate-spin inline-block" />
            ) : (
              <span className="material-symbols-outlined text-[15px] leading-none" aria-hidden>settings_backup_restore</span>
            )}
            {t('chat.filesChangedRestoreAll')}
          </button>
        )}
      </div>

      {/* 回退全部 —— 确认已改为内嵌决策区（InlineDecisionArea 吸底展示在消息区
          最底部、模式栏上方，不再弹窗）；此处只发起请求，确认与执行由
          RevertAllConfirmDialog 读取 chatStore.inlineConfirm 完成。 */}

      {expanded && (
        <>
          {/* 文件列表 —— 完整路径，行 hover 变白、图标转蓝 */}
          <div className="px-4 pb-3 pt-1.5 flex flex-col gap-1.5 border-t border-slate-200/60 dark:border-white/10">
            {allPaths.map((p) => {
              const isReverted = !pendingPaths.has(p)
              return (
                <div
                  key={p}
                  className={`group flex items-center justify-between gap-2 py-1 pl-6 pr-1 rounded transition-colors ${
                    isReverted
                      ? 'text-slate-400 dark:text-nova-text-muted'
                      : 'text-slate-600 dark:text-nova-text-secondary hover:bg-white dark:hover:bg-white/5 cursor-pointer'
                  }`}
                  onClick={isReverted ? undefined : () => openFile(p)}
                  title={p}
                >
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    <span
                      className={`material-symbols-outlined text-[15px] leading-none shrink-0 transition-colors ${
                        isReverted
                          ? 'text-slate-300 dark:text-nova-text-muted/50'
                          : 'text-slate-400 dark:text-nova-text-muted group-hover:text-blue-500'
                      }`}
                      aria-hidden
                    >
                      description
                    </span>
                    <span className="font-mono text-[13px] truncate">{p}</span>
                  </span>
                  {isReverted ? (
                    <span className="shrink-0 flex items-center gap-1.5">
                      <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                        <span className="material-symbols-outlined text-[14px] leading-none" aria-hidden>check</span>
                        {t('chat.filesChangedRevertedTag')}
                      </span>
                      {/* 恢复 —— 撤销回退、找回 AI 写的版本（行内常显，方便发现） */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleRestoreFile(p)
                        }}
                        disabled={busy}
                        title={t('chat.filesChangedRestoreFile')}
                        className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-slate-500 hover:text-emerald-600 dark:text-nova-text-muted dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[14px] leading-none" aria-hidden>settings_backup_restore</span>
                        {t('chat.filesChangedRestore')}
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRevertFile(p)
                      }}
                      disabled={busy}
                      title={t('chat.filesChangedRevertFile')}
                      className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all disabled:opacity-40"
                    >
                      <span className="material-symbols-outlined text-[14px] leading-none" aria-hidden>undo</span>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
