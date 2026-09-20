import { create } from 'zustand'
import { monaco, ensureLanguageService } from '@/editor/monacoSetup'
import { useRecentFilesStore } from '@/stores/recentFilesStore'
import { useUIStore } from '@/stores/uiStore'
import { useUnsavedStore } from '@/stores/unsavedStore'
import { modeKey } from '@/utils/windowMode'
import { OpenFile, UserPreferences, DEFAULT_PREFERENCES, LANGUAGE_MAP } from '@/types'
import {
  getFileContent,
  getModel,
  registerModel,
  unregisterModel,
  registerLoader,
  appendText,
  setModelEol,
  setModelLanguage,
  yieldToEventLoop,
  waitForLoad,
  fileUri,
} from '@/editor/modelRegistry'
import type { FileStreamChunk } from '@shared/types'

// Files larger than this ask for confirmation before opening (they take a lot
// of memory — a few hundred MB of text needs GBs of RAM in the editor model).
const LARGE_FILE_CONFIRM_BYTES = 50 * 1024 * 1024

// Files larger than this are loaded as plain text (no syntax highlighting). The
// tokenizer is what makes a huge file unusable — Monaco also skips tokenization
// for files above its own large-file threshold, so highlighting would be gone
// anyway. Plain text keeps the whole file editable with bounded CPU cost.
export const PLAINTEXT_THRESHOLD_BYTES = 20 * 1024 * 1024

// Files larger than this don't load the full content into the editor model at
// all — Monaco's setValue on a multi-hundred-MB string blocks the renderer for
// seconds and burns gigabytes of RAM. Instead we open a *read-only preview*
// limited to this many characters from the head of the file (≈ a few thousand
// lines), so the user can locate the section they care about and re-open with a
// smaller slice. This matches VS Code's "File is too large to open" behaviour.
export const READONLY_PREVIEW_BYTES = 100 * 1024 * 1024
export const READONLY_PREVIEW_CHARS = 500 * 1024 // ≈ 500 KB / a few thousand lines

// Models larger than this are saved to disk in bounded chunks (streamed write)
// instead of shipping the whole document string over IPC and encoding it in a
// single synchronous pass in the main process.
const STREAMED_SAVE_THRESHOLD = 4 * 1024 * 1024

// Paths with an in-flight save. A large streamed save runs for many seconds,
// so without this set each overlapping saveFile call would start another
// concurrent save of the same file (markDirty(false) only runs when the first
// save finishes). Guarded in saveFile.
const savingFiles = new Set<string>()

/** Display name of a file path (last segment). */
const fileNameOf = (path: string): string => path.split(/[/\\]/).pop() || path

// ── Hot exit (crash-safe unsaved buffers) ──────────────────────────────────
// Dirty buffers are mirrored to <userData>/backups a beat after the last edit
// and deleted on save/close/revert. Files above this size are skipped: backing
// up a multi-hundred-MB model means copying the whole buffer every few seconds,
// exactly what the streaming load/save paths exist to avoid. (VS Code likewise
// refuses to hot-exit extremely large files.)
const HOT_EXIT_BACKUP_MAX_BYTES = 50 * 1024 * 1024
const HOT_EXIT_DEBOUNCE_MS = 1500
const backupTimers = new Map<string, NodeJS.Timeout>()

function clearBackupTimer(path: string): void {
  const t = backupTimers.get(path)
  if (t) {
    clearTimeout(t)
    backupTimers.delete(path)
  }
}

function scheduleHotExitBackup(path: string): void {
  clearBackupTimer(path)
  backupTimers.set(path, setTimeout(() => {
    void performHotExitBackup(path)
  }, HOT_EXIT_DEBOUNCE_MS))
}

async function performHotExitBackup(path: string): Promise<void> {
  backupTimers.delete(path)
  const file = useEditorStore.getState().openFiles.find((f) => f.path === path)
  if (!file || !file.isDirty) return
  if ((file.size ?? 0) > HOT_EXIT_BACKUP_MAX_BYTES) return
  const model = getModel(path)
  if (model && model.getValueLength() > HOT_EXIT_BACKUP_MAX_BYTES) return
  try {
    const content = getFileContent(path, file.content)
    await window.electronAPI.saveBackup(path, content, file.encoding, file.hasBom)
  } catch {
    // Backups are best-effort — a failed write must never break typing/saving
  }
}

async function clearHotExitBackup(path: string): Promise<void> {
  clearBackupTimer(path)
  try {
    await window.electronAPI.deleteBackup(path)
  } catch {
    /* best-effort */
  }
}

export interface Panel {
  id: string
  tabOrder: string[]
  activeFilePath: string | null
}

/** A file's AI-edit diff shown in the central editor area (VS Code-style
 *  "Open Changes"). Rendered instead of the Monaco editor of the active panel. */
