/**
 * Skill Manager — discovers Agent-Skills-style skills (SKILL.md files) from
 * OUR OWN skill directories (project .ourcode/skills + skills, global
 * <userData>/skills), parses their frontmatter, and exposes them as dynamic
 * tools (skill__<name>) so the agent can load a skill's instructions on
 * demand.
 *
 * Skills written for other AI tools (Claude Code, Codex, ZCode, opencode,
 * Cursor, Gemini CLI, Windsurf, ChatGPT) share the same Agent Skills file
 * format (<name>/SKILL.md + name/description frontmatter) but live in their
 * own directories (.claude/skills, .agents/skills, …). We never use those
 * directories directly — they may change or disappear at any time. Instead
 * they are IMPORT SOURCES: the management UI lists them (listImportableSkills)
 * and the user picks which to copy into our own `skills/` dir (importSkill in
 * skillRegistry), where they become ours and are no longer affected by the
 * source tool.
 *
 * The system prompt only injects a compact index of available skills;
 * invoking skill__<name> returns the full SKILL.md content, which the model
 * then follows. Each invocation is recorded into the usage dashboard
 * (category 'skill').
 */
import type { ToolDefinition } from '@/services/tools/types'
import { isSkillEnabled } from '@/services/skills/skillRegistry'
import { BUILTIN_SKILLS } from '@/services/skills/builtinSkills'
import { useUIStore } from '@/stores/uiStore'

/** Platform whose directory a skill was found in (import sources only). */
export type SkillOrigin =
  | 'agents'
  | 'claude'
  | 'zcode'
  | 'cursor'
  | 'opencode'
  | 'gemini'
  | 'windsurf'

export interface SkillInfo {
  name: string
  description: string
  /** Global skills (follow the IDE) vs project skills (scoped to a project). */
  source: 'global' | 'project'
  /** Owning project root — set for project skills, undefined for global. */
  projectPath?: string
  path: string
  /** Full raw file content (frontmatter + body) */
  content: string
  mtime: number
  /** Built-in skills ship with the IDE — always enabled and never fully
   *  deletable (the built-in copy is a fallback that resurfaces when any
   *  same-named on-disk override is removed). */
  builtin?: boolean
}

/** A skill found in another platform's directory — a candidate for import
 *  (copied into our own dirs before use; never used directly). */
export interface ImportableSkill {
  name: string
  description: string
  /** Platform whose directory it came from. */
  origin: SkillOrigin
  /** Owning skill directory (contains SKILL.md or skill.md). */
  path: string
}

/** Display labels for skill origins (proper nouns — no i18n needed). */
export const SKILL_ORIGIN_LABELS: Record<SkillOrigin, string> = {
  agents: 'Agents',
  claude: 'Claude',
  zcode: 'ZCode',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  windsurf: 'Windsurf',
}

/** Our own project skill dirs — the only dirs whose skills are usable. */
const OWN_PROJECT_SKILL_DIRS = ['.ourcode/skills', 'skills'] // skills = registry/import install target

/** Other platforms' project skill dirs — import sources, never auto-discovered. */
const EXTERNAL_PROJECT_SKILL_DIRS: Array<[SkillOrigin, string]> = [
  ['agents', '.agents/skills'], // cross-tool standard (Codex/Cursor/Gemini/opencode/ZCode…)
  ['claude', '.claude/skills'],
  ['zcode', '.zcode/skills'],
  ['cursor', '.cursor/skills'],
  ['opencode', '.opencode/skills'],
  ['gemini', '.gemini/skills'],
  ['windsurf', '.windsurf/skills'],
]

/** Other platforms' home-dir skill dirs — global-scope import sources. */
const EXTERNAL_HOME_SKILL_DIRS: Array<[SkillOrigin, string]> = [
  ['agents', '.agents/skills'],
  ['claude', '.claude/skills'],
  ['zcode', '.zcode/skills'],
  ['cursor', '.cursor/skills'],
  ['opencode', '.config/opencode/skills'],
  ['gemini', '.gemini/skills'],
  ['windsurf', '.codeium/windsurf/skills'],
]

