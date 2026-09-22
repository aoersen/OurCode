import { useState, useEffect, useRef, useCallback } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import { useI18n } from '@/i18n/useI18n'
import { isComposingEvent } from '@/utils/composition'

interface QuickOpenFile {
  path: string
  name: string
  relativePath: string
}

export default function QuickOpen({ rootPath }: { rootPath?: string }) {
  const isQuickOpenOpen = useUIStore((s) => s.isQuickOpenOpen)
  const closeQuickOpen = useUIStore((s) => s.closeQuickOpen)
  const openFile = useEditorStore((s) => s.openFile)
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<QuickOpenFile[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const t = useI18n()

  // Collect all files when opened
  useEffect(() => {
    if (!isQuickOpenOpen || !rootPath) return

    setIsLoading(true)
    const collected: QuickOpenFile[] = []

    const walkDir = async (dirPath: string) => {
      try {
        const entries = await window.electronAPI.listDir(dirPath)
        for (const entry of entries) {
          if (entry.isHidden) continue
          if (entry.isDirectory) {
            await walkDir(entry.path)
          } else {
            collected.push({
              path: entry.path,
              name: entry.name,
              relativePath: entry.path.replace(rootPath, '').replace(/^[\\/]/, ''),
            })
          }
        }
      } catch { /* skip */ }
    }

    walkDir(rootPath).then(() => {
      setFiles(collected)
      setIsLoading(false)
    })
  }, [isQuickOpenOpen, rootPath])

  // Focus input on open
  useEffect(() => {
    if (isQuickOpenOpen) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isQuickOpenOpen])

  // Fuzzy match filter
  const filteredFiles = query.trim()
    ? files.filter((f) => {
        const q = query.toLowerCase()
        const name = f.name.toLowerCase()
        const rel = f.relativePath.toLowerCase()
        // Simple fuzzy: check if all chars of query appear in order
        let qi = 0
        for (let i = 0; i < rel.length && qi < q.length; i++) {
          if (rel[i] === q[qi]) qi++
        }
        if (qi === q.length) return true
        return name.includes(q) || rel.includes(q)
      })
        .sort((a, b) => {
          // Prioritize name matches over path matches
          const q = query.toLowerCase()
          const aName = a.name.toLowerCase()
          const bName = b.name.toLowerCase()
          const aNameMatch = aName.includes(q) ? 0 : 1
          const bNameMatch = bName.includes(q) ? 0 : 1
          if (aNameMatch !== bNameMatch) return aNameMatch - bNameMatch
          return a.name.length - b.name.length
        })
        .slice(0, 30)
    : files.slice(0, 30)

  // Handle selection
  const handleSelect = useCallback(async (filePath: string) => {
    await openFile(filePath)
    closeQuickOpen()
  }, [openFile, closeQuickOpen])

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeQuickOpen()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filteredFiles.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && !isComposingEvent(e)) {
      e.preventDefault()
      const file = filteredFiles[selectedIndex]
      if (file) {
        handleSelect(file.path)
      }
    }
  }

  if (!isQuickOpenOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[15%] z-50" onClick={closeQuickOpen}>
      <div
        className="w-[550px] glass-modal rounded-xl overflow-hidden" style={{ boxShadow: 'var(--shadow-xl)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="p-3 border-b border-nova-border">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('sidebar.quickOpenPlaceholder')}
            className="w-full bg-nova-input-bg text-nova-text-primary outline-none placeholder-nova-text-muted px-3 py-2 rounded border border-nova-border focus:border-nova-accent/50 transition-colors"
          />
        </div>

        {/* File List */}
        <div className="max-h-[350px] overflow-y-auto">
          {isLoading ? (
            <div className="px-4 py-6 text-center text-nova-text-muted text-sm">{t('sidebar.loading')}</div>
          ) : filteredFiles.length === 0 ? (
            <div className="px-4 py-6 text-center text-nova-text-muted text-sm">
              {query ? t('sidebar.noMatch') : t('sidebar.noFiles')}
            </div>
          ) : (
            filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`flex items-center px-4 py-2 cursor-pointer text-sm ${
                  index === selectedIndex ? 'bg-nova-accent/20' : 'hover:bg-nova-hover'
                }`}
                onClick={() => handleSelect(file.path)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="text-nova-accent mr-2 text-xs font-mono">
                  {file.name.endsWith('.ts') || file.name.endsWith('.tsx') ? 'TS' :
                   file.name.endsWith('.js') || file.name.endsWith('.jsx') ? 'JS' :
                   file.name.endsWith('.css') ? 'CSS' :
                   file.name.endsWith('.json') ? '{}' :
                   file.name.endsWith('.md') ? 'MD' : '📄'}
                </span>
                <span className="text-nova-text-primary truncate flex-1">{file.name}</span>
                <span className="text-nova-text-muted text-xs ml-3 truncate max-w-[200px]">
                  {file.relativePath}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-nova-border text-xs text-nova-text-muted flex items-center gap-4">
          <span>
            <kbd className="px-1 py-0.5 bg-nova-hover rounded text-[10px]">↑↓</kbd> {t('sidebar.nav')}
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-nova-hover rounded text-[10px]">Enter</kbd> {t('sidebar.openFile')}
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-nova-hover rounded text-[10px]">Esc</kbd> {t('sidebar.close')}
          </span>
        </div>
      </div>
    </div>
  )
}
