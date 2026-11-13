/**
 * Project switcher popover for the welcome hub.
 *
 * The old welcome screen could only continue the project it was already bound
 * to; this panel is the fix — pick any recent project before starting the first
 * conversation. It is a floating panel (no layout shift) with search + keyboard
 * navigation, and it reads only real project/session data.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/useI18n'
import { useShortcutStore } from '@/stores/shortcutStore'
import type { WelcomeProjectSummary } from './welcomeUtils'
import { formatRelativeTime } from './welcomeUtils'
import { relativeLabel } from './useWelcomeData'
import { CheckIcon, FolderIcon, PlusIcon, SearchIcon, TrashIcon } from './WelcomeIcons'

interface ProjectSwitcherPopoverProps {
  projects: WelcomeProjectSummary[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onOpenFolder: () => void
  onRemove: (path: string) => void
  onClose: () => void
}

const LISTBOX_ID = 'welcome-project-listbox'
const optionId = (index: number) => `welcome-project-option-${index}`

export default function ProjectSwitcherPopover({
  projects,
  selectedPath,
  onSelect,
  onOpenFolder,
  onRemove,
  onClose,
}: ProjectSwitcherPopoverProps) {
  const t = useI18n()
  const openFolderKey = useShortcutStore((s) => s.getShortcut('openFolder'))
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    )
  }, [projects, query])

  // Keep the highlighted row valid when the query changes or the selected
  // project moves. The selected row is the most likely target, so start there.
  useEffect(() => {
    const index = filtered.findIndex((p) => p.path === selectedPath)
    setHighlight(index >= 0 ? index : 0)
  }, [filtered, selectedPath])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const highlightedProject = filtered[highlight] ?? null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (filtered.length === 0) return
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      setHighlight((current) => (current + dir + filtered.length) % filtered.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (highlightedProject) onSelect(highlightedProject.path)
    }
  }

  return (
    <div
      role="dialog"
      aria-label={t('welcome.project.switch')}
      onKeyDown={handleKeyDown}
      className="absolute right-0 top-[calc(100%+8px)] z-30 w-[440px] max-w-[calc(100vw-36px)] overflow-hidden rounded-xl border border-nova-border bg-[var(--surface-popover)] shadow-xl"
      style={{ animation: 'fadeIn 0.12s ease-out' }}
    >
      {/* Search — the popover and its field are OPAQUE: at 440px it floats over
          the composer and starter chips, and a translucent white over text read
          as a smudged glass panel. */}
      <div className="border-b border-nova-border bg-[var(--surface-sunken)] p-2.5">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 w-3.5 h-3.5 -translate-y-1/2 text-nova-text-muted" />
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-label={t('welcome.project.search')}
            aria-expanded
            aria-controls={LISTBOX_ID}
            aria-activedescendant={highlightedProject ? optionId(highlight) : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('welcome.project.search')}
            className="h-8 w-full rounded-lg border border-nova-border bg-[var(--surface)] pl-8 pr-12 text-[12.5px] text-nova-text-primary outline-none transition-colors placeholder:text-nova-text-muted focus:border-accent-60"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-nova-border px-1 py-px font-mono text-[9.5px] leading-tight text-nova-text-muted">
            ESC
          </span>
        </div>
      </div>

      {/* Recent projects */}
      <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[10.5px] font-medium text-nova-text-muted">
        <span>{t('welcome.project.recent')}</span>
        <span>{t('welcome.project.recentHint')}</span>
      </div>
      <div
        id={LISTBOX_ID}
        role="listbox"
        aria-label={t('welcome.project.recent')}
        className="max-h-[260px] overflow-y-auto p-1.5"
      >
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11.5px] text-nova-text-muted">
            {projects.length === 0
              ? t('welcome.project.empty')
              : t('welcome.project.noMatch')}
          </div>
        ) : (
          filtered.map((project, index) => {
            const isSelected = project.path === selectedPath
            const isHighlighted = index === highlight
            const timeLabel = project.lastOpened > 0
              ? relativeLabel(formatRelativeTime(project.lastOpened), t)
              : ''
            return (
              <div
                key={project.path}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                onClick={() => onSelect(project.path)}
                onMouseEnter={() => setHighlight(index)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${
                  isHighlighted ? 'bg-nova-hover' : ''
                } ${isSelected ? 'bg-nova-accent/[0.06]' : ''}`}
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                    isSelected
                      ? 'bg-nova-accent text-white'
                      : 'bg-nova-accent/10 text-nova-accent'
                  }`}
                >
                  <FolderIcon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-nova-text-primary">
                      {project.name}
                    </span>
                    {timeLabel && (
                      <span className="shrink-0 text-[10.5px] text-nova-text-muted">{timeLabel}</span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-nova-text-muted">
                      {project.path}
                    </span>
                    {project.sessionCount > 0 && (
                      <span className="shrink-0 text-[10px] text-nova-text-muted">
                        {t('welcome.project.sessions', { count: project.sessionCount })}
                      </span>
                    )}
                  </span>
                </span>
                {isSelected && (
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-nova-accent text-white">
                    <CheckIcon className="h-3 w-3" />
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Footer */}
      <div className="flex h-10 items-center justify-between gap-2 border-t border-nova-border px-3">
        <button
          type="button"
          onClick={onOpenFolder}
          className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium text-nova-accent transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/40"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          <span className="truncate">{t('welcome.project.openFolder')}</span>
          {openFolderKey && (
            <span className="shrink-0 rounded border border-nova-border px-1 py-px font-mono text-[9.5px] leading-tight text-nova-text-muted">
              {openFolderKey.replace(/\+/g, ' ')}
            </span>
          )}
        </button>
        {highlightedProject && (
          <button
            type="button"
            onClick={() => onRemove(highlightedProject.path)}
            className="flex shrink-0 items-center gap-1 text-[11.5px] text-nova-text-muted transition-colors hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error-30"
          >
            <TrashIcon className="h-3 w-3" />
            {t('welcome.project.remove')}
          </button>
        )}
      </div>
    </div>
  )
}
