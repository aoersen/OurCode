import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react'
import FileTreeNode from './FileTreeNode'
import { FileEntry } from '@/types'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import LoadingSpinner from '../Common/LoadingSpinner'
import { useI18n } from '@/i18n/useI18n'

interface FileTreeProps {
  rootPath: string
  /** Bumped by the parent (tree-view header's refresh button) to force a full
   *  tree reload — re-reads the root and every expanded directory. */
  refreshSignal?: number
  /** Called after a non-directory entry is opened in the editor (e.g. the
   *  office view's in-panel tree uses it to also switch to the workspace so the
   *  opened file is actually visible). */
  onOpenFile?: (path: string) => void
}

/** Per-project expanded-directory persistence: the tree's fold/unfold state
 *  survives restarts, keyed by project root. Capped so pathological trees
 *  don't bloat localStorage. */
const EXPANDED_KEY_PREFIX = 'fileTreeExpanded:'
const EXPANDED_CAP = 300

/** Fixed row height (matches the h-[26px] rows) + overscan rows rendered above
 *  and below the viewport so scrolling feels instant. */
const ROW_HEIGHT = 26
const ROW_OVERSCAN = 12

/** One visible tree row: the entry plus its indent depth in the flattened list.
 *  The tree is rendered as a windowed list of these rows instead of one huge
 *  recursive DOM tree — expanding node_modules in a big project used to mount
 *  tens of thousands of nodes and freeze every interaction. */
interface TreeRow {
  entry: FileEntry
  depth: number
}

/** Flatten the (already filtered) tree into a row list, descending only into
 *  directories that are actually expanded — same traversal rule the recursive
 *  renderer used, so fold/search behavior is unchanged. */
function flattenRows(entries: FileEntry[], expandedDirs: Set<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: FileEntry[], depth: number) => {
    for (const entry of list) {
      rows.push({ entry, depth })
      if (entry.isDirectory && entry.children && expandedDirs.has(entry.path)) {
        walk(entry.children, depth + 1)
      }
    }
  }
  walk(entries, 0)
  return rows
}

function loadExpandedDirs(rootPath: string): Set<string> {
  try {
    const arr: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY_PREFIX + rootPath) || 'null')
    if (Array.isArray(arr)) return new Set(arr.filter((p): p is string => typeof p === 'string'))
  } catch { /* ignore */ }
  return new Set()
}

function saveExpandedDirs(rootPath: string, dirs: Set<string>): void {
  try {
    const arr = Array.from(dirs)
    const capped = arr.length > EXPANDED_CAP ? arr.slice(-EXPANDED_CAP) : arr
    localStorage.setItem(EXPANDED_KEY_PREFIX + rootPath, JSON.stringify(capped))
  } catch { /* ignore */ }
}