export interface ActiveDiff {
  /** Absolute path of the modified file (used for revert + re-open). */
  path: string
  fileName: string
  /** Pre-edit snapshot from the checkpoint — '' means the file didn't exist. */
  original: string
  /** Current file content on disk. */
  modified: string
  language: string
  /** 'checkpoint' = AI-edit diff; 'git' = source-control diff (VS Code style). */
  kind: 'checkpoint' | 'git'
  checkpointId?: string
  /** 已回退文件的恢复入口：会话 id + 文件路径 —— 差异视图右上角渲染「恢复」
   *  按钮，把回退前 AI 写入的版本写回磁盘。 */
  restoreSessionId?: string
  restorePath?: string
  /** Optional banner above the diff (e.g. no pre-edit snapshot found). */
  notice?: string
  /** Git diff extras — set when kind === 'git'. */
  git?: {
    /** Repo-relative path used in git commands (as reported by `git status`). */
    repoFile: string
    /** True when comparing HEAD vs index (staged); false = index vs worktree. */
    staged: boolean
    /** True for untracked files (no left side, whole-file actions only). */
    untracked?: boolean
    /** Raw `git diff [--cached]` text for this file (parsed for hunk patches). */
    diffText: string
    /** Set for history diffs (kind === 'git'): the commit whose version of the
     *  file is shown (read-only, no gutter actions). */
    commitHash?: string
  }
}

interface EditorState {
  // Panel model
  panels: Record<string, Panel>
  panelOrder: string[]
  activePanelId: string
  splitDirection: 'horizontal' | 'vertical'
  splitRatios: number[] // one ratio per boundary

  // Global file content (shared across panels)
  openFiles: OpenFile[]
  preferences: UserPreferences

  // Diff shown in place of the active panel's editor (null = normal editing)
  activeDiff: ActiveDiff | null

  // Backward-compatible: derived from active panel
  activeFilePath: string | null
  tabOrder: string[]
  cursorPosition: { line: number; column: number } | null

  // Actions
  setCursorPosition: (pos: { line: number; column: number }) => void
  loadPreferences: () => Promise<void>
  savePreferences: (prefs: Partial<UserPreferences>) => Promise<void>
  updatePreferences: (prefs: Partial<UserPreferences>) => void

  // Panel actions
  setActivePanel: (panelId: string) => void
  splitPanel: (direction: 'horizontal' | 'vertical') => void
  closePanel: (panelId: string) => void
  resizeSplit: (index: number, ratio: number) => void
  cyclePanelFocus: () => void

  // Diff mode
  openDiff: (diff: ActiveDiff) => void
  closeDiff: () => void

  // File actions (panel-aware)
  openFile: (path: string, panelId?: string) => Promise<void>
  closeFile: (path: string, panelId?: string) => void
  closeFileGlobally: (path: string) => void
  /** Close a file, prompting to save when it's dirty. `panelId` scopes the
   *  close to one panel; omit to close the file everywhere. Returns true when
   *  the file was (or is now) closed — false when the user cancelled or the
   *  save failed. */
  closeFileWithConfirm: (path: string, panelId?: string) => Promise<boolean>
  /** Close a panel and all its tabs — clean files close immediately, dirty
   *  ones prompt one at a time. Returns true when the panel was closed. */
  closePanelWithConfirm: (panelId: string) => Promise<boolean>
  /** Close the WHOLE editor area: every tab across all panels (dirty files
   *  prompt one at a time), clear the persisted session, then hide the editor.
   *  The next time the editor area is opened it starts empty — no carried-over
   *  files. Returns true when the area was closed; false when the user
   *  cancelled a dirty-file prompt (nothing changes in that case). */
  closeEditorArea: () => Promise<boolean>
  setActiveFile: (path: string, panelId?: string) => void
  newFile: () => string
  reorderTabs: (fromIndex: number, toIndex: number, panelId?: string) => void
  moveTabToPanel: (path: string, fromPanelId: string, toPanelId: string, insertIndex?: number) => void
  /** Save a file to disk. Resolves with the path that was saved — the original
   *  path for a normal save, the new path after an untitled Save As, or null
   *  when nothing was written (Save As cancelled, save failed, already saving,
   *  file not found). */
  saveFile: (path: string) => Promise<string | null>
  saveAll: () => Promise<void>
  markDirty: (path: string, isDirty?: boolean) => void
  setFileEncoding: (path: string, encoding: string) => void
  revertFile: (path: string) => Promise<void>
  updateFileContent: (path: string, content: string) => void
  restoreFromBackup: (filePath: string, content: string, encoding: string, hasBom: boolean) => Promise<void>

  /** Re-open the tabs that were open when the app last closed (VS Code-style
   *  session restore). Called once at startup after the project is restored. */
  restoreSession: () => Promise<void>

  getActiveFile: () => OpenFile | undefined
  getLanguageByPath: (path: string) => string
}

let panelCounter = 0
const createPanelId = () => `panel-${++panelCounter}`

const syncDerivedState = (s: EditorState) => {
  const panel = s.panels[s.activePanelId]
  return {
    activeFilePath: panel?.activeFilePath ?? null,
    tabOrder: panel?.tabOrder ?? [],
  }
}

// ── Session restore (VS Code-style tab persistence) ─────────────────────────
// The open-tab / panel layout is mirrored to localStorage (debounced) so the
// next launch can re-open the same files. Only the tab STRUCTURE is saved —
// file contents are re-read from disk (or hot-exit backups) on restore.
// 按窗口模式区分 key —— 一人公司窗口与对话窗口各自恢复各自的打开标签。
const SESSION_STORAGE_KEY = modeKey('ourcode.editorSession.v1')
const SESSION_WRITE_DEBOUNCE_MS = 400

interface SessionSnapshot {
  panels: Record<string, Panel>
  panelOrder: string[]
  activePanelId: string
  splitDirection: 'horizontal' | 'vertical'
  splitRatios: number[]
}

/** Serializable tab/panel layout — the ONLY thing session persistence tracks.
 *  Content churn (cursor moves, isDirty, streaming progress) never enters it. */
