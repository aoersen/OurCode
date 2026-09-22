import { useState, useEffect, useRef, useMemo } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useAICommandsStore } from '@/stores/aiCommandsStore'
import { useShortcutStore } from '@/stores/shortcutStore'
import { getCommands, executeCommand } from '@/services/commands/commandRegistry'
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'
import { isComposingEvent } from '@/utils/composition'

interface PaletteItem {
  id: string
  label: string
  shortcut?: string
  action: () => void
  category?: string
  icon?: string
}

// Default AI commands are localized via i18n; custom commands keep their names.
const AI_COMMAND_KEYS: Record<string, TranslationKey> = {
  'default-explain': 'aiCommands.default-explain',
  'default-refactor': 'aiCommands.default-refactor',
  'default-test': 'aiCommands.default-test',
  'default-docs': 'aiCommands.default-docs',
  'default-fix': 'aiCommands.default-fix',
  'default-optimize': 'aiCommands.default-optimize',
  'default-translate': 'aiCommands.default-translate',
  'default-simplify': 'aiCommands.default-simplify',
  'default-security': 'aiCommands.default-security',
}

export default function CommandPalette() {
  const isCommandPaletteOpen = useUIStore((s) => s.isCommandPaletteOpen)
  const closeCommandPalette = useUIStore((s) => s.closeCommandPalette)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const t = useI18n()

  const aiCommands = useAICommandsStore((s) => s.commands)
  const executeAICommand = useAICommandsStore((s) => s.executeCommand)
  // Re-render when shortcut bindings change so shown shortcuts stay in sync
  const shortcuts = useShortcutStore((s) => s.shortcuts)

  // The palette is built from the unified command registry (shortcuts, menus
  // and plugins all register here) plus the AI prompt commands.
  const paletteItems: PaletteItem[] = useMemo(() => {
    const shortcutStore = useShortcutStore.getState()
    const registryItems: PaletteItem[] = getCommands().map((cmd) => ({
      id: cmd.id,
      label: cmd.title,
      icon: cmd.icon,
      category: cmd.category,
      shortcut: cmd.shortcut || shortcutStore.getShortcut(cmd.id) || undefined,
      action: () => {
        closeCommandPalette()
        executeCommand(cmd.id)
      },
    }))

    const aiItems: PaletteItem[] = aiCommands.map((cmd) => ({
      id: `ai-${cmd.id}`,
      label: `AI: ${AI_COMMAND_KEYS[cmd.id] ? t(AI_COMMAND_KEYS[cmd.id]) : cmd.name}`,
      icon: cmd.icon,
      category: t('palette.aiCategory'),
      action: () => {
        const selection = window.getSelection()?.toString() || ''
        const activeFile = useEditorStore.getState().getActiveFile()
        const prompt = executeAICommand(cmd.id, {
          selection,
          file: activeFile?.path || '',
          language: activeFile?.language || '',
        })
        const chatStore = useChatStore.getState()
        if (!chatStore.activeSessionId) {
          const configId = useConfigStore.getState().activeConfigGroupId
          if (configId) chatStore.createSession(configId)
        }
        if (chatStore.activeSessionId) chatStore.sendMessage(chatStore.activeSessionId, prompt)
        useUIStore.getState().toggleChat()
        closeCommandPalette()
      },
    }))

    return [...registryItems, ...aiItems]
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when the palette opens
  }, [aiCommands, shortcuts, isCommandPaletteOpen])

  const filteredCommands = paletteItems.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase()) ||
    cmd.category?.toLowerCase().includes(query.toLowerCase())
  )

  useEffect(() => {
    if (isCommandPaletteOpen) {
      inputRef.current?.focus()
      setQuery('')
      setSelectedIndex(0)
    }
  }, [isCommandPaletteOpen])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeCommandPalette()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && !isComposingEvent(e)) {
      e.preventDefault()
      const cmd = filteredCommands[selectedIndex]
      if (cmd) cmd.action()
    }
  }

  if (!isCommandPaletteOpen) return null

  return (
    <div role="dialog" aria-modal="true" aria-label={t('palette.dialog')} className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15%] z-[100] backdrop-blur-sm" onClick={closeCommandPalette}>
      <div
        className="w-[550px] max-w-[90vw] glass-modal rounded-2xl overflow-hidden" style={{ boxShadow: 'var(--shadow-xl)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input — design: search icon + electric-blue underline */}
        <div className="p-3 pb-2 flex items-center gap-2 border-b border-nova-border" style={{ boxShadow: 'inset 0 -2px 0 var(--accent, #0058bc)' }}>
          <svg className="w-4 h-4 text-nova-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('palette.placeholder')}
            className="w-full bg-transparent text-nova-text-primary outline-none placeholder:text-nova-text-muted text-sm"
          />
        </div>

        {/* Command List */}
        <div className="max-h-[350px] overflow-y-auto py-1">
          {filteredCommands.length === 0 ? (
            <div className="px-4 py-6 text-center text-nova-text-muted text-sm">{t('palette.noMatch')}</div>
          ) : (
            filteredCommands.map((cmd, index) => (
              <div
                key={cmd.id}
                className={`
                  flex items-center justify-between px-4 py-2 cursor-pointer mx-1 rounded-lg
                  ${index === selectedIndex ? 'bg-nova-accent/15 border-l-2 border-l-nova-accent' : 'hover:bg-nova-hover border-l-2 border-l-transparent'}
                `}
                onClick={cmd.action}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {cmd.icon && <span className="text-sm">{cmd.icon}</span>}
                  <span className="text-sm text-nova-text-primary truncate">{cmd.label}</span>
                  {cmd.category && (
                    <span className="text-[10px] text-nova-text-muted px-1.5 py-0.5 bg-nova-hover rounded shrink-0">{cmd.category}</span>
                  )}
                </div>
                {cmd.shortcut && (
                  <kbd className="px-2 py-0.5 bg-nova-hover rounded-md text-[11px] text-nova-text-muted shrink-0 ml-2">
                    {cmd.shortcut}
                  </kbd>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