/** Renderer-side workspace root (the file tree's data attribute, falling back
 *  to the selected project — the tree only mounts in tree view). Note: callers
 *  working inside a session should prefer the session's own project path (the
 *  current project follows the active conversation, not the browsed folder). */
export function getWorkspaceRoot(): string {
  return document.getElementById('file-tree-root')?.getAttribute('data-root-path') || useUIStore.getState().rootPath || ''
}

function joinPath(dir: string, name: string): string {
  return dir.replace(/[\\/]$/, '') + '/' + name
}

/** Global skills/config root = <userData> (skills live in <userData>/skills,
 *  their skills.json config in <userData>/skills.json). '' when unavailable. */
export async function getGlobalRoot(): Promise<string> {
  try {
    return (await window.electronAPI?.getPath?.('userData')) || ''
  } catch {
    return ''
  }
}

/** User home dir — home-scoped cross-tool skill dirs (~/.claude/skills, …). */
export async function getHomeRoot(): Promise<string> {
  try {
    return (await window.electronAPI?.getPath?.('home')) || ''
  } catch {
    return ''
  }
}

async function listDirSafe(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
  try {
    const entries = await window.electronAPI.listDir(dir)
    return (entries || []).map((e) => ({ name: e.name, isDirectory: !!e.isDirectory }))
  } catch {
    return []
  }
}

async function statSafe(path: string): Promise<{ modifiedAt: number } | null> {
  try {
    return await window.electronAPI.stat(path)
  } catch {
    return null
  }
}

async function readFileSafe(path: string): Promise<string> {
  try {
    const { content } = await window.electronAPI.readFile(path)
    return content || ''
  } catch {
    return ''
  }
}

/**
 * Parse a skill's frontmatter (name / description) with graceful fallbacks:
 * the directory name becomes the skill name, and the first non-empty line of
 * the body becomes the description when frontmatter is absent.
 */
export function parseSkillFrontmatter(content: string, fallbackName: string): { name: string; description: string; body: string } {
  let name = fallbackName
  let description = ''
  let body = content
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (m) {
    body = content.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
      if (!kv) continue
      const key = kv[1].toLowerCase()
      const value = kv[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'name' && value) name = value
      if (key === 'description' && value) description = value
    }
  }
  if (!description) {
    const first = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
    description = (first || fallbackName).slice(0, 100)
  }
  return { name, description, body }
}

// ───────────────────────── discovery ─────────────────────────

/** A directory to scan for skills, plus its enable/disable config root. */
interface SkillDir {
  dir: string
  source: 'global' | 'project'
  /** Root whose skills.json governs this skill's enabled flag (global → <userData>). */
  configRoot: string
  /** Owning project root (project skills only). */
  projectPath?: string
}

/** Our own workspace skill dirs under a project root (source 'project'). */
function projectSkillDirs(root: string): SkillDir[] {
  return OWN_PROJECT_SKILL_DIRS.map((d) => ({
    dir: joinPath(root, d),
    source: 'project' as const,
    configRoot: root,
    projectPath: root,
  }))
}

/** Our own global skill dir: <userData>/skills ('' when unavailable). */
async function globalSkillDirs(): Promise<SkillDir[]> {
  const globalRoot = await getGlobalRoot()
  if (!globalRoot) return []
  return [{ dir: joinPath(globalRoot, 'skills'), source: 'global' as const, configRoot: globalRoot }]
}

interface SkillCache {
  key: string
  mtime: number
  /** Fingerprint of the candidate file set — deleting a skill must invalidate
   *  the cache even when its (now-removed) mtime would lower `newest`. */
  fileKey: string
  skills: SkillInfo[]
}

