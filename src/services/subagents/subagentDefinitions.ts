/**
 * Subagent definitions + permission guard.
 *
 * A subagent is defined either by a Markdown file (`.ourcode/agents/<name>.md`
 * in the workspace, or `<userData>/agents/<name>.md` globally) or by a built-in
 * archetype. The frontmatter declares the agent's name, description, tool
 * allowlist, allowed paths and resource budgets; the body is its system prompt.
 *
 * Permission model — monotonic decay: a subagent can never have more authority
 * than the parent that spawned it. Enforcement is two-layered (defense in
 * depth):
 *   1. Visibility: getToolDefinitions(filter) only exposes allowlisted tools to
 *      the subagent's LLM.
 *   2. Enforcement: SubagentGuard.checkCall() re-validates every tool call
 *      before execution (allowlist + path containment + command filtering).
 * Control tools (submit_plan / ask_user_question / manage_todo / run_subagent)
 * are always blocked — a subagent can't spawn further subagents or pause for
 * user input, so the delegation tree stays bounded.
 */

const AGENT_DIRS = ['.ourcode/agents']

/** Tools that never get executed by a subagent, regardless of allowlist. */
export const CONTROL_TOOLS = new Set([
  'submit_plan', 'ask_user_question', 'manage_todo', 'run_subagent',
  // Delegating work across sessions from a subagent could create unbounded
  // agent ping-pong; subagents may still use list_agents (read-only discovery).
  'send_message',
])

/** Tools whose `path` argument must stay inside allowedPaths (when configured). */
const WRITE_PATH_TOOLS = new Set([
  'write_file', 'edit_file', 'delete_file', 'create_directory', 'multi_edit_file',
])
const READ_PATH_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'list_directory', 'get_directory_tree',
  'search_files', 'search_in_files',
])

export interface SubAgentDefinition {
  name: string
  description: string
  /** The subagent's system prompt (role + constraints). */
  systemPrompt: string
  /** Tool allowlist. Undefined = inherit the parent's full tool set. */
  tools?: string[]
  /** Paths (relative to the project root, or absolute) the subagent may touch. */
  allowedPaths?: string[]
  /**
   * Read/write path separation (optional, target-mode strong-boundary roles).
   * When either is declared, write tools are checked against `allowedWritePaths`
   * and read tools against `allowedReadPaths ?? allowedPaths`, so a role can
   * "read broadly, write narrowly" (e.g. tester reads the whole repo but only
   * writes test files). Definitions that declare neither keep the original
   * unified `allowedPaths` behavior — byte-identical for existing roles.
   */
  allowedWritePaths?: string[]
  allowedReadPaths?: string[]
  /** Substrings that block a run_command invocation (e.g. 'rm -rf'). */
  blockedCommands?: string[]
  maxIterations?: number
  /** Prompt+completion token budget; the run stops when exceeded. */
  maxTokensBudget?: number
  temperature?: number
  model?: string
  source: 'builtin' | 'workspace' | 'global'
  path?: string
}

