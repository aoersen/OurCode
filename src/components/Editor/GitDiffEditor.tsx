import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { monaco, OURCODE_DARK_THEME, OURCODE_LIGHT_THEME } from '@/editor/monacoSetup'
import { useEditorStore, ActiveDiff } from '@/stores/editorStore'
import { useI18n } from '@/i18n/useI18n'
import { parseGitDiff, buildChangePatch, buildHunkPatch, findHunkForChange, DiffChangeRange } from '@/utils/gitDiff'
import { runGitCommand, fetchGitDiffSides, notifyGitChanged } from '@/services/git'
import { applyPatchArgs } from '@/utils/gitPatch'

type ChangeAction = 'revert' | 'stage' | 'unstage'

interface GitDiffEditorProps {
  diff: ActiveDiff
  onClose: () => void
}

/** Small inline SVG icons for the gutter action buttons. */
const REVERT_ICON =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>'
const PLUS_ICON =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>'
const MINUS_ICON =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14"/></svg>'

/**
 * VS Code-style source-control diff opened in the central editor area.
 *
 * Renders a Monaco side-by-side diff (left = HEAD/index, right = index/worktree)
 * and puts per-change action arrows in BOTH gutters — revert on either side,
 * plus stage/unstage — so a single change can be discarded or moved between the
 * index and the worktree exactly like VS Code's diff gutter. Precise single-
 * change patches are built from the parsed git diff (`buildChangePatch`) and
 * validated with `git apply --check` before applying; anything that can't be
 * isolated falls back to the whole git hunk.
 */
