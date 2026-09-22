import { memo, useState } from 'react'
import { FileEntry } from '@/types'
import { getFileIconHTML } from '@/utils/fileIcons'
import { useUIStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import { useI18n } from '@/i18n/useI18n'
import { askText } from '@/components/Common/PromptDialog'

// Module-level clipboard for file copy/cut operations
const fileClipboard: { path: string | null; action: 'copy' | 'cut' | null } = { path: null, action: null }
// Module-level drag source (exported so the chat input can recognize a tree drag)
export const dragSource: { path: string | null; isDirectory: boolean } = { path: null, isDirectory: false }

interface FileTreeNodeProps {
  entry: FileEntry
  depth: number
  isExpanded: boolean
  onClick: (path: string, isDirectory: boolean) => void
  onRefresh?: () => void
  /** Path open in the editor — the matching row shows the selected state */
  activePath?: string | null
}

function FileTreeNode({
  entry,
  depth,
  isExpanded,
  onClick,
  onRefresh,
  activePath,
}: FileTreeNodeProps) {
  const paddingLeft = depth * 12 + 8
  // Select just the action (stable) — a whole-store subscription would re-render
  // every tree node on ANY uiStore change (notifications, toggles, ...).
  const showContextMenu = useUIStore((s) => s.showContextMenu)
  const [isDragOver, setIsDragOver] = useState(false)
  const t = useI18n()
  const isActive = activePath === entry.path

  const handleClick = () => {
    onClick(entry.path, entry.isDirectory)
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const sep = entry.path.includes('/') ? '/' : '\\'
    const parentPath = entry.path.substring(0, entry.path.lastIndexOf(sep))
    const getDestPath = (dir: string, name: string) => `${dir}${sep}${name}`

    const commonFileItems = [
      {
        label: t('common.copy'),
        icon: '',
        action: () => { fileClipboard.path = entry.path; fileClipboard.action = 'copy' },
      },
      {
        label: t('sidebar.cut'),
        icon: '',
        action: () => { fileClipboard.path = entry.path; fileClipboard.action = 'cut' },
      },
      { separator: true, label: '' },
      {
        label: t('common.rename'),
        icon: '',
        action: async () => {
          const newName = await askText({ title: t('sidebar.renamePrompt'), defaultValue: entry.name })
          if (newName && newName !== entry.name) {
            await window.electronAPI.rename(entry.path, getDestPath(parentPath, newName))
            onRefresh?.()
          }
        },
      },
      {
        label: t('common.delete'),
        icon: '',
        action: async () => {
          if (confirm(t('sidebar.deleteConfirm', { name: entry.name }))) {
            await window.electronAPI.delete(entry.path)
            onRefresh?.()
          }
        },
      },
      { separator: true, label: '' },
      {
        label: t('sidebar.copyPath'),
        icon: '',
        action: () => window.electronAPI.copyPath(entry.path),
      },
      {
        label: t('sidebar.revealInExplorer'),
        icon: '',
        action: () => window.electronAPI.openInFinder(entry.path),
      },
    ]

    const pasteItem = fileClipboard.path ? {
      label: fileClipboard.action === 'cut' ? t('sidebar.pasteMove') : t('sidebar.paste'),
      icon: '',
      action: async () => {
        if (!fileClipboard.path) return
        const srcName = fileClipboard.path.split(/[/\\]/).pop() || ''
        const dest = getDestPath(entry.path, srcName)
        try {
          if (fileClipboard.action === 'cut') {
            await window.electronAPI.move(fileClipboard.path, dest)
            fileClipboard.path = null
            fileClipboard.action = null
          } else {
            await window.electronAPI.copy(fileClipboard.path, dest)
          }
          onRefresh?.()
        } catch (err) {
          alert(t('sidebar.operationFailed', { error: String(err) }))
        }
      },
    } : null

    const items = entry.isDirectory ? [
      {
        label: t('sidebar.newFile'),
        icon: '',
        action: async () => {
          const name = await askText({ title: t('sidebar.newFileNamePrompt') })
          if (name) {
            await window.electronAPI.createFile(getDestPath(entry.path, name))
            onRefresh?.()
          }
        },
      },
      {
        label: t('sidebar.newFolder'),
        icon: '',
        action: async () => {
          const name = await askText({ title: t('sidebar.newFolderNamePrompt') })
          if (name) {
            await window.electronAPI.createDir(getDestPath(entry.path, name))
            onRefresh?.()
          }
        },
      },
      ...(pasteItem ? [{ separator: true, label: '' }, pasteItem] : []),
      { separator: true, label: '' },
      ...commonFileItems.slice(0, 2), // copy, cut
      ...commonFileItems.slice(2),    // separator + rename + delete + separator + copyPath + openInFinder
    ] : [
      {
        label: t('sidebar.open'),
        icon: '',
        action: () => useEditorStore.getState().openFile(entry.path),
      },
      { separator: true, label: '' },
      ...commonFileItems,
    ]

    showContextMenu(e.clientX, e.clientY, items)
  }

  const handleDragStart = (e: React.DragEvent) => {
    dragSource.path = entry.path
    dragSource.isDirectory = entry.isDirectory
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', entry.path)
    // Custom MIME type so ChatInput can reliably read the path even when
    // Vite HMR creates a fresh module instance of FileTreeNode (which would
    // break the module-level dragSource reference held by ChatInput).
    e.dataTransfer.setData('application/x-ourcode-path', entry.path)
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!entry.isDirectory) return
    if (!dragSource.path) return
    // Prevent dropping onto self
    if (dragSource.path === entry.path) return
    // Prevent dropping a parent folder into its own child
    const sep = dragSource.path.includes('/') ? '/' : '\\'
    if (dragSource.isDirectory && entry.path.startsWith(dragSource.path + sep)) return

    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }

  const handleDragLeave = () => {
    setIsDragOver(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const src = dragSource.path
    if (!src || !entry.isDirectory) return
    if (src === entry.path) return

    const sep = src.includes('/') ? '/' : '\\'
    if (dragSource.isDirectory && entry.path.startsWith(src + sep)) return

    const srcName = src.split(/[/\\]/).pop() || ''
    const dest = `${entry.path}${sep}${srcName}`

    try {
      await window.electronAPI.move(src, dest)
      onRefresh?.()
    } catch (err) {
      alert(t('sidebar.moveFailed', { error: String(err) }))
    }
  }

  const handleDragEnd = () => {
    dragSource.path = null
    dragSource.isDirectory = false
    setIsDragOver(false)
  }

  return (
    <div>
      <div
        className={`group relative flex items-center h-[26px] px-2 cursor-pointer rounded-md mx-2 transition-colors ${
          isDragOver
            ? 'bg-accent-15 ring-1 ring-accent-50'
            : isActive
              ? 'bg-accent-10'
              : 'hover:bg-nova-hover'
        }`}
        style={{ paddingLeft }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable={true}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
      >
        {/* Active accent bar (Stitch: left primary rounded bar on selected file) */}
        {isActive && (
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-3.5 bg-nova-accent rounded-r-full"
            aria-hidden="true"
          />
        )}

        {/* Expand/Collapse icon */}
        {entry.isDirectory ? (
          <span className="w-4 mr-1 text-text-muted text-xs">
            {isExpanded ? '▼' : '▶'}
          </span>
        ) : (
          <span className="w-4 mr-1" />
        )}

        {/* File icon */}
        <span
          className="mr-2 flex items-center"
          dangerouslySetInnerHTML={getFileIconHTML(entry.name, entry.isDirectory, isExpanded, 16)}
        />

        {/* File name */}
        <span className={`flex-1 text-[13px] truncate transition-colors ${
          isActive
            ? 'text-nova-text-primary font-medium'
            : entry.isDirectory
              ? 'text-nova-text-secondary group-hover:text-nova-text-primary'
              : 'text-nova-text-primary'
        }`}>
          {entry.name}
        </span>

        {/* Git status — colored badge letter (Stitch: M warning / A success / D error / R info) */}
        {entry.gitStatus && (
          <span
            className="text-xs font-bold px-1 rounded"
            style={{
              color:
                entry.gitStatus === 'modified' ? 'var(--yellow, #d97706)'
                : entry.gitStatus === 'added' ? 'var(--green, #16a34a)'
                : entry.gitStatus === 'deleted' ? 'var(--red, #dc2626)'
                : '#3B82F6',
            }}
          >
            {entry.gitStatus === 'modified' ? 'M' : entry.gitStatus === 'added' ? 'A' : entry.gitStatus === 'deleted' ? 'D' : 'R'}
          </span>
        )}
      </div>
    </div>
  )
}

export default memo(FileTreeNode)
