import { useState, useCallback } from 'react'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { SearchResult } from '@/types'
import { useI18n } from '@/i18n/useI18n'
import { isComposingEvent } from '@/utils/composition'

export default function SearchPanel() {
  const [query, setQuery] = useState('')
  const [replaceValue, setReplaceValue] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [showReplace, setShowReplace] = useState(false)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [filePattern, setFilePattern] = useState('')
  const [excludeFolders, setExcludeFolders] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const t = useI18n()

  // Select the ACTION only — a whole-store subscription would re-render the
  // search panel on every editorStore change (cursor moves while editing).
  const openFile = useEditorStore((s) => s.openFile)

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setResults([])
      return
    }

    const rootPath = useUIStore.getState().rootPath
    if (!rootPath) return

    setIsSearching(true)
    try {
      const searchResults = await window.electronAPI.searchInFiles(rootPath, query, {
        caseSensitive,
        wholeWord,
        regex: useRegex,
        filePattern: filePattern.trim() || undefined,
        excludeFolders: excludeFolders.trim() || undefined,
      })
      setResults(searchResults)
      // Expand all files with results
      setExpandedFiles(new Set(searchResults.map((r) => r.filePath)))
    } catch (error) {
      console.error('搜索失败:', error)
    } finally {
      setIsSearching(false)
    }
  }, [query, caseSensitive, wholeWord, useRegex, filePattern, excludeFolders])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组合期间的回车是确认候选词，不触发搜索
    if (e.key === 'Enter' && !isComposingEvent(e)) {
      handleSearch()
    }
  }

  const toggleFile = (filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }

  const handleResultClick = (result: SearchResult) => {
    openFile(result.filePath)
    // Scroll to line and highlight match after a short delay (wait for model to load)
    setTimeout(() => {
      const editor = (window as any).__monacoEditor
      if (editor) {
        editor.revealLineInCenter(result.lineNumber)
        editor.setPosition({ lineNumber: result.lineNumber, column: result.matchStart + 1 })
        editor.focus()
        // Highlight the matching text
        const model = editor.getModel()
        if (model) {
          const decorations = editor.deltaDecorations([], [{
            range: {
              startLineNumber: result.lineNumber,
              startColumn: result.matchStart + 1,
              endLineNumber: result.lineNumber,
              endColumn: result.matchEnd + 1,
            },
            options: { inlineClassName: 'searchHighlight', isWholeLine: false },
          }])
          // Clear highlight after 3 seconds
          setTimeout(() => editor.deltaDecorations(decorations, []), 3000)
        }
      }
    }, 150)
  }

  const handleReplaceAll = async () => {
    if (!replaceValue.trim() || results.length === 0) return

    // Staleness guard: the search results carry line numbers + column offsets
    // captured at search time. If a file was edited after the search (manual
    // typing, an agent write, a build regenerating files), those offsets no
    // longer describe the current text — blind splicing would corrupt the file.
    // Verify the exact span still matches the query before touching it and
    // skip results that no longer do (fail-closed).
    const isMatchAt = (text: string, start: number, end: number): boolean => {
      if (start < 0 || end > text.length || start >= end) return false
      if (useRegex) {
        try {
          const flags = caseSensitive ? 'g' : 'gi'
          const re = new RegExp(query, flags)
          re.lastIndex = start
          const m = re.exec(text)
          return m !== null && m.index === start && m[0].length === end - start
        } catch {
          return false
        }
      }
      const slice = text.slice(start, end)
      return caseSensitive ? slice === query : slice.toLowerCase() === query.toLowerCase()
    }

    const fileGroups = new Map<string, SearchResult[]>()
    for (const result of results) {
      const group = fileGroups.get(result.filePath) || []
      group.push(result)
      fileGroups.set(result.filePath, group)
    }

    for (const [filePath, fileResults] of fileGroups) {
      try {
        const { content, encoding, hasBom } = await window.electronAPI.readFile(filePath)
        let newContent = content

        // Sort results by position (descending) to replace from end to start
        const sorted = [...fileResults].sort((a, b) => b.matchStart - a.matchStart)

        for (const result of sorted) {
          const lineStart = newContent.split('\n').slice(0, result.lineNumber - 1).join('\n').length + (result.lineNumber > 1 ? 1 : 0)
          const matchStart = lineStart + result.matchStart
          const matchEnd = lineStart + result.matchEnd
          if (!isMatchAt(newContent, matchStart, matchEnd)) continue // stale — leave the file untouched here
          newContent = newContent.slice(0, matchStart) + replaceValue + newContent.slice(matchEnd)
        }

        await window.electronAPI.writeFile(filePath, newContent, encoding, hasBom)

        // Refresh open editors so Monaco doesn't show stale content
        if (useEditorStore.getState().openFiles.some((f) => f.path === filePath)) {
          await useEditorStore.getState().revertFile(filePath)
        }
      } catch (error) {
        console.error(`替换文件失败: ${filePath}`, error)
      }
    }

    // Re-search
    handleSearch()
  }

  // Group results by file
  const groupedResults = new Map<string, SearchResult[]>()
  for (const result of results) {
    const group = groupedResults.get(result.filePath) || []
    group.push(result)
    groupedResults.set(result.filePath, group)
  }

  return (
    <div className="h-full flex flex-col text-sm">
      {/* Search input */}
      <div className="p-2 space-y-1">
        <div className="flex items-center gap-1">
          <div className="flex-1 flex items-center bg-nova-input-bg border border-nova-border rounded px-2 py-1 focus-within:border-nova-accent/50">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('search.placeholder')}
              className="flex-1 bg-transparent text-nova-text-primary text-xs outline-none placeholder:text-nova-text-muted"
            />
            {query && (
              <button
                onClick={() => { setQuery(''); setResults([]) }}
                className="text-nova-text-muted hover:text-nova-text-primary ml-1"
              >
                &times;
              </button>
            )}
          </div>
        </div>

        {/* Search options */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCaseSensitive(!caseSensitive)}
            className={`px-1.5 py-0.5 text-[10px] rounded ${
              caseSensitive ? 'bg-nova-accent/20 text-nova-accent' : 'text-nova-text-muted hover:bg-nova-hover'
            }`}
            title={t('search.caseSensitive')}
          >
            Aa
          </button>
          <button
            onClick={() => setWholeWord(!wholeWord)}
            className={`px-1.5 py-0.5 text-[10px] rounded ${
              wholeWord ? 'bg-nova-accent/20 text-nova-accent' : 'text-nova-text-muted hover:bg-nova-hover'
            }`}
            title={t('search.wholeWord')}
          >
            Ab
          </button>
          <button
            onClick={() => setUseRegex(!useRegex)}
            className={`px-1.5 py-0.5 text-[10px] rounded ${
              useRegex ? 'bg-nova-accent/20 text-nova-accent' : 'text-nova-text-muted hover:bg-nova-hover'
            }`}
            title={t('search.regex')}
          >
            .*
          </button>
          <button
            onClick={() => setShowReplace(!showReplace)}
            className={`px-1.5 py-0.5 text-[10px] rounded ${
              showReplace ? 'bg-nova-accent/20 text-nova-accent' : 'text-nova-text-muted hover:bg-nova-hover'
            }`}
            title={t('search.replace')}
          >
            {t('search.replace')}
          </button>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-1.5 py-0.5 text-[10px] rounded ml-auto ${
              showFilters ? 'bg-nova-accent/20 text-nova-accent' : 'text-nova-text-muted hover:bg-nova-hover'
            }`}
            title={t('search.fileFilter')}
          >
            {t('search.fileFilter')}
          </button>
        </div>

        {/* Replace input */}
        {showReplace && (
          <div className="flex items-center gap-1">
            <div className="flex-1 flex items-center bg-nova-input-bg border border-nova-border rounded px-2 py-1 focus-within:border-nova-accent/50">
              <input
                type="text"
                value={replaceValue}
                onChange={(e) => setReplaceValue(e.target.value)}
                placeholder={t('search.replacePlaceholder')}
                className="flex-1 bg-transparent text-nova-text-primary text-xs outline-none placeholder:text-nova-text-muted"
              />
            </div>
            <button
              onClick={handleReplaceAll}
              disabled={!replaceValue.trim() || results.length === 0}
              className="px-2 py-1 text-[10px] bg-nova-accent/20 text-nova-accent rounded hover:bg-nova-accent/30 disabled:opacity-30"
              title={t('search.replaceAll')}
            >
              {t('search.replaceAll')}
            </button>
          </div>
        )}

        {/* File filters */}
        {showFilters && (
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-nova-text-muted w-10 shrink-0">{t('search.fileType')}</span>
              <div className="flex-1 flex items-center bg-nova-input-bg border border-nova-border rounded px-2 py-1 focus-within:border-nova-accent/50">
                <input
                  type="text"
                  value={filePattern}
                  onChange={(e) => setFilePattern(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="*.ts,*.tsx"
                  className="flex-1 bg-transparent text-nova-text-primary text-xs outline-none placeholder:text-nova-text-muted"
                />
                {filePattern && (
                  <button
                    onClick={() => setFilePattern('')}
                    className="text-nova-text-muted hover:text-nova-text-primary ml-1"
                  >
                    &times;
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-nova-text-muted w-10 shrink-0">{t('search.exclude')}</span>
              <div className="flex-1 flex items-center bg-nova-input-bg border border-nova-border rounded px-2 py-1 focus-within:border-nova-accent/50">
                <input
                  type="text"
                  value={excludeFolders}
                  onChange={(e) => setExcludeFolders(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="node_modules,.git,dist"
                  className="flex-1 bg-transparent text-nova-text-primary text-xs outline-none placeholder:text-nova-text-muted"
                />
                {excludeFolders && (
                  <button
                    onClick={() => setExcludeFolders('')}
                    className="text-nova-text-muted hover:text-nova-text-primary ml-1"
                  >
                    &times;
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Results count */}
      {results.length > 0 && (
        <div className="px-3 py-1 text-[11px] text-nova-text-muted border-t border-nova-border">
          {t('search.resultCount', { results: results.length, files: groupedResults.size })}
        </div>
      )}

      {/* Results list */}
      <div className="flex-1 overflow-y-auto">
        {isSearching && (
          <div className="p-4 text-center text-nova-text-muted text-xs">
            {t('search.searching')}
          </div>
        )}

        {!isSearching && query && results.length === 0 && (
          <div className="p-4 text-center text-nova-text-muted text-xs">
            {t('search.noResults')}
          </div>
        )}

        {Array.from(groupedResults.entries()).map(([filePath, fileResults]) => {
          const fileName = filePath.split(/[/\\]/).pop() || filePath
          const isExpanded = expandedFiles.has(filePath)

          return (
            <div key={filePath}>
              <button
                className="w-full text-left px-2 py-1.5 flex items-center gap-1 hover:bg-nova-hover text-nova-text-secondary"
                onClick={() => toggleFile(filePath)}
              >
                <span className="text-[10px] text-nova-text-muted">{isExpanded ? '▼' : '▶'}</span>
                <span className="text-xs font-medium truncate">{fileName}</span>
                <span className="text-[10px] text-nova-text-muted ml-auto">{fileResults.length}</span>
              </button>

              {isExpanded && fileResults.map((result, index) => (
                <button
                  key={index}
                  className="w-full text-left px-4 py-1 hover:bg-nova-hover flex items-start gap-2"
                  onClick={() => handleResultClick(result)}
                >
                  <span className="text-[10px] text-nova-text-muted w-8 text-right shrink-0 pt-0.5">
                    {result.lineNumber}
                  </span>
                  <span className="text-xs text-nova-text-secondary truncate font-mono">
                    {result.lineContent.trim()}
                  </span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