function FileTree({ rootPath, refreshSignal, onOpenFile }: FileTreeProps) {
  const [files, setFiles] = useState<FileEntry[]>([])
  // The root itself is always expanded; the rest of the fold state is restored
  // from this project's last visit.
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set([rootPath, ...loadExpandedDirs(rootPath)]))
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  // Virtualization: track scroll offset + container height so only the visible
  // rows are mounted (see flattenRows). Measured on scroll and via a
  // ResizeObserver so collapsing/expanding the sidebar re-windows correctly.
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  // Select the ACTION only (stable reference) — subscribing to the whole
  // editorStore would re-render the entire tree on every cursor move/keystroke.
  const openFile = useEditorStore((s) => s.openFile)
  const activeFilePath = useEditorStore((s) => s.activeFilePath)
  // Main refuses to register an untrusted folder, so the tree would read as an
  // empty project. Surface the real reason and the one action that fixes it.
  const untrusted = useUIStore((s) => (s.untrustedProjectPath === rootPath ? rootPath : null))
  const requestProjectTrust = useUIStore((s) => s.requestProjectTrust)
  // Bumped after trust is granted to re-run the load/watch effect.
  const [trustGeneration, setTrustGeneration] = useState(0)
  const { showHiddenFiles } = useEditorStore((s) => s.preferences)
  const t = useI18n()

  // Drag scroll lock: while dragging a file, hold the tree's scroll position so
  // the browser's edge auto-scroll can't slide the whole tree up/down mid-drag.
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragLockTopRef = useRef<number | null>(null)

  // Debounce for watcher events — bursts (git ops, build output) coalesce into
  // one refresh instead of reloading the tree per event.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mirror expandedDirs in a ref so the watcher callback never sees a stale closure
  const expandedDirsRef = useRef(expandedDirs)
  useEffect(() => { expandedDirsRef.current = expandedDirs }, [expandedDirs])

  // files is read through a ref inside stable callbacks so memoized tree nodes
  // don't re-render when the array reference changes.
  const filesRef = useRef(files)
  useEffect(() => { filesRef.current = files }, [files])

  // Monotonic token — bumped every time the project root changes, so a slow
  // in-flight load from the PREVIOUS project can never overwrite the new one
  // (quick project switching used to race and show the wrong files).
  const loadSeqRef = useRef(0)

  // Switching projects restores THAT project's own fold state (the component
  // instance is reused across projects, so state must not leak between them).
  useEffect(() => {
    loadSeqRef.current++
    setExpandedDirs(new Set([rootPath, ...loadExpandedDirs(rootPath)]))
    setSearchQuery('')
    setScrollTop(0) // stale offset from the previous project must not persist
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [rootPath])

  const loadFiles = useCallback(async (dirPath: string) => {
    try {
      const entries = await window.electronAPI.listDir(dirPath)
      return entries
    } catch (error) {
      console.error('Failed to load files:', error)
      return []
    }
  }, [])

  /** Progressively load children of every expanded directory, updating the
   *  tree as each level arrives — a project with many expanded folders never
   *  blocks the first paint on the whole recursive read. */
  const loadExpandedChildren = useCallback(async (entries: FileEntry[], seq: number) => {
    for (const entry of entries) {
      if (!entry.isDirectory || !expandedDirsRef.current.has(entry.path)) continue
      const children = await loadFiles(entry.path)
      if (seq !== loadSeqRef.current) return // project switched mid-load — discard
      // updateEntryChildren is a pure function — its RETURN VALUE is the new
      // tree (a shallow copy never mutates the stored entries, so passing a
      // fresh `[...prev]` copy and ignoring the result would silently drop the
      // children and leave expanded folders empty). Pass it straight through,
      // exactly like toggleDir does for one-off expansions.
      setFiles((prev) => updateEntryChildren(prev, entry.path, children))
      // Nested expanded folders inside this one
      await loadExpandedChildren(children, seq)
    }
  }, [loadFiles])

  // Load root files (and re-load children of every expanded directory, so a
  // watcher-triggered refresh does NOT flatten the tree)
  const refreshTree = useCallback(async (initial = false) => {
    const seq = loadSeqRef.current
    if (initial) setIsLoading(true)
    const rootEntries = await loadFiles(rootPath)
    if (seq !== loadSeqRef.current) return // project switched mid-load — discard
    setFiles(rootEntries)
    if (initial) setIsLoading(false)
    await loadExpandedChildren(rootEntries, seq)
  }, [rootPath, loadFiles, loadExpandedChildren])

  // Parent-triggered manual refresh — the tree-view header's refresh button
  // bumps `refreshSignal`. The ref starts at the CURRENT signal so a remount
  // (re-entering the project after the user already hit refresh) doesn't fire a
  // duplicate load — only a genuine bump triggers refreshTree.
  const lastRefreshSignalRef = useRef(refreshSignal ?? 0)
  useEffect(() => {
    if (refreshSignal === undefined || refreshSignal === lastRefreshSignalRef.current) return
    lastRefreshSignalRef.current = refreshSignal
    void refreshTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshTree identity tracks rootPath, which the mount effect already handles
  }, [refreshSignal])

  /** Surgically reload ONE directory's listing and merge it into the tree,
   *  keeping deeper expanded folders populated. Used for watcher events — a
   *  full `refreshTree()` per change would recursively reload every expanded
   *  folder (catastrophic on big projects with node_modules etc.). */
  const refreshDir = useCallback(async (dirPath: string) => {
    const seq = loadSeqRef.current
    if (dirPath === rootPath) {
      const entries = await loadFiles(rootPath)
      if (seq !== loadSeqRef.current) return
      setFiles(entries)
      await loadExpandedChildren(entries, seq)
      return
    }
    // Only reload directories that are actually visible (expanded) — a change
    // inside a collapsed folder has nothing to update.
    if (!expandedDirsRef.current.has(dirPath)) return
    const children = await loadFiles(dirPath)
    if (seq !== loadSeqRef.current) return
    setFiles((prev) => updateEntryChildren(prev, dirPath, children))
    await loadExpandedChildren(children, seq)
  }, [rootPath, loadFiles, loadExpandedChildren])

  /** Watcher callback. Saves are explicit now (autosave was removed), so there
   *  is no per-keystroke event flood to filter — even files open in the editor
   *  must refresh their directory (fresh git badges, new/deleted sibling
   *  files). Bursts (git ops, build output) coalesce into one refresh via the
   *  300ms debounce. */
  const handleFileChanged = useCallback((changedPath: string) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      refreshDir(parentDir(changedPath))
    }, 300)
  }, [refreshDir])

  // Fetch git status and apply to file entries
  const fetchGitStatus = useCallback(async () => {
    try {
      const result = await window.electronAPI.gitExec(rootPath, ['status', '--porcelain=v1'])
      if (!result.success) return
      const statusMap = new Map<string, string>()
      for (const line of result.output.split('\n').filter(Boolean)) {
        const status = line.slice(0, 2).trim()
        const filePath = line.slice(3)
        if (status === 'M' || status === 'MM') statusMap.set(filePath, 'modified')
        else if (status === 'A') statusMap.set(filePath, 'added')
        else if (status === 'D') statusMap.set(filePath, 'deleted')
        else if (status.startsWith('R')) statusMap.set(filePath, 'renamed')
        else if (status === '??') statusMap.set(filePath, 'added')
      }
      // Apply status to file entries
      setFiles(prev => applyGitStatus(prev, statusMap, rootPath))
    } catch { /* ignore git errors */ }
  }, [rootPath])

  // Load the tree IMMEDIATELY — the watcher must not gate the first paint.
  // fs:* calls are rejected by the main process until the root is registered;
  // enterProject / setRootPath / restoreLastProject authorize it up front, and
  // we authorize again here (belt-and-suspenders) so the first listDir can
  // never be rejected.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try { await window.electronAPI.authorize?.(rootPath) } catch { /* ignore */ }
      if (cancelled) return
      await refreshTree(true)
      fetchGitStatus()
    })()
    // Start the watcher in the BACKGROUND — its initial recursive scan
    // (chokidar depth 10) and MCP-config load can take a while on big
    // projects, and the file tree must not wait for it to show files.
    void Promise.resolve(window.electronAPI.watch?.(rootPath))
      .then((res) => {
        if (!res || cancelled) return
        useUIStore.setState({ untrustedProjectPath: res.ok === false ? rootPath : null })
      })
      .catch(() => { /* watcher failed — the tree still loads */ })
    const unsubscribe = window.electronAPI.onFileChanged?.(handleFileChanged)

    return () => {
      cancelled = true
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      window.electronAPI.unwatch?.(rootPath)
      unsubscribe?.()
    }
  }, [rootPath, refreshTree, fetchGitStatus, handleFileChanged, trustGeneration])

  // Git status badges refresh on a timer; the initial fetch happens once the
  // tree is loaded (see the watch effect above).
  useEffect(() => {
    const interval = setInterval(fetchGitStatus, 15000)
    return () => clearInterval(interval)
  }, [fetchGitStatus])

  // Stable callbacks (read state via refs) so memoized FileTreeNodes only
  // re-render when their own props actually change.
  const toggleDir = useCallback(async (path: string) => {
    const newExpanded = new Set(expandedDirsRef.current)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
      // Load children if not loaded
      const entry = findEntry(filesRef.current, path)
      if (entry && !entry.children) {
        const children = await loadFiles(path)
        setFiles((prev) => updateEntryChildren(prev, path, children))
      }
    }
    setExpandedDirs(newExpanded)
    saveExpandedDirs(rootPath, newExpanded)
  }, [loadFiles, rootPath])

  const handleFileClick = useCallback((path: string, isDirectory: boolean) => {
    if (isDirectory) {
      toggleDir(path)
    } else {
      openFile(path)
      onOpenFile?.(path)
    }
  }, [toggleDir, openFile, onOpenFile])

  const filteredFiles = useMemo(() => searchQuery
    ? filterFiles(files, searchQuery)
    : showHiddenFiles
    ? files
    : files.filter((f) => !f.isHidden), [files, searchQuery, showHiddenFiles])

  // Flatten the visible tree once per files/fold-state change; the render pass
  // only mounts the rows that fall inside the viewport.
  const rows = useMemo(() => flattenRows(filteredFiles, expandedDirs), [filteredFiles, expandedDirs])
  const totalHeight = rows.length * ROW_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_OVERSCAN)
  const endIndex = Math.min(rows.length, startIndex + Math.ceil(viewportHeight / ROW_HEIGHT) + ROW_OVERSCAN * 2)
  const visibleRows = rows.slice(startIndex, endIndex)

  // Measure the scroll container so the windowed slice stays correct when the
  // panel is resized / first laid out.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setViewportHeight(el.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="h-full flex flex-col" id="file-tree-root" data-root-path={rootPath}>
      {/* Search — glass capsule with leading icon (Stitch 资源管理器) */}
      <div className="p-2 pb-1">
        <div className="relative">
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-nova-text-muted pointer-events-none"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('sidebar.searchFiles')}
            className="w-full bg-nova-input-bg border border-nova-border rounded-full py-1.5 pl-9 pr-4 text-[11px] text-nova-text-primary placeholder-nova-text-muted focus:border-accent-60 focus:ring-2 focus:ring-accent-20 focus:outline-none transition-all"
          />
        </div>
      </div>

      {untrusted && (
        <div className="mx-2 mb-1 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <span className="flex-1 leading-snug">{t('sidebar.untrustedWorkspace')}</span>
          <button
            onClick={async () => {
              if (await requestProjectTrust(rootPath)) setTrustGeneration((v) => v + 1)
            }}
            className="shrink-0 rounded border border-amber-500/40 px-1.5 py-0.5 text-[10px] transition-colors hover:bg-amber-500/15 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-60"
          >
            {t('project.trustWorkspace')}
          </button>
        </div>
      )}

      {/* File Tree */}
      <div
        ref={scrollRef}
        onDragStartCapture={() => {
          if (scrollRef.current) dragLockTopRef.current = scrollRef.current.scrollTop
        }}
        onDragEndCapture={() => { dragLockTopRef.current = null }}
        onScroll={() => {
          const el = scrollRef.current
          if (!el) return
          // While a drag is active, hold the list in place so edge auto-scroll
          // can't slide the whole tree around mid-drag; otherwise feed the new
          // scroll offset into the windowed renderer.
          const lock = dragLockTopRef.current
          if (lock !== null && Math.abs(el.scrollTop - lock) > 1) el.scrollTop = lock
          else setScrollTop(el.scrollTop)
        }}
        className="flex-1 overflow-y-auto bg-white/95 dark:bg-black/40 shadow-inner"
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <LoadingSpinner size="md" text={t('sidebar.loading')} />
          </div>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}>
              {visibleRows.map(({ entry, depth }) => (
                <div key={entry.path} style={{ height: ROW_HEIGHT }}>
                  <FileTreeNode
                    entry={entry}
                    depth={depth}
                    isExpanded={expandedDirs.has(entry.path)}
                    onClick={handleFileClick}
                    onRefresh={refreshTree}
                    activePath={activeFilePath}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// memo: the parent (ProjectListPanel) re-renders whenever the chat store's
// session list changes — the tree must NOT re-render (or re-run memo checks on
// every node) for that. Props are just the root path, so memo keeps the whole
// windowed tree untouched across unrelated store churn.
export default memo(FileTree)

// Helper functions
/** Parent of a file/dir path (handles both / and \ separators). */
function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx > 0 ? p.slice(0, idx) : p
}

function findEntry(entries: FileEntry[], path: string): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry
    if (entry.children) {
      const found = findEntry(entry.children, path)
      if (found) return found
    }
  }
  return null
}