let _cache: SkillCache | null = null

/** Read a skill's content from a directory (SKILL.md wins over skill.md). */
async function readSkillFileSafe(dir: string): Promise<string> {
  return (await readFileSafe(joinPath(dir, 'SKILL.md'))) || (await readFileSafe(joinPath(dir, 'skill.md')))
}

/**
 * Parse + enable-filter skills from the scanned dirs. `includeDisabled` skips
 * the skills.json enabled filter (registry/panel UI needs disabled skills
 * visible so toggles stay reachable).
 */
async function parseDirs(dirs: SkillDir[], includeDisabled: boolean): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  for (const sd of dirs) {
    const entries = await listDirSafe(sd.dir)
    for (const e of entries) {
      if (!e.isDirectory) continue
      const dir = joinPath(sd.dir, e.name)
      const content = await readSkillFileSafe(dir)
      if (!content) continue
      const parsed = parseSkillFrontmatter(content, e.name)
      // Respect skills.json enable/disable overrides (default: enabled) — global
      // skills consult <userData>/skills.json, project skills their project's.
      if (!includeDisabled && !(await isSkillEnabled(parsed.name, sd.configRoot))) continue
      skills.push({
        name: parsed.name,
        description: parsed.description,
        source: sd.source,
        projectPath: sd.projectPath,
        path: dir,
        content,
        mtime: 0, // caller fills from the newest candidate mtime
      })
    }
  }
  return skills
}

/**
 * Deduplicate by name. Two sources may declare the same frontmatter name, which
 * would produce duplicate skill__<name> tool definitions (some providers
 * reject). `projectOverGlobal` drops a global skill shadowed by a project skill
 * of the same name (agent context — project wins); otherwise every
 * source+project combination is kept (management UI shows both, labeled).
 */
function dedupSkills(skills: SkillInfo[], projectOverGlobal: boolean): SkillInfo[] {
  skills.sort((a, b) => a.name.localeCompare(b.name))
  const seen = new Map<string, SkillInfo>()
  for (const s of skills) {
    const key = projectOverGlobal ? s.name : `${s.source}:${s.projectPath || ''}:${s.name}`
    const prev = seen.get(key)
    if (!prev) {
      seen.set(key, s)
      continue
    }
    // Built-in skills are a fallback: an on-disk skill of the same name wins,
    // so a user can "override" a built-in by installing/importing a same-named
    // skill; deleting that override restores the built-in.
    if (prev.builtin && !s.builtin) {
      seen.set(key, s)
      continue
    }
    if (s.builtin && !prev.builtin) continue
    if (projectOverGlobal && prev.source === 'global' && s.source === 'project') seen.set(key, s)
  }
  return [...seen.values()]
}

/** Built-in fallback skills — injected into every discovery result so they
 *  are always present and enabled. An on-disk skill of the same name overrides
 *  a built-in (see dedupSkills); deleting that override restores the built-in. */
function builtinSkills(): SkillInfo[] {
  return BUILTIN_SKILLS.map((b) => ({
    name: b.name,
    description: b.description,
    source: 'global' as const,
    projectPath: undefined,
    path: `__builtin__/${b.name}`,
    content: b.content,
    mtime: 0,
    builtin: true,
  }))
}

/**
 * Scan `dirs` honoring the module-level cache (keyed by cacheKey + newest file
 * mtime + candidate set + every config root's skills.json mtime, so toggles
 * invalidate too). Attaches the newest candidate mtime to each skill for the
 * knowledge cache.
 */