/** Built-in archetypes — the fallback when no <name>.md definition exists. */
export const BUILTIN_AGENTS: Record<string, Omit<SubAgentDefinition, 'name' | 'source'>> = {
  'code-reviewer': {
    description: '只读代码审查专家',
    systemPrompt:
      '你是「code-reviewer」子智能体，负责对代码进行结构化审查。你只读代码并输出审查报告，绝不修改任何文件。' +
      '每个发现必须标注 文件:行号 并给出可操作的修复建议，按 严重/一般/建议 分级汇总。',
    tools: ['read_file', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files'],
    maxIterations: 6,
    temperature: 0.1,
  },
  'test-generator': {
    description: '单元测试生成器',
    systemPrompt:
      '你是「test-generator」子智能体，负责为目标代码编写并运行单元测试。' +
      '遵循项目既有测试框架与风格；可以修改测试文件，但默认不修改被测源码；测试必须可重复运行并全部通过。',
    tools: [
      'read_file', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files',
      'write_file', 'edit_file', 'create_directory', 'run_command', 'read_terminal_output', 'stop_terminal',
    ],
    maxIterations: 12,
    maxTokensBudget: 120_000,
    temperature: 0.1,
  },
  'researcher': {
    description: '信息检索与调研员',
    systemPrompt:
      '你是「researcher」子智能体，负责检索代码与网络信息并整理调研结论。' +
      '引用来源（文件路径或 URL）必须可追溯；不确定的信息明确标注，不得臆造。',
    tools: [
      'read_file', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files',
      'web_search', 'read_url',
    ],
    maxIterations: 8,
    temperature: 0.2,
  },
  // ── Target-mode strong-boundary roles (v2) ──
  // The guard boundary is enforced in CODE via allowedWritePaths + read/write
  // separation — "physical inability" rather than prompt discipline.
  // Two names each: the canonical name and the `tm-` workspace-file name (the
  // supervisor spawns tm-* per SPEC ch.9; the tm-* alias keeps the strong
  // boundary even if the user deletes the editable .md → falls back here
  // instead of the unrestricted generic definition).
  'requirement-analyst': {
    description: '需求分析师（目标模式）',
    systemPrompt:
      '你是「requirement-analyst」子智能体，负责澄清目标、产出可验证的检查清单与实施方案。' +
      '你只写 .ourcode/targemode/ 下的文档，绝不修改业务代码。' +
      '产出必须结构化：需求条目、检查清单（每项标注可验证性类别 auto=可机器验证 / code=需代码审查 / manual=需人工确认）、假设与待确认项。',
    tools: [
      'read_file', 'read_multiple_files', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files',
      'write_file', 'edit_file', 'create_directory',
    ],
    // 可读全仓（allowedReadPaths 未声明 → 读不限），只写目标模式状态目录。
    allowedWritePaths: ['.ourcode/targemode'],
    maxIterations: 8,
    temperature: 0.1,
  },
  'tm-requirement-analyst': {
    description: '需求分析师（目标模式，tm- 工作区角色回退）',
    systemPrompt:
      '你是「tm-requirement-analyst」子智能体，负责澄清目标、产出可验证的检查清单与实施方案。' +
      '你只写 .ourcode/targemode/ 下的文档，绝不修改业务代码。' +
      '产出必须结构化：需求条目、检查清单（每项标注可验证性类别 auto=可机器验证 / code=需代码审查 / manual=需人工确认）、假设与待确认项。',
    tools: [
      'read_file', 'read_multiple_files', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files',
      'write_file', 'edit_file', 'create_directory',
    ],
    allowedWritePaths: ['.ourcode/targemode'],
    maxIterations: 8,
    temperature: 0.1,
  },
  'tester': {
    description: '独立测试验证（目标模式）',
    systemPrompt:
      '你是「tester」子智能体，负责独立验证实现是否满足验收标准。' +
      '你只写测试文件与测试报告，绝不修改业务代码。' +
      '报告必须逐条对照验收标准给出 通过/失败/缺陷，并引用证据（测试名 / 文件:行 / 命令输出），无证据的"通过"不计入。',
    tools: [
      'read_file', 'read_multiple_files', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files',
      'write_file', 'edit_file', 'multi_edit_file', 'create_directory', 'delete_file', 'run_command', 'read_terminal_output', 'stop_terminal',
    ],
    // 可读全仓（读不限），只写测试目录与目标模式报告目录。具体测试路径随项目
    // 而异——由工作区 tm-tester.md 编辑，或由任务信封 files_to_modify 精确授予（v2.4）。
    allowedWritePaths: ['.ourcode/targemode', 'src/__tests__', 'tests', 'test'],
    maxIterations: 10,
    maxTokensBudget: 120_000,
    temperature: 0.1,
  },
  'tm-tester': {
    description: '独立测试验证（目标模式，tm- 工作区角色回退）',
    systemPrompt:
      '你是「tm-tester」子智能体，负责独立验证实现是否满足验收标准。' +
      '你只写测试文件与测试报告，绝不修改业务代码。' +
      '报告必须逐条对照验收标准给出 通过/失败/缺陷，并引用证据（测试名 / 文件:行 / 命令输出），无证据的"通过"不计入。',
    tools: [
      'read_file', 'read_multiple_files', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files',
      'write_file', 'edit_file', 'multi_edit_file', 'create_directory', 'delete_file', 'run_command', 'read_terminal_output', 'stop_terminal',
    ],
    allowedWritePaths: ['.ourcode/targemode', 'src/__tests__', 'tests', 'test'],
    maxIterations: 10,
    maxTokensBudget: 120_000,
    temperature: 0.1,
  },
}

/** Generic fallback for a name with no matching definition. */
function genericDefinition(name: string): Omit<SubAgentDefinition, 'name' | 'source'> {
  return {
    description: `子智能体 ${name}`,
    systemPrompt:
      `你是「${name}」子智能体，由主智能体派生的专责执行者。你需要自主、专注地完成交给你的子任务，然后向主智能体报告结果。`,
    maxIterations: 10,
  }
}

// ───────────────────────── path helpers (no node:path — renderer-safe) ─────────────────────────

function normalizePath(p: string): string {
  const withSlashes = (p || '').replace(/\\/g, '/')
  const isAbsolute = withSlashes.startsWith('/')
  const parts: string[] = []
  for (const seg of withSlashes.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      continue
    }
    parts.push(seg)
  }
  const joined = parts.join('/')
  if (joined === '') return isAbsolute ? '/' : '.'
  return (isAbsolute ? '/' : '') + joined
}

