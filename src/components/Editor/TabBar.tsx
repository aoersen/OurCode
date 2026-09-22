import { useState } from 'react'
import { useEditorStore } from '@/stores/editorStore'
import { getFileIconHTML } from '@/utils/fileIcons'
import { useI18n } from '@/i18n/useI18n'

interface TabBarProps {
  panelId: string
}

const DND_MIME = 'application/x-ourcode-tab'

interface DragData {
  path: string
  sourcePanelId: string
}

export default function TabBar({ panelId }: TabBarProps) {
  const panels = useEditorStore((s) => s.panels)
  const panelOrder = useEditorStore((s) => s.panelOrder)
  const openFiles = useEditorStore((s) => s.openFiles)
  const setActiveFile = useEditorStore((s) => s.setActiveFile)
  const closeFileWithConfirm = useEditorStore((s) => s.closeFileWithConfirm)
  const closePanelWithConfirm = useEditorStore((s) => s.closePanelWithConfirm)
  const reorderTabs = useEditorStore((s) => s.reorderTabs)
  const moveTabToPanel = useEditorStore((s) => s.moveTabToPanel)
  const saveFile = useEditorStore((s) => s.saveFile)
  const splitPanel = useEditorStore((s) => s.splitPanel)
  const closeEditorArea = useEditorStore((s) => s.closeEditorArea)

  const panel = panels[panelId]
  const tabOrder = panel?.tabOrder ?? []
  const activeFilePath = panel?.activeFilePath ?? null

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const t = useI18n()

  const orderedFiles = tabOrder
    .map((path) => openFiles.find((f) => f.path === path))
    .filter(Boolean)

  const handleDragStart = (e: React.DragEvent, index: number) => {
    const file = orderedFiles[index]
    if (!file) return
    const data: DragData = { path: file.path, sourcePanelId: panelId }
    e.dataTransfer.setData(DND_MIME, JSON.stringify(data))
    e.dataTransfer.effectAllowed = 'move'
    setDragIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropIndex(index)
    setIsDragOver(true)
  }

  const handleTabBarDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }

  const handleDrop = (e: React.DragEvent, index?: number) => {
    e.preventDefault()
    setIsDragOver(false)

    const raw = e.dataTransfer.getData(DND_MIME)
    if (!raw) {
      // Within-panel reorder
      if (dragIndex !== null && index !== undefined && dragIndex !== index) {
        reorderTabs(dragIndex, index, panelId)
      }
      setDragIndex(null)
      setDropIndex(null)
      return
    }

    try {
      const data: DragData = JSON.parse(raw)
      if (data.sourcePanelId === panelId) {
        // Same panel reorder
        if (index !== undefined && dragIndex !== null && dragIndex !== index) {
          reorderTabs(dragIndex, index, panelId)
        }
      } else {
        // Cross-panel move
        const insertIndex = index ?? tabOrder.length
        moveTabToPanel(data.path, data.sourcePanelId, panelId, insertIndex)
      }
    } catch {
      // ignore malformed data
    }
    setDragIndex(null)
    setDropIndex(null)
  }

  const handleDragEnd = () => {
    setDragIndex(null)
    setDropIndex(null)
    setIsDragOver(false)
  }

  const handleClose = (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    // Clean files close immediately; dirty ones prompt Save / Don't Save /
    // Cancel inside closeFileWithConfirm.
    void closeFileWithConfirm(path, panelId)
  }

  const handleSave = (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    saveFile(path)
  }

  const getFileName = (path: string) => {
    return path.split('\\').pop() || path.split('/').pop() || path
  }

  return (
    <>
      <div
        className={`flex bg-transparent overflow-x-auto ${isDragOver ? 'bg-opacity-80 ring-1 ring-accent-blue/30' : ''}`}
        style={{ padding: '8px 12px 4px', gap: 4 }}
        onDragOver={handleTabBarDragOver}
        onDrop={(e) => handleDrop(e)}
        onDragLeave={() => setIsDragOver(false)}
        onDragEnd={handleDragEnd}
      >
        {orderedFiles.map((file, index) => {
          if (!file) return null

          const isActive = file.path === activeFilePath
          const fileName = getFileName(file.path)

          return (
            <div
              key={file.path}
              className={`
                flex items-center h-8 px-3 cursor-pointer
                text-[13px] gap-2 min-w-0
                rounded-full
                group relative select-none transition-all
                ${isActive
                  ? 'bg-nova-surface/90 text-[var(--text-primary)] shadow-sm border border-nova-border'
                  : 'bg-transparent text-nova-text-secondary hover:bg-nova-hover border border-transparent'
                }
                ${dropIndex === index ? 'ring-2 ring-accent-blue' : ''}
              `}
              onClick={() => setActiveFile(file.path, panelId)}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => { e.stopPropagation(); handleDrop(e, index) }}
              onDragEnd={handleDragEnd}
            >
              <span
                className="flex items-center shrink-0"
                dangerouslySetInnerHTML={getFileIconHTML(fileName, false, false, 16)}
              />

              <span className="truncate">
                {fileName}
              </span>

              {file.isDirty && (
                <button
                  onClick={(e) => handleSave(e, file.path)}
                  className="w-2 h-2 rounded-full bg-yellow-500 hover:bg-yellow-400 flex-shrink-0"
                  title={t('editor.saveFile')}
                />
              )}

              <button
                onClick={(e) => handleClose(e, file.path)}
                className={`
                  w-5 h-5 flex items-center justify-center rounded-full shrink-0
                  ${file.isDirty ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
                  hover:bg-nova-border transition-opacity
                `}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                  <path d="M1 1L7 7M7 1L1 7" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
            </div>
          )
        })}

        {orderedFiles.length === 0 && (
          <div
            className="flex items-center h-8 px-4 text-[13px] text-nova-text-muted italic"
            onDragOver={handleTabBarDragOver}
            onDrop={(e) => handleDrop(e)}
          >
            {t('editor.dragTabHint')}
          </div>
        )}

        {/* Panel controls: split + close */}
        <div className="ml-auto flex items-center gap-0.5 px-1 shrink-0">
          <button
            onClick={() => splitPanel('horizontal')}
            className="p-1.5 text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover rounded-full transition-colors"
            title={t('editor.splitLeftRight')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
          </button>
          <button
            onClick={() => splitPanel('vertical')}
            className="p-1.5 text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover rounded-full transition-colors"
            title={t('editor.splitUpDown')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="12" x2="21" y2="12" />
            </svg>
          </button>
          {panelOrder.length > 1 && (
            <button
              onClick={() => void closePanelWithConfirm(panelId)}
              className="p-1.5 text-nova-text-muted hover:text-red-400 hover:bg-nova-hover rounded-full transition-colors"
              title={t('editor.closePanel')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="9" x2="15" y2="15" />
                <line x1="15" y1="9" x2="9" y2="15" />
              </svg>
            </button>
          )}
          <button
            onClick={() => { void closeEditorArea() }}
            className="p-1.5 text-nova-text-muted hover:text-red-400 hover:bg-nova-hover rounded-full transition-colors"
            title={t('editor.hideEditor')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </div>
      </div>
    </>
  )
}