async function cachedDiscover(
  cacheKey: string,
  dirs: SkillDir[],
  includeDisabled: boolean,
  force: boolean,
  projectOverGlobal: boolean,
): Promise<SkillInfo[]> {
  const candidates: Array<{ sd: SkillDir; dir: string; path: string }> = []
  for (const sd of dirs) {
    const entries = await listDirSafe(sd.dir)
    for (const e of entries) {
      if (!e.isDirectory) continue
      const sub = joinPath(sd.dir, e.name)
      candidates.push({ sd, dir: sub, path: joinPath(sub, 'SKILL.md') })
      candidates.push({ sd, dir: sub, path: joinPath(sub, 'skill.md') })
    }
  }

  let newest = 0
  for (const c of candidates) {
    const s = await statSafe(c.path)
    if (s && s.modifiedAt > newest) newest = s.modifiedAt
  }
  // skills.json enable/disable toggles must invalidate the cache too — stat
  // every config root involved (global + each project), deduplicated.
  let configMtime = 0
  for (const root of new Set(dirs.map((d) => d.configRoot))) {
    const s = await statSafe(joinPath(root, 'skills.json'))
    if (s && s.modifiedAt > configMtime) configMtime = s.modifiedAt
  }
  const cacheMtime = Math.max(newest, configMtime)
  // Order matters for the fingerprint — sort so an identical set always hashes
  // the same regardless of directory enumeration order.
  const fileKey = candidates.map((c) => c.path).sort().join('\n')
  if (!force && _cache && _cache.key === cacheKey && _cache.mtime >= cacheMtime && _cache.fileKey === fileKey) {
    return _cache.skills
  }

  const skills = await parseDirs(dirs, includeDisabled)
  for (const s of skills) s.mtime = newest
  const result = dedupSkills([...builtinSkills(), ...skills], projectOverGlobal)
  _cache = { key: cacheKey, mtime: cacheMtime, fileKey, skills: result }
  return result
}

/**
 * Discover + parse skills (cached by newest mtime + candidate set) for a single
 * workspace: global skills (follow the IDE) + that project's own skills. This
 * is the agent-facing view — project skills shadow same-named global skills so
 * the tool list / skill index never carries duplicate names.
 */
export async function listSkills(force = false, rootOverride?: string, includeDisabled = false): Promise<SkillInfo[]> {
  const root = rootOverride ?? getWorkspaceRoot()
  // 全局技能永远扫；项目技能要看主进程认不认这个根。会话的 projectPath 可能指向
  // 一个「没被打开过」的项目（后台/恢复的会话），那样每次 fs:listDir / fs:stat
  // 都会被 allowlist 拒绝并刷 EUNTRUSTED 日志。
  const dirs = await globalSkillDirs()
  if (root) {
    try {
      const ok = await window.electronAPI?.authorize?.(root)
      // 明确 false = 主进程不认；跳过项目目录，只留全局技能。
      if (ok !== false) dirs.push(...projectSkillDirs(root))
    } catch {
      /* 桥不可用（测试 / 预览沙盘）：按老行为继续扫 */
      dirs.push(...projectSkillDirs(root))
    }
  }
  return cachedDiscover(`root:${root}:${includeDisabled}`, dirs, includeDisabled, force, true)
}

/**
 * All skills for the management UI: global skills + project skills of every
 * recent project (authorized for the fs bridge). Unlike listSkills, a global
 * and a project skill with the same name both show — each labeled by source
 * and origin.
 */
export async function listAllSkills(force = false, includeDisabled = true): Promise<SkillInfo[]> {
  const candidates = [...new Set((useUIStore.getState().recentProjects || []).filter(Boolean))]
  // 最近项目里可能有一堆主进程不认的根（从没被打开/信任过）。对它们扫 skills 目录
  // 只会让每一条 fs:listDir / fs:stat 抛 EUNTRUSTED，日志刷屏又没有结果 ——
  // 先用 authorize 过一遍，明确 false 的直接不扫（undefined = 桥不可用，保留老行为）。
  const roots: string[] = []
  for (const r of candidates) {
    try {
      const ok = await window.electronAPI?.authorize?.(r)
      if (ok !== false) roots.push(r)
    } catch {
      roots.push(r)
    }
  }
  const dirs = await globalSkillDirs()
  for (const r of roots) dirs.push(...projectSkillDirs(r))
  const rootsKey = roots.sort().join('|')
  return cachedDiscover(`all:${rootsKey}:${includeDisabled}`, dirs, includeDisabled, force, false)
}