/** Case-insensitive containment check (Windows-safe). */
export function isPathWithin(root: string, target: string): boolean {
  const r = normalizePath(root).toLowerCase()
  const t = normalizePath(target).toLowerCase()
  return t === r || t.startsWith(r + '/')
}

/** Resolve an allowedPaths entry against the project root (supports absolute too). */
export function resolveAllowedRoot(projectPath: string, rel: string): string {
  const p = normalizePath(rel)
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) return p
  const base = normalizePath(projectPath || '')
  return base && base !== '/' ? `${base}/${p}` : p
}

// ───────────────────────── frontmatter parsing ─────────────────────────

function parseScalar(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '')
}

function parseArray(raw: string): string[] | undefined {
  let s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const items = s.split(',').map((x) => x.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

/**
 * Parse a definition's frontmatter (name/description + scalars/arrays).
 * Missing fields fall back to the file name / empty strings.
 */
export function parseAgentFrontmatter(content: string, fallbackName: string): {
  name: string
  description: string
  systemPrompt: string
  frontmatter: Record<string, string>
} {
  let body = content
  const meta: Record<string, string> = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (m) {
    body = content.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim()
    }
  }
  return {
    name: parseScalar(meta.name || '') || fallbackName,
    description: parseScalar(meta.description || ''),
    systemPrompt: body.trim(),
    frontmatter: meta,
  }
}

// ───────────────────────── discovery & loading ─────────────────────────

async function listDirSafe(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
  try {
    const entries = await window.electronAPI.listDir(dir)
    return (entries || []).map((e) => ({ name: e.name, isDirectory: !!e.isDirectory }))
  } catch {
    return []
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

async function statSafe(path: string): Promise<{ modifiedAt: number } | null> {
  try {
    return await window.electronAPI.stat(path)
  } catch {
    return null
  }
}

async function getGlobalAgentsDir(): Promise<string> {
  try {
    const userData = await window.electronAPI?.getPath?.('userData')
    return userData ? `${userData.replace(/[\\/]$/, '')}/agents` : ''
  } catch {
    return ''
  }
}

interface AgentCache {
  root: string
  mtime: number
  /** Fingerprint of the candidate set — deleting a definition must invalidate
   *  the cache even when its (now-removed) mtime would lower `newest`. */
  fileKey: string
  files: Array<{ path: string; name: string; source: 'workspace' | 'global' }>
}

let _cache: AgentCache | null = null

/**
 * Discover candidate <name>.md definition files (workspace `.ourcode/agents`
 * + global `<userData>/agents`), cached by newest mtime + the candidate set.
 */
export async function listAgentDefinitionFiles(rootOverride?: string): Promise<
  Array<{ path: string; name: string; source: 'workspace' | 'global' }>
> {
  const root = rootOverride ?? ''
  const global = await getGlobalAgentsDir()
  const dirs: Array<{ dir: string; source: 'workspace' | 'global' }> = []
  for (const d of AGENT_DIRS) if (root) dirs.push({ dir: `${root.replace(/[\\/]$/, '')}/${d}`, source: 'workspace' })
  if (global) dirs.push({ dir: global, source: 'global' })

  const candidates: Array<{ path: string; name: string; source: 'workspace' | 'global' }> = []
  for (const { dir, source } of dirs) {
    const entries = await listDirSafe(dir)
    for (const e of entries) {
      if (e.isDirectory || !/\.md$/i.test(e.name)) continue
      candidates.push({ path: `${dir}/${e.name}`, name: e.name.replace(/\.md$/i, ''), source })
    }
  }

  let newest = 0
  for (const c of candidates) {
    const s = await statSafe(c.path)
    if (s && s.modifiedAt > newest) newest = s.modifiedAt
  }
  // Order matters for the fingerprint — sort so an identical set always hashes
  // the same regardless of directory enumeration order.
  const fileKey = candidates.map((c) => c.path).sort().join('\n')
  if (!_cache || _cache.root !== root || _cache.mtime < newest || _cache.fileKey !== fileKey) {
    _cache = { root, mtime: newest, fileKey, files: candidates }
  }
  return _cache.files
}

/** Build a full SubAgentDefinition from a definition file. */
async function definitionFromFile(file: { path: string; name: string; source: 'workspace' | 'global' }): Promise<SubAgentDefinition | null> {
  const content = await readFileSafe(file.path)
  if (!content) return null
  const parsed = parseAgentFrontmatter(content, file.name)
  const fm = parsed.frontmatter
  return {
    name: parsed.name,
    description: parsed.description,
    systemPrompt: parsed.systemPrompt,
    tools: fm.tools !== undefined ? parseArray(fm.tools) : undefined,
    allowedPaths: fm.allowedpaths !== undefined ? parseArray(fm.allowedpaths) : undefined,
    allowedWritePaths: fm.allowedwritepaths !== undefined ? parseArray(fm.allowedwritepaths) : undefined,
    allowedReadPaths: fm.allowedreadpaths !== undefined ? parseArray(fm.allowedreadpaths) : undefined,
    blockedCommands: fm.blockedcommands !== undefined ? parseArray(fm.blockedcommands) : undefined,
    maxIterations: fm.maxiterations !== undefined ? parseInt(fm.maxiterations, 10) || undefined : undefined,
    maxTokensBudget: fm.maxtokensbudget !== undefined ? parseInt(fm.maxtokensbudget, 10) || undefined : undefined,
    temperature: fm.temperature !== undefined ? parseFloat(fm.temperature) || undefined : undefined,
    model: fm.model !== undefined ? parseScalar(fm.model) || undefined : undefined,
    source: file.source,
    path: file.path,
  }
}

/**
 * Load a definition by name: workspace file → global file → built-in
 * archetype → generic fallback. Never throws.
 */
export async function loadAgentDefinition(name: string, rootOverride?: string): Promise<SubAgentDefinition> {
  const files = await listAgentDefinitionFiles(rootOverride).catch(() => [])
  for (const f of files) {
    if (f.name !== name) continue
    const def = await definitionFromFile(f)
    if (def) return def
  }
  const builtin = BUILTIN_AGENTS[name] || genericDefinition(name)
  return { name, source: 'builtin', ...builtin }
}

/** Compact index of available agent definitions (for the parent's system prompt). */
export async function buildAgentIndex(rootOverride?: string): Promise<string> {
  const files = await listAgentDefinitionFiles(rootOverride).catch(() => [])
  if (files.length === 0) return ''
  const lines = files.map((f) => `- ${f.name}`)
  return `\n\n<available_subagents>\n以下子智能体定义可用（run_subagent 的 name 参数）：\n${lines.join('\n')}\n</available_subagents>`
}

// ───────────────────────── permission guard ─────────────────────────

/**
 * Enforces a definition's permission boundary on every tool call.
 * `toolAllowed` drives which definitions reach the LLM; `checkCall` is the
 * runtime backstop that rejects anything that slips through.
 */
export class SubagentGuard {
  constructor(
    private def: SubAgentDefinition,
    private projectPath: string,
  ) {}

  toolAllowed(name: string): boolean {
    if (CONTROL_TOOLS.has(name)) return false
    if (this.def.tools == null) return true
    // skill__ tools only load instructions — harmless for any subagent
    if (name.startsWith('skill__')) return true
    return this.def.tools.includes(name)
  }

  /** Returns an error message when the call is blocked, else null. */
  checkCall(name: string, args: Record<string, any>): string | null {
    if (CONTROL_TOOLS.has(name)) {
      return `工具 "${name}" 是控制类工具，子智能体不允许调用。`
    }
    if (this.def.tools != null && !this.def.tools.includes(name) && !name.startsWith('skill__')) {
      return `工具 "${name}" 不在子智能体「${this.def.name}」的权限白名单中。可用的工具: ${this.def.tools.join(', ')}。`
    }

    // ── Path scoping ──
    // Read/write separation (target-mode strong-boundary roles): a definition
    // may declare allowedWritePaths (write scope) and/or allowedReadPaths (read
    // scope). When neither is declared, every path tool shares the original
    // unified allowedPaths scope — existing definitions behave byte-identically.
    const separated = !!(this.def.allowedWritePaths || this.def.allowedReadPaths)
    const scopeFor = (name: string): string[] | undefined => {
      if (!separated) return this.def.allowedPaths
      if (WRITE_PATH_TOOLS.has(name)) return this.def.allowedWritePaths ?? this.def.allowedPaths
      // Read tools AND run_command (cwd = the role's read/execute scope) check
      // the read scope — a test-runner must be able to run commands at the
      // project root without extending its write scope there.
      return this.def.allowedReadPaths ?? this.def.allowedPaths
    }

    const allowedRoots = scopeFor(name)
    if (allowedRoots && allowedRoots.length > 0 && (WRITE_PATH_TOOLS.has(name) || READ_PATH_TOOLS.has(name)) && typeof args.path === 'string') {
      const roots = allowedRoots.map((r) => resolveAllowedRoot(this.projectPath, r))
      const ok = roots.some((root) => isPathWithin(root, args.path))
      if (!ok) {
        return `路径 "${args.path}" 超出子智能体「${this.def.name}」允许的目录范围: ${allowedRoots.join(', ')}。`
      }
    }

    // Batch tools carry arrays of paths instead of a single `path`
    // (read_multiple_files → paths[], multi_edit_file → edits[].path) — check
    // every target the same way, so a path-restricted subagent can't escape
    // its allowed roots through the array shape.
    if (allowedRoots && allowedRoots.length > 0) {
      const batchTargets = name === 'read_multiple_files'
        ? (Array.isArray(args.paths) ? args.paths : []).map((p) => String(p))
        : name === 'multi_edit_file'
          ? (Array.isArray(args.edits) ? args.edits : []).map((e: any) => String(e?.path || '')).filter(Boolean)
          : []
      if (batchTargets.length > 0) {
        const roots = allowedRoots.map((r) => resolveAllowedRoot(this.projectPath, r))
        for (const p of batchTargets) {
          if (!roots.some((root) => isPathWithin(root, p))) {
            return `路径 "${p}" 超出子智能体「${this.def.name}」允许的目录范围: ${allowedRoots.join(', ')}。`
          }
        }
      }
    }

    // A subagent restricted to allowedPaths must not be able to run commands
    // outside them. When allowedPaths is set and run_command omits cwd, the
    // command would fall back to the whole project root — escaping the
    // subagent's boundary — so require an explicit cwd inside the allowed
    // roots instead of skipping the check.
    if (allowedRoots && allowedRoots.length > 0 && name === 'run_command') {
      const roots = allowedRoots.map((r) => resolveAllowedRoot(this.projectPath, r))
      if (typeof args.cwd !== 'string' || !args.cwd) {
        return `run_command 需要显式指定 cwd（工作目录），且必须位于子智能体「${this.def.name}」允许的目录范围内: ${allowedRoots.join(', ')}。`
      }
      if (!roots.some((root) => isPathWithin(root, args.cwd))) {
        return `run_command 的工作目录 "${args.cwd}" 超出子智能体「${this.def.name}」允许的目录范围: ${allowedRoots.join(', ')}。`
      }
    }

    if (name === 'run_command' && this.def.blockedCommands && this.def.blockedCommands.length > 0 && typeof args.command === 'string') {
      const hit = this.def.blockedCommands.find((b) => args.command.includes(b))
      if (hit) {
        return `命令 "${args.command}" 包含被禁用的片段 "${hit}"，子智能体「${this.def.name}」不允许执行。`
      }
    }

    return null
  }
}
