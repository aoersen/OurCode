import { useEffect, useState } from 'react'
import MainLayout from './components/Layout/MainLayout'
import ErrorBoundary from './components/Common/ErrorBoundary'
import SessionEventNotifier from './components/Common/SessionEventNotifier'
import OnboardingModal from './components/Onboarding/OnboardingModal'
import RestoreBackupsModal from './components/Editor/RestoreBackupsModal'
import type { BackupEntry } from '@shared/types'
import { useConfigStore } from './stores/configStore'
import { useChatStore, refreshGitBranch } from './stores/chatStore'
import { useEditorStore } from './stores/editorStore'
import { useUIStore } from './stores/uiStore'
import { useMemoryStore } from './stores/memoryStore'
import { useWorkflowStore } from './stores/workflowStore'
import { useAICommandsStore } from './stores/aiCommandsStore'
import { useShortcutStore } from './stores/shortcutStore'
import { ensureProblemsSubscription, useProblemsStore } from './stores/problemsStore'
import { ensureLspDiagnosticsSubscription } from './services/lsp/lspClient'
import { ensureDebugEventSubscription } from './stores/debugStore'
import { ensureBrowserSubscription } from './stores/browserStore'
import { registerCoreCommands } from './services/commands/coreCommands'
import { setLocale, resolveLocale, getSystemLocale, type LanguagePreference } from './i18n'
import { IS_OFFICE } from './utils/windowMode'

export default function App() {
  const loadConfigGroups = useConfigStore((s) => s.loadConfigGroups)
  const loadSessions = useChatStore((s) => s.loadSessions)
  const loadPreferences = useEditorStore((s) => s.loadPreferences)
  // Select the ACTION only — a whole-store subscription here would re-render
  // the ENTIRE app (MainLayout and every editor/chat/sidebar child) on any
  // uiStore change: notifications, sidebar drag-resize, context menus, ...
  const initTheme = useUIStore((s) => s.initTheme)
  const loadCommands = useAICommandsStore((s) => s.loadCommands)
  const loadMemories = useMemoryStore((s) => s.loadMemories)
  const loadWorkflows = useWorkflowStore((s) => s.loadWorkflows)

  const [showOnboarding, setShowOnboarding] = useState(false)
  const [ready, setReady] = useState(false)
  const [pendingBackups, setPendingBackups] = useState<BackupEntry[]>([])

  // Re-resolve the UI language (and re-register command titles/categories, which
  // are captured as resolved strings) whenever the preference changes.
  const language = useEditorStore((s) => s.preferences.language)
  useEffect(() => {
    setLocale(resolveLocale((language ?? 'system') as LanguagePreference, getSystemLocale()))
    registerCoreCommands()
    loadCommands()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only refresh on language change
  }, [language])

  useEffect(() => {
    const hasCompleted = localStorage.getItem('hasCompletedOnboarding')
    // Register the shared command surface (shortcuts / palette / plugins)
    registerCoreCommands()
    loadConfigGroups().then(async () => {
      await loadSessions()
      await loadPreferences()
      // Apply the persisted UI language to the document ('system' resolves to
      // the OS locale captured at bootstrap)
      setLocale(resolveLocale(
        (useEditorStore.getState().preferences.language ?? 'system') as LanguagePreference,
        getSystemLocale(),
      ))
      // Restore the persisted theme (initTheme used to hardcode 'dark' on startup)
      initTheme(useEditorStore.getState().preferences.theme)
      // Re-select the last opened project (if it still exists on disk)
      await useUIStore.getState().restoreLastProject()
      // First launch (or no last project) — fall back to the app-owned default
      // empty project so the user can chat in agent mode without opening a folder.
      if (!useUIStore.getState().rootPath) {
        await useUIStore.getState().ensureDefaultProject()
      }
      // 办公室窗口：确保存在一个活动的 office 会话——无会话时办公室视图右下角
      // 的目标输入框不可见，用户会卡在「打开对话」上；有会话即可直接启动目标模式。
      // createSession 已为办公室会话默认置位 targetMode（一人公司 = 目标模式），
      // 启动兜底会话无需再手动补位；不显式走 setTargetMode —— 后者会弹实验性
      // 提示并把尚未发消息的空会话落盘（每次开公司累积一条空会话）。
      if (IS_OFFICE && !useChatStore.getState().activeSessionId) {
        const configId = useConfigStore.getState().activeConfigGroupId
        if (configId) {
          useChatStore.getState().createSession(configId, useUIStore.getState().rootPath || undefined)
        }
      }
      // Restore the tabs open when the app last closed (hides the editor when
      // none were open — the chat panel fills the window instead)
      await useEditorStore.getState().restoreSession()
      loadCommands()
      // Load persistent user memories (injected into the agent prompt)
      loadMemories()
      // Load reusable workflow templates
      loadWorkflows()
      // Load persisted shortcut presets/custom bindings before the first keystroke
      useShortcutStore.getState().loadShortcuts()
      refreshGitBranch()
      // Hot-exit backups from a previous session (crash / force-quit recovery)
      try {
        const backups = await window.electronAPI.listBackups()
        if (backups.length > 0) setPendingBackups(backups)
      } catch { /* ignore */ }
      // Live diagnostics: follow Monaco's marker stream into the Problems panel
      ensureProblemsSubscription()
      useProblemsStore.getState().refresh()
      // LSP diagnostics → markers (opt-in language servers)
      ensureLspDiagnosticsSubscription()
      // Debug Adapter Protocol events (single session)
      ensureDebugEventSubscription()
      // Agent browser session mirror (console + page state) for the Browser panel
      ensureBrowserSubscription()
      setReady(true)
      if (!hasCompleted) {
        setShowOnboarding(true)
      }
    })

    // Fade out splash screen
    const splash = document.getElementById('splash-screen')
    if (splash) {
      splash.classList.add('fade-out')
      setTimeout(() => splash.remove(), 500)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only init; store actions are stable references
  }, [])

  const handleOnboardingComplete = () => {
    localStorage.setItem('hasCompletedOnboarding', 'true')
    setShowOnboarding(false)
  }

  return (
    <ErrorBoundary>
      <SessionEventNotifier />
      <MainLayout />
      {ready && showOnboarding && <OnboardingModal onComplete={handleOnboardingComplete} />}
      {ready && pendingBackups.length > 0 && (
        <RestoreBackupsModal backups={pendingBackups} onClose={() => setPendingBackups([])} />
      )}
    </ErrorBoundary>
  )
}
