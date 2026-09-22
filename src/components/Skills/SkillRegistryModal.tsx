import { useState, useEffect, useCallback, useRef } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import { listAllSkills, listImportableSkills, getGlobalRoot, getWorkspaceRoot, SKILL_ORIGIN_LABELS, type SkillInfo, type ImportableSkill, type SkillOrigin } from '@/services/skills/skillManager'
import { isBuiltinSkillName } from '@/services/skills/builtinSkills'
import {
  isSkillEnabled,
  setSkillEnabled,
  setRegistryUrl,
  readSkillConfig,
  fetchRegistryIndex,
  installSkill,
  importSkill,
  uninstallSkill,
  compareRegistryEntry,
  type RegistrySkillInfo,
} from '@/services/skills/skillRegistry'

interface LocalSkillRow extends SkillInfo {
  enabled: boolean
  version?: string
  /** Platform this skill was imported from (provenance display only). */
  importedFrom?: SkillOrigin
  /** Root whose skills.json governs this skill's enabled flag (computed at
   *  reload — also marks the registry install dir for uninstall gating). */
  configRoot: string
}

/** Config root whose skills.json governs a skill's enabled flag. */
async function configRootFor(s: SkillInfo): Promise<string> {
  return s.source === 'global' ? await getGlobalRoot() : s.projectPath || ''
}

/** Registry-managed skills are the ones we installed/imported ourselves into
 *  <configRoot>/skills/<name> (parent dir literally "skills"). Manually
 *  dropped .ourcode/skills entries are never deleted — uninstall there would
 *  only remove the config record. */
const isRegistryManaged = (s: LocalSkillRow): boolean => {
  // Built-in skills are protected and never deletable.
  if (s.builtin) return false
  const parts = s.path.split(/[/\\]/)
  return parts.at(-2) === 'skills' && parts.at(-3) !== '.ourcode'
}

/**
 * Skill management dialog: local skills (enable/disable/uninstall) + remote
 * registry browser (install/update). Mirrors the old plugin marketplace layout,
 * restyled after the "插件市场与技能管理设计稿" — pill tabs, round search,
 * status dot + mono "/name" rows with iOS-style toggles, footer hint bar.
 * Installed/enabled skills surface automatically in the agent's skill index,
 * tool list and "/" slash menu.
 */
