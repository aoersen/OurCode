import { useRef, useEffect, useCallback, useState } from 'react'
import { monaco } from '@/editor/monacoSetup'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { registerModel, unregisterModel, getModel, getRegisteredPaths, takeLoader, trackLoad, fileUri } from '@/editor/modelRegistry'
import { ensureLanguageService, OURCODE_DARK_THEME, OURCODE_LIGHT_THEME } from '@/editor/monacoSetup'
import { getFileViewMode, type FileViewMode } from '@/editor/fileViews'
import { setPendingVibeReplace } from '@/services/vibeReplace'
import { attachLsp, detachLsp } from '@/services/lsp/lspClient'
import BreadcrumbBar from './BreadcrumbBar'
import DiffView from './DiffView'
import GitDiffEditor from './GitDiffEditor'
import PreviewPane from './PreviewPane'
import type { UserPreferences } from '@/types'
import { useI18n } from '@/i18n/useI18n'
import { t as moduleT } from '@/i18n'

// Files above this size get large-file editor settings (no word wrap / minimap)
const LARGE_FILE_OPTIMIZE_BYTES = 10 * 1024 * 1024

// Store writes of the cursor position are throttled to ~10 Hz — see the
// onDidChangeCursorPosition handler below. BreadcrumbBar's symbol chain rescan
// (up to 2000 lines) and StatusBar's line:col display both subscribe to it.
const CURSOR_STORE_THROTTLE_MS = 100

// Per-file cursor positions live outside the store so cursor movement never
// rebuilds the `openFiles` array (which would re-render every subscriber — the
// tab bar, status bar and the options effect — on every arrow key of a big
// file). Restored when the file becomes active again.
const fileCursors = new Map<string, { line: number; column: number }>()

// Per-file preview layout (editor / split / preview), remembered across tab
// switches — same pattern as fileCursors: module state, not the store.
type PreviewLayout = 'editor' | 'split' | 'preview'
const previewLayouts = new Map<string, PreviewLayout>()

/** Default layout when a file's view mode has no remembered choice. Markdown
 *  opens side-by-side (VS Code style); html/image open straight to the preview
 *  (no split offered). */
function defaultLayoutFor(mode: FileViewMode): PreviewLayout {
  return mode === 'markdown' ? 'split' : 'preview'
}

/**
 * Editor options for a file. Large files get a reduced-feature preset (like VS
 * Code's large-file mode) so scrolling and rendering stay at 60 fps; the
 * heavy interactive features (minimap, folding, hover, suggestions, bracket
 * colorization, semantic highlighting, smooth scrolling) are kept off.
 */
function buildMonacoOptions(
  preferences: UserPreferences,
  large: boolean,
  isDark: boolean,
): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    fontSize: preferences.fontSize,
    fontFamily: preferences.fontFamily,
    tabSize: preferences.tabSize,
    theme: isDark ? OURCODE_DARK_THEME : OURCODE_LIGHT_THEME,
    padding: { top: 8 },
    largeFileOptimizations: true,
    minimap: { enabled: large ? false : preferences.showMinimap },
    wordWrap: large ? 'off' : 'on',
    folding: !large,
    links: !large,
    colorDecorators: !large,
    renderLineHighlight: large ? 'none' : 'all',
    cursorBlinking: large ? 'solid' : 'blink',
    mouseStyle: 'text',
    smoothScrolling: !large,
    scrollBeyondLastLine: false,
    bracketPairColorization: { enabled: !large },
    'semanticHighlighting.enabled': large ? false : 'configuredByTheme',
    guides: { indentation: !large },
    quickSuggestions: large
      ? { other: false, comments: false, strings: false }
      : { other: true, comments: false, strings: false },
    hover: { enabled: !large },
    suggestOnTriggerCharacters: !large,
    wordBasedSuggestions: large ? 'off' : 'currentDocument',
    parameterHints: { enabled: !large },
    stopRenderingLineAfter: 10000,
    matchBrackets: large ? 'never' : 'always',
    occurrencesHighlight: large ? 'off' : 'multiFile',
    selectionHighlight: !large,
    lineDecorationsWidth: large ? 0 : 10,
    unicodeHighlight: {
      ambiguousCharacters: !large,
      invisibleCharacters: !large,
    },
  }
}

