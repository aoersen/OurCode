import { useMemo, useRef, useState } from 'react'
import { useEditorStore } from '@/stores/editorStore'
import { useRecentFilesStore } from '@/stores/recentFilesStore'
import { baseName, filterArtifactCandidates } from './artifactModel'

interface PanelFilePickerProps {
  onPick: (path: string) => void
  onClose: () => void
}

/**
 * 面板内的「+」文件选择器。
 *
 * 为什么不复用 components/Sidebar/QuickOpen：QuickOpen 只在旧工作台 MainLayout
 * 里挂载，由 uiStore.isQuickOpenOpen 驱动，agent 壳里没有任何宿主渲染它 —— 直接
 * 调 openQuickOpen() 只会改一个没人订阅的开关。所以这里做一个 260px 的小浮层，
 * 数据源是最近文件（recentFilesStore）+ 当前打开的文件。
 */
export default function PanelFilePicker({ onPick, onClose }: PanelFilePickerProps) {
  const recentFiles = useRecentFilesStore((s) => s.files)
  const openFiles = useEditorStore((s) => s.openFiles)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const candidates = useMemo(() => {
    const ordered = [...openFiles.map((file) => file.path), ...recentFiles]
    return filterArtifactCandidates(ordered, query)
  }, [openFiles, recentFiles, query])

  const pick = (path: string | undefined) => {
    if (!path) return
    onPick(path)
    onClose()
  }

  return (
    <>
      {/* 点击浮层外部关闭（不画遮罩，保持纯白画布） */}
      <div className="fixed inset-0 z-30" aria-hidden="true" onClick={onClose} />
      <div
        role="dialog"
        aria-label="打开产物文件"
        className="pure-card-shadow absolute right-4 top-[46px] z-40 w-[268px] rounded-xl bg-[var(--pure-canvas)] p-2"
      >
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              onClose()
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              setCursor((index) => Math.min(index + 1, Math.max(0, candidates.length - 1)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setCursor((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              pick(candidates[cursor] ?? candidates[0])
            }
          }}
          placeholder="搜索最近文件…"
          aria-label="搜索最近文件"
          spellCheck={false}
          className="w-full h-8 px-2.5 mb-1 rounded-lg bg-[var(--pure-hover)] text-[12.5px] text-[var(--pure-ink)] outline-none border-0 placeholder:text-[var(--pure-muted)]"
        />
        <div className="max-h-[240px] overflow-y-auto pure-scroll">
          {candidates.length === 0 ? (
            <div className="px-2.5 py-3 text-[12px] leading-[18px] text-[var(--pure-muted)]">
              还没有最近打开的文件。先在左侧会话里让 agent 改一个文件，或在工作台打开文件。
            </div>
          ) : (
            candidates.map((path, index) => (
              <button
                key={path}
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => pick(path)}
                aria-label={`打开 ${path}`}
                title={path}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors ${
                  index === cursor ? 'bg-[var(--pure-hover)]' : ''
                }`}
              >
                <span className="block text-[12.5px] leading-[18px] text-[var(--pure-ink)] truncate">
                  {baseName(path)}
                </span>
                <span className="block text-[11px] leading-[16px] text-[var(--pure-muted)] truncate">
                  {path}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  )
}