export default function GitDiffEditor({ diff, onClose }: GitDiffEditorProps) {
  const t = useI18n()

  const git = diff.git
  const repoFile = git?.repoFile ?? diff.path
  const staged = !!git?.staged

  const [original, setOriginal] = useState(diff.original)
  const [modified, setModified] = useState(diff.modified)
  const [diffText, setDiffText] = useState(git?.diffText ?? '')
  const [isStaged, setIsStaged] = useState(staged)
  // An untracked file becomes tracked after being staged — tracked as state so
  // the view (badge, banner, gutter arrows) can flip instead of closing.
  const [untracked, setUntracked] = useState(!!git?.untracked)
  const [sideBySide, setSideBySide] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const widgetsRef = useRef<{ editor: monaco.editor.IStandaloneCodeEditor; widget: monaco.editor.IGlyphMarginWidget }[]>([])

  const parsed = useMemo(() => (diffText ? parseGitDiff(diffText, repoFile) : null), [diffText, repoFile])

  // Latest values for the stable callbacks — the gutter widgets are created
  // once and re-created on state changes, so their handlers must never close
  // over a stale render scope.
  const stateRef = useRef({ repoFile, isStaged, untracked, parsed })
  useEffect(() => {
    stateRef.current = { repoFile, isStaged, untracked, parsed }
  }, [repoFile, isStaged, untracked, parsed])

  // ── git operations ────────────────────────────────────────────────────────

  /** Re-read both sides after a mutation; close the diff when nothing remains.
   *  Also detects a staged ↔ unstaged flip (e.g. staging the last hunk).
   *  `opts.wasUntracked` lets a staging action on an untracked file keep the
   *  diff open and switch it to the newly-staged view instead of closing. */
  const refreshDiff = useCallback(async (opts?: { wasUntracked?: boolean }) => {
    const { repoFile: file, untracked: untrackedNow } = stateRef.current
    notifyGitChanged()
    // Worktree mutations must refresh models that are open in the editor.
    window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: diff.path }))

    if (untrackedNow && !opts?.wasUntracked) {
      onClose()
      return
    }

    let nextStaged = false
    let nextText = ''
    const cached = await runGitCommand(['diff', '--cached', '--', file])
    if (cached.success && cached.output) {
      nextStaged = true
      nextText = cached.output
    } else {
      const work = await runGitCommand(['diff', '--', file])
      if (work.success && work.output) nextText = work.output
    }
    if (!nextText) {
      onClose()
      return
    }
    const sides = await fetchGitDiffSides(file, nextStaged)
    setIsStaged(nextStaged)
    setUntracked(false) // a diff exists now, so the file is tracked
    setDiffText(nextText)
    setOriginal(sides.original)
    setModified(sides.modified)
  }, [diff.path, onClose])

  const tryApplyPatch = useCallback(async (patch: string, action: ChangeAction): Promise<boolean> => {
    const { isStaged: stagedNow } = stateRef.current
    const { check, apply } = applyPatchArgs(action, stagedNow)
    const checkRes = await runGitCommand(check, patch)
    if (!checkRes.success) return false
    const applyRes = await runGitCommand(apply, patch)
    return applyRes.success
  }, [])

  /** Apply a patch for one change: precise sub-patch first, whole hunk fallback. */
  const applyChange = useCallback(async (change: DiffChangeRange, action: ChangeAction): Promise<boolean> => {
    const { repoFile: file, parsed: parsedNow } = stateRef.current
    if (!parsedNow) return false
    const candidates = [buildChangePatch(file, parsedNow, change)]
    const hunk = findHunkForChange(parsedNow, change)
    if (hunk) candidates.push(buildHunkPatch(file, hunk, parsedNow))
    for (const patch of candidates) {
      if (!patch) continue
      if (await tryApplyPatch(patch, action)) return true
    }
    return false
  }, [tryApplyPatch])

  const runChangeAction = useCallback(
    async (change: DiffChangeRange, action: ChangeAction) => {
      setNotice(null)
      setBusy(true)
      try {
        const ok = await applyChange(change, action)
        if (!ok) {
          setNotice(t('git.applyHunkFailed'))
          return
        }
        await refreshDiff()
      } finally {
        setBusy(false)
      }
    },
    [applyChange, refreshDiff, t],
  )

  // ── Gutter action widgets (VS Code diff arrows) ───────────────────────────

  const makeWidget = useCallback(
    (change: monaco.editor.ILineChange, lineNumber: number, lane: monaco.editor.GlyphMarginLane): monaco.editor.IGlyphMarginWidget => {
      const dom = document.createElement('div')
      dom.style.cssText = 'display:flex;align-items:center;gap:1px;height:100%;padding-left:2px;'

      const addButton = (icon: string, title: string, color: string, hoverBg: string, onClick: () => void) => {
        const btn = document.createElement('button')
        btn.title = title
        btn.innerHTML = icon
        btn.style.cssText =
          `display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border:none;padding:0;` +
          `border-radius:4px;cursor:pointer;color:${color};background:transparent;`
        btn.addEventListener('mouseenter', () => {
          btn.style.background = hoverBg
        })
        btn.addEventListener('mouseleave', () => {
          btn.style.background = 'transparent'
        })
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          onClick()
        })
        dom.appendChild(btn)
      }

      if (stateRef.current.isStaged) {
        addButton(MINUS_ICON, t('git.unstageChange'), '#fbbf24', 'rgba(217,119,6,0.22)', () => {
          void runChangeAction(change, 'unstage')
        })
      } else {
        addButton(REVERT_ICON, t('git.revertChange'), '#f87171', 'rgba(239,68,68,0.2)', () => {
          void runChangeAction(change, 'revert')
        })
        addButton(PLUS_ICON, t('git.stageChange'), '#34d399', 'rgba(16,185,129,0.2)', () => {
          void runChangeAction(change, 'stage')
        })
      }

      return {
        getId: () => `git-diff-change-${change.originalStartLineNumber}-${change.modifiedStartLineNumber}-${lane}`,
        getDomNode: () => dom,
        getPosition: () => ({
          lane,
          zIndex: 1,
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        }),
      }
    },
    [runChangeAction, t],
  )

  const refreshWidgets = useCallback(() => {
    const diffEditor = diffEditorRef.current
    if (!diffEditor) return

    for (const { editor, widget } of widgetsRef.current) {
      try {
        editor.removeGlyphMarginWidget(widget)
      } catch {
        /* already gone */
      }
    }
    widgetsRef.current = []

    const { parsed: parsedNow, untracked: untrackedNow } = stateRef.current
    // Untracked files have no index/HEAD side to patch against — whole-file
    // actions only (the header covers them).
    if (untrackedNow || !parsedNow) return

    const changes = diffEditor.getLineChanges() ?? []
    changes.forEach((change, i) => {
      // Alternate lanes so adjacent changes on the same line don't overlap.
      const lane = i % 2 === 0 ? monaco.editor.GlyphMarginLane.Center : monaco.editor.GlyphMarginLane.Right

      if (change.originalStartLineNumber > 0) {
        const editor = diffEditor.getOriginalEditor()
        const widget = makeWidget(change, change.originalStartLineNumber, lane)
        editor.addGlyphMarginWidget(widget)
        widgetsRef.current.push({ editor, widget })
      }
      if (change.modifiedStartLineNumber > 0) {
        const editor = diffEditor.getModifiedEditor()
        const widget = makeWidget(change, change.modifiedStartLineNumber, lane)
        editor.addGlyphMarginWidget(widget)
        widgetsRef.current.push({ editor, widget })
      }
    })
  }, [makeWidget])

  // Coalesce widget rebuilds into one pass per animation frame: a single git
  // action triggers setValue on both models (→ onDidUpdateDiff) plus a parsed /
  // isStaged state change (→ the effect below), each of which used to tear down
  // and recreate every gutter widget. With many changes that's hundreds of DOM
  // nodes rebuilt 3× per action. rAF merges them into a single rebuild.
  const widgetRefreshQueuedRef = useRef(false)
  const scheduleWidgetRefresh = useCallback(() => {
    if (widgetRefreshQueuedRef.current) return
    widgetRefreshQueuedRef.current = true
    requestAnimationFrame(() => {
      widgetRefreshQueuedRef.current = false
      refreshWidgets()
    })
  }, [refreshWidgets])

  // ── Monaco diff editor (created once; content syncs below) ────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const isDark = document.documentElement.classList.contains('dark')
    const diffEditor = monaco.editor.createDiffEditor(container, {
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      enableSplitViewResizing: true,
      glyphMargin: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      theme: isDark ? OURCODE_DARK_THEME : OURCODE_LIGHT_THEME,
    })
    const originalModel = monaco.editor.createModel(original, diff.language)
    const modifiedModel = monaco.editor.createModel(modified, diff.language)
    diffEditor.setModel({ original: originalModel, modified: modifiedModel })

    diffEditorRef.current = diffEditor
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel

    // Rebuild the gutter arrows whenever Monaco recomputes the diff (initial
    // computation, content updates, side-by-side ↔ inline toggles).
    const onDiff = diffEditor.onDidUpdateDiff(() => scheduleWidgetRefresh())

    return () => {
      onDiff.dispose()
      for (const { editor, widget } of widgetsRef.current) {
        try {
          editor.removeGlyphMarginWidget(widget)
        } catch {
          /* editor already disposed */
        }
      }
      widgetsRef.current = []
      originalModel.dispose()
      modifiedModel.dispose()
      diffEditor.dispose()
      diffEditorRef.current = null
      originalModelRef.current = null
      modifiedModelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, [])

  // Keep the models in sync with the (possibly refreshed) diff content.
  useEffect(() => {
    originalModelRef.current?.setValue(original)
    modifiedModelRef.current?.setValue(modified)
  }, [original, modified])

  // Side-by-side ↔ inline toggle.
  useEffect(() => {
    diffEditorRef.current?.updateOptions({ renderSideBySide: sideBySide })
  }, [sideBySide])

  // Rebuild arrows when the git state or parsed hunks change.
  useEffect(() => {
    scheduleWidgetRefresh()
  }, [scheduleWidgetRefresh, parsed, isStaged, untracked])

  // ── whole-file actions ────────────────────────────────────────────────────

  const handleRevertAll = useCallback(async () => {
    const { repoFile: file, untracked: untrackedNow, isStaged: stagedNow } = stateRef.current
    if (untrackedNow) return // untracked files have nothing to revert to
    if (!window.confirm(t('git.revertAllConfirm', { file }))) return
    setNotice(null)
    setBusy(true)
    try {
      const args = stagedNow ? ['reset', 'HEAD', '--', file] : ['checkout', '--', file]
      const res = await runGitCommand(args)
      if (!res.success) {
        setNotice(res.error || t('git.applyHunkFailed'))
        return
      }
      await refreshDiff()
    } finally {
      setBusy(false)
    }
  }, [refreshDiff, t])

  const handleStageAll = useCallback(async () => {
    const { repoFile: file, untracked: untrackedNow } = stateRef.current
    setNotice(null)
    setBusy(true)
    try {
      const res = await runGitCommand(['add', '--', file])
      if (!res.success) {
        setNotice(res.error || t('git.applyHunkFailed'))
        return
      }
      // For untracked files `add` makes them tracked — keep the diff open and
      // switch it to the new staged view rather than closing.
      await refreshDiff({ wasUntracked: untrackedNow })
    } finally {
      setBusy(false)
    }
  }, [refreshDiff, t])

  const handleUnstageAll = useCallback(async () => {
    const { repoFile: file } = stateRef.current
    setNotice(null)
    setBusy(true)
    try {
      const res = await runGitCommand(['reset', 'HEAD', '--', file])
      if (!res.success) {
        setNotice(res.error || t('git.applyHunkFailed'))
        return
      }
      await refreshDiff()
    } finally {
      setBusy(false)
    }
  }, [refreshDiff, t])

  const handleOpenFile = useCallback(() => {
    useEditorStore.getState().openFile(diff.path)
  }, [diff.path])

  const badge = untracked ? t('git.untracked') : isStaged ? t('git.staged') : t('git.changes')

  return (
    <div className="h-full flex flex-col">
      {/* Header (VS Code-style diff toolbar) */}
      <div className="flex items-center justify-between px-4 py-2 bg-nova-surface border-b border-nova-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-nova-text-primary font-medium truncate" title={diff.fileName}>
            {diff.fileName}
          </span>
          <span
            className={`text-[10px] font-mono px-1.5 py-px rounded-full shrink-0 border ${
              isStaged
                ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                : untracked
                  ? 'bg-slate-500/15 text-slate-400 border-slate-500/30'
                  : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
            }`}
          >
            {badge}
          </span>
          {parsed && (
            <span className="flex gap-1 text-[10px] font-mono shrink-0">
              <span className="text-green-500 bg-green-500/10 px-1 rounded">+{parsed.added}</span>
              <span className="text-red-500 bg-red-500/10 px-1 rounded">−{parsed.deleted}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleOpenFile}
            className="px-2.5 py-1 text-xs text-nova-text-secondary bg-white/70 dark:bg-white/10 border border-nova-border rounded-md hover:bg-white/90 dark:hover:bg-white/15 transition-colors flex items-center gap-1"
            title={t('git.openFile')}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
              <path d="M14 2v6h6" />
            </svg>
            {t('git.openFile')}
          </button>
          {isStaged ? (
            <button
              onClick={handleUnstageAll}
              disabled={busy}
              className="px-2.5 py-1 text-xs text-nova-text-secondary bg-white/70 dark:bg-white/10 border border-nova-border rounded-md hover:bg-white/90 dark:hover:bg-white/15 transition-colors disabled:opacity-50"
            >
              {t('git.unstageAllShort')}
            </button>
          ) : (
            <button
              onClick={handleStageAll}
              disabled={busy}
              className="px-2.5 py-1 text-xs text-nova-text-secondary bg-white/70 dark:bg-white/10 border border-nova-border rounded-md hover:bg-white/90 dark:hover:bg-white/15 transition-colors disabled:opacity-50"
            >
              {untracked ? t('git.track') : t('git.stageAllShort')}
            </button>
          )}
          {!untracked && (
            <button
              onClick={handleRevertAll}
              disabled={busy}
              className="px-2.5 py-1 text-xs bg-red-500/20 text-red-400 border border-red-500/30 rounded-md hover:bg-red-500/30 transition-colors flex items-center gap-1 disabled:opacity-50"
              title={t('git.revertAllChanges')}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
              {t('git.revertAllChanges')}
            </button>
          )}
          <button
            onClick={() => setSideBySide((v) => !v)}
            className="p-1.5 text-nova-text-muted hover:text-nova-text-primary rounded-md transition-colors"
            title={sideBySide ? t('git.inlineView') : t('git.sideBySideView')}
          >
            {sideBySide ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v18M4 5h16v14H4z" />
              </svg>
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1 text-nova-text-muted hover:text-nova-text-primary rounded transition-colors"
            title={t('common.close')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Notice / error */}
      {notice && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-xs bg-amber-500/15 text-amber-400 border-b border-amber-500/20">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          <span>{notice}</span>
        </div>
      )}

      {untracked && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-xs bg-sky-500/15 text-sky-300 border-b border-sky-500/20">
          <span>📄</span>
          <span>{t('git.untrackedNotice')}</span>
        </div>
      )}

      <div ref={containerRef} className="flex-1" />
    </div>
  )
}