/** Immutable update: returns a NEW tree where only the path chain leading to
 *  `path` gets new object references, so memoized FileTreeNodes for untouched
 *  subtrees don't re-render. Returns the SAME array when `path` is not present
 *  (e.g. the folder was removed meanwhile). */
function updateEntryChildren(entries: FileEntry[], path: string, children: FileEntry[]): FileEntry[] {
  let changed = false
  const next = entries.map((entry) => {
    if (entry.path === path) {
      changed = true
      return { ...entry, children }
    }
    if (entry.children) {
      const newChildren = updateEntryChildren(entry.children, path, children)
      if (newChildren !== entry.children) {
        changed = true
        return { ...entry, children: newChildren }
      }
    }
    return entry
  })
  return changed ? next : entries
}

/** Immutable filter — never mutates the source tree (memoized nodes share
 *  entry references with the real tree, so searching must not clobber their
 *  children). */
function filterFiles(entries: FileEntry[], query: string): FileEntry[] {
  const lowerQuery = query.toLowerCase()
  const next: FileEntry[] = []
  for (const entry of entries) {
    if (entry.name.toLowerCase().includes(lowerQuery)) {
      next.push(entry)
      continue
    }
    if (entry.children) {
      const filteredChildren = filterFiles(entry.children, query)
      if (filteredChildren.length > 0) {
        next.push(filteredChildren === entry.children ? entry : { ...entry, children: filteredChildren })
      }
    }
  }
  return next
}

/** Reference-preserving git-status pass: only entries whose status (or whose
 *  subtree) actually changed get new objects, so the 15s git poll doesn't
 *  re-render the whole tree when nothing moved. */
function applyGitStatus(entries: FileEntry[], statusMap: Map<string, string>, rootPath: string): FileEntry[] {
  let changed = false
  const next = entries.map((entry) => {
    const relativePath = entry.path.replace(rootPath + '/', '').replace(rootPath + '\\', '')
    const status = (statusMap.get(relativePath) as FileEntry['gitStatus']) || null
    const childResult = entry.children ? applyGitStatus(entry.children, statusMap, rootPath) : null
    const children = childResult ?? entry.children
    if (entry.gitStatus === status && children === entry.children) return entry
    changed = true
    return { ...entry, gitStatus: status, children }
  })
  return changed ? next : entries
}
