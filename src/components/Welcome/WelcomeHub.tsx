/**
 * Welcome hub — the launch pad a new conversation starts on.
 *
 * Six blocks, each answering one question, in the order a person actually
 * asks them: where am I → which project will this run in → what do I want →
 * what else can I start → what if I have no idea → is my environment usable.
 * Every block hides itself when its data does not exist (no MCP config, no
 * context window) rather than rendering a placeholder that looks like data.
 *
 * Shown whenever the active conversation has no messages yet — i.e. right after
 * 新建会话 / 新建对话 / 空会话. Sending the first message turns it into a real
 * conversation and the normal chat panel takes over.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { useWelcomeEnv, useWelcomeProjects } from './useWelcomeData'
import { projectName, type WelcomeProjectSummary } from './welcomeUtils'
import ProjectContextBar from './ProjectContextBar'
import WelcomeComposer from './WelcomeComposer'
import ActionRow from './ActionRow'
import StarterRail from './StarterRail'
import EnvLine from './EnvLine'
import { WarningIcon } from './WelcomeIcons'

/** Project the next conversation should be created in. Mirrors the design
 *  rule: the active (still unused) session's project first, then the workspace
 *  being browsed, then the most recently known project. */
function resolveInitialProjectPath(): string | null {
  const chat = useChatStore.getState()
  const active = chat.sessions.find((s) => s.id === chat.activeSessionId)
  if (active?.projectPath) return active.projectPath
  const ui = useUIStore.getState()
  return ui.rootPath ?? ui.recentProjects[0] ?? null
}

