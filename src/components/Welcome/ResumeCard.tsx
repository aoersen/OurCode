/**
 * The single "continue where you left off" row.
 *
 * This is the ONLY place in the welcome canvas where project + session context
 * appears: the sidebar already lists every project and session, so putting a
 * second list here would just be the same data three times. Everything above
 * the fold that is duplicated gets removed, not restyled.
 */
import { useI18n } from '@/i18n/useI18n'
import type { ResumeTarget } from './useWelcomeData'
import { relativeLabel } from './useWelcomeData'
import { formatRelativeTime } from './welcomeUtils'
import { ArrowRightIcon, ClockIcon, PlayIcon } from './WelcomeIcons'

interface ResumeCardProps {
  target: ResumeTarget
  onResume: (target: ResumeTarget) => void
}

export default function ResumeCard({ target, onResume }: ResumeCardProps) {
  const t = useI18n()
  const timeLabel = relativeLabel(formatRelativeTime(target.lastActivity), t)

  return (
    <button
      type="button"
      onClick={() => onResume(target)}
      title={`${target.projectName} · ${target.sessionTitle}`}
      className="group w-full h-14 px-4 flex items-center gap-3 rounded-xl border border-nova-border bg-nova-card text-left transition-colors hover:border-nova-accent/40 hover:bg-nova-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/40"
    >
      <span className="w-6 h-6 rounded-full grid place-items-center bg-nova-accent/10 text-nova-accent shrink-0">
        <PlayIcon />
      </span>

      <span className="text-[13px] font-semibold text-nova-text-primary shrink-0 max-w-[190px] truncate">
        {target.projectName}
      </span>

      <span className="h-3.5 w-px bg-nova-border shrink-0" aria-hidden />

      <span className="flex-1 min-w-0 text-[13px] text-nova-text-secondary truncate">
        {target.sessionTitle}
      </span>

      <span className="flex items-center gap-1 text-[11px] text-nova-text-muted shrink-0">
        <ClockIcon className="w-3 h-3" />
        <span className="whitespace-nowrap">{timeLabel}</span>
      </span>

      <span className="shrink-0 flex items-center gap-1 px-3 h-8 rounded-full bg-nova-accent text-white text-[12px] font-medium">
        {t('welcome.resume.continue')}
        <ArrowRightIcon className="w-3.5 h-3.5" />
      </span>
    </button>
  )
}