/**
 * Skills importable from other platforms' directories for a scope: 'global'
 * scans the home-dir skill dirs (~/.claude/skills, ~/.agents/skills, …),
 * 'project' the given project root's own external dirs. Import sources are
 * listed read-only — they never enter the agent's skill index until the user
 * imports them into our own dirs (importSkill). Same frontmatter name from
 * two platforms stays listed twice, labeled by origin.
 */
export async function listImportableSkills(scope: 'global' | 'project', projectRoot?: string): Promise<ImportableSkill[]> {
  const dirs: Array<{ dir: string; origin: SkillOrigin }> = []
  if (scope === 'global') {
    const home = await getHomeRoot()
    if (home) {
      for (const [origin, rel] of EXTERNAL_HOME_SKILL_DIRS) {
        // Home dirs aren't in the main-process fs allowlist — authorize each
        // so fs:listDir can probe them (a no-op once registered, mirroring
        // how project roots are authorized).
        const dir = joinPath(home, rel)
        try { await window.electronAPI?.authorize?.(dir) } catch { /* keep scanning the rest */ }
        dirs.push({ dir, origin })
      }
    }
  } else if (projectRoot) {
    try { await window.electronAPI?.authorize?.(projectRoot) } catch { /* keep scanning home only */ }
    for (const [origin, rel] of EXTERNAL_PROJECT_SKILL_DIRS) {
      dirs.push({ dir: joinPath(projectRoot, rel), origin })
    }
  }

  const seen = new Set<string>()
  const skills: ImportableSkill[] = []
  for (const { dir, origin } of dirs) {
    const entries = await listDirSafe(dir)
    for (const e of entries) {
      if (!e.isDirectory) continue
      const skillDir = joinPath(dir, e.name)
      const content = await readSkillFileSafe(skillDir)
      if (!content) continue
      const parsed = parseSkillFrontmatter(content, e.name)
      const key = `${origin}:${parsed.name}`
      if (seen.has(key)) continue
      seen.add(key)
      skills.push({ name: parsed.name, description: parsed.description, origin, path: skillDir })
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** Compact index block injected into the system prompt (content stays on demand) */
export async function buildSkillIndex(rootOverride?: string): Promise<string> {
  const skills = await listSkills(false, rootOverride)
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description || '(无描述)'}`)
  return `\n\n<available_skills>\n以下技能可用。当任务涉及某项技能时，调用对应的 skill__<name> 工具加载其完整说明，并严格遵循其中的步骤。\n${lines.join('\n')}\n</available_skills>`
}

/** Full skill content (frontmatter stripped) for the skill__<name> tool result */
export async function loadSkillContent(name: string, rootOverride?: string): Promise<string | null> {
  const skills = await listSkills(false, rootOverride)
  const skill = skills.find((s) => s.name === name)
  if (!skill) return null
  const parsed = parseSkillFrontmatter(skill.content, skill.name)
  return `# 技能: ${skill.name}\n\n${parsed.description ? `> ${parsed.description}\n\n` : ''}${parsed.body.trim()}`
}

/** Dynamic tool definitions: one skill__<name> tool per discovered skill */
export async function toSkillToolDefinitions(force = false, rootOverride?: string): Promise<ToolDefinition[]> {
  const skills = await listSkills(force, rootOverride)
  return skills.map((s) => ({
    type: 'function' as const,
    function: {
      name: `skill__${s.name}`,
      description: `[技能] ${s.description || s.name}。调用后返回该技能的完整说明，请严格遵循其中步骤完成任务。`,
      parameters: { type: 'object', properties: {} },
    },
  }))
}
