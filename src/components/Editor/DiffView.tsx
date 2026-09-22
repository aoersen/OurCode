import { useCallback, useEffect, useRef, useState } from 'react'
import { monaco, OURCODE_DARK_THEME, OURCODE_LIGHT_THEME } from '@/editor/monacoSetup'
import { getModel } from '@/editor/modelRegistry'
import { useEditorStore } from '@/stores/editorStore'
import { useI18n } from '@/i18n/useI18n'
import { acceptChangeEdit, findChangeIndex, normalizeChanges, rejectChangeEdit } from '@/utils/diffReview'

interface DiffViewProps {
  original: string
  modified: string
  language: string
  onClose: () => void
  /** Header title — defaults to the generic diff label. Pass the file name for
   *  the central-editor diff view. */
  title?: string
  /** When provided, renders a "revert this change" button in the header. */
  onRevert?: () => void
  /** 已回退文件的「恢复」入口 —— 把回退前 AI 写入的版本写回磁盘。 */
  onRestore?: () => void
  /** Optional banner above the editor (e.g. "no pre-edit snapshot found"). */
  notice?: string
  /** Absolute path of the file under review. Enables per-change 接受/拒绝 arrows:
   *  the AI edit is already on disk, so a block is kept (accepted) or its
   *  pre-edit lines are written back (rejected). Omitted for read-only diffs. */
  filePath?: string
}

const ACCEPT_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" stroke-linejoin="round"><path d="M4 13l5 5L20 6"/></svg>'
const REJECT_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'

/**
 * VS Code-style "Open Changes" view for an AI edit: left = the checkpoint's
 * pre-edit snapshot, right = the file as it is now.
 *
 * Reviewing happens one block at a time. Accepting folds the current lines into
 * the snapshot, so that block stops showing as a difference (the file already
 * has the content — nothing to write). Rejecting splices the snapshot's lines
 * back into the current document and persists it. Both are the same line
 * splice (`@/utils/diffReview`), just in opposite directions.
 */
