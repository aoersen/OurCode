/**
 * Target-mode global token budget fuse (§11.4 / §13.3).
 *
 * Lives entirely on the target-mode side: it listens to the
 * `ourcode:usage-recorded` event whose detail carries per-session token totals
 * for TARGET-MODE sessions only (see chatStore.flushUsageEvents and
 * subagentRunner.recordEvent — both dispatch the detail; existing listeners
 * ignore it). The main loop itself stays untouched; the fuse only gates the
 * auto-resume path (chatStore.continueGeneration) for target-mode sessions.
 *
 * The limit is read from `.ourcode/targemode/budget.md` (visible config +
 * audit); enforcement here is the code-level backstop. This module deliberately
 * does NOT import chatStore, so chatStore → budget is a one-way edge (no cycle).
 *
 * State is keyed by PROJECT, not session: the company budget is the sum of the
 * director + every role worker, all of which share one budget.md. The used
 * total is persisted back into budget.md (throttled) so restarting the app no
 * longer resets the fuse to zero — previously `used` lived only in memory and a
 * 100M-token project could reset its own accounting simply by restarting.
 */

const DEFAULT_LIMIT = 2_000_000
/** Persist the running total at most this often (usage events arrive per round). */
const PERSIST_DEBOUNCE_MS = 5_000

interface BudgetState {
  projectPath: string
  limit: number
  used: number
  /** Whether the persisted total has been folded into `used` (once). */
  hydrated: boolean
  /** Bumped by resetProjectBudget so async reads started before the reset
   *  cannot resurrect the old persisted total when they resolve. */
  generation: number
}

const budgets = new Map<string, BudgetState>()
/** sessionId → project key (empty project → a synthetic per-session key). */
const sessionProjects = new Map<string, string>()
/** Last manual setBudgetLimit timestamp per project. Async reads started BEFORE
 *  it must not clobber the newer manual value when they resolve. */
const manualSetAt = new Map<string, number>()
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

function normalizeProjectPath(projectPath: string): string {
  return projectPath.replace(/[\\/]+$/, '')
}

function projectKey(projectPath: string, sessionId: string): string {
  const root = normalizeProjectPath(projectPath || '')
  return root || `@session:${sessionId}`
}

function budgetPathFor(projectPath: string): string {
  return `${normalizeProjectPath(projectPath)}/.ourcode/targemode/budget.md`
}

async function readBudget(projectPath: string): Promise<{ limit: number; used: number }> {
  if (!projectPath) return { limit: DEFAULT_LIMIT, used: 0 }
  try {
    const { content } = await window.electronAPI.readFile(budgetPathFor(projectPath))
    const limitMatch = content?.match(/总消耗上限（tokens）[：:]\s*(\d+)/)
    const usedMatch = content?.match(/当前累计[：:]\s*(\d+)/)
    return {
      limit: limitMatch ? Math.max(0, parseInt(limitMatch[1], 10)) : DEFAULT_LIMIT,
      used: usedMatch ? Math.max(0, parseInt(usedMatch[1], 10)) : 0,
    }
  } catch {
    // Unreadable / missing budget.md → defaults
    return { limit: DEFAULT_LIMIT, used: 0 }
  }
}

function ensureState(sessionId: string, projectPath: string): BudgetState {
  const key = projectKey(projectPath, sessionId)
  sessionProjects.set(sessionId, key)
  let s = budgets.get(key)
  if (!s) {
    s = {
      projectPath: normalizeProjectPath(projectPath || ''),
      limit: DEFAULT_LIMIT,
      used: 0,
      hydrated: false,
      generation: 0,
    }
    budgets.set(key, s)
    const gen = s.generation
    const readStartedAt = Date.now()
    void readBudget(s.projectPath).then(({ limit, used }) => {
      const cur = budgets.get(key)
      if (!cur || cur.generation !== gen) return // reset happened mid-read
      if ((manualSetAt.get(key) ?? 0) <= readStartedAt) cur.limit = limit
      // Add the persisted baseline to whatever this app run already counted
      // before the read resolved (fire-and-forget read) — overwriting would
      // silently lose the first round's tokens.
      if (!cur.hydrated) {
        cur.used += used
        cur.hydrated = true
      } else {
        cur.used = Math.max(cur.used, used)
      }
    })
  }
  return s
}

/**
 * Ensure a session has a budget entry (creating one reads the limit from
 * budget.md async). Call from UI surfaces (dashboard / toolbar) so the limit
 * shows and is editable BEFORE the first token is ever consumed — getBudgetUsage
 * would otherwise keep reporting the hardcoded default.
 */
