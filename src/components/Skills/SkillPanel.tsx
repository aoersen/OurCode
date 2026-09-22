import { useState, useEffect, useCallback, useRef } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { listAllSkills, getGlobalRoot, SKILL_ORIGIN_LABELS, type SkillInfo, type SkillOrigin } from '@/services/skills/skillManager'
import { isSkillEnabled, setSkillEnabled, readSkillConfig } from '@/services/skills/skillRegistry'
import { isBuiltinSkillName } from '@/services/skills/builtinSkills'

interface LocalSkillRow extends SkillInfo {
  enabled: boolean
  version?: string
  /** Platform this skill was imported from (provenance display only). */
  importedFrom?: SkillOrigin
}

/** Config root whose skills.json governs a skill's enabled flag. */
async function configRootFor(s: SkillInfo): Promise<string> {
  return s.source === 'global' ? await getGlobalRoot() : s.projectPath || ''
}

/**
 * Skill sidebar panel (activity-bar "skills" icon → opens the left sidebar).
 * Quick management: search, enable/disable via toggle. The header "管理" pill
 * opens the full SkillRegistryModal (local + remote registry install).
 * Lists ALL skills — global (follow the IDE) + every recent project's own —
 * each labeled with its source, independent of the active conversation.
 */
export default function SkillPanel() {
  const t = useI18n()
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const openSkillRegistry = useUIStore((s) => s.openSkillRegistry)
  // Refresh whenever the recent-project list changes (opening a project brings
  // its skills into the list) — the list is independent of the active session.
  // The revision bumps when the skill manager modal mutates skills (import/
  // install/uninstall/toggle), so this panel refreshes even while it stays
  // mounted behind the modal.
  const recentProjects = useUIStore((s) => s.recentProjects)
  const skillsRevision = useUIStore((s) => s.skillsRevision)

  const [search, setSearch] = useState('')
  const [skills, setSkills] = useState<LocalSkillRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Synchronous in-flight guard: `busy` state updates are async, so rapid
  // double-clicks would toggle the same skill twice before the state lands —
  // a ref keeps the check race-free (see toggleSkill).
  const busyRef = useRef<string | null>(null)

  const reload = useCallback(async () => {
    const all = await listAllSkills(true)
    const rows: LocalSkillRow[] = []
    for (const s of all) {
      const configRoot = await configRootFor(s)
      const config = await readSkillConfig(configRoot)
      rows.push({
        ...s,
        enabled: await isSkillEnabled(s.name, configRoot),
        version: config.skills[s.name]?.version,
        importedFrom: config.skills[s.name]?.importedFrom,
      })
    }
    setSkills(rows)
  }, [])

  useEffect(() => {
    reload().catch(() => setSkills([]))
  }, [reload, recentProjects, skillsRevision])

  const toggleSkill = async (skill: LocalSkillRow, enabled: boolean) => {
    if (busyRef.current) return
    busyRef.current = skill.name
    setBusy(skill.name)
    setError(null)
    try {
      const configRoot = await configRootFor(skill)
      if (!configRoot) throw new Error('无法确定该技能的配置位置')
      await setSkillEnabled(skill.name, !enabled, configRoot)
      await reload()
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  const q = search.trim().toLowerCase()
  const filtered = q
    ? skills.filter(
        (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      )
    : skills

  const enabledCount = skills.filter((s) => s.enabled).length

  return (
    <div className="h-full flex flex-col bg-transparent">
      {/* Header — 方案A 变体: 标题 + 右侧「管理」pill（打开完整技能管理） */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{ padding: '0 12px', height: 36 }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <svg viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className="text-nova-accent shrink-0">
            <path d="M823.296 64.96l135.744 135.744-769.28 769.28-135.808-135.68L823.296 64.96z m0 108.544L162.432 834.24l27.2 27.136L850.432 200.704l-27.2-27.2zM803.2 512a15.68 15.68 0 0 1 15.232 14.336 146.88 146.88 0 0 0 127.68 133.12 15.68 15.68 0 0 1-0.64 31.232 146.752 146.752 0 0 0-133.12 127.744 15.68 15.68 0 0 1-31.104-0.64 146.816 146.816 0 0 0-127.488-133.184 15.68 15.68 0 0 1 0.64-31.232 146.752 146.752 0 0 0 132.992-127.744 15.68 15.68 0 0 1 12.032-13.248l3.84-0.384z m-576-448a15.68 15.68 0 0 1 15.232 14.336 146.88 146.88 0 0 0 127.68 133.12 15.68 15.68 0 0 1-0.64 31.232 146.752 146.752 0 0 0-133.12 127.744 15.68 15.68 0 0 1-31.104-0.64 146.816 146.816 0 0 0-127.488-133.184 15.68 15.68 0 0 1 0.64-31.232 146.752 146.752 0 0 0 132.992-127.744 15.68 15.68 0 0 1 12.032-13.248L227.328 64z m282.624 0a10.24 10.24 0 0 1 10.496 8.832c3.328 23.36 22.4 41.216 45.952 42.944a10.24 10.24 0 0 1 0.64 20.48 50.112 50.112 0 0 0-42.944 45.888 10.24 10.24 0 0 1-20.48 0.64 50.112 50.112 0 0 0-45.888-42.944 10.24 10.24 0 0 1-0.64-20.416 50.112 50.112 0 0 0 42.944-45.952 10.24 10.24 0 0 1 6.912-8.96L509.888 64z" />
          </svg>
          <span
            className="font-bold uppercase tracking-[0.08em] truncate"
            style={{ fontSize: 11, color: 'var(--text-secondary)', letterSpacing: '0.08em' }}
          >
            {t('skillPanel.title')}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={openSkillRegistry}
            className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white bg-[var(--accent)] rounded-full hover:opacity-90 transition-opacity"
          >
            {t('skillPanel.manage')}
          </button>
          <button
            onClick={toggleSidebar}
            className="w-6 h-6 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
            title={t('sidebar.collapse')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '4px 12px 8px' }} className="shrink-0">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-nova-text-muted pointer-events-none"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder={t('skillPanel.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-nova-bg border border-nova-border rounded-full text-xs text-nova-text-primary placeholder-nova-text-muted focus:outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>
      </div>

      {/* Count row */}
      <div className="px-3 pb-1.5 shrink-0">
        <span className="text-[10px] uppercase font-bold tracking-wider text-nova-text-muted">
          {t('skillRegistry.localTab', { count: skills.length })}
        </span>
        {enabledCount > 0 && (
          <span className="text-[10px] text-nova-text-muted ml-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#22c55e] align-middle mr-1" />
            {enabledCount}
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-3 mb-2 p-2 bg-red-500/10 border border-red-500/30 rounded-lg text-[11px] text-red-400 shrink-0">
          {error}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 ? (
          <div className="text-center py-10 text-nova-text-muted text-xs px-4">
            {search ? t('skillPanel.noMatch') : t('skillPanel.noSkills')}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((s) => (
              <div
                key={`${s.source}:${s.projectPath || 'global'}:${s.name}`}
                className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-white/50 dark:hover:bg-white/5 transition-colors group"
              >
                {/* Status dot */}
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${s.enabled ? 'bg-[#22c55e]' : 'bg-slate-400'}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span
                      className="font-mono text-[13px] font-bold truncate"
                      style={{ color: s.enabled ? 'var(--accent)' : 'var(--text-secondary)' }}
                    >
                      /{s.name}
                    </span>
                    {s.version && (
                      <span className="font-mono text-[10px] text-nova-text-muted shrink-0">v{s.version}</span>
                    )}
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-nova-hover text-nova-text-muted"
                      title={s.source === 'global' ? undefined : s.projectPath}
                    >
                      {s.source === 'global' ? t('skillRegistry.globalTag') : s.projectPath?.split(/[/\\]/).pop() || t('skillRegistry.projectTag')}
                    </span>
                    {s.builtin && (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-[var(--accent)]/15 text-[var(--accent)]"
                        title={t('skillRegistry.builtinProtected')}
                      >
                        {t('skillRegistry.builtinTag')}
                      </span>
                    )}
                    {s.importedFrom && (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-nova-bg border border-nova-border text-nova-text-muted"
                        title={t('skillRegistry.importedFrom', { origin: SKILL_ORIGIN_LABELS[s.importedFrom] })}
                      >
                        {SKILL_ORIGIN_LABELS[s.importedFrom]}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-nova-text-muted mt-0.5 truncate">
                    {s.description || s.path}
                  </p>
                </div>
                {/* Toggle — built-in skill names are always enabled (whether the
                    row is the built-in fallback or an on-disk override). */}
                <button
                  onClick={() => toggleSkill(s, s.enabled)}
                  disabled={busy === s.name || isBuiltinSkillName(s.name)}
                  aria-label={`${s.enabled ? t('skillRegistry.disable') : t('skillRegistry.enable')} ${s.name}`}
                  title={isBuiltinSkillName(s.name) ? t('skillRegistry.builtinProtected') : undefined}
                  className={`relative shrink-0 w-8 h-5 rounded-full transition-colors disabled:opacity-40 ${
                    s.enabled ? 'bg-[#22c55e]' : 'bg-slate-300 dark:bg-slate-600'
                  } ${isBuiltinSkillName(s.name) ? 'cursor-not-allowed' : ''}`}
                  style={{ outline: 'none' }}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                      s.enabled ? 'left-[14px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="px-3 py-2 border-t border-nova-border shrink-0">
        <p className="text-[11px] text-nova-text-muted flex items-start gap-1.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>{t('skillPanel.hint')}</span>
        </p>
      </div>
    </div>
  )
}
