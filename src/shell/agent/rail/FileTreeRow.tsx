import { memo } from 'react'
import type { FileEntry } from '@/types'
import DocIcon from '../artifact/DocIcon'
import { detectFileType } from '../artifact/docModel'
import { ChevronIcon } from './railIcons'

export interface FileTreeRowProps {
  entry: FileEntry
  /** 0 = 项目根的直接子项。 */
  depth: number
  /** 目录是否展开（文件恒为 false，不画 chevron）。 */
  expanded: boolean
  /** 与 editorStore.activeFilePath 一致的文件行（浅灰底）。 */
  selected: boolean
  /** 漫游 tabIndex：整棵树同一时刻只有一行是 0。 */
  tabbable: boolean
  onActivate: (entry: FileEntry) => void
  onFocusRow: (path: string) => void
  onCopyPath: (entry: FileEntry) => void
  /** 右键与键盘 Shift+F10 共用。 */
  onOpenMenu: (entry: FileEntry, x: number, y: number) => void
}

/**
 * 文件树的一行（OurCode Pure）：
 *   缩进 = 8 + depth*12；目录带 chevron，文件留同宽空格对齐；
 *   行 hover / 键盘聚焦时右侧出现「复制路径」文字动作 —— 纯文字，无图标块。
 *
 * 键盘不在这里处理：↑↓←→/Enter/F2 需要整份可见行，统一由 FileTreeRail 的
 * 容器 onKeyDown 处理；行只负责焦点落点（onFocusRow → 漫游 tabIndex）。
 * memo：流式 token 引起的父级刷新不得重渲染整棵树（回调都由父级 useCallback 固化）。
 */
function FileTreeRowInner({
  entry,
  depth,
  expanded,
  selected,
  tabbable,
  onActivate,
  onFocusRow,
  onCopyPath,
  onOpenMenu,
}: FileTreeRowProps) {
  const state = selected
    ? 'bg-[var(--pure-hover)] text-[var(--pure-ink)]'
    : entry.isDirectory
      ? 'text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]'
      : 'text-[var(--pure-secondary)] hover:bg-[var(--pure-hover)] hover:text-[var(--pure-ink)]'

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={entry.isDirectory ? expanded : undefined}
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      data-file-row={entry.path}
      title={entry.path}
      onClick={() => onActivate(entry)}
      onFocus={() => onFocusRow(entry.path)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onOpenMenu(entry, event.clientX, event.clientY)
      }}
      className={`pure-row pure-focus w-full min-h-7 pr-2 flex items-center gap-1.5 rounded-md text-[13px] leading-[18px] text-left cursor-pointer transition-colors ${state}`}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center text-[var(--pure-muted)]">
        {entry.isDirectory ? (
          <ChevronIcon collapsed={!expanded} className="w-3 h-3" />
        ) : (
          <DocIcon tone={detectFileType(entry.path).tone} className="w-3 h-3" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      <button
        type="button"
        // 不进 Tab 序列：整栏的 Tab 焦点按行漫游，复制路径另有右键菜单与
        // 「行聚焦时出现的这个动作」；鼠标用户直接点。图标而不是文字，
        // 长文件名不会被「复制路径」四个字挤掉。
        tabIndex={-1}
        aria-label={`复制 ${entry.name} 的路径`}
        title="复制路径"
        onClick={(event) => {
          event.stopPropagation()
          onCopyPath(entry)
        }}
        className="pure-row-actions shrink-0 w-5 h-5 rounded flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-active)] transition-colors"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M15 5H6a2 2 0 00-2 2v9" />
        </svg>
      </button>
    </div>
  )
}

const FileTreeRow = memo(FileTreeRowInner)
FileTreeRow.displayName = 'FileTreeRow'
export default FileTreeRow