export default function DiffView({ original, modified, language, onClose, title, onRevert, onRestore, notice, filePath }: DiffViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const widgetsRef = useRef<{ editor: monaco.editor.IStandaloneCodeEditor; widget: monaco.editor.IGlyphMarginWidget }[]>([])
  const t = useI18n()

  // Review state: `baseline` is the snapshot with the accepted blocks folded in,
  // `current` the file with the rejected ones restored.
  const [baseline, setBaseline] = useState(original)
  const [current, setCurrent] = useState(modified)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)

  const reviewEnabled = !!filePath

  // Latest props for the gutter callbacks — widgets are rebuilt on every diff
  // update, and a click must never read a stale render scope.
  const stateRef = useRef({ filePath })
  useEffect(() => {
    stateRef.current = { filePath }
  }, [filePath])

  // Adopt the sides the parent hands us (reopen, external reload).
  useEffect(() => setBaseline(original), [original])
  useEffect(() => setCurrent(modified), [modified])

  /**
   * Resolve the spans for a change at click time. The diff has been recomputed
   * since the widget was created and line numbers shift after every accept or
   * reject, so the captured Monaco change object is looked up in the *current*
   * list rather than used as-is.
   */
  const spansFor = useCallback((target: monaco.editor.ILineChange) => {
    const diffEditor = editorRef.current
    const originalModel = originalModelRef.current
    const modifiedModel = modifiedModelRef.current
    if (!diffEditor || !originalModel || !modifiedModel) return null
    const changes = diffEditor.getLineChanges() ?? []
    const index = findChangeIndex(changes, target)
    if (index === -1) return null
    return normalizeChanges(changes, originalModel.getLineCount(), modifiedModel.getLineCount())[index] ?? null
  }, [])

  const acceptChange = useCallback(
    (change: monaco.editor.ILineChange) => {
      const originalModel = originalModelRef.current
      const modifiedModel = modifiedModelRef.current
      const spans = spansFor(change)
      if (!originalModel || !modifiedModel || !spans) return
      const eol = originalModel.getEOL()
      const edit = acceptChangeEdit(spans, originalModel.getLinesContent(), modifiedModel.getLinesContent(), eol)
      if (edit) setBaseline(edit.nextLines.join(eol))
    },
    [spansFor]
  )

  const rejectChange = useCallback(
    async (change: monaco.editor.ILineChange) => {
      const path = stateRef.current.filePath
      const originalModel = originalModelRef.current
      const modifiedModel = modifiedModelRef.current
      const spans = spansFor(change)
      if (!path || !originalModel || !modifiedModel || !spans) return
      const eol = modifiedModel.getEOL()
      const edit = rejectChangeEdit(spans, originalModel.getLinesContent(), modifiedModel.getLinesContent(), eol)
      if (!edit) return
      const text = edit.nextLines.join(eol)

      setReviewError(null)
      setBusy(true)
      try {
        const failure = await writeReviewedFile(path, text, edit, t('editor.diffBufferDirty'), t('editor.diffWriteFailed'))
        if (failure) {
          setReviewError(failure)
          return
        }
        setCurrent(text)
      } finally {
        setBusy(false)
      }
    },
    [spansFor, t]
  )

  // ── Gutter action widgets ─────────────────────────────────────────────────

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

      addButton(ACCEPT_ICON, t('editor.acceptChange'), '#34d399', 'rgba(16,185,129,0.2)', () => {
        if (!busy) acceptChange(change)
      })
      addButton(REJECT_ICON, t('editor.rejectChange'), '#f87171', 'rgba(239,68,68,0.2)', () => {
        if (!busy) void rejectChange(change)
      })

      return {
        getId: () => `diff-review-${change.originalStartLineNumber}-${change.modifiedStartLineNumber}-${lineNumber}-${lane}`,
        getDomNode: () => dom,
        getPosition: () => ({ lane, zIndex: 1, range: new monaco.Range(lineNumber, 1, lineNumber, 1) }),
      }
    },
    [acceptChange, busy, rejectChange, t]
  )

  const refreshWidgets = useCallback(() => {
    const diffEditor = editorRef.current
    for (const { editor, widget } of widgetsRef.current) {
      try {
        editor.removeGlyphMarginWidget(widget)
      } catch {
        /* already gone */
      }
    }
    widgetsRef.current = []

    const changes = diffEditor?.getLineChanges()
    if (!diffEditor || !changes) {
      setRemaining(changes ? 0 : null)
      return
    }
    setRemaining(changes.length)
    if (!stateRef.current.filePath) return

    const modifiedModel = modifiedModelRef.current
    if (!modifiedModel) return
    // Monaco keeps the snapshot side's glyph-margin widgets hidden inside a diff
    // editor, and a pure deletion has no current-document line to point at
    // (`modifiedStartLineNumber === 0`) — so every block's arrows go on the right
    // side, at the line the change collapses into.
    const normalized = normalizeChanges(changes, originalModelRef.current?.getLineCount() ?? 0, modifiedModel.getLineCount())
    changes.forEach((change, i) => {
      // Alternate lanes so adjacent changes on the same line don't overlap.
      const lane = i % 2 === 0 ? monaco.editor.GlyphMarginLane.Center : monaco.editor.GlyphMarginLane.Right
      const anchor = change.modifiedStartLineNumber || normalized[i]?.modifiedStart || 0
      const lineNumber = Math.min(anchor, modifiedModel.getLineCount())
      if (lineNumber < 1) return
      const editor = diffEditor.getModifiedEditor()
      const widget = makeWidget(change, lineNumber, lane)
      editor.addGlyphMarginWidget(widget)
      widgetsRef.current.push({ editor, widget })
    })
  }, [makeWidget])

  // Coalesce rebuilds into one pass per frame: one accept/reject updates both
  // models (→ onDidUpdateDiff) and the review state, each of which would
  // otherwise tear down and recreate every gutter widget.
  const queuedRef = useRef(false)
  const scheduleWidgetRefresh = useCallback(() => {
    if (queuedRef.current) return
    queuedRef.current = true
    requestAnimationFrame(() => {
      queuedRef.current = false
      refreshWidgets()
    })
  }, [refreshWidgets])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const isDark = document.documentElement.classList.contains('dark')
    const diffEditor = monaco.editor.createDiffEditor(container, {
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      enableSplitViewResizing: true,
      glyphMargin: reviewEnabled,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      theme: isDark ? OURCODE_DARK_THEME : OURCODE_LIGHT_THEME,
    })
    const originalModel = monaco.editor.createModel(baseline, language)
    const modifiedModel = monaco.editor.createModel(current, language)
    diffEditor.setModel({ original: originalModel, modified: modifiedModel })

    editorRef.current = diffEditor
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel

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
      editorRef.current = null
      originalModelRef.current = null
      modifiedModelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; content syncs below
  }, [])

  // Keep the models in sync with the reviewed content.
  useEffect(() => {
    originalModelRef.current?.setValue(baseline)
  }, [baseline])

  useEffect(() => {
    modifiedModelRef.current?.setValue(current)
  }, [current])

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 bg-nova-surface border-b border-nova-border shrink-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-nova-text-primary font-medium truncate" title={title}>
            {title || t('editor.diffTitle')}
          </span>
          {reviewEnabled && remaining !== null && (
            <span className="shrink-0 text-xs text-nova-text-muted">
              {remaining > 0 ? t('editor.changesRemaining', { count: remaining }) : t('editor.changesCleared')}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {onRevert && (
            <button
              onClick={onRevert}
              className="px-2.5 py-1 text-xs bg-red-500/20 text-red-400 border border-red-500/30 rounded-md hover:bg-red-500/30 transition-colors flex items-center gap-1"
              title={t('editor.revertWholeChange')}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
              {t('editor.revertWholeChange')}
            </button>
          )}
          {onRestore && (
            <button
              onClick={onRestore}
              className="px-2.5 py-1 text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-md hover:bg-emerald-500/30 transition-colors flex items-center gap-1"
              title={t('editor.restoreWholeChange')}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 12a8 8 0 1 1-2.3-5.7" />
                <path d="M20 3v6h-6" />
              </svg>
              {t('editor.restoreWholeChange')}
            </button>
          )}
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
      {(notice || reviewError) && (
        <div
          className={`shrink-0 flex items-center gap-2 px-4 py-1.5 text-xs border-b ${
            reviewError
              ? 'bg-red-500/15 text-red-400 border-red-500/20'
              : 'bg-amber-500/15 text-amber-400 border-amber-500/20'
          }`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          <span>{reviewError || notice}</span>
        </div>
      )}
      <div ref={containerRef} className="flex-1" />
    </div>
  )
}

/**
 * Persist a rejected block. When the file is open in an editor its Monaco model
 * is the source of truth, so the same surgical edit is applied there (single
 * undo step, cursor preserved) and saved; a buffer with unsaved user edits is
 * refused rather than silently overwritten. Files that aren't open keep their
 * detected encoding and BOM.
 */
async function writeReviewedFile(
  path: string,
  text: string,
  edit: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string },
  dirtyMessage: string,
  failureMessage: string
): Promise<string | null> {
  const store = useEditorStore.getState()
  const open = store.openFiles.find((f) => f.path === path)
  if (open?.isDirty) return dirtyMessage
  try {
    const model = getModel(path)
    if (open) {
      if (model) {
        model.applyEdits([
          {
            range: new monaco.Range(edit.range.startLineNumber, edit.range.startColumn, edit.range.endLineNumber, edit.range.endColumn),
            text: edit.text,
          },
        ])
      }
      await window.electronAPI.writeFile(path, text, open.encoding, open.hasBom)
      useEditorStore.getState().markDirty(path, false)
    } else {
      const { encoding, hasBom } = await window.electronAPI.readFile(path)
      await window.electronAPI.writeFile(path, text, encoding, hasBom)
    }
    window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: path }))
    return null
  } catch (error) {
    console.error('Failed to write reviewed file:', error)
    return failureMessage
  }
}
