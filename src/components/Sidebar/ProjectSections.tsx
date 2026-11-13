import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useUIStore, type ProjectSection } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'
import FileTree from './FileTree'
import FileChangesPanel from './FileChangesPanel'
import GitPanel from '../Git/GitPanel'
import { PanelActivityProvider } from './panelActivity'

/**
 * Project-internal accordion: 文件 / 代码管理 / 文件变更.
 *
 * The three sections belong to the project that was double-clicked in the
 * project list — they used to live in Settings (代码管理 / 文件变更) even though
 * they only ever operate on the current workspace. Exactly one section is
 * expanded; the others stay as collapsed header rows, so switching never loses
 * the tree's scroll position or a half-typed commit message:
 *
 * - a section is mounted on first visit and then kept alive (hidden via
 *   `display:none`, background work paused through the panel-activity contract);
 * - the expanded body is the flex child that fills the sidebar, collapsed
 *   headers stack below it (classic accordion order: header, body, next header).
 */

const SECTION_ICON = {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const SECTIONS: Array<{ id: ProjectSection; labelKey: TranslationKey; icon: ReactNode }> = [
  {
    id: 'files',
    labelKey: 'projectSection.files',
    icon: (
      <svg {...SECTION_ICON} aria-hidden="true">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: 'git',
    labelKey: 'projectSection.git',
    icon: (
      <svg {...SECTION_ICON} aria-hidden="true">
        <circle cx="6" cy="6" r="2.2" />
        <circle cx="18" cy="6" r="2.2" />
        <circle cx="6" cy="18" r="2.2" />
        <path d="M6 8.2v7.6" />
        <path d="M6 12c0-3 3.5-4 7.2-5.4" />
      </svg>
    ),
  },
  {
    id: 'changes',
    labelKey: 'projectSection.changes',
    icon: (
      <svg {...SECTION_ICON} aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 15h6" />
        <path d="M8 11h3" />
      </svg>
    ),
  },
]

interface ProjectSectionsProps {
  /** Workspace root of the project being browsed — both the tree and the
   *  AI-change list are scoped to it. */
  rootPath: string
  /** Bumped by the parent header's refresh action — reloads the file tree. */
  refreshSignal?: number
}

export default function ProjectSections({ rootPath, refreshSignal }: ProjectSectionsProps) {
  const t = useI18n()
  const section = useUIStore((s) => s.projectSection)
  const setSection = useUIStore((s) => s.setProjectSection)
  // Sections are mounted on first visit and then kept alive: remounting would
  // drop the tree's scroll position, the git commit draft and the log toggle.
  const [mounted, setMounted] = useState<Set<ProjectSection>>(() => new Set([section]))
  useEffect(() => {
    setMounted((prev) => (prev.has(section) ? prev : new Set(prev).add(section)))
  }, [section])

  return (
    <div className="h-full flex flex-col">
      {SECTIONS.map(({ id, labelKey, icon }) => {
        const open = section === id
        return (
          <Fragment key={id}>
            <button
              type="button"
              data-project-section={id}
              aria-expanded={open}
              // The panel is mounted lazily on first visit — only point at an id
              // that actually exists in the DOM.
              aria-controls={mounted.has(id) ? `project-section-panel-${id}` : undefined}
              onClick={() => setSection(id)}
              className={`shrink-0 flex w-full items-center gap-2 border-b border-glass-border/40 px-3 py-2 text-left text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nova-accent/40 ${
                open
                  ? 'bg-white/70 text-nova-text-primary dark:bg-white/10'
                  : 'text-nova-text-secondary hover:bg-white/50 hover:text-nova-text-primary dark:hover:bg-white/5'
              }`}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90 text-nova-text-primary' : 'text-nova-text-muted'}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className={`shrink-0 flex ${open ? 'text-nova-accent' : 'text-nova-text-muted'}`}>{icon}</span>
              <span className="flex-1 truncate">{t(labelKey)}</span>
            </button>

            {mounted.has(id) && (
              <PanelActivityProvider value={open}>
                <div
                  id={`project-section-panel-${id}`}
                  role="region"
                  aria-label={t(labelKey)}
                  className={open ? 'flex-1 min-h-0 overflow-hidden' : 'hidden'}
                >
                  {id === 'files' ? (
                    <FileTree rootPath={rootPath} refreshSignal={refreshSignal} />
                  ) : id === 'git' ? (
                    <GitPanel />
                  ) : (
                    <FileChangesPanel projectPath={rootPath} />
                  )}
                </div>
              </PanelActivityProvider>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
