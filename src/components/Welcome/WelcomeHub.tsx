/**
 * Welcome hub — the launch pad shown in the editor area while nothing is open.
 *
 * Six blocks, each answering one question, in the order a person actually asks
 * them: where am I → what was I doing → what do I want → what else can I start
 * → what if I have no idea → is my environment usable. Every block hides itself
 * when its data does not exist (no resume target, no MCP config, no context
 * window) rather than rendering a placeholder that looks like data.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { useWelcomeEnv, useResumeTarget, type ResumeTarget } from './useWelcomeData'
import ResumeCard from './ResumeCard'
import WelcomeComposer from './WelcomeComposer'
import ActionRow from './ActionRow'
import StarterRail from './StarterRail'
import EnvLine from './EnvLine'
import { WarningIcon } from './WelcomeIcons'

export default function WelcomeHub() {
  const t = useI18n()
  const env = useWelcomeEnv()
  const resume = useResumeTarget()

  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const composerRef = useRef<HTMLDivElement>(null)

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
      const sessionId =
        chat.activeSessionId ?? chat.createSession(configId, useUIStore.getState().rootPath || undefined)
      setInput('')
      await useChatStore.getState().sendMessage(sessionId, text)
    } finally {
      setSending(false)
    }
  }, [input, sending])

  const resumeInto = useCallback((target: ResumeTarget) => {
    // Opening the project first makes the session's workspace real again; then
    // activating the session switches the chat panel to it.
    useUIStore.getState().enterProject(target.projectPath)
    useChatStore.getState().setActiveSession(target.sessionId)
  }, [])

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

        {/* ② Cheapest action: go back to the conversation that was in progress */}
        {resume && <ResumeCard target={resume} onResume={resumeInto} />}

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
