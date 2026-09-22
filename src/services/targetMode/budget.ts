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
 */

const DEFAULT_LIMIT = 2_000_000

interface BudgetState {
  projectPath: string
  limit: number
  used: number
}

const budgets = new Map<string, BudgetState>()

async function readLimit(projectPath: string): Promise<number> {
  if (!projectPath) return DEFAULT_LIMIT
  try {
    const { content } = await window.electronAPI.readFile(
      `${projectPath.replace(/[\\/]+$/, '')}/.ourcode/targemode/budget.md`,
    )
    const m = content?.match(/总消耗上限（tokens）[：:]\s*(\d+)/)
    if (m) return Math.max(0, parseInt(m[1], 10))
  } catch {
    // Unreadable / missing budget.md → keep the default
  }
  return DEFAULT_LIMIT
}

/** Last manual setBudgetLimit timestamp per session. Async limit reads started
 *  BEFORE it must not clobber the newer manual value when they resolve. */
const manualSetAt = new Map<string, number>()

function applyReadLimit(sessionId: string, readStartedAt: number, limit: number): void {
  const cur = budgets.get(sessionId)
  if (!cur) return
  if ((manualSetAt.get(sessionId) ?? 0) > readStartedAt) return // 手动修改更新，丢弃过期读值
  cur.limit = limit
}

function ensureState(sessionId: string, projectPath: string): BudgetState {
  let s = budgets.get(sessionId)
  if (!s || s.projectPath !== projectPath) {
    s = { projectPath, limit: DEFAULT_LIMIT, used: 0 }
    budgets.set(sessionId, s)
    const readStartedAt = Date.now()
    void readLimit(projectPath).then((limit) => {
      applyReadLimit(sessionId, readStartedAt, limit)
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

/**
 * Change the session's token cap: persists to `.ourcode/targemode/budget.md`
 * (visible config + audit; survives restarts) and updates the in-memory fuse
 * immediately. Returns false when the session has no bound project or the
 * write failed — callers surface that instead of silently pretending.
 */
export async function setBudgetLimit(sessionId: string, limit: number): Promise<boolean> {
  const s = budgets.get(sessionId)
  if (!s || !s.projectPath) return false
  const rounded = Math.round(limit)
  if (!Number.isFinite(rounded) || rounded <= 0) return false

  const path = `${s.projectPath.replace(/[\\/]+$/, '')}/.ourcode/targemode/budget.md`
  // Same field format as targetModeService.BUDGET_INIT / readLimit above.
  const FIELD_RE = /总消耗上限（tokens）[：:]\s*\d+[^\n]*/
  const line = `- 总消耗上限（tokens）：${rounded}（可修改）`
  let content = ''
  try {
    content = (await window.electronAPI.readFile(path)).content ?? ''
  } catch {
    content = '' // missing/unreadable → recreate below
  }
  let next: string
  if (FIELD_RE.test(content)) {
    next = content.replace(FIELD_RE, line)
  } else if (content.trim()) {
    next = content.replace(/\r?\n*$/, '\n') + `${line}\n`
  } else {
    next = `# 目标模式预算\n\n${line}\n- 当前累计：0\n- 触顶后停止自主续跑并询问用户。\n`
  }
  try {
    await window.electronAPI.writeFile(path, next, 'utf-8')
  } catch (e) {
    console.error('目标模式预算上限写入失败:', e)
    return false
  }
  manualSetAt.set(sessionId, Date.now())
  const cur = budgets.get(sessionId)
  if (cur) cur.limit = rounded
  return true
}

/** Accumulate consumed tokens for a session (event listener; target-mode only
 *  because the dispatch sites already filtered to target-mode sessions). */
function accumulate(sessionId: string, projectPath: string, tokens: number): void {
  if (!sessionId || !tokens || tokens <= 0) return
  ensureState(sessionId, projectPath).used += tokens
}

/** True when the session's cumulative target-mode consumption hit the cap. */
export function budgetExceeded(sessionId: string): boolean {
  const s = budgets.get(sessionId)
  return !!s && s.used >= s.limit
}

/**
 * Re-read the limit from budget.md — so raising the cap mid-run takes effect
 * (the fuse checks this before each auto-resume attempt).
 */
export async function refreshBudgetLimit(sessionId: string): Promise<void> {
  const s = budgets.get(sessionId)
  if (!s) return
  const readStartedAt = Date.now()
  const limit = await readLimit(s.projectPath)
  applyReadLimit(sessionId, readStartedAt, limit)
}

/** Current usage for the session (0 when never tracked) — surfaced to UI/audit. */
export function getBudgetUsage(sessionId: string): { used: number; limit: number } {
  const s = budgets.get(sessionId)
  return s ? { used: s.used, limit: s.limit } : { used: 0, limit: DEFAULT_LIMIT }
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
