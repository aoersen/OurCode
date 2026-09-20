/**
 * Context engine — automatic context retrieval.
 *
 * Given the user's message, retrieves the most relevant files in the workspace
 * (by name match + content keyword search) and appends them as a bounded
 * <retrieved_context> block. Also loads workspace rules / Claude skills
 * (.ourcoderules, AGENTS.md, .cursorrules, .claude/skills, .ourcode/skills)
 * into the system prompt, and honors a .ourcodeignore file (gitignore-style)
 * for tool listings.
 *
 * No embeddings — heuristic keyword/symbol retrieval first (cheap, local),
 * which covers ~80% of the value; a local embedding index can be layered on
 * later without changing the prompt shape.
 */

import { listSkills, buildSkillIndex } from '@/services/skills/skillManager'

const SOURCE_EXTENSIONS = '*.ts,*.tsx,*.js,*.jsx,*.mjs,*.cjs,*.py,*.go,*.rs,*.java,*.kt,*.c,*.cpp,*.h,*.hpp,*.cs,*.rb,*.php,*.swift,*.vue,*.svelte,*.html,*.css,*.scss,*.json,*.yaml,*.yml,*.sql,*.sh,*.md,*.toml,*.ini'

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'please', 'you', 'your',
  'are', 'can', 'will', 'would', 'should', 'could', 'not', 'was', 'were', 'been', 'has',
  'its', 'all', 'any', 'but', 'our', 'they', 'them', 'their', 'there', 'these', 'those',
])

const MAX_CONTEXT_BYTES = 6000
const MAX_CONTEXT_FILES = 8
const MAX_KEYWORDS = 3

const KNOWLEDGE_CACHE = new Map<string, { mtime: number; text: string }>()

// 检索结果对同一组 (项目根, 关键词, 显式附件) 是确定性的，做短 TTL 缓存——
// 会话内追问/改述常复用相同关键词，命中缓存就省掉一次全项目遍历。
// 60s 内仍能拾取真实文件变化，同时避免每条消息都付全量搜索成本。
const RETRIEVAL_CACHE_TTL_MS = 60_000
const retrievalCache = new Map<string, { t: number; text: string }>()

// ───────────────────────── Keyword extraction ─────────────────────────

/** Extract search keywords from free text (identifiers, words, CJK bigrams) */
export function extractKeywords(text: string): string[] {
  const tokens = new Set<string>()

  // CamelCase / snake_case identifiers
  const idMatches = text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []
  for (const id of idMatches) {
    // Split camelCase into meaningful parts
    if (!STOPWORDS.has(id.toLowerCase())) tokens.add(id.toLowerCase())
    for (const part of id.split(/(?=[A-Z])/)) {
      const p = part.toLowerCase()
      if (part.length >= 3 && !STOPWORDS.has(p)) tokens.add(p)
    }
    for (const part of id.split('_')) {
      const p = part.toLowerCase()
      if (part.length >= 3 && !STOPWORDS.has(p)) tokens.add(p)
    }
  }

  // Plain English words
  const wordMatches = text.match(/[a-zA-Z]{3,}/g) || []
  for (const w of wordMatches) {
    const lower = w.toLowerCase()
    if (STOPWORDS.has(lower)) continue
    tokens.add(lower)
  }

  // CJK bigrams (adjacent character pairs carry most meaning)
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.add(cjk.slice(i, i + 2))
  }

  return Array.from(tokens).slice(0, 20)
}

/** Score a document against keywords: how many distinct keywords appear? */
export function scoreAgainstKeywords(text: string, keywords: string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const kw of keywords) {
    if (lower.includes(kw)) score++
  }
  return score
}

// ───────────────────────── Retrieval ─────────────────────────

/**
 * Retrieve relevant code context for the user's latest message.
 * Returns a bounded block to append to the system prompt, or ''.
 *
 * `opts.skipSearch` skips the project-wide file/content search (pure chat mode
 * has no tool loop — auto-retrieval costs most but benefits least there);
 * explicitly attached contextFiles are still always read.
 */
