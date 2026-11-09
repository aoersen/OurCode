import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ConfirmDialog from '@/components/Common/ConfirmDialog'
import { askText } from '@/components/Common/PromptDialog'
import type { ContextMenuItem } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import type { FileEntry } from '@/types'
import FileTreeRow from './FileTreeRow'
import { readShowHiddenFiles, writeShowHiddenFiles } from './railMode'
import {
  fileBaseName,
  flattenFileTree,
  joinPath,
  parentDirOf,
  type RailFileRow,
} from './railFiles'
import { useRailFiles } from './useRailFiles'
import { SearchIcon } from './railIcons'

export interface FileTreeRailProps {
  /** 当前项目根（uiStore.rootPath ?? activeProjectPath）；null = 还没有打开项目。 */
  rootPath: string | null
}

/**
 * 左栏「文件」模式：当前项目根的懒加载文件树。
 *
 * 设计契约（OurCode Pure）：
 *  - 顶部一条无边框筛选输入 + 一行灰色「显示隐藏文件」开关；
 *  - 行 = 缩进 + chevron（目录） + 文件名，13px 单行；没有徽标、没有彩色 chip；
 *  - 目录展开时子项还没到 → 灰色占位线（不是 spinner）；
 *  - 空项目 / 读不到 → 一行灰字（后者带一个「重试」文字动作）。
 *
 * 交互：
 *  - 目录点击展开 / 收起；文件点击打开 —— 可预览类型（md/html/图片）同时开产物面板；
 *  - 行 hover / 键盘聚焦显示「复制路径」；右键是 复制路径 / 重命名 / 删除 / 在产物面板中打开，
 *    删除必须走 ConfirmDialog；
 *  - 键盘：row 是 treeitem，整栏 roving tabIndex，↑↓/Home/End 移动、←→ 收起/展开、
 *    Enter 打开、F2 重命名、Shift+F10 开菜单。
 *
 * 性能：整个组件 memo 在 rootPath 上；父级（SessionRail）因为流式 token 重渲染时，
 * 只要根没变就不会重跑这里。行组件同样 memo，回调全部 useCallback 固化。
 */