export default function SkillRegistryModal() {
  const { isSkillRegistryOpen, closeSkillRegistry, bumpSkillsRevision } = useUIStore()
  const t = useI18n()

  // The local tab lists ALL skills (global + every recent project's). The
  // registry tab installs into a chosen target: 全局 (follows the IDE) or the
  // current project (active session's bound project, browsed folder fallback).
  const [installTarget, setInstallTarget] = useState<'global' | 'project'>('global')
  const [projectRoot, setProjectRoot] = useState('')
  const [tab, setTab] = useState<'local' | 'registry' | 'import'>('local')
  const [search, setSearch] = useState('')
  const [localSkills, setLocalSkills] = useState<LocalSkillRow[]>([])
  const [registrySkills, setRegistrySkills] = useState<RegistrySkillInfo[]>([])
  // Import tab: candidates from other platforms' dirs + the user's selection
  // (keyed `${origin}:${name}` — the same name may come from two platforms).
  const [importSkills, setImportSkills] = useState<ImportableSkill[]>([])
  const [selectedImports, setSelectedImports] = useState<Set<string>>(new Set())
  const [registryUrl, setRegistryUrlState] = useState('')
  // Registry-source editing: draft holds the input while editing, so the
  // displayed URL only updates after a successful save.
  const [editingUrl, setEditingUrl] = useState(false)
  const [draftUrl, setDraftUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<LocalSkillRow | null>(null)
  // Same-name override confirmation: installing/importing a skill whose name
  // already exists (built-in or installed) must be explicitly confirmed first.
  const [confirmOverride, setConfirmOverride] = useState<{
    name: string
    builtin: boolean
    action: () => void
  } | null>(null)
  // Synchronous in-flight guard: `busy` state updates are async, so rapid
  // double-clicks on the same toggle/button would run the action twice before
  // the state lands (toggle flips twice = no-op). A ref keeps the check
  // race-free (see run).
  const busyRef = useRef<string | null>(null)

  const reloadLocal = useCallback(async () => {
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
        configRoot,
      })
    }
    setLocalSkills(rows)
  }, [])

  const reloadRegistry = useCallback(async (root: string) => {
    if (!root) {
      setRegistrySkills([])
      setRegistryUrlState('')
      return
    }
    const list = await fetchRegistryIndex(undefined, root)
    const config = await readSkillConfig(root)
    setRegistrySkills(list)
    setRegistryUrlState(config.registryUrl || '')
  }, [])

  /** Reload the import candidates for a scope (global → home dirs, project →
   *  the current project's external dirs). */
  const reloadImport = useCallback(async (scope: 'global' | 'project') => {
    const root = scope === 'project' ? projectRoot : ''
    setImportSkills(await listImportableSkills(scope, root || undefined))
  }, [projectRoot])

  useEffect(() => {
    if (!isSkillRegistryOpen) return
    // The current project = the active session's bound project (browsed folder
    // as fallback) — the "install to project" target.
    const workspace = useChatStore.getState().getActiveSession()?.projectPath || getWorkspaceRoot() || ''
    setProjectRoot(workspace)
    // Skills follow the IDE by default — install target starts at 全局; the
    // user can switch to 当前项目 in the registry tab.
    setInstallTarget('global')
    reloadLocal()
    void getGlobalRoot().then((globalRoot) => reloadRegistry(globalRoot))
    void reloadImport('global')
  }, [isSkillRegistryOpen, reloadLocal, reloadRegistry, reloadImport])

  if (!isSkillRegistryOpen) return null

  /** Root the registry installs into for the current target. */
  const targetRoot = async (): Promise<string> =>
    installTarget === 'global' ? await getGlobalRoot() : projectRoot

  const switchTarget = async (target: 'global' | 'project') => {
    setInstallTarget(target)
    setEditingUrl(false)
    setDraftUrl('')
    setSelectedImports(new Set())
    await reloadRegistry(target === 'global' ? await getGlobalRoot() : projectRoot)
    await reloadImport(target)
  }

  /** Start editing the registry source URL (prefill with the current one). */
  const startEditUrl = () => {
    setDraftUrl(registryUrl)
    setEditingUrl(true)
  }

  /** Save the URL to the current target's skills.json — empty clears it. */
  const saveRegistryUrl = () => {
    const url = draftUrl.trim()
    if (url && !/^https?:\/\//i.test(url)) {
      setError(t('skillRegistry.registryUrlInvalid'))
      return
    }
    run('registry-url', async () => {
      const root = await targetRoot()
      if (!root) throw new Error(t('skillRegistry.workspaceRequired'))
      if (!(await setRegistryUrl(root, url))) throw new Error(t('skillRegistry.registryUrlSaveFailed'))
      setEditingUrl(false)
    })
  }

  const run = async (name: string, fn: () => Promise<unknown>) => {
    if (busyRef.current) return
    busyRef.current = name
    setBusy(name)
    setError(null)
    try {
      await fn()
    } catch (e: any) {
      setError(t('skillRegistry.error', { error: e.message || String(e) }))
    } finally {
      busyRef.current = null
      setBusy(null)
      reloadLocal()
      reloadRegistry(await targetRoot())
      reloadImport(installTarget)
      // Any skills change must reach the sidebar panel too — it stays mounted
      // behind this modal and would otherwise show stale data.
      bumpSkillsRevision()
    }
  }

  const localByName = new Map(localSkills.map((s) => [s.name, s]))

  const filteredLocal = localSkills.filter((s) => {
    if (!search) return true
    const q = search.toLowerCase()
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  })

  const filteredRegistry = registrySkills.filter((s) => {
    if (!search) return true
    const q = search.toLowerCase()
    return s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)
  })

  const filteredImport = importSkills.filter((s) => {
    if (!search) return true
    const q = search.toLowerCase()
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  })

  const statusOf = (remote: RegistrySkillInfo) => {
    const local = localByName.get(remote.name)
    // A built-in fallback has no on-disk copy — offer an "install" (override)
    // rather than "installed", so the user can replace the default.
    if (local?.builtin) return 'install'
    return compareRegistryEntry(local, remote)
  }

  /** Install a registry skill, asking for confirmation when its name already
   *  exists (built-in fallback or an installed skill). */
  const installOrConfirm = (r: RegistrySkillInfo) => {
    const existing = localByName.get(r.name)
    if (existing) {
      setConfirmOverride({
        name: r.name,
        builtin: existing.builtin === true,
        action: () => void run(r.name, async () => {
          const root = await targetRoot()
          if (!root) throw new Error('未选择安装目标')
          await installSkill(r.name, root, r)
        }),
      })
      return
    }
    void run(r.name, async () => {
      const root = await targetRoot()
      if (!root) throw new Error('未选择安装目标')
      await installSkill(r.name, root, r)
    })
  }

  /** Whether a skill name already exists in the current target dir (sync —
   *  local rows carry their configRoot). */
  const nameExistsInTarget = (name: string): boolean =>
    installTarget === 'project'
      ? localSkills.some((l) => l.configRoot === projectRoot && l.name === name)
      : localSkills.some((l) => l.source === 'global' && l.name === name)

  /** Whether an import candidate already exists in the current target dir. */
  const existsInTarget = (s: ImportableSkill): boolean => nameExistsInTarget(s.name)

  const toggleImport = (key: string) => {
    setSelectedImports((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Copy every selected candidate into the target's own `skills/` dir. */
  const doImport = async () => {
    const root = await targetRoot()
    if (!root) throw new Error(t('skillRegistry.workspaceRequired'))
    for (const key of selectedImports) {
      const sep = key.indexOf(':')
      const origin = key.slice(0, sep) as SkillOrigin
      const name = key.slice(sep + 1)
      const src = importSkills.find((s) => `${s.origin}:${s.name}` === key)
      if (!src) continue
      const ok = await importSkill(name, root, src.path, origin)
      if (!ok) throw new Error(t('skillRegistry.importFailed', { name }))
    }
    setSelectedImports(new Set())
  }

  /** Import after confirming any same-name collisions (built-in fallback or a
   *  skill already present in the target). */
  const importSelected = () => {
    if (selectedImports.size === 0) return
    const conflictNames = [...selectedImports]
      .map((key) => key.slice(key.indexOf(':') + 1))
      .filter((name) => nameExistsInTarget(name))
    if (conflictNames.length > 0) {
      setConfirmOverride({
        name: conflictNames.join(', '),
        builtin: conflictNames.some((n) => localByName.get(n)?.builtin === true),
        action: () => void run('import', doImport),
      })
      return
    }
    void run('import', doImport)
  }

  /** Install target switcher — shared by the registry and import tabs. */
  const targetSelector = (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-xs text-nova-text-muted shrink-0">{t('skillRegistry.installTarget')}</span>
      <div className="flex rounded-full border border-nova-border overflow-hidden text-xs">
        <button
          onClick={() => switchTarget('global')}
          className={`px-3 py-1 transition-colors ${
            installTarget === 'global' ? 'bg-[var(--accent)] text-white' : 'text-nova-text-muted hover:bg-nova-hover'
          }`}
        >
          {t('skillRegistry.installGlobal')}
        </button>
        <button
          onClick={() => switchTarget('project')}
          disabled={!projectRoot}
          title={projectRoot ? undefined : t('skillRegistry.installProjectDisabled')}
          className={`px-3 py-1 transition-colors disabled:opacity-40 ${
            installTarget === 'project' ? 'bg-[var(--accent)] text-white' : 'text-nova-text-muted hover:bg-nova-hover'
          }`}
        >
          {t('skillRegistry.installProject')}
        </button>
      </div>
      {installTarget === 'project' && projectRoot && (
        <span className="text-[11px] text-nova-text-muted truncate min-w-0" title={projectRoot}>
          {projectRoot.split(/[/\\]/).pop()}
        </span>
      )}
    </div>
  )

  return (
    <div role="dialog" aria-modal="true" aria-label={t('skillRegistry.dialog')} className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={closeSkillRegistry}>
      <div
        className="glass-modal rounded-2xl w-[760px] max-h-[80vh] flex flex-col overflow-hidden" style={{ boxShadow: 'var(--shadow-xl)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nova-border">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#10b981] to-[#059669] flex items-center justify-center">
              <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor" className="text-white" xmlns="http://www.w3.org/2000/svg">
                <path d="M823.296 64.96l135.744 135.744-769.28 769.28-135.808-135.68L823.296 64.96z m0 108.544L162.432 834.24l27.2 27.136L850.432 200.704l-27.2-27.2zM803.2 512a15.68 15.68 0 0 1 15.232 14.336 146.88 146.88 0 0 0 127.68 133.12 15.68 15.68 0 0 1-0.64 31.232 146.752 146.752 0 0 0-133.12 127.744 15.68 15.68 0 0 1-31.104-0.64 146.816 146.816 0 0 0-127.488-133.184 15.68 15.68 0 0 1 0.64-31.232 146.752 146.752 0 0 0 132.992-127.744 15.68 15.68 0 0 1 12.032-13.248l3.84-0.384z m-576-448a15.68 15.68 0 0 1 15.232 14.336 146.88 146.88 0 0 0 127.68 133.12 15.68 15.68 0 0 1-0.64 31.232 146.752 146.752 0 0 0-133.12 127.744 15.68 15.68 0 0 1-31.104-0.64 146.816 146.816 0 0 0-127.488-133.184 15.68 15.68 0 0 1 0.64-31.232 146.752 146.752 0 0 0 132.992-127.744 15.68 15.68 0 0 1 12.032-13.248L227.328 64z m282.624 0a10.24 10.24 0 0 1 10.496 8.832c3.328 23.36 22.4 41.216 45.952 42.944a10.24 10.24 0 0 1 0.64 20.48 50.112 50.112 0 0 0-42.944 45.888 10.24 10.24 0 0 1-20.48 0.64 50.112 50.112 0 0 0-45.888-42.944 10.24 10.24 0 0 1-0.64-20.416 50.112 50.112 0 0 0 42.944-45.952 10.24 10.24 0 0 1 6.912-8.96L509.888 64z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-nova-text-primary">{t('skillRegistry.title')}</h2>
              <p className="text-xs text-nova-text-muted">{t('skillRegistry.subtitle')}</p>
            </div>
          </div>
          <button
            onClick={closeSkillRegistry}
            className="p-2 text-nova-text-muted hover:text-white hover:bg-nova-hover rounded-lg transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeWidth={2} d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        </div>

        {/* Toolbar: pill tabs + search (设计稿: rounded-full pills & glass input) */}
        <div className="px-6 pt-3 pb-4 flex flex-col gap-3 border-b border-nova-border">
          <div className="flex gap-2">
            <button
              className={`px-4 py-1.5 rounded-full text-sm font-bold transition-all ${
                tab === 'local'
                  ? 'text-[var(--accent)] bg-white border border-[var(--accent)]/20 shadow-sm'
                  : 'text-nova-text-muted hover:bg-nova-hover'
              }`}
              onClick={() => setTab('local')}
            >
              {t('skillRegistry.localTab', { count: localSkills.length })}
            </button>
            <button
              className={`px-4 py-1.5 rounded-full text-sm font-bold transition-all ${
                tab === 'registry'
                  ? 'text-[var(--accent)] bg-white border border-[var(--accent)]/20 shadow-sm'
                  : 'text-nova-text-muted hover:bg-nova-hover'
              }`}
              onClick={() => setTab('registry')}
            >
              {t('skillRegistry.registryTab')}
            </button>
            <button
              className={`px-4 py-1.5 rounded-full text-sm font-bold transition-all ${
                tab === 'import'
                  ? 'text-[var(--accent)] bg-white border border-[var(--accent)]/20 shadow-sm'
                  : 'text-nova-text-muted hover:bg-nova-hover'
              }`}
              onClick={() => setTab('import')}
            >
              {t('skillRegistry.importTab')}
            </button>
          </div>
          <div className="relative w-full">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nova-text-muted pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder={t('skillRegistry.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-nova-bg border border-nova-border rounded-full text-sm text-nova-text-primary placeholder-nova-text-muted focus:outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_1.5px_rgba(0,88,188,0.3)] transition-all"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{error}</div>
          )}

          {tab === 'local' ? (
            filteredLocal.length === 0 ? (
              <div className="text-center py-16 text-nova-text-muted text-sm">
                {search ? t('skillRegistry.noMatch') : t('skillRegistry.noLocalSkills')}
              </div>
            ) : (
              <div className="space-y-1">
                {filteredLocal.map((s) => (
                  <div
                    key={`${s.source}:${s.projectPath || 'global'}:${s.name}`}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-white/50 dark:hover:bg-white/5 transition-colors group"
                  >
                    {/* Status dot */}
                    <span className={`w-2 h-2 rounded-full shrink-0 ${s.enabled ? 'bg-[#22c55e]' : 'bg-slate-400'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span
                          className="font-mono text-[13px] font-bold truncate"
                          style={{ color: s.enabled ? 'var(--accent)' : 'var(--text-secondary)' }}
                        >
                          /{s.name}
                        </span>
                        {s.version && <span className="font-mono text-[11px] text-nova-text-muted shrink-0">v{s.version}</span>}
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0 ${
                          s.enabled
                            ? 'bg-[#22c55e]/15 text-[#22c55e] border-[#22c55e]/30'
                            : 'bg-gray-500/15 text-gray-400 border-gray-500/30'
                        }`}>
                          {s.enabled ? t('skillRegistry.installed') : t('plugin.statusDisabled')}
                        </span>
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
                      <p className="text-xs text-nova-text-muted mt-0.5 truncate">
                        {s.description || s.path}
                      </p>
                    </div>
                    {/* Toggle switch (设计稿) — built-in skill names are always on. */}
                    <button
                      onClick={() => run(s.name, async () => {
                        if (!s.configRoot) throw new Error('无法确定该技能的配置位置')
                        await setSkillEnabled(s.name, !s.enabled, s.configRoot)
                      })}
                      disabled={busy === s.name || isBuiltinSkillName(s.name)}
                      aria-label={`${s.enabled ? t('skillRegistry.disable') : t('skillRegistry.enable')} ${s.name}`}
                      title={isBuiltinSkillName(s.name) ? t('skillRegistry.builtinProtected') : undefined}
                      className={`relative shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-40 ${
                        s.enabled ? 'bg-[#22c55e]' : 'bg-slate-300 dark:bg-slate-600'
                      } ${isBuiltinSkillName(s.name) ? 'cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
                          s.enabled ? 'left-[18px]' : 'left-0.5'
                        }`}
                      />
                    </button>
                    {/* Uninstall (icon button, appears on hover to keep the row
                        compact). Only registry-managed skills (ours, in a
                        `<configRoot>/skills/` dir) can be deleted — skills from
                        other platforms' directories are never removed. */}
                    {isRegistryManaged(s) && (
                      <button
                        onClick={() => setConfirmUninstall(s)}
                        disabled={busy === s.name}
                        title={t('skillRegistry.uninstall')}
                        className="shrink-0 p-1.5 text-nova-text-muted opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-all disabled:opacity-0"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )
          ) : tab === 'import' ? (
            <div>
              {targetSelector}
              <p className="text-xs text-nova-text-muted mb-3">{t('skillRegistry.importHint')}</p>
              {importSkills.length === 0 ? (
                <div className="text-center py-16 text-nova-text-muted text-sm">
                  {search ? t('skillRegistry.noMatch') : t('skillRegistry.noImportSources')}
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    {filteredImport.map((s) => {
                      const key = `${s.origin}:${s.name}`
                      const checked = selectedImports.has(key)
                      const exists = existsInTarget(s)
                      return (
                        <div key={key} className="flex items-center gap-3 p-3 rounded-lg hover:bg-white/50 dark:hover:bg-white/5 transition-colors">
                          {/* Checkbox (multi-select) */}
                          <button
                            onClick={() => toggleImport(key)}
                            disabled={busy === 'import'}
                            aria-label={t('skillRegistry.selectImport', { name: s.name })}
                            className={`shrink-0 w-5 h-5 rounded-md border flex items-center justify-center transition-all disabled:opacity-40 ${
                              checked ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-nova-border hover:border-[var(--accent)]'
                            }`}
                          >
                            {checked && (
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                          {/* Status dot: green once the skill exists in the target */}
                          <span className={`w-2 h-2 rounded-full shrink-0 ${exists ? 'bg-[#22c55e]' : 'bg-slate-400'}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <span className="font-mono text-[13px] font-bold truncate" style={{ color: 'var(--accent)' }}>{s.name}</span>
                              <span
                                className="shrink-0 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-nova-bg border border-nova-border text-nova-text-muted"
                                title={s.path}
                              >
                                {SKILL_ORIGIN_LABELS[s.origin]}
                              </span>
                              {exists && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium bg-[#22c55e]/15 text-[#22c55e] border-[#22c55e]/30 shrink-0">
                                  {t('skillRegistry.existsTag')}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-nova-text-muted mt-0.5 truncate">
                              {s.description || s.path}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="pt-3">
                    <button
                      onClick={importSelected}
                      disabled={selectedImports.size === 0 || busy === 'import'}
                      className="w-full py-2.5 text-sm font-bold rounded-full bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-all"
                    >
                      {busy === 'import'
                        ? t('skillRegistry.busy')
                        : t('skillRegistry.importSelected', { count: selectedImports.size })}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div>
              {targetSelector}
              {/* Registry source: configure the index URL right in the UI —
                  no hand-editing skills.json (大众用户友好). */}
              <div className="mb-3">
                {editingUrl || !registryUrl ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={draftUrl}
                      onChange={(e) => setDraftUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveRegistryUrl() }}
                      placeholder={t('skillRegistry.registryUrlPlaceholder')}
                      aria-label={t('skillRegistry.registryUrlLabel')}
                      className="flex-1 min-w-0 px-3.5 py-1.5 bg-nova-bg border border-nova-border rounded-full text-xs font-mono text-nova-text-primary placeholder-nova-text-muted placeholder:font-sans focus:outline-none focus:border-[var(--accent)] transition-all"
                    />
                    <button
                      onClick={saveRegistryUrl}
                      disabled={busy === 'registry-url'}
                      className="shrink-0 px-3.5 py-1.5 text-xs font-bold rounded-full bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-all"
                    >
                      {t('skillRegistry.registryUrlSave')}
                    </button>
                    {editingUrl && (
                      <button
                        onClick={() => { setEditingUrl(false); setDraftUrl('') }}
                        className="shrink-0 px-3 py-1.5 text-xs text-nova-text-muted hover:text-nova-text-primary transition-colors"
                      >
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 min-w-0">
                    <svg className="w-3.5 h-3.5 shrink-0 text-nova-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5m9.656-1.172l-1.5 1.5m1.172-9.656a4 4 0 015.656 5.656l-3 3a4 4 0 01-5.656 0" />
                    </svg>
                    <span className="text-xs text-nova-text-muted shrink-0">{t('skillRegistry.registryUrlLabel')}</span>
                    <span className="font-mono text-xs text-nova-text-primary truncate min-w-0" title={registryUrl}>{registryUrl}</span>
                    <button
                      onClick={startEditUrl}
                      className="shrink-0 px-2.5 py-1 text-[11px] font-medium text-nova-text-muted hover:text-[var(--accent)] border border-nova-border rounded-full hover:border-[var(--accent)]/40 transition-all"
                    >
                      {t('skillRegistry.registryUrlEdit')}
                    </button>
                  </div>
                )}
                <p className="text-xs text-nova-text-muted mt-1.5">
                  {registryUrl
                    ? t('skillRegistry.installFromRegistry')
                    : t('skillRegistry.noRegistryConfigured')}
                </p>
              </div>
              {registrySkills.length === 0 ? (
                <div className="text-center py-16 text-nova-text-muted text-sm">
                  {search ? t('skillRegistry.noMatch') : t('skillRegistry.noRegistrySkills')}
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredRegistry.map((r) => {
                    const status = statusOf(r)
                    return (
                      <div key={r.name} className="flex items-center gap-3 p-3 rounded-lg hover:bg-white/50 dark:hover:bg-white/5 transition-colors">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${
                          status === 'install' ? 'bg-slate-400' : 'bg-[#22c55e]'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono text-[13px] font-bold truncate" style={{ color: 'var(--accent)' }}>{r.name}</span>
                            {r.version && <span className="font-mono text-[11px] text-nova-text-muted shrink-0">v{r.version}</span>}
                            {r.author && <span className="text-[11px] text-nova-text-muted shrink-0">by {r.author}</span>}
                            {status !== 'install' && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium bg-[#22c55e]/15 text-[#22c55e] border-[#22c55e]/30 shrink-0">
                                {status === 'update' ? t('skillRegistry.update') : t('skillRegistry.installed')}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-nova-text-muted mt-0.5 truncate">{r.description}</p>
                        </div>
                        <button
                          onClick={() => installOrConfirm(r)}
                          disabled={busy === r.name}
                          className={`shrink-0 px-3 py-1.5 text-xs font-bold rounded-full transition-all disabled:opacity-40 ${
                            status === 'installed'
                              ? 'bg-nova-hover text-nova-text-muted border border-nova-border cursor-default'
                              : 'bg-[var(--accent)] text-white hover:opacity-90'
                          }`}
                        >
                          {busy === r.name
                            ? t('skillRegistry.busy')
                            : status === 'installed'
                              ? t('skillRegistry.installed')
                              : status === 'update'
                                ? t('skillRegistry.update')
                                : t('skillRegistry.install')}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer hint (设计稿) */}
        <div className="px-6 py-3 border-t border-nova-border bg-nova-bg/40">
          <p className="text-xs text-nova-text-muted flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v-3M4 7v3M4 13a4 4 0 000 6M4 7a4 4 0 000 6M20 16v-3M20 7v3M20 13a4 4 0 000 6M20 7a4 4 0 000 6" />
            </svg>
            {t('skillRegistry.installFromRegistry')}
          </p>
        </div>
      </div>

      {/* Uninstall confirmation */}
      {confirmUninstall && (
        <div role="dialog" aria-modal="true" aria-label={t('skillRegistry.uninstallConfirm', { name: confirmUninstall.name })} className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60" onClick={() => setConfirmUninstall(null)}>
          <div className="glass-modal rounded-2xl p-6 w-[400px]" style={{ boxShadow: 'var(--shadow-xl)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-nova-text-primary mb-2">
              {t('skillRegistry.uninstallConfirm', { name: confirmUninstall.name })}
            </h3>
            <p className="text-xs text-nova-text-muted mb-6">
              {t('skillRegistry.uninstallDesc', { name: confirmUninstall.name })}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setConfirmUninstall(null)}
                className="px-4 py-2 text-sm text-nova-text-muted hover:text-nova-text-primary transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  const row = confirmUninstall
                  setConfirmUninstall(null)
                  run(row.name, async () => {
                    const configRoot = await configRootFor(row)
                    if (!configRoot) throw new Error('无法确定该技能的配置位置')
                    await uninstallSkill(row.name, configRoot)
                  })
                }}
                className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
              >
                {t('skillRegistry.uninstall')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Same-name override confirmation */}
      {confirmOverride && (
        <div role="dialog" aria-modal="true" aria-label={t('skillRegistry.overrideConfirm')} className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60" onClick={() => setConfirmOverride(null)}>
          <div className="glass-modal rounded-2xl p-6 w-[440px]" style={{ boxShadow: 'var(--shadow-xl)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-nova-text-primary mb-2">
              {t('skillRegistry.overrideConfirm')}
            </h3>
            <p className="text-xs text-nova-text-muted mb-6">
              {confirmOverride.builtin
                ? t('skillRegistry.overrideBuiltinDesc', { name: confirmOverride.name })
                : t('skillRegistry.overrideDesc', { name: confirmOverride.name })}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setConfirmOverride(null)}
                className="px-4 py-2 text-sm text-nova-text-muted hover:text-nova-text-primary transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  const action = confirmOverride.action
                  setConfirmOverride(null)
                  action()
                }}
                className="px-4 py-2 text-sm font-medium bg-[var(--accent)] text-white rounded-lg hover:opacity-90 transition-all"
              >
                {t('skillRegistry.overrideConfirmAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