export async function retrieveRelevantContext(
  userContent: string,
  contextFiles: string[],
  rootPath: string,
  _activeFilePath?: string,
  opts?: { skipSearch?: boolean },
): Promise<string> {
  if (!rootPath) return ''

  // Explicitly attached files are ALWAYS read (the user pointed at them) even
  // when the message has no extractable keywords — e.g. pure-Chinese prompts
  // or Chinese filenames. Keyword search is only for auto-discovering RELATED
  // files; it must never gate the user's own attachments.
  const keywords = extractKeywords(userContent).slice(0, MAX_KEYWORDS)
  if (keywords.length === 0 && contextFiles.length === 0) return ''

  // Short-TTL cache — the expensive part is the search, not the block assembly,
  // so cache the final block (empty hits included, so a hitless query doesn't
  // re-walk the project on the next message either).
  const cacheKey = `${rootPath}\u0000${keywords.join(' ')}\u0000${contextFiles.join('\u0001')}`
  const cached = retrievalCache.get(cacheKey)
  if (cached && Date.now() - cached.t < RETRIEVAL_CACHE_TTL_MS) return cached.text

  const matches: Array<{ path: string; line?: number; content?: string; score: number }> = []

  // 1) File-name matches (highest signal) — only when we have a keyword to
  //    search by (explicit attachments alone must not call search with undefined)
  if (keywords.length > 0 && !opts?.skipSearch) {
    console.time(`[检索] searchFiles "${keywords[0]}" @ ${rootPath}`)
    try {
      const nameHits = await window.electronAPI.searchFiles(rootPath, keywords[0])
      for (const p of nameHits.slice(0, 10)) matches.push({ path: p, score: 10 })
    } catch { /* ignore */ } finally {
      console.timeEnd(`[检索] searchFiles "${keywords[0]}" @ ${rootPath}`)
    }
  }

  // 2) Content keyword search — FIRST keyword only. Each searchInFiles is a
  //    full project walk (read every matching file + regex every line); the
  //    recall gained from the 2nd/3rd keywords doesn't justify tripling that
  //    cost on every message. (The cache above makes repeated queries free.)
  if (keywords.length > 0 && !opts?.skipSearch) {
    const kw = keywords[0]
    console.time(`[检索] searchInFiles "${kw}" @ ${rootPath}`)
    try {
      const hits = await window.electronAPI.searchInFiles(rootPath, kw, {
        filePattern: SOURCE_EXTENSIONS,
        caseSensitive: false,
      })
      for (const hit of hits.slice(0, 20)) {
        matches.push({
          path: hit.filePath,
          line: hit.lineNumber,
          content: hit.lineContent,
          score: 5,
        })
      }
    } catch { /* ignore */ } finally {
      console.timeEnd(`[检索] searchInFiles "${kw}" @ ${rootPath}`)
    }
  }

  // 3) Context files explicitly referenced by the user — highest priority so
  //    they are ALWAYS read before auto-search results crowd the byte budget.
  for (const f of contextFiles) {
    matches.push({ path: f, score: 12 })
  }

  if (matches.length === 0) return ''

  // Rank: explicit context files first, then name matches, then content matches.
  // Deterministic to the end (path tie-break) so identical requests produce an
  // identical block — keeps the client-side response cache key stable.
  matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })

  const lines: string[] = []
  let bytes = 0
  const seenPaths = new Set<string>()

  for (const m of matches) {
    if (lines.length >= MAX_CONTEXT_FILES) break
    if (seenPaths.has(m.path)) continue
    seenPaths.add(m.path)

    if (m.content != null) {
      const line = `- ${m.path}:${m.line}: ${m.content.slice(0, 160)}`
      bytes += line.length
      if (bytes > MAX_CONTEXT_BYTES) break
      lines.push(line)
    } else {
      const snippet = await readFileSnippet(m.path)
      const line = snippet
        ? `- ${m.path}\n${snippet}`
        : `- ${m.path}`
      bytes += line.length
      if (bytes > MAX_CONTEXT_BYTES) break
      lines.push(line)
    }
  }

  const text = lines.length === 0
    ? ''
    : `\n\n<retrieved_context>\n以下是工作区中与本次请求相关的文件（自动检索）：\n${lines.join('\n')}\n</retrieved_context>`
  // 空结果也缓存——命中为空的查询同样省掉下一次的全项目遍历。
  // 写前淘汰过期项，防止长会话里不同关键词集撑爆 Map（缓存只对 60s 内有效）。
  if (retrievalCache.size >= 500) {
    const now = Date.now()
    for (const [k, v] of retrievalCache) {
      if (now - v.t >= RETRIEVAL_CACHE_TTL_MS) retrievalCache.delete(k)
    }
  }
  retrievalCache.set(cacheKey, { t: Date.now(), text })
  return text
}