function FileTreeRailInner({ rootPath }: FileTreeRailProps) {
  const {
    tree,
    rootStatus,
    expanded,
    loadingDirs,
    errorDirs,
    toggleDir,
    expandDir,
    collapseDir,
    ensureDir,
    retryRoot,
    retryDir,
    reloadDir,
  } = useRailFiles(rootPath)

  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(readShowHiddenFiles)
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  const activeFilePath = useEditorStore((s) => s.activeFilePath)
  const openFile = useEditorStore((s) => s.openFile)
  const setArtifactPanelOpen = useUIStore((s) => s.setArtifactPanelOpen)
  const requestArtifact = useUIStore((s) => s.requestArtifact)
  const showContextMenu = useUIStore((s) => s.showContextMenu)
  const showNotification = useUIStore((s) => s.showNotification)
  const setRootPath = useUIStore((s) => s.setRootPath)

  /** 打开另一个项目（原生目录选择）—— 文件模式里不必先回会话模式再点项目。 */
  const openOtherProject = useCallback(async () => {
    try {
      const picked = await window.electronAPI.openFolder()
      if (picked) setRootPath(picked)
    } catch {
      showNotification('打开项目失败', 'warning')
    }
  }, [setRootPath, showNotification])

  // 换项目：筛选与焦点都回到干净状态（展开状态由 useRailFiles 重置）
  useEffect(() => {
    setQuery('')
    setFocusPath(null)
  }, [rootPath])

  const rows = useMemo<RailFileRow[]>(
    () =>
      flattenFileTree(tree, {
        expanded,
        query,
        showHidden,
        loading: loadingDirs,
        errors: errorDirs,
      }),
    [tree, expanded, query, showHidden, loadingDirs, errorDirs],
  )

  const entryRows = useMemo(() => rows.filter((row) => row.kind === 'entry'), [rows])
  const rowByPath = useMemo(() => {
    const map = new Map<string, RailFileRow>()
    for (const row of entryRows) map.set(row.entry.path, row)
    return map
  }, [entryRows])
  const tabbablePath = useMemo(
    () => (focusPath && rowByPath.has(focusPath) ? focusPath : entryRows[0]?.entry.path ?? null),
    [focusPath, rowByPath, entryRows],
  )

  // 展开的目录缺子项 → 读一层。占位行由 flattenFileTree 根据 loadingDirs 画。
  useEffect(() => {
    for (const row of entryRows) {
      const entry = row.entry
      if (!entry.isDirectory || !expanded.has(entry.path)) continue
      if (entry.children !== undefined) continue
      if (loadingDirs.has(entry.path) || errorDirs.has(entry.path)) continue
      ensureDir(entry.path)
    }
  }, [entryRows, expanded, loadingDirs, errorDirs, ensureDir])

  const openPath = useCallback(
    (path: string) => {
      void Promise.resolve(openFile(path)).catch(() => showNotification('打开文件失败', 'warning'))
    },
    [openFile, showNotification],
  )

  /**
   * 点开一个文件 = 在右侧文档面板里打开它（这就是 agent 壳里的「编辑器」）。
   *
   * 旧实现只对 md / html / 图片开面板，代码文件只调 editorStore.openFile，
   * 而 agent 壳里没有中央编辑区 —— 结果是「点了没反应」。现在所有文件都落到
   * 面板里：代码走 Monaco 编辑，图片走预览，二进制给一行说明。
   */
  const openFileEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.isDirectory) return
      openPath(entry.path)
      requestArtifact({ tab: 'file', path: entry.path })
      setArtifactPanelOpen(true)
    },
    [openPath, requestArtifact, setArtifactPanelOpen],
  )

  const openInArtifactPanel = useCallback(
    (entry: FileEntry) => {
      if (entry.isDirectory) return
      openPath(entry.path)
      requestArtifact({ tab: 'file', path: entry.path })
      setArtifactPanelOpen(true)
    },
    [openPath, requestArtifact, setArtifactPanelOpen],
  )

  const copyPath = useCallback(
    async (entry: FileEntry) => {
      try {
        await navigator.clipboard.writeText(entry.path)
        showNotification('已复制路径', 'success')
      } catch {
        showNotification('复制路径失败', 'warning')
      }
    },
    [showNotification],
  )

  const renameEntry = useCallback(
    async (entry: FileEntry) => {
      const next = await askText({ title: '重命名', defaultValue: entry.name })
      const name = next?.trim()
      if (!name || name === entry.name) return
      if (name.includes('/') || name.includes('\\')) {
        showNotification('名称不能包含路径分隔符', 'warning')
        return
      }
      const parent = parentDirOf(entry.path)
      if (!parent) {
        showNotification('无法重命名：找不到上级目录', 'warning')
        return
      }
      try {
        await window.electronAPI.rename(entry.path, joinPath(parent, name))
        void reloadDir(parent)
        showNotification('已重命名', 'success')
      } catch {
        showNotification('重命名失败', 'warning')
      }
    },
    [reloadDir, showNotification],
  )

  const openMenu = useCallback(
    (entry: FileEntry, x: number, y: number) => {
      const items: ContextMenuItem[] = [
        {
          label: '复制路径',
          action: () => {
            void copyPath(entry)
          },
        },
        {
          label: '重命名',
          action: () => {
            void renameEntry(entry)
          },
        },
        // 破坏性操作：只把目标交给 ConfirmDialog，绝不在这里直接删
        { label: '删除', action: () => setPendingDelete(entry) },
      ]
      if (!entry.isDirectory) {
        items.push({ label: '在文档面板中打开', action: () => openInArtifactPanel(entry) })
      }
      showContextMenu(x, y, items)
    },
    [copyPath, renameEntry, openInArtifactPanel, showContextMenu],
  )

  const confirmDelete = useCallback(async () => {
    const entry = pendingDelete
    setPendingDelete(null)
    if (!entry) return
    const parent = parentDirOf(entry.path)
    try {
      await window.electronAPI.delete(entry.path)
      if (parent) void reloadDir(parent)
      showNotification('已删除', 'success')
    } catch {
      showNotification('删除失败', 'warning')
    }
  }, [pendingDelete, reloadDir, showNotification])

  const activateEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.isDirectory) {
        toggleDir(entry)
        return
      }
      openFileEntry(entry)
    },
    [toggleDir, openFileEntry],
  )

  const handleRowFocus = useCallback((path: string) => setFocusPath(path), [])

  /** 行内动作的回调必须固定引用，否则 memo 过的行每次父级渲染都失效。 */
  const handleCopyPath = useCallback(
    (entry: FileEntry) => {
      void copyPath(entry)
    },
    [copyPath],
  )

  const toggleShowHidden = useCallback(() => {
    const next = !showHidden
    writeShowHiddenFiles(next)
    setShowHidden(next)
  }, [showHidden])

  const focusRowByPath = useCallback((path: string | null) => {
    if (!path) return
    const host = treeRef.current
    if (!host) return
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-file-row]'))) {
      if (el.dataset.fileRow === path) {
        el.focus()
        return
      }
    }
  }, [])

  const handleTreeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      const rowEl = target?.closest<HTMLElement>('[data-file-row]')
      // 焦点在行内的文字动作（复制路径）上时，Enter 属于那个按钮，不是这一行
      if (!target || !rowEl || target !== rowEl) return
      const path = rowEl.dataset.fileRow
      if (!path) return
      const row = rowByPath.get(path)
      if (!row) return
      const entry = row.entry
      const index = entryRows.findIndex((item) => item.entry.path === path)

      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Home' ||
        event.key === 'End'
      ) {
        event.preventDefault()
        if (entryRows.length === 0) return
        let next = 0
        if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = entryRows.length - 1
        else if (index < 0) next = 0
        else {
          const delta = event.key === 'ArrowDown' ? 1 : -1
          next = Math.min(entryRows.length - 1, Math.max(0, index + delta))
        }
        focusRowByPath(entryRows[next]?.entry.path ?? null)
        return
      }

      if (event.key === 'ArrowRight') {
        if (!entry.isDirectory) return
        event.preventDefault()
        if (!expanded.has(entry.path)) {
          expandDir(entry)
          return
        }
        // 已展开 → 焦点落到第一个可见子项（可能还没加载完，那就停在原地）
        const child = entryRows
          .slice(index + 1)
          .find((item) => item.depth === row.depth + 1)
        focusRowByPath(child?.entry.path ?? null)
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (entry.isDirectory && expanded.has(entry.path)) {
          collapseDir(entry)
          return
        }
        const parent = parentDirOf(entry.path)
        if (!parent) return
        const parentRow = entryRows.find((item) => item.entry.path === parent)
        focusRowByPath(parentRow?.entry.path ?? null)
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        activateEntry(entry)
        return
      }

      if (event.key === 'F2') {
        event.preventDefault()
        void renameEntry(entry)
        return
      }

      if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
        event.preventDefault()
        const rect = rowEl.getBoundingClientRect()
        openMenu(entry, rect.left + 24, rect.bottom)
      }
    },
    [
      activateEntry,
      collapseDir,
      entryRows,
      expandDir,
      expanded,
      focusRowByPath,
      openMenu,
      renameEntry,
      rowByPath,
    ],
  )

  const showFilter = !!rootPath

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 项目条：当前项目名 + 打开其他项目 + 显示隐藏文件。
          文件模式也要能「换项目」，否则只能退回会话模式点项目行。 */}
      <div className="shrink-0 px-2 pt-2 pb-1 flex items-center gap-1">
        <span
          className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--pure-ink)]"
          title={rootPath ?? '还没有打开项目'}
        >
          {rootPath ? fileBaseName(rootPath) : '未打开项目'}
        </span>
        <button
          type="button"
          onClick={() => {
            void openOtherProject()
          }}
          title="打开其他项目文件夹"
          aria-label="打开其他项目文件夹"
          className="pure-focus shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <path d="M12 11v5M9.5 13.5h5" />
          </svg>
        </button>
        <button
          type="button"
          aria-pressed={showHidden}
          onClick={toggleShowHidden}
          title={showHidden ? '隐藏点文件与 node_modules' : '显示隐藏文件'}
          aria-label={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
          className={`pure-focus shrink-0 w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
            showHidden
              ? 'text-[var(--pure-ink)] bg-[var(--pure-hover)]'
              : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]'
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" />
            <circle cx="12" cy="12" r="2.6" />
          </svg>
        </button>
      </div>

      {showFilter && (
        <div className="shrink-0 mx-2 h-8 flex items-center gap-2 px-1 text-[var(--pure-muted)]">
          <SearchIcon className="w-[14px] h-[14px]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation()
                setQuery('')
              }
            }}
            placeholder="筛选文件…"
            aria-label="筛选文件"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[13px] text-[var(--pure-ink)] placeholder:text-[var(--pure-muted)]"
          />
        </div>
      )}

      {rootPath && <div className="shrink-0 mx-3 mb-1 h-px bg-[var(--pure-border)]" aria-hidden="true" />}

      {!rootPath ? (
        <div className="px-3 py-2 text-[12.5px] text-[var(--pure-muted)]">还没有打开项目</div>
      ) : rootStatus === 'loading' || rootStatus === 'idle' ? (
        <div className="px-3 pt-1" role="status" aria-label="正在读取文件">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-7 flex items-center">
              <span
                className="h-[6px] rounded-full bg-[var(--pure-hover)]"
                style={{ width: 92 - i * 16 }}
              />
            </div>
          ))}
        </div>
      ) : rootStatus === 'error' ? (
        <div className="px-3 py-2 flex items-center gap-2 text-[12.5px] text-[var(--pure-muted)]">
          <span>无法读取这个文件夹</span>
          <button
            type="button"
            onClick={retryRoot}
            className="text-[var(--pure-ink)] hover:underline"
          >
            重试
          </button>
        </div>
      ) : (
        <div
          ref={treeRef}
          role="tree"
          aria-label="项目文件"
          tabIndex={-1}
          data-file-tree=""
          onKeyDown={handleTreeKeyDown}
          className="flex-1 min-h-0 overflow-y-auto pure-scroll pb-2 outline-none"
        >
          {rows.map((row) =>
            row.kind === 'entry' ? (
              <FileTreeRow
                key={row.entry.path}
                entry={row.entry}
                depth={row.depth}
                expanded={row.entry.isDirectory && expanded.has(row.entry.path)}
                selected={!row.entry.isDirectory && row.entry.path === activeFilePath}
                tabbable={row.entry.path === tabbablePath}
                onActivate={activateEntry}
                onFocusRow={handleRowFocus}
                onCopyPath={handleCopyPath}
                onOpenMenu={openMenu}
              />
            ) : row.kind === 'loading' ? (
              <div
                key={`loading:${row.entry.path}`}
                role="none"
                aria-hidden="true"
                className="w-full h-7 flex items-center"
                style={{ paddingLeft: 8 + row.depth * 12 }}
              >
                <span
                  className="h-[6px] rounded-full bg-[var(--pure-hover)]"
                  style={{ width: 88 }}
                />
              </div>
            ) : (
              <div
                key={`error:${row.entry.path}`}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={false}
                tabIndex={-1}
                className="w-full min-h-7 pr-2 flex items-center gap-2 text-[12px] text-[var(--pure-muted)]"
                style={{ paddingLeft: 8 + row.depth * 12 }}
              >
                <span className="min-w-0 truncate">无法读取这个文件夹</span>
                <button
                  type="button"
                  onClick={() => retryDir(row.entry.path)}
                  className="shrink-0 text-[var(--pure-ink)] hover:underline"
                >
                  重试
                </button>
              </div>
            ),
          )}
          {rows.length === 0 && (
            <div className="px-3 py-2 text-[12.5px] text-[var(--pure-muted)]">
              {query.trim() ? '没有匹配的文件' : '这个项目还没有文件'}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="删除"
        message={
          pendingDelete
            ? `「${fileBaseName(pendingDelete.path)}」${
                pendingDelete.isDirectory ? '文件夹及其内容' : ''
              }将被永久删除。`
            : ''
        }
        confirmText="删除"
        cancelText="取消"
        variant="danger"
        onConfirm={() => {
          void confirmDelete()
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

const FileTreeRail = memo(FileTreeRailInner)
FileTreeRail.displayName = 'FileTreeRail'
export default FileTreeRail