const snapshotOf = (s: EditorState): string => JSON.stringify({
  panels: s.panels,
  panelOrder: s.panelOrder,
  activePanelId: s.activePanelId,
  splitDirection: s.splitDirection,
  splitRatios: s.splitRatios,
})

function loadSessionSnapshot(): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SessionSnapshot
    if (!parsed || typeof parsed !== 'object' || !parsed.panels) return null
    return parsed
  } catch {
    return null
  }
}

let sessionWriteTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSessionPersist(): void {
  if (sessionWriteTimer) clearTimeout(sessionWriteTimer)
  sessionWriteTimer = setTimeout(() => {
    sessionWriteTimer = null
    // Read the freshest state at write time (never a captured snapshot) so a
    // burst of tab changes always lands on the final layout.
    try { localStorage.setItem(SESSION_STORAGE_KEY, snapshotOf(useEditorStore.getState())) } catch { /* storage full / unavailable */ }
  }, SESSION_WRITE_DEBOUNCE_MS)
}

// Seeded with the initial (empty) layout and kept in sync by the subscription
// below — see the note next to it.
let lastSessionSnapshot = ''

/**
 * Load a file's content into its model. Chunks are pulled over IPC in 8 MB
 * batches (a big file used to cost one round-trip per 1 MB chunk), yielding
 * between batches so the UI stays responsive, then applied with a single
 * `model.setValue` — Monaco builds the buffer in one optimized pass, which is
 * dramatically faster and less memory-fragmented than thousands of incremental
 * appends. This is the same strategy as VS Code.
 */
async function streamFileIntoModel(path: string, model: monaco.editor.ITextModel): Promise<void> {
  let streamId: number | null = null
  try {
    const stream = await window.electronAPI.openFileStream(path)
    streamId = stream.id

    // Large files get a heads-up — loading them fully takes a lot of memory
    if (stream.totalBytes > LARGE_FILE_CONFIRM_BYTES) {
      const mb = Math.round(stream.totalBytes / (1024 * 1024))
      const message = `此文件较大（约 ${mb} MB）。将以纯文本模式打开（无语法高亮）并完整加载，可能占用较多内存，确定打开吗？`
      if (!window.confirm(message)) {
        await window.electronAPI.closeFileStream(stream.id)
        useEditorStore.getState().closeFileGlobally(path)
        return
      }
    }

    // Above the threshold the file opens as plain text — the whole point of the
    // mode is to keep it editable without paying tokenization cost. Switch the
    // model language now (it was created before the size was known).
    const plainText = stream.totalBytes > PLAINTEXT_THRESHOLD_BYTES
    if (plainText) {
      setModelLanguage(model, 'plaintext')
    }
    const lineEnding = stream.chunk.includes('\r\n') ? 'crlf' : 'lf'
    useEditorStore.setState((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path
          ? {
              ...f,
              encoding: stream.encoding,
              hasBom: stream.hasBom,
              size: stream.totalBytes,
              lineEnding,
              plainText,
            }
          : f,
      ),
    }))

    // Pull chunks in 8 MB batches — a big file used to cost one IPC round-trip
    // per 1 MB chunk (~800 for an 800 MB file); batching cuts that ~8x. Group
    // them so no single string exceeds V8's ~536M-char limit for two-byte
    // strings, then apply the groups in as few operations as possible: the
    // first via setValue (one optimized buffer build, like VS Code) and the
    // rest by appending. Fewer, larger operations are dramatically faster than
    // many incremental appends on a growing model. Yielding every few batches
    // keeps the window responsive (spinner, tab switching) while loading.
    const READ_BATCH_BYTES = 8 * 1024 * 1024
    const YIELD_EVERY_BATCHES = 4
    const MAX_JOIN_CHARS = 400 * 1024 * 1024
    const groups: string[][] = [[stream.chunk]]
    let groupChars = stream.chunk.length
    let batchCount = 0
    // Progress for the loading overlay: approximate the raw bytes pulled (each
    // batch asks for READ_BATCH_BYTES), capped at 99 so the UI never shows 100%
    // while the final buffer build (`setValue`) is still pending.
    let bytesRead = stream.chunk.length
    for (;;) {
      // Cancel if the model was disposed (file closed globally) mid-load
      if (getModel(path) !== model) {
        await window.electronAPI.closeFileStream(stream.id)
        return
      }
      const res: FileStreamChunk[] | null = await window.electronAPI.readFileChunkBatch(stream.id, READ_BATCH_BYTES)
      if (!res || res.length === 0) break
      bytesRead += READ_BATCH_BYTES
      const progress = Math.min(99, Math.round((bytesRead / stream.totalBytes) * 100))
      useEditorStore.setState((s) => ({
        openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, loadProgress: progress } : f)),
      }))
      let done = false
      for (const chunkRes of res) {
        const chunk = chunkRes.chunk
        if (groupChars + chunk.length > MAX_JOIN_CHARS) {
          groups.push([chunk])
          groupChars = chunk.length
        } else {
          groups[groups.length - 1].push(chunk)
          groupChars += chunk.length
        }
        if (chunkRes.done) {
          done = true
          break
        }
      }
      if (done) break
      if (++batchCount % YIELD_EVERY_BATCHES === 0) await yieldToEventLoop()
    }
    streamId = null

    setModelEol(model, lineEnding)
    model.setValue(groups[0].join(''))
    for (let i = 1; i < groups.length; i++) {
      appendText(model, groups[i].join(''))
    }
  } catch (error) {
    console.error('Failed to stream file:', error)
    if (streamId !== null) {
      await window.electronAPI.closeFileStream(streamId).catch(() => {})
    }
  } finally {
    // Mark loaded even on failure so the editor stays usable
    useEditorStore.setState((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, isLoading: false, isDirty: false } : f,
      ),
    }))
  }
}