export function initBudgetTracking(sessionId: string, projectPath: string): void {
  if (!sessionId) return
  ensureState(sessionId, projectPath || '')
}

/** Parse a user-entered limit: plain integer tokens, or `N`/`N.N` with an
 *  `m`/`M` (million) suffix. Returns null when unparseable or non-positive. */
export function parseBudgetLimitInput(raw: string): number | null {
  const text = raw.trim().replace(/,/g, '')
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(m|百万)?$/i)
  if (!m) return null
  const value = parseFloat(m[1]) * (m[2] ? 1_000_000 : 1)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value)
}

/** Rewrite the limit + cumulative-used lines, keeping any extra user notes. */
async function writeBudgetFile(projectPath: string, limit: number, used: number): Promise<boolean> {
  if (!projectPath) return false
  const writeFile = (window.electronAPI as unknown as {
    writeFile?: (path: string, content: string, encoding?: string) => Promise<unknown>
  } | undefined)?.writeFile
  if (typeof writeFile !== 'function') return false

  const path = budgetPathFor(projectPath)
  let content = ''
  try {
    content = (await window.electronAPI.readFile(path)).content ?? ''
  } catch {
    content = '' // missing/unreadable → recreate below
  }
  // Match the WHOLE line (the old format can be malformed as "- - - 总消耗上限")
  // so a rewrite also cleans it up.
  const LIMIT_LINE_RE = /^.*总消耗上限（tokens）[：:]\s*\d+[^\n]*$/m
  const USED_LINE_RE = /^.*当前累计[：:]\s*\d+[^\n]*$/m
  const limitLine = `- 总消耗上限（tokens）：${Math.round(limit)}（可修改）`
  const usedLine = `- 当前累计：${Math.round(used)}`

  let next = content
  if (LIMIT_LINE_RE.test(next)) next = next.replace(LIMIT_LINE_RE, limitLine)
  else if (next.trim()) next = next.replace(/\r?\n*$/, '\n') + `${limitLine}\n`
  else next = `# 目标模式预算\n\n${limitLine}\n${usedLine}\n- 触顶后停止自主续跑并询问用户。\n`

  if (USED_LINE_RE.test(next)) next = next.replace(USED_LINE_RE, usedLine)
  else next = next.replace(/\r?\n*$/, '\n') + `${usedLine}\n`

  try {
    await writeFile(path, next, 'utf-8')
    return true
  } catch (e) {
    console.error('目标模式预算写入失败:', e)
    return false
  }
}

function schedulePersist(s: BudgetState, key: string): void {
  if (!s.projectPath || pendingWrites.has(key)) return
  const timer = setTimeout(() => {
    pendingWrites.delete(key)
    void writeBudgetFile(s.projectPath, s.limit, s.used)
  }, PERSIST_DEBOUNCE_MS)
  pendingWrites.set(key, timer)
}

/** Flush throttled budget writes (call on app shutdown). Best-effort. */
export function flushBudgetWrites(): void {
  const entries = Array.from(pendingWrites.entries())
  pendingWrites.clear()
  for (const [key, timer] of entries) {
    clearTimeout(timer)
    const s = budgets.get(key)
    if (s?.projectPath) void writeBudgetFile(s.projectPath, s.limit, s.used)
  }
}

/**
 * Change the session's token cap: persists to `.ourcode/targemode/budget.md`
 * (visible config + audit; survives restarts) and updates the in-memory fuse
 * immediately. Returns false when the session has no bound project or the
 * write failed — callers surface that instead of silently pretending.
 */
export async function setBudgetLimit(sessionId: string, limit: number): Promise<boolean> {
  const key = sessionProjects.get(sessionId)
  const s = key ? budgets.get(key) : undefined
  if (!key || !s || !s.projectPath) return false
  const rounded = Math.round(limit)
  if (!Number.isFinite(rounded) || rounded <= 0) return false

  const ok = await writeBudgetFile(s.projectPath, rounded, s.used)
  if (!ok) return false
  manualSetAt.set(key, Date.now())
  s.limit = rounded
  return true
}

/** Accumulate consumed tokens for a session (event listener; target-mode only
 *  because the dispatch sites already filtered to target-mode sessions). */
function accumulate(sessionId: string, projectPath: string, tokens: number): void {
  if (!sessionId || !tokens || tokens <= 0) return
  const key = projectKey(projectPath, sessionId)
  const s = ensureState(sessionId, projectPath)
  s.used += tokens
  schedulePersist(s, key)
}

