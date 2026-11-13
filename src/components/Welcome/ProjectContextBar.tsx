/**
 * Project context bar — the one thing v2 was missing.
 *
 * It states which project the next conversation will be created in, and opens
 * the project switcher without leaving the welcome page. The bar is the anchor;
 * the popover is a transient overlay so the page never reflows when it opens.
 */
import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n/useI18n'
import type { WelcomeProjectSummary } from './welcomeUtils'
import ProjectSwitcherPopover from './ProjectSwitcherPopover'
import { ChevronDownIcon, FolderIcon } from './WelcomeIcons'

interface ProjectContextBarProps {
  project: WelcomeProjectSummary | null
  projects: WelcomeProjectSummary[]
  open: boolean
  onToggle: () => void
  onClose: () => void
  onSelect: (path: string) => void
  onOpenFolder: () => void
  onRemove: (path: string) => void
}

export default function ProjectContextBar({
  project,
  projects,
  open,
  onToggle,
  onClose,
  onSelect,
  onOpenFolder,
  onRemove,
}: ProjectContextBarProps) {
  const t = useI18n()
  const wrapRef = useRef<HTMLDivElement>(null)

  // Clicking anywhere outside the bar/popover closes the switcher. The trigger
  // lives inside the wrapper, so clicking it toggles instead of double-firing.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, onClose])

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex min-h-[56px] items-center gap-3 rounded-xl border border-nova-border bg-nova-card px-3.5 py-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-nova-accent/10 text-nova-accent">
          <FolderIcon className="h-4 w-4" />
        </span>

        {project ? (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span
              className="max-w-[190px] shrink-0 truncate text-[13px] font-semibold text-nova-text-primary"
              title={project.name}
            >
              {project.name}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-nova-text-muted"
              title={project.path}
            >
              {project.path}
            </span>
            <span className="hidden shrink-0 rounded-full bg-nova-accent/10 px-2 py-0.5 text-[10.5px] font-medium text-nova-accent sm:inline">
              {t('welcome.project.current')}
            </span>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-nova-text-secondary">
              {t('welcome.project.none')}
            </div>
            <div className="mt-0.5 truncate text-[10.5px] text-nova-text-muted">
              {t('welcome.project.noneHint')}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onToggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-nova-border bg-nova-card px-3 text-[11.5px] font-medium text-nova-text-secondary transition-colors hover:border-nova-accent/40 hover:text-nova-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/40"
        >
          {t('welcome.project.switch')}
          <ChevronDownIcon
            className={`h-3 w-3 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {open && (
        <ProjectSwitcherPopover
          projects={projects}
          selectedPath={project?.path ?? null}
          onSelect={onSelect}
          onOpenFolder={onOpenFolder}
          onRemove={onRemove}
          onClose={onClose}
        />
      )}
    </div>
  )
}