/**
 * Save a model to disk in bounded chunks. Bounded IPC payloads keep the
 * renderer responsive and avoid one giant encode pass in the main process;
 * `openWriteStream`/`closeWriteStream` retain the atomic temp-file + rename
 * semantics of `writeFile`.
 */
async function streamSaveModel(
  path: string,
  model: monaco.editor.ITextModel,
  encoding: string,
  hasBom: boolean | undefined,
): Promise<void> {
  const id = await window.electronAPI.openWriteStream(path, encoding, hasBom)
  const totalLength = model.getValueLength()
  const CHUNK = 4 * 1024 * 1024
  try {
    for (let offset = 0; offset < totalLength; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, totalLength)
      const startPos = model.getPositionAt(offset)
      const endPos = model.getPositionAt(end)
      const text = model.getValueInRange({
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
      })
      await window.electronAPI.writeChunk(id, text)
    }
  } catch (error) {
    await window.electronAPI.abortWriteStream(id).catch(() => {})
    throw error
  }
  await window.electronAPI.closeWriteStream(id)
}

const initialPanelId = createPanelId()

export const useEditorStore = create<EditorState>((set, get) => ({
  // Panel state
  panels: {
    [initialPanelId]: { id: initialPanelId, tabOrder: [], activeFilePath: null },
  },
  panelOrder: [initialPanelId],
  activePanelId: initialPanelId,
  splitDirection: 'horizontal',
  splitRatios: [],

  // Global
  openFiles: [],
  preferences: DEFAULT_PREFERENCES,
  activeDiff: null,

  // Derived
  activeFilePath: null,
  tabOrder: [],
  cursorPosition: null,

  setCursorPosition: (pos) => set({ cursorPosition: pos }),

  loadPreferences: async () => {
    try {
      const prefs = await window.electronAPI.getPreferences()
      set({ preferences: { ...DEFAULT_PREFERENCES, ...prefs } })
    } catch (error) {
      console.error('Failed to load preferences:', error)
    }
  },

  savePreferences: async (prefs) => {
    const newPrefs = { ...get().preferences, ...prefs }
    await window.electronAPI.savePreferences(newPrefs)
    set({ preferences: newPrefs })
  },

  updatePreferences: (prefs) => {
    set((s) => ({ preferences: { ...s.preferences, ...prefs } }))
  },

  // --- Panel actions ---

  setActivePanel: (panelId) => {
    get().closeDiff()
    set((s) => {
      if (!s.panels[panelId]) return s
      const next = { ...s, activePanelId: panelId }
      return { ...next, ...syncDerivedState(next) }
    })
  },

  splitPanel: (direction) => {
    set((s) => {
      if (s.panelOrder.length >= 4) return s
      const newPanelId = createPanelId()
      const newPanel: Panel = { id: newPanelId, tabOrder: [], activeFilePath: null }
      const newPanels = { ...s.panels, [newPanelId]: newPanel }
      const newPanelOrder = [...s.panelOrder, newPanelId]
      const newRatios = s.splitRatios.length === 0
        ? [0.5]
        : [...s.splitRatios, 0.5]

      const next = {
        ...s,
        panels: newPanels,
        panelOrder: newPanelOrder,
        activePanelId: newPanelId,
        splitDirection: direction,
        splitRatios: newRatios,
      }
      return { ...next, ...syncDerivedState(next) }
    })
  },

  closePanel: (panelId) => {
    get().closeDiff()
    set((s) => {
      if (s.panelOrder.length <= 1) return s

      const closingPanel = s.panels[panelId]
      if (!closingPanel) return s

      // Move tabs from closing panel to the nearest remaining panel
      const remainingIds = s.panelOrder.filter((id) => id !== panelId)
      const targetId = remainingIds[0]
      const targetPanel = s.panels[targetId]

      const newTargetPanel: Panel = {
        ...targetPanel,
        tabOrder: [...targetPanel.tabOrder, ...closingPanel.tabOrder.filter((p) => !targetPanel.tabOrder.includes(p))],
        activeFilePath: targetPanel.activeFilePath || closingPanel.activeFilePath,
      }

      const newPanels = { ...s.panels, [targetId]: newTargetPanel }
      delete newPanels[panelId]

      const newPanelOrder = remainingIds
      const newActivePanelId = s.activePanelId === panelId ? targetId : s.activePanelId
      // Remove one ratio (keep ratios proportional to boundaries)
      const newRatios = s.splitRatios.slice(0, Math.max(0, newPanelOrder.length - 1))
      // Rebalance ratios
      if (newRatios.length > 0) {
        const total = newRatios.reduce((a, b) => a + b, 0)
        if (total > 0) {
          for (let i = 0; i < newRatios.length; i++) {
            newRatios[i] = newRatios[i] / total
          }
        }
      }

      const next = {
        ...s,
        panels: newPanels,
        panelOrder: newPanelOrder,
        activePanelId: newActivePanelId,
        splitRatios: newRatios,
      }
      return { ...next, ...syncDerivedState(next) }
    })
  },

  resizeSplit: (index, ratio) => {
    set((s) => {
      const newRatios = [...s.splitRatios]
      if (index < 0 || index >= newRatios.length) return s
      newRatios[index] = Math.max(0.1, Math.min(0.9, ratio))
      return { splitRatios: newRatios }
    })
  },

  cyclePanelFocus: () => {
    set((s) => {
      if (s.panelOrder.length <= 1) return s
      const idx = s.panelOrder.indexOf(s.activePanelId)
      const nextIdx = (idx + 1) % s.panelOrder.length
      const nextId = s.panelOrder[nextIdx]
      const next = { ...s, activePanelId: nextId }
      return { ...next, ...syncDerivedState(next) }
    })
  },

  // --- Diff mode ---

  /** Show a file's AI-edit diff in the central editor area. Replaces any diff
   *  already open; any subsequent navigation (openFile/tab switch/...) closes it. */
  openDiff: (diff) => {
    // Opening a diff implies the user wants to see the editor — bring it back
    // if it was closed (the ✕ button hides it to focus on the chat panel).
    if (!useUIStore.getState().isEditorVisible) {
      useUIStore.getState().setEditorVisible(true)
    }
    set({ activeDiff: diff })
  },

  closeDiff: () => {
    // Guard: set() with an identical value would re-render subscribers for
    // nothing on every editor focus while no diff is open.
    if (get().activeDiff) set({ activeDiff: null })
  },

  // --- File actions ---

  openFile: async (path, panelId) => {
    const state = get()
    const targetPanelId = panelId || state.activePanelId

    // Opening a file implies the user wants to see the editor — bring it back
    // if it was closed (the ✕ button hides it to focus on the chat panel).
    if (!useUIStore.getState().isEditorVisible) {
      useUIStore.getState().setEditorVisible(true)
    }
    // The user navigated to a real file — leave the diff view
    get().closeDiff()

    // Track the most recently opened file (Ctrl+R list)
    useRecentFilesStore.getState().addRecentFile(path)

    // Check if file content is already loaded
    const existingFile = state.openFiles.find((f) => f.path === path)
    if (existingFile) {
      // Just activate it in the target panel
      set((s) => {
        const panel = s.panels[targetPanelId]
        if (!panel) return s
        const newPanel: Panel = {
          ...panel,
          activeFilePath: path,
          tabOrder: panel.tabOrder.includes(path) ? panel.tabOrder : [...panel.tabOrder, path],
        }
        const next = { ...s, panels: { ...s.panels, [targetPanelId]: newPanel }, activePanelId: targetPanelId }
        return { ...next, ...syncDerivedState(next) }
      })
      return
    }

    // Reserve the tab immediately (content streams in afterwards), then hand the
    // load to the editor's model via a registered loader
    const language = get().getLanguageByPath(path)
    const newFile: OpenFile = {
      path,
      content: '',
      language,
      encoding: 'utf-8',
      lineEnding: 'lf',
      isDirty: false,
      isLoading: true,
    }

    set((s) => {
      const panel = s.panels[targetPanelId]
      if (!panel) return s
      const newPanel: Panel = {
        ...panel,
        activeFilePath: path,
        tabOrder: panel.tabOrder.includes(path) ? panel.tabOrder : [...panel.tabOrder, path],
      }
      const next = {
        ...s,
        openFiles: [...s.openFiles, newFile],
        panels: { ...s.panels, [targetPanelId]: newPanel },
        activePanelId: targetPanelId,
      }
      return { ...next, ...syncDerivedState(next) }
    })

    registerLoader(path, (model) => streamFileIntoModel(path, model))
  },

  closeFile: (path, panelId) => {
    get().closeDiff()
    set((s) => {
      const targetPanelId = panelId || s.activePanelId
      const panel = s.panels[targetPanelId]
      if (!panel) return s

      const newTabOrder = panel.tabOrder.filter((p) => p !== path)
      const newActivePath = panel.activeFilePath === path
        ? newTabOrder[newTabOrder.length - 1] || null
        : panel.activeFilePath

      const newPanel: Panel = { ...panel, tabOrder: newTabOrder, activeFilePath: newActivePath }
      const next = { ...s, panels: { ...s.panels, [targetPanelId]: newPanel } }
      return { ...next, ...syncDerivedState(next) }
    })
  },

  closeFileGlobally: (path) => {
    set((s) => {
      // Remove from openFiles
      const newOpenFiles = s.openFiles.filter((f) => f.path !== path)

      // Remove from all panels
      const newPanels = { ...s.panels }
      for (const pid of Object.keys(newPanels)) {
        const p = newPanels[pid]
        if (p.tabOrder.includes(path)) {
          const newTabOrder = p.tabOrder.filter((tp) => tp !== path)
          const newActivePath = p.activeFilePath === path
            ? newTabOrder[newTabOrder.length - 1] || null
            : p.activeFilePath
          newPanels[pid] = { ...p, tabOrder: newTabOrder, activeFilePath: newActivePath }
        }
      }

      const next = { ...s, openFiles: newOpenFiles, panels: newPanels }
      return { ...next, ...syncDerivedState(next) }
    })
    void clearHotExitBackup(path)
  },

  /** Close a file, asking the user when it has unsaved changes. `panelId`
   *  scopes the close to one panel (the tab leaves that panel, the file stays
   *  open elsewhere); omit it to close the file everywhere. Save is attempted
   *  first for dirty files; a cancelled Save As or a failed save keeps the
   *  file open so the edits are never lost. Returns whether the file was
   *  closed. */
  closeFileWithConfirm: async (path, panelId) => {
    const file = get().openFiles.find((f) => f.path === path)
    if (!file) {
      // No loaded content — a stale tab left over by session restore (e.g. a
      // filtered /untitled/ entry) that never became an openFiles entry. There
      // is nothing to save or confirm; just drop the tab. Without this the tab
      // survives every close and lingers in the persisted session forever.
      if (panelId) get().closeFile(path, panelId)
      else get().closeFileGlobally(path)
      return true
    }
    if (!file.isDirty) {
      if (panelId) get().closeFile(path, panelId)
      else get().closeFileGlobally(path)
      return true
    }

    const choice = await useUnsavedStore.getState().ask(fileNameOf(file.path))
    if (choice === 'cancel') return false
    if (choice === 'save') {
      const savedPath = await get().saveFile(path).catch(() => null)
      if (!savedPath) return false // Save As cancelled / write failed → keep open
      if (panelId) get().closeFile(savedPath, panelId)
      else get().closeFileGlobally(savedPath)
      return true
    }
    if (panelId) get().closeFile(path, panelId)
    else get().closeFileGlobally(path)
    return true
  },

  /** Close a panel and every tab in it. Clean files close immediately; dirty
   *  ones prompt one at a time. A single 'cancel' aborts the whole panel
   *  close, keeping the remaining tabs (and the panel) open. Files that are
   *  also open in another panel only lose their tab here. */
  closePanelWithConfirm: async (panelId) => {
    const s = get()
    if (s.panelOrder.length <= 1) return false
    const panel = s.panels[panelId]
    if (!panel) return true

    for (const path of [...panel.tabOrder]) {
      // Re-check each iteration: earlier prompts may have closed tabs
      const shared = Object.values(get().panels).some((p) => p.id !== panelId && p.tabOrder.includes(path))
      const closed = await get().closeFileWithConfirm(path, shared ? panelId : undefined)
      if (!closed) return false
    }
    // All tabs are gone (or were never there) — drop the empty panel
    get().closePanel(panelId)
    return true
  },

  /** Close the whole editor area (see interface doc). Scoped per-panel closes
   *  let a file shared by two panels be prompted once per panel. */
  closeEditorArea: async () => {
    const panelIds = Object.keys(get().panels)
    for (const pid of panelIds) {
      const panel = get().panels[pid]
      if (!panel) continue
      for (const path of [...panel.tabOrder]) {
        // A file open in another panel is only closed HERE — the other panel
        // keeps its tab until its own turn comes around.
        const shared = Object.values(get().panels).some((p) => p.id !== pid && p.tabOrder.includes(path))
        const closed = await get().closeFileWithConfirm(path, shared ? pid : undefined)
        if (!closed) return false // Save As cancelled / dirty prompt aborted
      }
    }
    // Every tab is gone — the layout subscription already persisted an empty
    // session, but clear the key explicitly so a stale write can never
    // resurrect the previous tabs on the next launch.
    try { localStorage.removeItem(SESSION_STORAGE_KEY) } catch { /* storage unavailable */ }
    lastSessionSnapshot = ''
    useUIStore.getState().setEditorVisible(false)
    return true
  },

  setActiveFile: (path, panelId) => {
    get().closeDiff()
    set((s) => {
      const targetPanelId = panelId || s.activePanelId
      const panel = s.panels[targetPanelId]
      if (!panel) return s
      const newPanel: Panel = { ...panel, activeFilePath: path }
      const next = { ...s, panels: { ...s.panels, [targetPanelId]: newPanel } }
      return { ...next, ...syncDerivedState(next) }
    })
  },

  /** Create an untitled buffer in the active panel and return its pseudo path */
  newFile: () => {
    get().closeDiff()
    const path = `/untitled/untitled-${Date.now()}.txt`
    // Creating a file also implies the user wants the editor visible
    if (!useUIStore.getState().isEditorVisible) {
      useUIStore.getState().setEditorVisible(true)
    }
    const newFile: OpenFile = {
      path,
      content: '',
      language: 'plaintext',
      encoding: 'utf-8',
      lineEnding: 'lf',
      isDirty: false,
      hasBom: false,
    }
    set((s) => {
      const panel = s.panels[s.activePanelId]
      if (!panel) return s
      const newPanel: Panel = {
        ...panel,
        activeFilePath: path,
        tabOrder: panel.tabOrder.includes(path) ? panel.tabOrder : [...panel.tabOrder, path],
      }
      const next = {
        ...s,
        openFiles: [...s.openFiles, newFile],
        panels: { ...s.panels, [s.activePanelId]: newPanel },
        activePanelId: s.activePanelId,
      }
      return { ...next, ...syncDerivedState(next) }
    })
    return path
  },

  reorderTabs: (fromIndex, toIndex, panelId) => {
    set((s) => {
      const targetPanelId = panelId || s.activePanelId
      const panel = s.panels[targetPanelId]
      if (!panel) return s
      const newOrder = [...panel.tabOrder]
      const [moved] = newOrder.splice(fromIndex, 1)
      newOrder.splice(toIndex, 0, moved)
      const newPanel: Panel = { ...panel, tabOrder: newOrder }
      const next = { ...s, panels: { ...s.panels, [targetPanelId]: newPanel } }
      return { ...next, ...syncDerivedState(next) }
    })
  },

  moveTabToPanel: (path, fromPanelId, toPanelId, insertIndex) => {
    set((s) => {
      const fromPanel = s.panels[fromPanelId]
      const toPanel = s.panels[toPanelId]
      if (!fromPanel || !toPanel) return s

      // Remove from source
      const newFromTabOrder = fromPanel.tabOrder.filter((p) => p !== path)
      const newFromActive = fromPanel.activeFilePath === path
        ? newFromTabOrder[newFromTabOrder.length - 1] || null
        : fromPanel.activeFilePath

      // Add to target
      const newToTabOrder = toPanel.tabOrder.includes(path)
        ? toPanel.tabOrder
        : insertIndex !== undefined
          ? [...toPanel.tabOrder.slice(0, insertIndex), path, ...toPanel.tabOrder.slice(insertIndex)]
          : [...toPanel.tabOrder, path]

      const newPanels = {
        ...s.panels,
        [fromPanelId]: { ...fromPanel, tabOrder: newFromTabOrder, activeFilePath: newFromActive },
        [toPanelId]: { ...toPanel, tabOrder: newToTabOrder, activeFilePath: path },
      }

      const next = { ...s, panels: newPanels, activePanelId: toPanelId }
      return { ...next, ...syncDerivedState(next) }
    })
  },

  saveFile: async (path) => {
    // Guard against overlapping saves — a large streamed save takes many
    // seconds, and without this set each overlapping call would start another
    // concurrent save of the same file, piling up until the main process is
    // saturated encoding/writing gigabytes.
    if (savingFiles.has(path)) return null
    savingFiles.add(path)
    try {
      const file = get().openFiles.find((f) => f.path === path)
      if (!file) return null

      // If the file is still streaming in, wait for it to finish first
      const pendingLoad = waitForLoad(path)
      if (pendingLoad) await pendingLoad.catch(() => {})

      // Untitled buffer → prompt Save As, then migrate the tab to the real path
      if (path.startsWith('/untitled/')) {
        // Untitled buffers are small; reading the live model text is cheap here
        const content = getFileContent(path, file.content)
        const newPath = await window.electronAPI.saveFile()
        if (!newPath) return null
        await window.electronAPI.writeFile(newPath, content, file.encoding, file.hasBom)
        // Re-register the live model under the real path (and store the saved text
        // as the initial copy) so the migrated tab keeps its content
        const model = getModel(path)
        if (model) {
          registerModel(newPath, model)
          unregisterModel(path)
        }
        set((s) => {
          const newOpenFiles = s.openFiles.map((f) =>
            f.path === path ? { ...f, path: newPath, content, isDirty: false } : f
          )
          const newPanels = { ...s.panels }
          for (const pid of Object.keys(newPanels)) {
            const p = newPanels[pid]
            if (p.tabOrder.includes(path)) {
              newPanels[pid] = {
                ...p,
                tabOrder: p.tabOrder.map((tp) => (tp === path ? newPath : tp)),
                activeFilePath: p.activeFilePath === path ? newPath : p.activeFilePath,
              }
            }
          }
          const next = { ...s, openFiles: newOpenFiles, panels: newPanels }
          return { ...next, ...syncDerivedState(next) }
        })
        void clearHotExitBackup(path)
        return newPath
      }

      if (!file.isDirty) return path

      const model = getModel(path)
      // Large models are streamed to disk in bounded chunks. Reading the whole
      // document (`getFileContent` → `model.getValue()`) is only done for small
      // files — on a multi-hundred-MB model it copies the entire buffer on every
      // save.
      if (model && model.getValueLength() > STREAMED_SAVE_THRESHOLD) {
        await streamSaveModel(path, model, file.encoding, file.hasBom)
      } else {
        // The Monaco model is the source of truth once the file is open; the
        // store's content is only the initial copy. Read the live text at save.
        const content = getFileContent(path, file.content)
        await window.electronAPI.writeFile(path, content, file.encoding, file.hasBom)
      }
      get().markDirty(path, false)
      void clearHotExitBackup(path)
      return path
    } catch (error) {
      console.error('Failed to save file:', error)
      throw error
    } finally {
      savingFiles.delete(path)
    }
  },

  saveAll: async () => {
    const dirtyFiles = get().openFiles.filter((f) => f.isDirty)
    await Promise.all(dirtyFiles.map((f) => get().saveFile(f.path)))
  },

  markDirty: (path, isDirty = true) => {
    const file = get().openFiles.find((f) => f.path === path)
    if (!file || file.isDirty === isDirty) return
    // First keystroke on a clean buffer schedules the hot-exit backup
    if (isDirty) scheduleHotExitBackup(path)
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, isDirty } : f
      ),
    }))
  },

  setFileEncoding: (path, encoding) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        // Re-encode the in-memory (decoded) content with the new encoding on next save
        f.path === path ? { ...f, encoding, isDirty: true } : f
      ),
    }))
  },

  revertFile: async (path) => {
    get().closeDiff()
    try {
      const { content, encoding, hasBom } = await window.electronAPI.readFile(path)
      // Refresh the live model too, so the editor immediately matches disk
      // (this resets Monaco's undo history — expected for a revert)
      getModel(path)?.setValue(content)
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path ? { ...f, content, encoding, hasBom, isDirty: false } : f
        ),
      }))
      void clearHotExitBackup(path)
    } catch (error) {
      console.error('Failed to revert file:', error)
      throw error
    }
  },

  updateFileContent: (path, content) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, content, isDirty: true } : f
      ),
    }))
  },

  /** Open a tab filled with hot-exit backup content (no disk read, marked dirty). */
  restoreFromBackup: async (filePath, content, encoding, hasBom) => {
    get().closeDiff()
    const state = get()
    const language = state.getLanguageByPath(filePath)

    // Register the lazy language service (e.g. TypeScript) before the model
    await ensureLanguageService(language)

    // If already open, just refresh the live model and mark dirty
    const existing = state.openFiles.find((f) => f.path === filePath)
    if (existing) {
      const model = getModel(filePath)
      if (model) model.setValue(content)
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === filePath ? { ...f, content, encoding, hasBom, isDirty: true } : f
        ),
      }))
      return
    }

    // Pre-register the model so EditorContainer picks it up without streaming
    let model = getModel(filePath)
    if (model) {
      model.setValue(content)
    } else {
      const uri = fileUri(filePath)
      model = monaco.editor.createModel(content, language, uri)
      registerModel(filePath, model)
    }

    set((s) => {
      const panel = s.panels[s.activePanelId]
      if (!panel) return s
      const newPanel: Panel = {
        ...panel,
        activeFilePath: filePath,
        tabOrder: panel.tabOrder.includes(filePath) ? panel.tabOrder : [...panel.tabOrder, filePath],
      }
      const newFile: OpenFile = {
        path: filePath,
        content,
        language,
        encoding,
        lineEnding: 'lf',
        isDirty: true,
        hasBom,
      }
      const next = {
        ...s,
        openFiles: [...s.openFiles, newFile],
        panels: { ...s.panels, [s.activePanelId]: newPanel },
      }
      return { ...next, ...syncDerivedState(next) }
    })
  },

  /** Re-open the tabs that were open when the app last closed. Called once at
   *  startup (after restoreLastProject) so the editor shows the same files the
   *  user left open — and stays hidden when none were open. Best-effort: any
   *  failure (a file deleted on disk, localStorage full, ...) must never block
   *  app startup, so the whole body is guarded. */
  restoreSession: async () => {
    try {
      const saved = loadSessionSnapshot()
      if (!saved) {
        // Nothing was saved — the middle editor area stays hidden (no files
        // open = nothing to show).
        useUIStore.getState().setEditorVisible(false)
        return
      }
      // Untitled buffers are throwaway — don't resurrect empty ones here. If
      // one held unsaved content, the hot-exit backup flow restores it.
      const paths = [...new Set(
        Object.values(saved.panels).flatMap((p) => (p.tabOrder || []).filter((path) => !path.startsWith('/untitled/'))),
      )]
      if (paths.length === 0) {
        useUIStore.getState().setEditorVisible(false)
        return
      }

      // Re-open every file so openFiles is populated and content streams in
      // when its tab becomes active (openFile registers the lazy loader, then
      // returns immediately).
      for (const path of paths) {
        await get().openFile(path)
      }

      // Advance the panel-id counter past any restored ids so a later split
      // can't collide with a restored panel (the fresh process restarts at
      // panel-1).
      for (const id of Object.keys(saved.panels)) {
        const n = parseInt(id.split('-').pop() || '0', 10)
        if (Number.isFinite(n)) panelCounter = Math.max(panelCounter, n)
      }

      // Apply the saved layout exactly — tab order, the active file per panel,
      // and any split configuration. Untitled entries are stripped from the
      // restored tabOrder too (they were already excluded from `paths` above,
      // but keeping them in tabOrder would let stale /untitled/ tabs linger in
      // every later session snapshot — and survive closeFileWithConfirm).
      const cleanPanels: Record<string, Panel> = {}
      for (const [id, p] of Object.entries(saved.panels)) {
        const tabOrder = (p.tabOrder || []).filter((path) => !path.startsWith('/untitled/'))
        cleanPanels[id] = {
          ...p,
          tabOrder,
          activeFilePath: p.activeFilePath && !p.activeFilePath.startsWith('/untitled/')
            ? p.activeFilePath
            : tabOrder[tabOrder.length - 1] || null,
        }
      }
      const panelOrder = saved.panelOrder.length > 0 ? saved.panelOrder : [initialPanelId]
      const activePanelId = saved.panels[saved.activePanelId] ? saved.activePanelId : (saved.panels[panelOrder[0]] ? panelOrder[0] : initialPanelId)
      const next = {
        ...get(),
        panels: cleanPanels,
        panelOrder,
        activePanelId,
        splitDirection: saved.splitDirection || 'horizontal',
        splitRatios: saved.splitRatios || [],
      }
      set({ ...next, ...syncDerivedState(next) })
      useUIStore.getState().setEditorVisible(true)
    } catch (error) {
      console.error('Failed to restore editor session:', error)
    }
  },

  getActiveFile: () => {
    const { openFiles, activeFilePath } = get()
    return openFiles.find((f) => f.path === activeFilePath)
  },

  getLanguageByPath: (path) => {
    const ext = path.split('.').pop()?.toLowerCase() || ''
    return LANGUAGE_MAP[ext] || 'plaintext'
  },
}))

// Mirror the tab/panel layout to localStorage whenever it changes (debounced).
// Cursor moves / streaming progress / isDirty toggles never change the
// snapshot, so they never reach the disk. The snapshot is pre-seeded with the
// current (empty) layout so unrelated startup writes (e.g. loadPreferences)
// can't clobber a saved session before restoreSession has read it.
lastSessionSnapshot = snapshotOf(useEditorStore.getState())
useEditorStore.subscribe((s) => {
  const snap = snapshotOf(s)
  if (snap === lastSessionSnapshot) return
  lastSessionSnapshot = snap
  scheduleSessionPersist()
})