export default function WelcomeHub() {
  const t = useI18n()
  const env = useWelcomeEnv()
  const projects = useWelcomeProjects()
  const activeSessionProject = useChatStore(
    (s) => (s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId)?.projectPath ?? null : null),
  )

  // Which project the first message will be created in. Opening / switching it
  // never rewrites a real conversation — only the unused session behind this
  // page changes its owner (see rebindPendingSessionProject).
  const [selectedPath, setSelectedPath] = useState<string | null>(resolveInitialProjectPath)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const composerRef = useRef<HTMLDivElement>(null)

  // Another entry point may bind a new empty session to a different project
  // while this page stays mounted (e.g. 项目卡片 → 新建对话): follow it.
  useEffect(() => {
    if (activeSessionProject) setSelectedPath(activeSessionProject)
  }, [activeSessionProject])

  const selectedProject = useMemo<WelcomeProjectSummary | null>(() => {
    if (!selectedPath) return null
    const known = projects.find((p) => p.path === selectedPath)
    if (known) return known
    // The workspace can be open without being in the recent list yet — show it
    // anyway instead of pretending nothing is selected.
    return {
      path: selectedPath,
      name: projectName(selectedPath),
      lastOpened: 0,
      sessionCount: 0,
      lastSession: null,
    }
  }, [projects, selectedPath])

  // The resume card was removed from this page: the sidebar already lists every
  // conversation, and a duplicate "continue" row on the launch pad was noise
  // (the user's call). Project switching stays in the context bar above.

  /** Point the pending (unused) session at `path` and make the workspace real.
   *  With no active session nothing is rebound — send() creates it lazily. */
  const bindPendingSession = useCallback((path: string | null) => {
    const chat = useChatStore.getState()
    const active = chat.sessions.find((s) => s.id === chat.activeSessionId)
    if (active && active.messages.length === 0) {
      chat.rebindPendingSessionProject(active.id, path ?? undefined)
    }
    if (path) useUIStore.getState().setRootPath(path)
  }, [])

  const selectProject = useCallback(
    (path: string) => {
      setSelectedPath(path)
      setSwitcherOpen(false)
      bindPendingSession(path)
    },
    [bindPendingSession],
  )

  const openFolder = useCallback(async () => {
    const path = await window.electronAPI.openFolder()
    if (!path) return
    setSwitcherOpen(false)
    setSelectedPath(path)
    bindPendingSession(path)
  }, [bindPendingSession])

  /** Remove a project from the welcome page. The pending empty session is just
   *  re-bound to the next project; a real conversation keeps its existing
   *  roll-away behavior (never silently rewritten). */
  const removeProjectFromList = useCallback(
    (path: string) => {
      const chat = useChatStore.getState()
      const active = chat.sessions.find((s) => s.id === chat.activeSessionId)
      const pending = active && active.messages.length === 0
      const next = projects.find((p) => p.path !== path)?.path ?? null

      useUIStore.getState().removeProject(path)
      if (pending && active?.projectPath === path) {
        setSelectedPath(next)
        bindPendingSession(next)
      } else {
        chat.rollActiveSessionAwayFrom(path)
        if (selectedPath === path) setSelectedPath(next)
      }
      setSwitcherOpen(false)
    },
    [bindPendingSession, projects, selectedPath],
  )

  // A session is created lazily on the first send — opening the app must not
  // litter the session list with empty conversations.
  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return

    const configId = useConfigStore.getState().activeConfigGroupId
    if (!configId) {
      useUIStore.getState().openSettings()
      return
    }

    setSending(true)
    try {
      const chat = useChatStore.getState()
      const active = chat.sessions.find((s) => s.id === chat.activeSessionId)
      let sessionId: string
      if (active && active.messages.length === 0) {
        // The page owns this unused conversation — make sure it starts in the
        // project the user actually has selected right now.
        chat.rebindPendingSessionProject(active.id, selectedPath ?? undefined)
        sessionId = active.id
      } else {
        sessionId = chat.createSession(configId, selectedPath ?? undefined)
      }
      setInput('')
      await useChatStore.getState().sendMessage(sessionId, text)
    } finally {
      setSending(false)
    }
  }, [input, sending, selectedPath])

  const fill = useCallback((text: string) => {
    setInput(text)
    composerRef.current?.querySelector('textarea')?.focus()
  }, [])

  const openModelSettings = useCallback(() => {
    useUIStore.getState().openSettings()
  }, [])

  const greeting = useMemo(
    () => (env.modelConfigured ? t('welcome.greetingReturn') : t('welcome.greetingFirstRun')),
    [env.modelConfigured, t],
  )

  return (
    <div className="w-full flex-1 min-w-0 h-full min-h-0 overflow-auto flex flex-col px-6 py-6">
      <div className="my-auto w-full max-w-[760px] mx-auto flex flex-col gap-7">
        {/* ① Where am I */}
        <header className="flex flex-col gap-1">
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-nova-text-primary">
            {greeting}
          </h1>
          {!env.modelConfigured && (
            <p className="text-[13px] text-nova-text-muted">{t('welcome.firstRunHint')}</p>
          )}
        </header>

        {/* ② Which project will this conversation run in */}
        <ProjectContextBar
          project={selectedProject}
          projects={projects}
          open={switcherOpen}
          onToggle={() => {
            // Nothing to choose from — go straight to the folder picker.
            if (projects.length === 0) void openFolder()
            else setSwitcherOpen((open) => !open)
          }}
          onClose={() => setSwitcherOpen(false)}
          onSelect={selectProject}
          onOpenFolder={() => void openFolder()}
          onRemove={removeProjectFromList}
        />

        {/* ③ The anchor: describe the goal */}
        <div ref={composerRef} className="flex flex-col gap-2.5">
          {!env.modelConfigured && (
            <div className="flex items-center gap-2 h-10 px-3.5 rounded-xl border border-orange-500/30 bg-orange-500/[0.06]">
              <WarningIcon className="w-4 h-4 text-orange-500" />
              <span className="flex-1 min-w-0 text-[12.5px] text-nova-text-secondary truncate">
                {t('welcome.notice.modelMissing')}
              </span>
              <button
                type="button"
                onClick={openModelSettings}
                className="shrink-0 h-7 px-3 rounded-md bg-nova-accent text-white text-[11.5px] font-medium hover:brightness-110 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/40"
              >
                {t('welcome.notice.configure')}
              </button>
            </div>
          )}

          <WelcomeComposer
            value={input}
            onChange={setInput}
            onSubmit={() => void send()}
            modelLabel={env.modelLabel}
            modelConfigured={env.modelConfigured}
            onConfigureModel={openModelSettings}
            projectName={selectedProject?.name ?? ''}
            onOpenProjectSwitcher={() => setSwitcherOpen(true)}
            autoFocus
          />
        </div>

        {/* ④ What else can I start */}
        <ActionRow />

        {/* ⑤ What if I have no idea yet */}
        <StarterRail onPick={fill} />

        {/* ⑥ Is this environment usable */}
        <EnvLine env={env} />
      </div>
    </div>
  )
}