/** Read the first ~40 lines of a file as a snippet */
async function readFileSnippet(path: string): Promise<string> {
  try {
    const { content } = await window.electronAPI.readFile(path)
    const lines = content.split('\n').slice(0, 40)
    return lines.map((l, i) => `  ${i + 1}: ${l}`).join('\n').slice(0, 1200)
  } catch {
    return ''
  }
}

// ───────────────────────── Workspace rules + skills ─────────────────────────

/**
 * Rule file names loaded from the workspace root. OurCode's own names come
 * first, then the cross-tool standards — so a repo that only carries an
 * `AGENTS.md` (or was previously used with Cursor / Windsurf) gets its rules
 * picked up with no migration step.
 */
const RULES_FILE_NAMES = [
  '.ourcoderules', 'rules.json', 'RULES.md',
  'AGENTS.md',
  '.cursorrules', '.windsurfrules',
]

// A mature repo's AGENTS.md is often a multi-kilobyte engineering manual. These
// ride in the byte-stable prompt prefix, so injecting one in full on every turn
// inflates the prefix and eats the cache savings; cap each file and say so.
const MAX_RULES_FILE_CHARS = 20000

// How far up from the active file to look for directory-level AGENTS.md.
const MAX_NESTED_RULES_LEVELS = 5

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Directory-level rule files governing the file being edited, outermost first.
 * Monorepos nest AGENTS.md per package and expect the ones closest to a file
 * to apply to it; probing with `stat` (which resolves null for a missing path)
 * keeps this to a handful of cheap IPCs instead of reading every candidate.
 */
async function collectNestedRulePaths(rootPath: string, activeFilePath?: string): Promise<string[]> {
  if (!activeFilePath) return []
  const root = normalizeSlashes(rootPath).replace(/\/$/, '')
  const file = normalizeSlashes(activeFilePath)
  if (!file.startsWith(root + '/')) return []
  const { stat } = window.electronAPI
  const found: string[] = []
  let dir = file.slice(0, file.lastIndexOf('/'))
  for (let i = 0; i < MAX_NESTED_RULES_LEVELS && dir.length > root.length; i++) {
    try {
      const s = await stat(dir + '/AGENTS.md')
      if (s) found.unshift(dir + '/AGENTS.md')
    } catch { /* missing */ }
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }
  return found
}

function capRules(text: string): string {
  if (text.length <= MAX_RULES_FILE_CHARS) return text
  return text.slice(0, MAX_RULES_FILE_CHARS) + '\n…（该规则文件已截断，需要完整内容请用 read_file 读取）'
}

/**
 * Load workspace knowledge: rule files (.ourcoderules / AGENTS.md /
 * .cursorrules …) and Claude-style skills (from .claude/skills and
 * .ourcode/skills directories). Rules files are injected (capped); skills are
 * injected as a compact index only — the model loads a skill's full
 * instructions on demand via the skill__<name> tool. Cached by mtime.
 *
 * Root-level files only, on purpose: this text rides in the byte-stable prompt
 * prefix, and anything that varies with the open tab would break provider-side
 * prompt caching every time the user switches files. Directory-level rules go
 * through buildActiveFileRulesBlock instead.
 */
export async function loadWorkspaceKnowledge(rootPath: string): Promise<string> {
  if (!rootPath) return ''
  const key = rootPath
  try {
    const { stat } = window.electronAPI
    const rootRulePaths = RULES_FILE_NAMES.map((f) => joinPath(rootPath, f))
    let newest = 0
    for (const p of rootRulePaths) {
      try {
        const s = await stat(p)
        if (s && s.modifiedAt > newest) newest = s.modifiedAt
      } catch { /* missing */ }
    }
    // Skill mtimes come from the shared SkillManager cache (used by the
    // skill__<name> tools too, so the prompt index stays in sync).
    const skills = await listSkills(false, rootPath)
    for (const s of skills) {
      if (s.mtime > newest) newest = s.mtime
    }
    const cached = KNOWLEDGE_CACHE.get(key)
    if (cached && cached.mtime >= newest) return cached.text

    const parts: string[] = []
    for (const p of rootRulePaths) {
      const text = (await tryReadFile(p)).trim()
      if (text) parts.push(capRules(text))
    }
    const skillIndex = await buildSkillIndex(rootPath)
    if (skillIndex) parts.push(skillIndex)
    const text = parts.length ? `\n\n<workspace_knowledge>\n${parts.join('\n\n')}\n</workspace_knowledge>` : ''
    KNOWLEDGE_CACHE.set(key, { mtime: newest, text })
    return text
  } catch {
    return ''
  }
}