// Track all editor instances for theme updates
const editorInstances = new Set<monaco.editor.IStandaloneCodeEditor>()

// Expose primary editor on window for keyboard shortcuts
const updateWindowEditor = () => {
  const editors = Array.from(editorInstances)
  ;(window as any).__monacoEditor = editors[0] || null
}

interface EditorContainerProps {
  panelId: string
}

export default function EditorContainer({ panelId }: EditorContainerProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  const panels = useEditorStore((s) => s.panels)
  const openFiles = useEditorStore((s) => s.openFiles)
  const preferences = useEditorStore((s) => s.preferences)
  const setCursorPosition = useEditorStore((s) => s.setCursorPosition)
  const activeDiff = useEditorStore((s) => s.activeDiff)
  const activePanelId = useEditorStore((s) => s.activePanelId)
  const closeDiff = useEditorStore((s) => s.closeDiff)

  const panel = panels[panelId]
  const activeFilePath = panel?.activeFilePath ?? null
  const activeFile = useEditorStore((s) => s.openFiles.find((f) => f.path === activeFilePath))
  // The file size as a primitive — a selector returning it only re-renders when
  // the size actually changes, never on cursor-move store churn.
  const activeFileSize = useEditorStore((s) => s.openFiles.find((f) => f.path === activeFilePath)?.size)

  const openCommandPalette = useUIStore((s) => s.openCommandPalette)
  const showContextMenu = useUIStore((s) => s.showContextMenu)
  const uiTheme = useUIStore((s) => s.theme)
  const t = useI18n()

  // ── Per-file preview views (html / markdown / image) ──────────────────────
  // Files with a dedicated view mode get an extra preview surface next to (or
  // instead of) the Monaco editor, plus a toolbar to pick the layout. The
  // choice is remembered per path across tab switches. Only markdown supports
  // side-by-side; html/image are either-or (editor or preview).
  const viewMode = activeFilePath ? getFileViewMode(activeFilePath) : 'code'
  const hasPreview = viewMode === 'html' || viewMode === 'markdown' || viewMode === 'image'
  const [layout, setLayoutState] = useState<PreviewLayout>('split')
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    // A stale 'split' (e.g. remembered from a markdown tab) is clamped for
    // non-split modes so the toolbar can never land on a layout it doesn't offer.
    const remembered = previewLayouts.get(activeFilePath ?? '')
    const initial = remembered ?? defaultLayoutFor(viewMode)
    setLayoutState(viewMode === 'html' && initial === 'split' ? 'preview' : initial)
  }, [activeFilePath, viewMode])

  const setLayout = (l: PreviewLayout) => {
    const clamped = viewMode === 'html' && l === 'split' ? 'preview' : l
    setLayoutState(clamped)
    if (activeFilePath) previewLayouts.set(activeFilePath, clamped)
  }

  // Image files have no text to edit — always preview-only. Code files keep
  // the plain Monaco editor (showEditor defaults to true when no preview).
  const showEditor = !hasPreview || (viewMode !== 'image' && layout !== 'preview')
  const showPreview = hasPreview && layout !== 'editor'

  // A Monaco editor hidden via display:none can render a blank frame when it
  // comes back — force a relayout pass after the editor side toggles.
  useEffect(() => {
    if (!hasPreview) return
    const editor = monacoRef.current
    if (!editor) return
    const id = window.requestAnimationFrame(() => editor.layout())
    return () => window.cancelAnimationFrame(id)
  }, [showEditor, hasPreview])

  // Reload open models when a file changes on disk (tool edits / checkpoint reverts)
  useEffect(() => {
    // Per-path debounce: AI tools editing a large file emit several change
    // events in quick succession (one per write step). Without coalescing each
    // event triggers a full readFile → getValue comparison → setValue — an O(n)
    // copy + a Monaco rebuild per step, which froze the editor while an agent
    // edited a large file. Coalesce to at most one reload per path per ~300ms.
    const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()

    const reloadModel = (path: string) => {
      const model = getModel(path)
      if (!model || model.isDisposed()) return
      // Skip files with unsaved edits — reloading would revert whatever the
      // user typed since the snapshot (and reset the cursor). External edits to
      // a CLEAN file still reload as before.
      const openFile = useEditorStore.getState().openFiles.find((f) => f.path === path)
      if (openFile?.isDirty) return

      const existing = reloadTimers.get(path)
      if (existing) clearTimeout(existing)
      reloadTimers.set(path, setTimeout(() => {
        reloadTimers.delete(path)
        // Re-check dirtiness after the debounce window — the user may have
        // started typing while we were waiting, and reloading then would revert
        // their edits.
        const latest = useEditorStore.getState().openFiles.find((f) => f.path === path)
        if (latest?.isDirty) return
        window.electronAPI.readFile(path).then(({ content }) => {
          // Length check short-circuits the O(n) getValue() copy+compare when
          // the edit changed the file size (the common case for tool edits).
          if (!model.isDisposed() && (model.getValueLength() !== content.length || model.getValue() !== content)) {
            model.setValue(content)
          }
        }).catch(() => { /* file may have been deleted */ })
      }, 300))
    }
    const unsubFs = window.electronAPI.onFileChanged((path) => reloadModel(path))
    const onLocal = (e: Event) => reloadModel((e as CustomEvent).detail)
    window.addEventListener('ourcode:file-changed', onLocal)
    return () => {
      unsubFs()
      window.removeEventListener('ourcode:file-changed', onLocal)
      for (const t of reloadTimers.values()) clearTimeout(t)
      reloadTimers.clear()
    }
  }, [])

  // Initialize Monaco
  useEffect(() => {
    if (!editorRef.current) return

    const currentTheme = useUIStore.getState().theme
    const isDark = currentTheme === 'dark' || (currentTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

    // Preset the large-file options up front when the first file is already
    // large, so Monaco doesn't build expensive state before the per-file effect
    // below gets a chance to downgrade the features.
    const state = useEditorStore.getState()
    const currentFile = state.openFiles.find((f) => f.path === state.activeFilePath)
    const largeAtCreate = (currentFile?.size ?? 0) > LARGE_FILE_OPTIMIZE_BYTES

    const editor = monaco.editor.create(
      editorRef.current,
      buildMonacoOptions(preferences, largeAtCreate, isDark),
    )

    monacoRef.current = editor
    editorInstances.add(editor)
    updateWindowEditor()

    // Mark this panel active on focus
    editor.onDidFocusEditorWidget(() => {
      useEditorStore.getState().setActivePanel(panelId)
    })

    // Add command palette shortcut
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => {
      openCommandPalette()
    })

    // Track cursor position changes. The store write is throttled: every arrow
    // key / keystroke fires this handler, and BreadcrumbBar + StatusBar both
    // subscribe to the position (BreadcrumbBar rescans up to 2000 lines on
    // every change). Writing at most ~10 Hz is imperceptible for the status
    // display but removes the per-keystroke scan from the typing path. The
    // per-file cursor map is updated immediately — it's module state (no
    // re-render) and the source of truth when the file is re-activated.
    let cursorStoreTimer: ReturnType<typeof setTimeout> | null = null
    let pendingCursor: { line: number; column: number } | null = null
    const flushCursor = () => {
      cursorStoreTimer = null
      if (pendingCursor) {
        setCursorPosition(pendingCursor)
        pendingCursor = null
      }
    }
    editor.onDidChangeCursorPosition((e) => {
      const state = useEditorStore.getState()
      const panel = state.panels[panelId]
      if (panel?.activeFilePath) {
        const pos = { line: e.position.lineNumber, column: e.position.column }
        fileCursors.set(panel.activeFilePath, pos)
        pendingCursor = pos
        if (cursorStoreTimer === null) {
          cursorStoreTimer = setTimeout(flushCursor, CURSOR_STORE_THROTTLE_MS)
        }
      }
    })

    // Right-click context menu with AI operations
    editor.onContextMenu((e) => {
      const selection = editor.getSelection()
      const selectedText = selection && !selection.isEmpty()
        ? editor.getModel()?.getValueInRange(selection) || ''
        : ''

      const filePath = useEditorStore.getState().panels[panelId]?.activeFilePath || ''
      const fileName = filePath.split(/[/\\]/).pop() || ''
      const ext = fileName.split('.').pop() || ''

      const items = [
        { label: moduleT('editor.cut'), shortcut: 'Ctrl+X', action: () => editor.trigger('keyboard', 'editor.action.clipboardCutAction', null) },
        { label: moduleT('editor.copy'), shortcut: 'Ctrl+C', action: () => editor.trigger('keyboard', 'editor.action.clipboardCopyAction', null) },
        { label: moduleT('editor.paste'), shortcut: 'Ctrl+V', action: () => editor.trigger('keyboard', 'editor.action.clipboardPasteAction', null) },
        { separator: true, label: '' },
        { label: moduleT('editor.fold'), shortcut: 'Ctrl+Shift+[', action: () => editor.trigger('keyboard', 'editor.fold', null) },
        { label: moduleT('editor.unfold'), shortcut: 'Ctrl+Shift+]', action: () => editor.trigger('keyboard', 'editor.unfold', null) },
        { separator: true, label: '' },
        ...(selectedText ? [
          { label: moduleT('editor.aiActions'), disabled: true },
          { label: moduleT('editor.aiExplain'), icon: '🤖', action: () => sendToAI('请解释以下代码的含义和功能：\n\n```' + ext + '\n' + selectedText + '\n```') },
          { label: moduleT('editor.aiRefactor'), icon: '🔧', action: () => sendToAI('请对以下代码提供重构建议，优化其可读性和性能：\n\n```' + ext + '\n' + selectedText + '\n```') },
          { label: moduleT('editor.vibeReplace'), icon: '✨', action: () => vibeReplace(selectedText, ext) },
          { label: moduleT('editor.aiTest'), icon: '🧪', action: () => sendToAI('请为以下代码生成单元测试：\n\n```' + ext + '\n' + selectedText + '\n```') },
          { label: moduleT('editor.aiDocs'), icon: '📝', action: () => sendToAI('请为以下代码生成详细的文档注释（JSDoc/Docstring）：\n\n```' + ext + '\n' + selectedText + '\n```') },
          { label: moduleT('editor.aiFix'), icon: '🩹', action: () => sendToAI('请检查以下代码中的问题并提供修复方案：\n\n```' + ext + '\n' + selectedText + '\n```') },
          { label: moduleT('editor.aiOptimize'), icon: '⚡', action: () => sendToAI('请分析以下代码的性能瓶颈并提供优化方案：\n\n```' + ext + '\n' + selectedText + '\n```') },
          { label: moduleT('editor.aiTranslate'), icon: '🌐', action: () => sendToAI('请将以下代码中的中文注释和字符串翻译为英文：\n\n```' + ext + '\n' + selectedText + '\n```') },
        ] : []),
        ...(selectedText ? [{ separator: true, label: '' }] : []),
        { label: moduleT('editor.commandPalette'), shortcut: 'Ctrl+Shift+P', action: () => openCommandPalette() },
      ]

      showContextMenu(e.event.posx, e.event.posy, items)
    })

    return () => {
      if (cursorStoreTimer !== null) clearTimeout(cursorStoreTimer)
      editorInstances.delete(editor)
      updateWindowEditor()
      editor.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: the editor is created once; option changes go through updateOptions below
  }, [])

  const sendToAI = useCallback((prompt: string) => {
    const chatStore = useChatStore.getState()
    if (!chatStore.activeSessionId) {
      const configStore = useConfigStore.getState()
      if (configStore.activeConfigGroupId) {
        chatStore.createSession(configStore.activeConfigGroupId)
      }
    }
    if (chatStore.activeSessionId) chatStore.sendMessage(chatStore.activeSessionId, prompt)
    useUIStore.getState().toggleChat()
  }, [])

  // Vibe and Replace: stash the selection, focus the chat
  // input, and let the user describe the rewrite. The description + selection
  // are combined on submit (see ChatInput), and the reply's code block can be
  // applied back to the selection via "应用到编辑器".
  const vibeReplace = useCallback((selectedText: string, ext: string) => {
    const filePath = useEditorStore.getState().panels[panelId]?.activeFilePath || ''
    setPendingVibeReplace({ text: selectedText, language: ext, filePath })
    useUIStore.getState().toggleChat()
    setTimeout(() => {
      const input = document.querySelector('textarea[data-ai-input]') as HTMLTextAreaElement | null
      input?.focus()
    }, 300)
  }, [panelId])

  // Revert the diffed file to its pre-AI-edit checkpoint, then open the reverted
  // file in a normal tab (openFile closes the diff view).
  const handleDiffRevert = useCallback(() => {
    const diff = useEditorStore.getState().activeDiff
    if (!diff?.checkpointId) return
    if (!window.confirm(`确定要回退 "${diff.fileName}" 的 AI 改动吗？此操作会恢复到 AI 修改之前的内容。`)) return
    useChatStore.getState().revertCheckpoint(diff.checkpointId)
      .then(() => {
        window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: diff.path }))
        return useEditorStore.getState().openFile(diff.path)
      })
      .catch((error) => console.error('Failed to revert checkpoint:', error))
  }, [])

  // Restore an already-reverted file from the diff view — writes the AI version
  // captured at revert time back to disk, then reopens the file in a normal tab.
  const handleDiffRestore = useCallback(() => {
    const diff = useEditorStore.getState().activeDiff
    if (!diff?.restoreSessionId || !diff?.restorePath) return
    const { restoreSessionId: sessionId, restorePath: path } = diff
    if (!window.confirm(`确定要恢复 "${diff.fileName}" 的 AI 改动吗？此操作会把回退前 AI 写入的版本写回磁盘。`)) return
    useChatStore.getState().restoreRevertedPath(sessionId, path)
      .then((ok) => {
        if (!ok) {
          useUIStore.getState().showNotification('恢复失败：未找到该文件可恢复的改动。', 'error')
          return
        }
        window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: path }))
        return useEditorStore.getState().openFile(path)
      })
      .catch((error) => console.error('Failed to restore reverted file:', error))
  }, [])

  // Keep editor options in sync with preferences and the active file's size
  // (large files get a reduced-feature preset). Depends on the file size as a
  // primitive, not the whole `openFiles` array, so this doesn't re-run on every
  // cursor move while navigating a big file.
  useEffect(() => {
    const large = (activeFileSize ?? 0) > LARGE_FILE_OPTIMIZE_BYTES
    const isDark = uiTheme === 'dark' || (uiTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    monacoRef.current?.updateOptions(buildMonacoOptions(preferences, large, isDark))
  }, [preferences, activeFileSize, uiTheme])

  // Update Monaco theme when UI theme changes
  useEffect(() => {
    const isDark = uiTheme === 'dark' || (uiTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    monaco.editor.setTheme(isDark ? OURCODE_DARK_THEME : OURCODE_LIGHT_THEME)
  }, [uiTheme])

  // Create/switch models when the active file changes. The Monaco model is the
  // source of truth for the text; editing only marks the file dirty (no full
  // document copy into the store per keystroke), and save/revert/AI context read
  // the live content through the model registry. Deps are just the active path so
  // this never re-runs on keystrokes — even for multi-megabyte files.
  useEffect(() => {
    const editor = monacoRef.current
    if (!editor || !activeFilePath) {
      if (monacoRef.current) {
        monacoRef.current.setModel(null)
      }
      return
    }

    let cancelled = false
    void (async () => {
      const state = useEditorStore.getState()
      const file = state.openFiles.find((f) => f.path === activeFilePath)
      if (!file) return

      // The TypeScript service is loaded lazily; the contribution must be
      // registered before the model is created or Monaco degrades to plaintext.
      await ensureLanguageService(file.language)
      // The user may have switched tabs while the service loaded
      if (cancelled) return
      if (activeFilePath !== useEditorStore.getState().panels[panelId]?.activeFilePath) return

      let model = getModel(activeFilePath)

      if (!model) {
        const uri = fileUri(activeFilePath)
        // Start empty; a registered stream loader fills it chunk by chunk so large
        // files load without freezing the UI. Large files are plain text (no
        // syntax highlighting) — see PLAINTEXT_THRESHOLD_BYTES.
        model = monaco.editor.createModel('', file.plainText ? 'plaintext' : file.language, uri)
        registerModel(activeFilePath, model)

        model.onDidChangeContent(() => {
          // Edits applied while the file streams in are programmatic, not user
          // edits — only mark dirty once the load finished
          const current = useEditorStore.getState().openFiles.find((f) => f.path === activeFilePath)
          if (current && !current.isLoading) {
            useEditorStore.getState().markDirty(activeFilePath, true)
          }
        })

        const loader = takeLoader(activeFilePath)
        if (loader) {
          trackLoad(activeFilePath, loader(model))
        }

        // Opt-in language server (LSP): spawn for configured languages
        attachLsp(activeFilePath, file.language, model)
      }

      editor.setModel(model)

      const cursor = fileCursors.get(activeFilePath) ?? file.cursorPosition
      if (cursor) {
        editor.setPosition({
          lineNumber: cursor.line,
          column: cursor.column,
        })
        editor.revealLineInCenter(cursor.line)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeFilePath, panelId])

  // Cleanup models for closed files
  useEffect(() => {
    const openPaths = new Set(useEditorStore.getState().openFiles.map((f) => f.path))

    for (const path of getRegisteredPaths()) {
      if (!openPaths.has(path)) {
        detachLsp(path)
        getModel(path)?.dispose()
        unregisterModel(path)
      }
    }
  }, [openFiles])

  // The editor div is always mounted so the Monaco editor initializes once, even
  // when no file is open yet (previously the empty state replaced the div, the
  // one-time init effect saw `editorRef.current === null`, and the editor was
  // never created — every file then opened into a blank pane).

  // Diff mode: an AI-edit diff is overlaid on the ACTIVE panel's editor (VS
  // Code "Open Changes"). The overlay — not an early return — keeps the Monaco
  // editor's DOM attached underneath, so closing the diff restores the plain
  // editor without a re-init glitch. Navigating to any file/panel closes the
  // diff (see the store's navigation actions).
  const diffMode = activeDiff && panelId === activePanelId

  return (
    <div className="flex-1 h-full min-h-0 flex flex-col">
      {!diffMode && activeFile?.plainText && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs bg-sky-500/15 text-sky-300 border-b border-sky-500/20">
          <span>📄</span>
          <span>
            {t('editor.largeFileMode', { mb: formatMB(activeFile.size) })}
          </span>
        </div>
      )}
      {!diffMode && <BreadcrumbBar />}
      {!diffMode && hasPreview && viewMode !== 'image' && (
        <PreviewToolbar
          mode={viewMode as 'html' | 'markdown'}
          layout={layout}
          onLayout={setLayout}
          onRefresh={() => setRefreshToken((v) => v + 1)}
        />
      )}
      <div className="relative flex-1 min-h-0 flex">
        <div className={`relative min-w-0 flex-1 ${showEditor ? '' : 'hidden'}`}>
          <div ref={editorRef} className="absolute inset-0" />
          {!diffMode && activeFile?.isLoading && (activeFile.size ?? 0) > 1024 * 1024 && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-nova-bg/70 pointer-events-none">
              <div className="w-8 h-8 rounded-full border-2 border-nova-accent border-t-transparent animate-spin" />
              <div className="text-sm text-nova-text-secondary">
                {t('editor.loadingFile', { percent: activeFile.loadProgress ?? 0 })}
              </div>
              <div className="w-48 h-1 bg-nova-hover rounded-full overflow-hidden">
                <div
                  className="h-full bg-nova-accent rounded-full transition-all duration-150"
                  style={{ width: `${activeFile.loadProgress ?? 0}%` }}
                />
              </div>
            </div>
          )}
        </div>
        {showPreview && (
          <div className="relative min-w-0 flex-1 border-l border-nova-border">
            <PreviewPane
              key={activeFilePath ?? ''}
              path={activeFilePath ?? ''}
              mode={viewMode}
              refreshToken={refreshToken}
            />
          </div>
        )}
        {diffMode && activeDiff && (
          <div className="absolute inset-0 z-20 bg-nova-bg">
            {activeDiff.kind === 'git' ? (
              <GitDiffEditor diff={activeDiff} onClose={closeDiff} />
            ) : (
              <DiffView
                original={activeDiff.original}
                modified={activeDiff.modified}
                language={activeDiff.language}
                title={activeDiff.fileName}
                notice={activeDiff.notice}
                filePath={activeDiff.path}
                onClose={closeDiff}
                onRevert={activeDiff.checkpointId ? handleDiffRevert : undefined}
                onRestore={activeDiff.restoreSessionId && activeDiff.restorePath ? handleDiffRestore : undefined}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Format a byte count as an MB integer for the preview banner. */
function formatMB(bytes: number | undefined): number {
  return Math.round((bytes ?? 0) / (1024 * 1024))
}

/** Toolbar above the editor for preview-capable files: pick the layout and,
 *  for HTML, manually refresh the iframe. Only markdown offers side-by-side —
 *  html is either editor or preview (no split). */
function PreviewToolbar({
  mode,
  layout,
  onLayout,
  onRefresh,
}: {
  mode: 'html' | 'markdown'
  layout: PreviewLayout
  onLayout: (l: PreviewLayout) => void
  onRefresh: () => void
}) {
  const t = useI18n()
  const segments: Array<{ value: PreviewLayout; label: string }> = mode === 'html'
    ? [
        { value: 'editor', label: t('preview.edit') },
        { value: 'preview', label: t('preview.preview') },
      ]
    : [
        { value: 'editor', label: t('preview.edit') },
        { value: 'split', label: t('preview.split') },
        { value: 'preview', label: t('preview.preview') },
      ]

  return (
    <div data-testid="preview-toolbar" className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-nova-border bg-nova-bg/60">
      <div className="flex items-center rounded-md overflow-hidden border border-nova-border divide-x divide-nova-border">
        {segments.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => onLayout(value)}
            className={`px-2.5 py-1 text-xs transition-colors ${
              layout === value
                ? 'bg-nova-accent/20 text-nova-accent font-medium'
                : 'text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'html' && (
        <button
          onClick={onRefresh}
          title={t('preview.refreshHint')}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
        >
          <span aria-hidden>↻</span>
          {t('preview.refresh')}
        </button>
      )}
      <span className="ml-auto text-[11px] text-nova-text-muted hidden sm:block">
        {t('preview.liveHint')}
      </span>
    </div>
  )
}