/** True when the session's cumulative target-mode consumption hit the cap. */
export function budgetExceeded(sessionId: string): boolean {
  const key = sessionProjects.get(sessionId)
  const s = key ? budgets.get(key) : undefined
  return !!s && s.used >= s.limit
}

/**
 * Re-read the limit (and the persisted total) from budget.md — so raising the
 * cap mid-run takes effect, and a restart resumes from the persisted total.
 */
export async function refreshBudgetLimit(sessionId: string, projectPath?: string): Promise<void> {
  const mappedKey = sessionProjects.get(sessionId)
  let s = mappedKey ? budgets.get(mappedKey) : undefined
  // Fresh app run: no usage event / UI init has created the state yet. Hydrate
  // from budget.md now so a restart resumes from the persisted total instead of
  // treating the project as unused.
  if (!s && projectPath) s = ensureState(sessionId, projectPath)
  if (!s) return
  const key = sessionProjects.get(sessionId)!
  const gen = s.generation
  const readStartedAt = Date.now()
  const { limit, used } = await readBudget(s.projectPath)
  if (s.generation !== gen) return // reset happened mid-read
  if ((manualSetAt.get(key) ?? 0) <= readStartedAt) s.limit = limit
  if (!s.hydrated) {
    s.used += used
    s.hydrated = true
  } else {
    s.used = Math.max(s.used, used)
  }
}

/**
 * Start a fresh company task: zero the project's consumed total while keeping
 * the cap. Without this, the persisted total would make a new task inherit the
 * previous task's burn and could trip the fuse immediately.
 */
export function resetProjectBudget(projectPath: string): void {
  const root = normalizeProjectPath(projectPath || '')
  if (!root) return
  const pending = pendingWrites.get(root)
  if (pending) {
    clearTimeout(pending)
    pendingWrites.delete(root)
  }
  let s = budgets.get(root)
  if (!s) {
    s = { projectPath: root, limit: DEFAULT_LIMIT, used: 0, hydrated: true, generation: 0 }
    budgets.set(root, s)
  } else {
    s.used = 0
    s.hydrated = true
  }
  s.generation++
  // Persist the reset (and the file's configured limit) asynchronously; new
  // usage accumulated meanwhile is included when the write resolves.
  void readBudget(root).then(({ limit }) => {
    const cur = budgets.get(root)
    if (!cur) return
    if (!manualSetAt.has(root)) cur.limit = limit
    void writeBudgetFile(root, cur.limit, cur.used)
  })
}

/** Current usage for the session (0 when never tracked) — surfaced to UI/audit. */
export function getBudgetUsage(sessionId: string): { used: number; limit: number } {
  const key = sessionProjects.get(sessionId)
  const s = key ? budgets.get(key) : undefined
  return s ? { used: s.used, limit: s.limit } : { used: 0, limit: DEFAULT_LIMIT }
}

/** 项目（公司）预算合计：总监 + 全体角色员工共享一份 budget.md / 一份状态。 */
export function getProjectBudgetUsage(projectPath: string): { used: number; limit: number } {
  const root = normalizeProjectPath(projectPath || '')
  if (root) {
    const s = budgets.get(root)
    return s ? { used: s.used, limit: s.limit } : { used: 0, limit: DEFAULT_LIMIT }
  }
  // Sessions without a project keep their own synthetic keys — sum them.
  let used = 0
  let limit = DEFAULT_LIMIT
  let found = false
  for (const s of budgets.values()) {
    if (s.projectPath) continue
    used += s.used
    if (s.limit > limit) limit = s.limit
    found = true
  }
  return found ? { used, limit } : { used: 0, limit: DEFAULT_LIMIT }
}

/** 项目（公司）预算是否触顶——总监续跑与员工回报触发的续跑都以此为准（M4）。 */
export function projectBudgetExceeded(projectPath: string): boolean {
  const { used, limit } = getProjectBudgetUsage(projectPath)
  return limit > 0 && used >= limit
}

let installed = false

/** Install the global listener once (called from the App bootstrap). */
export function installBudgetFuse(): void {
  if (installed) return
  installed = true
  window.addEventListener('ourcode:usage-recorded', ((ev: Event) => {
    const detail = (ev as CustomEvent).detail as
      | { bySession?: Record<string, { tokens: number; projectPath: string }> }
      | undefined
    if (!detail?.bySession) return
    for (const [sessionId, info] of Object.entries(detail.bySession)) {
      accumulate(sessionId, info.projectPath, info.tokens)
    }
  }) as EventListener)
}