/**
 * Directory-level rule files governing the file currently being edited, as a
 * per-turn dynamic block. Monorepos nest AGENTS.md per package and expect the
 * one closest to a file to apply to it — that selection follows the active tab,
 * so it cannot live in the stable prefix (see loadWorkspaceKnowledge).
 */
export async function buildActiveFileRulesBlock(rootPath: string, activeFilePath?: string): Promise<string> {
  if (!rootPath || !activeFilePath) return ''
  try {
    const nestedRulePaths = await collectNestedRulePaths(rootPath, activeFilePath)
    if (nestedRulePaths.length === 0) return ''
    const root = normalizeSlashes(rootPath).replace(/\/$/, '')
    const parts: string[] = []
    for (const p of nestedRulePaths) {
      const text = (await tryReadFile(p)).trim()
      if (!text) continue
      parts.push(`以下规则来自 ${normalizeSlashes(p).slice(root.length + 1)}，适用于该目录下的文件：\n\n${capRules(text)}`)
    }
    return parts.length ? `\n\n<directory_rules>\n${parts.join('\n\n')}\n</directory_rules>` : ''
  } catch {
    return ''
  }
}

async function tryReadFile(path: string): Promise<string> {
  try {
    const { content } = await window.electronAPI.readFile(path)
    return content
  } catch {
    return ''
  }
}

function joinPath(dir: string, name: string): string {
  return dir.replace(/[\\/]$/, '') + '/' + name
}

// ───────────────────────── .ourcodeignore ─────────────────────────

let ignoreCache = { root: '', mtime: 0, patterns: [] as string[] }

/** Reload .ourcodeignore (gitignore-style) from the workspace root */
export async function loadIgnorePatterns(rootPath: string): Promise<void> {
  if (!rootPath) return
  try {
    const { stat } = window.electronAPI
    const ignorePath = joinPath(rootPath, '.ourcodeignore')
    const s = await stat(ignorePath)
    // Missing .ourcodeignore — no patterns for this root (fs:stat resolves
    // with null for missing files instead of rejecting).
    if (!s) {
      ignoreCache = { root: rootPath, mtime: 0, patterns: [] }
      return
    }
    // Re-validate the mtime even for the SAME root — the old code returned
    // early on `rootPath === ignoreCache.root`, which made the mtime check
    // below it dead code: editing .ourcodeignore never refreshed the rules.
    if (ignoreCache.root === rootPath && s.modifiedAt === ignoreCache.mtime) return
    const { content } = await window.electronAPI.readFile(ignorePath)
    ignoreCache = {
      root: rootPath,
      mtime: s.modifiedAt,
      patterns: content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
    }
  } catch {
    // .ourcodeignore missing — no patterns for this root
    ignoreCache = { root: rootPath, mtime: 0, patterns: [] }
  }
}

/** Check whether a path should be ignored per .ourcodeignore (simple glob-ish) */
export function isIgnoredPath(path: string): boolean {
  const { patterns } = ignoreCache
  if (patterns.length === 0) return false
  const normalized = path.replace(/\\/g, '/')
  const baseName = normalized.split('/').pop() || ''
  for (const p of patterns) {
    const pattern = p.endsWith('/') ? p.slice(0, -1) : p
    if (baseName === pattern) return true
    if (normalized.includes(`/${pattern}/`)) return true
    if (normalized === pattern) return true
    if (pattern.includes('*')) {
      const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$')
      if (re.test(normalized) || re.test(baseName)) return true
    }
  }
  return false
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ───────────────────────── Editor selection context ─────────────────────────

/** Read the current selection from the live Monaco editor (if any) */
export function getEditorSelectionContext(): string {
  try {
    const editor = (window as any).__monacoEditor as any
    if (!editor || !editor.getSelection || !editor.getModel) return ''
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (!selection || selection.isEmpty() || !model) return ''
    const filePath = model.uri?.path || ''
    const text = model.getValueInRange(selection)
    if (!text) return ''
    return `\n\n<editor_selection path="${filePath}" lineStart="${selection.startLineNumber}" lineEnd="${selection.endLineNumber}">\n${text.slice(0, 4000)}\n</editor_selection>`
  } catch {
    return ''
  }
}
