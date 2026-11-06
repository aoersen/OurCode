/**
 * Starter rail: four engineering presets as one quiet row.
 *
 * A preset fills the composer with a concrete, editable instruction — it never
 * sends anything, because the whole point is that the user still gets to adjust
 * the wording before the agent runs.
 */
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'
import { ChatIcon, FileIcon, FolderIcon, WarningIcon } from './WelcomeIcons'

interface StarterRailProps {
  onPick: (prompt: string) => void
}

interface Starter {
  key: string
  labelKey: TranslationKey
  promptKey: TranslationKey
  icon: (p: { className?: string }) => JSX.Element
  tone: string
}

const STARTERS: Starter[] = [
  { key: 'fixTest', labelKey: 'welcome.starter.fixTest', promptKey: 'welcome.starter.fixTestPrompt', icon: WarningIcon, tone: 'text-orange-500' },
  { key: 'addTest', labelKey: 'welcome.starter.addTest', promptKey: 'welcome.starter.addTestPrompt', icon: ChatIcon, tone: 'text-emerald-500' },
  { key: 'explain', labelKey: 'welcome.starter.explain', promptKey: 'welcome.starter.explainPrompt', icon: FileIcon, tone: 'text-sky-500' },
  { key: 'refactor', labelKey: 'welcome.starter.refactor', promptKey: 'welcome.starter.refactorPrompt', icon: FolderIcon, tone: 'text-amber-500' },
]

export default function StarterRail({ onPick }: StarterRailProps) {
  const t = useI18n()

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {STARTERS.map(({ key, labelKey, promptKey, icon: Icon, tone }) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(t(promptKey))}
          className="flex items-center gap-1.5 h-8 px-3 rounded-full border border-nova-border text-[12px] text-nova-text-secondary bg-nova-surface/40 transition-colors hover:text-nova-text-primary hover:border-nova-accent/40 hover:bg-nova-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/30"
        >
          <Icon className={`w-3.5 h-3.5 ${tone}`} />
          {t(labelKey)}
        </button>
      ))}
    </div>
  )
}
