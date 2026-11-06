/**
 * Action row: one dominant path, two quiet alternatives.
 *
 * The design is deliberately asymmetric — "open a folder" is what nearly every
 * launch does, while recent-files / new-session are occasional. Three equal
 * cards (the earlier draft) claimed all three were equally likely, which is
 * false and costs the eye the same effort for every option.
 */
import { useShortcutStore } from '@/stores/shortcutStore'
import { useI18n } from '@/i18n/useI18n'
import { executeCommand } from '@/services/commands/commandRegistry'
import { ChatIcon, FileIcon, FolderIcon } from './WelcomeIcons'

/** Keycaps come from the live shortcut bindings so the label can never lie. */
function useKeycap(action: string): string {
  return useShortcutStore((s) => s.getShortcut(action))
}

function Keycap({ keys, tone }: { keys: string; tone: 'onPrimary' | 'muted' }) {
  if (!keys) return null
  const cls =
    tone === 'onPrimary'
      ? 'border-white/30 text-white/85'
      : 'border-nova-border text-nova-text-muted'
  return (
    <span className={`ml-1.5 px-1.5 py-[1px] rounded border font-mono text-[10px] leading-tight ${cls}`}>
      {keys.replace(/\+/g, ' ')}
    </span>
  )
}

export default function ActionRow() {
  const t = useI18n()
  const openFolder = useKeycap('openFolder')
  const recentFiles = useKeycap('recentFiles')
  const newSession = useKeycap('newChatSession')

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        type="button"
        onClick={() => executeCommand('openFolder')}
        className="flex items-center h-9 px-3.5 rounded-lg bg-nova-accent text-white text-[12.5px] font-medium transition-all hover:brightness-110 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/40"
      >
        <FolderIcon className="w-3.5 h-3.5 mr-1.5" />
        {t('welcome.action.openFolder')}
        <Keycap keys={openFolder} tone="onPrimary" />
      </button>

      <button
        type="button"
        onClick={() => executeCommand('recentFiles')}
        className="flex items-center h-9 px-2.5 rounded-lg text-[12.5px] text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/30"
      >
        <FileIcon className="w-3.5 h-3.5 mr-1.5" />
        {t('welcome.action.recentFiles')}
        <Keycap keys={recentFiles} tone="muted" />
      </button>

      <button
        type="button"
        onClick={() => executeCommand('newChatSession')}
        className="flex items-center h-9 px-2.5 rounded-lg text-[12.5px] text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/30"
      >
        <ChatIcon className="w-3.5 h-3.5 mr-1.5" />
        {t('welcome.action.newSession')}
        <Keycap keys={newSession} tone="muted" />
      </button>
    </div>
  )
}
