/**
 * Data behind the welcome hub.
 *
 * Every value here is real runtime state — the welcome screen is a launch pad,
 * so it must never show a placeholder project, a fake model or a decorative
 * number. When a source is unavailable the value collapses to an "unknown"
 * shape and the consuming element hides itself instead of inventing data.
 */
import { useEffect, useMemo, useState } from 'react'
import { useChatStore, sessionLastUserActivity } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { useContextUsage } from '@/hooks/useContextUsage'
import { listSkills } from '@/services/skills/skillManager'
import type { TranslationKey } from '@/i18n'
import { pickResumeSession, projectName, type RelativeToken } from './welcomeUtils'

export interface ResumeTarget {
  sessionId: string
  projectPath: string
  projectName: string
  sessionTitle: string
  lastActivity: number
}

export interface WelcomeEnv {
  /** "DeepSeek · deepseek-chat" — the composer chip. */
  modelLabel: string
  /** Short provider/group name only — the status line. */
  modelName: string
  modelConfigured: boolean
  mcpCount: number | null
  skillCount: number | null
  contextUsed: number
  contextWindow: number
  contextKnown: boolean
}

export function useResumeTarget(): ResumeTarget | null {
  const sessions = useChatStore((s) => s.sessions)
  return useMemo(() => {
    const session = pickResumeSession(sessions, sessionLastUserActivity)
    if (!session || !session.projectPath) return null
    return {
      sessionId: session.id,
      projectPath: session.projectPath,
      projectName: projectName(session.projectPath),
      sessionTitle: session.title,
      lastActivity: sessionLastUserActivity(session),
    }
  }, [sessions])
}

/** Active model + the environment counts shown on the bottom status line. */
export function useWelcomeEnv(): WelcomeEnv {
  const groups = useConfigStore((s) => s.configGroups)
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const rootPath = useUIStore((s) => s.rootPath)
  const usage = useContextUsage()

  const [mcpCount, setMcpCount] = useState<number | null>(null)
  const [skillCount, setSkillCount] = useState<number | null>(null)

  const model = useMemo(
    () => groups.find((g) => g.id === activeConfigGroupId) ?? null,
    [groups, activeConfigGroupId],
  )

  // MCP servers: global config merged with the project config (project wins on
  // name collision) — the same resolution the agent uses.
  useEffect(() => {
    let cancelled = false
    const api = window.electronAPI
    if (!api?.mcpGetGlobalConfig) return
    void (async () => {
      try {
        const [global, project] = await Promise.all([
          api.mcpGetGlobalConfig!(),
          rootPath && api.mcpGetConfig ? api.mcpGetConfig(rootPath) : Promise.resolve(null),
        ])
        if (cancelled) return
        const names = new Set<string>([
          ...Object.keys(global?.config?.mcpServers ?? {}),
          ...Object.keys(project?.config?.mcpServers ?? {}),
        ])
        setMcpCount(names.size)
      } catch {
        if (!cancelled) setMcpCount(null)
      }
    })()
    return () => { cancelled = true }
  }, [rootPath])

  // Skills: enabled skills visible to the current workspace (project skills
  // shadow same-named global ones — listSkills already resolves that).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const skills = await listSkills(false, rootPath ?? undefined)
        if (!cancelled) setSkillCount(skills.length)
      } catch {
        if (!cancelled) setSkillCount(null)
      }
    })()
    return () => { cancelled = true }
  }, [rootPath])

  return {
    modelLabel: model ? [model.name, model.defaultModel].filter(Boolean).join(' · ') : '',
    modelName: model?.name ?? '',
    modelConfigured: !!model,
    mcpCount,
    skillCount,
    contextUsed: usage?.used ?? 0,
    contextWindow: usage?.window ?? 0,
    contextKnown: !!usage,
  }
}

/** Translate a relative-time token through the caller's translator. */
export function relativeLabel(
  token: RelativeToken,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  switch (token.unit) {
    case 'justNow':
      return t('welcome.time.justNow')
    case 'minutes':
      return t('welcome.time.minutes', { count: token.count })
    case 'hours':
      return t('welcome.time.hours', { count: token.count })
    case 'yesterday':
      return t('welcome.time.yesterday')
    case 'days':
      return t('welcome.time.days', { count: token.count })
    case 'date':
    default:
      return t('welcome.time.date', { month: token.month, day: token.day })
  }
}
