/**
 * Core application commands. Registered once at startup so the shortcut
 * handler, the command palette and plugins all resolve the same IDs.
 * Import for its side effects (e.g. `import '@/services/commands/coreCommands'`).
 */
import { registerCommand } from './commandRegistry'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useProblemsStore } from '@/stores/problemsStore'
import { useRecentFilesStore } from '@/stores/recentFilesStore'
import { useDebugStore } from '@/stores/debugStore'
import { toggleNoLimits } from '@/stores/noLimitsStore'
import { t } from '@/i18n'

/** Trigger a Monaco command on the focused editor. */
function runEditorCommand(command: string): void {
  const editor = (window as unknown as { __monacoEditor?: { trigger: (source: string, cmd: string, payload: unknown) => void } }).__monacoEditor
  editor?.trigger('keyboard', command, null)
}

/** Open a folder and reveal it in the file explorer. */
async function openFolderFlow(): Promise<void> {
  const path = await window.electronAPI.openFolder()
  if (!path) return
  const ui = useUIStore.getState()
  ui.setRootPath(path)
  ui.setActiveSidebarTab('files')
  if (!ui.isSidebarVisible) ui.toggleSidebar()
}

/** Export the active session in the given format. */
function exportActiveSession(format: 'markdown' | 'json'): void {
  const session = useChatStore.getState().getActiveSession()
  if (!session) return
  const data = useChatStore.getState().exportSession(session.id, format)
  const blob = new Blob([data], { type: format === 'markdown' ? 'text/markdown' : 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `对话-${Date.now()}.${format === 'markdown' ? 'md' : 'json'}`
  a.click()
  URL.revokeObjectURL(url)
}

/** Ensure a chat session exists (creating one with the active config group). */
function ensureChatSession(): void {
  const chat = useChatStore.getState()
  if (chat.activeSessionId) return
  const configId = useConfigStore.getState().activeConfigGroupId
  if (configId) chat.createSession(configId)
  else useUIStore.getState().openSettings()
}

export function registerCoreCommands(): void {
  // ── File ──
  registerCommand({
    id: 'newFile', title: t('commands.newFile'), category: t('commands.catFile'), shortcut: 'Ctrl+N',
    run: () => useEditorStore.getState().newFile(),
  })
  registerCommand({
    id: 'openFolder', title: t('commands.openFolder'), category: t('commands.catFile'), shortcut: 'Ctrl+O',
    run: () => openFolderFlow(),
  })
  registerCommand({
    id: 'saveFile', title: t('commands.saveFile'), category: t('commands.catFile'), shortcut: 'Ctrl+S',
    run: () => {
      const { activeFilePath, saveFile } = useEditorStore.getState()
      if (activeFilePath) void saveFile(activeFilePath)
    },
  })
  registerCommand({
    id: 'saveAll', title: t('commands.saveAll'), category: t('commands.catFile'), shortcut: 'Ctrl+Shift+S',
    run: () => void useEditorStore.getState().saveAll(),
  })
  registerCommand({
    id: 'closeTab', title: t('commands.closeTab'), category: t('commands.catFile'), shortcut: 'Ctrl+W',
    run: () => {
      const { activeFilePath, closeFileWithConfirm } = useEditorStore.getState()
      if (activeFilePath) void closeFileWithConfirm(activeFilePath)
    },
  })

  // ── Edit (Monaco native) ──
  registerCommand({ id: 'undo', title: t('commands.undo'), category: t('commands.catEdit'), shortcut: 'Ctrl+Z', run: () => runEditorCommand('undo') })
  registerCommand({ id: 'redo', title: t('commands.redo'), category: t('commands.catEdit'), shortcut: 'Ctrl+Shift+Z', run: () => runEditorCommand('redo') })
  registerCommand({ id: 'find', title: t('commands.find'), category: t('commands.catEdit'), shortcut: 'Ctrl+F', run: () => runEditorCommand('actions.find') })
  registerCommand({ id: 'replace', title: t('commands.replace'), category: t('commands.catEdit'), shortcut: 'Ctrl+H', run: () => runEditorCommand('editor.action.startFindReplaceAction') })

  // ── View ──
  registerCommand({ id: 'toggleSidebar', title: t('commands.toggleSidebar'), category: t('commands.catView'), shortcut: 'Ctrl+B', run: () => useUIStore.getState().toggleSidebar() })
  registerCommand({ id: 'toggleTerminal', title: t('commands.toggleTerminal'), category: t('commands.catView'), shortcut: 'Ctrl+J', run: () => useUIStore.getState().toggleTerminal() })
  registerCommand({ id: 'toggleChat', title: t('commands.toggleChat'), category: t('commands.catView'), shortcut: 'Ctrl+L', run: () => useUIStore.getState().toggleChat() })
  registerCommand({ id: 'toggleProblems', title: t('commands.toggleProblems'), category: t('commands.catView'), shortcut: 'Ctrl+Shift+M', run: () => useProblemsStore.getState().toggle() })
  registerCommand({ id: 'toggleDebugPanel', title: t('commands.toggleDebugPanel'), category: t('commands.catView'), shortcut: 'Ctrl+Shift+D', run: () => useDebugStore.getState().toggle() })
  registerCommand({ id: 'commandPalette', title: t('commands.commandPalette'), category: t('commands.catView'), shortcut: 'Ctrl+Shift+P', run: () => useUIStore.getState().openCommandPalette() })
  registerCommand({ id: 'quickOpen', title: t('commands.quickOpen'), category: t('commands.catView'), shortcut: 'Ctrl+P', run: () => useUIStore.getState().openQuickOpen() })
  registerCommand({ id: 'recentFiles', title: t('commands.recentFiles'), category: t('commands.catFile'), shortcut: 'Ctrl+R', run: () => useRecentFilesStore.getState().toggle() })
  registerCommand({ id: 'openMcpCenter', title: t('commands.openMcpCenter'), category: t('commands.catView'), shortcut: 'Ctrl+Shift+X', run: () => useUIStore.getState().openMcpCenter() })
  registerCommand({ id: 'openSkillRegistry', title: t('commands.openSkillRegistry'), category: t('commands.catView'), run: () => useUIStore.getState().openSkillRegistry() })
  registerCommand({ id: 'openSettings', title: t('commands.openSettings'), category: t('commands.catView'), run: () => useUIStore.getState().openSettings() })
  registerCommand({ id: 'newWindow', title: t('commands.newWindow'), category: t('commands.catView'), run: () => window.electronAPI.openNewWindow() })
  registerCommand({ id: 'splitPanelHorizontal', title: t('commands.splitPanelHorizontal'), category: t('commands.catView'), shortcut: 'Ctrl+\\', run: () => useEditorStore.getState().splitPanel('horizontal') })
  registerCommand({ id: 'splitPanelVertical', title: t('commands.splitPanelVertical'), category: t('commands.catView'), run: () => useEditorStore.getState().splitPanel('vertical') })
  registerCommand({
    id: 'closePanel', title: t('commands.closePanel'), category: t('commands.catView'),
    run: () => {
      const state = useEditorStore.getState()
      if (state.panelOrder.length > 1) void state.closePanelWithConfirm(state.activePanelId)
    },
  })
  registerCommand({ id: 'cyclePanelFocus', title: t('commands.cyclePanelFocus'), category: t('commands.catView'), shortcut: 'Ctrl+Shift+\\', run: () => useEditorStore.getState().cyclePanelFocus() })
  registerCommand({ id: 'zoomIn', title: t('commands.zoomIn'), category: t('commands.catView'), shortcut: 'Ctrl+=', run: () => runEditorCommand('editor.action.fontZoomIn') })
  registerCommand({ id: 'zoomOut', title: t('commands.zoomOut'), category: t('commands.catView'), shortcut: 'Ctrl+-', run: () => runEditorCommand('editor.action.fontZoomOut') })

  // ── Chat / AI ──
  registerCommand({
    id: 'newChatSession', title: t('commands.newChatSession'), category: t('commands.catChat'), shortcut: 'Ctrl+Shift+N',
    run: () => {
      const configId = useConfigStore.getState().activeConfigGroupId
      if (configId) useChatStore.getState().createSession(configId)
      else useUIStore.getState().openSettings()
    },
  })
  registerCommand({
    id: 'sendSelectionToAI', title: t('commands.sendSelectionToAI'), category: t('commands.catChat'), shortcut: 'Ctrl+Shift+L',
    run: () => {
      const selection = window.getSelection()?.toString()
      if (!selection) return
      ensureChatSession()
      const chat = useChatStore.getState()
      if (chat.activeSessionId) chat.sendMessage(chat.activeSessionId, `解释这段代码:\n\n\`\`\`\n${selection}\n\`\`\``)
      if (!useUIStore.getState().isChatVisible) useUIStore.getState().toggleChat()
    },
  })
  registerCommand({
    id: 'clearChat', title: t('commands.clearChat'), category: t('commands.catChat'),
    run: () => {
      const session = useChatStore.getState().getActiveSession()
      if (session) useChatStore.getState().clearMessages(session.id)
    },
  })
  registerCommand({ id: 'exportChatMarkdown', title: t('commands.exportChatMarkdown'), category: t('commands.catChat'), run: () => exportActiveSession('markdown') })
  registerCommand({ id: 'exportChatJson', title: t('commands.exportChatJson'), category: t('commands.catChat'), run: () => exportActiveSession('json') })
  // no-limits（能力取自 dsh-purge）：命令面板里一键开关，默认关闭时就是把它打开。
  registerCommand({
    id: 'toggleNoLimits', title: t('commands.toggleNoLimits'), category: t('commands.catChat'),
    run: () => {
      const on = toggleNoLimits()
      useUIStore.getState().showNotification(on ? t('noLimits.notifyOn') : t('noLimits.notifyOff'), on ? 'warning' : 'info')
    },
  })
}
