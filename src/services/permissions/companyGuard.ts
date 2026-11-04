/**
 * One-person-company guard — **permissive by design**.
 *
 * Company sessions (office window / target mode / role workers) do not run a
 * permission system. Every file operation, every command, every path — inside
 * or outside the workspace — is allowed. Safety comes from checkpoints and
 * rollback, not from guessing what a command string might do:
 *
 *   - write tools take a per-file pre-image (checkpointService);
 *   - commands / MCP / deletes take a whole-tree snapshot before running;
 *   - `restore_changes` / the office restore card put the workspace back,
 *     including the project baseline and the task-start anchor.
 *
 * What remains here is NOT a permission model:
 *   - availability: tools that block on a human (`ask_user_question`,
 *     `submit_plan`) or rewrite the session's own mode (`claw_state`,
 *     `office_instruct`) are refused so an unattended run can never hang;
 *   - a **narrow** deletion guard: only targets that would damage the machine
 *     or destroy something no snapshot can restore are refused (drive roots,
 *     system dirs, home root, AppData root, the workspace root, `.git`, and
 *     recursive deletes outside the workspace that are not rebuildable/temp).
 *     Everything else passes — including `git push`, formatters, `rm -rf src`,
 *     and commands outside the workspace.
 *
 * The deletion guard is intentionally target-based, not command-text-based:
 * `rm -rf C:\` is refused because of its target, not because the string looks
 * scary. A command allowlist was tried and removed — it broke legitimate
 * debugging without making anything safer.
 */
import {
  analyzeDestructiveCommand,
  isInsideProject,
  isRebuildablePath,
  isTempPath,
  normPath,
  protectedDeleteReason,
  resolveAgainst,
} from './deletionGuard'

export { normPath, resolveAgainst, isInsideProject }

export interface CompanySessionLike {
  mode?: 'main' | 'office' | 'claw'
  targetMode?: boolean
  workerRole?: string
}

/** Office window, target mode and role workers are all "company" sessions. */
export function isCompanySession(session: CompanySessionLike | undefined | null): boolean {
  if (!session) return false
  return session.mode === 'office' || session.targetMode === true || !!session.workerRole
}

export type CompanyVerdict = { allow: true } | { allow: false; reason: string }

const ALLOW: CompanyVerdict = { allow: true }

function deny(reason: string): CompanyVerdict {
  return { allow: false, reason }
}

/**
 * Tools that would wait for a human or rewrite the session's own mode. These
 * are refused in company mode so an unattended run can never hang.
 */
const UNATTENDED_BLOCKED = new Set([
  'ask_user_question',
  'submit_plan',
  'claw_state',
  'office_instruct',
])

/** stat via the preload bridge, or null when unavailable (unit tests / boot). */
async function statSafe(p: string): Promise<{ isDirectory?: boolean } | null> {
  try {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.stat) return null
    return await api.stat(p)
  } catch {
    return null
  }
}

/** Resolve a possibly-relative cwd against the workspace (the shell helper only
 *  ever sees absolute cwds, but the model sometimes emits `src`). */
function absoluteCwd(projectRoot: string, raw: unknown): string {
  const s = String(raw || '')
  if (!s) return projectRoot
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/')) return s
  return resolveAgainst(projectRoot, s)
}

/**
 * Commands are not inspected as a permission gate. The only command-level
 * check is the narrow destructive-delete target scan (see evaluateCompanyToolCall).
 * Kept as a separate export for callers/tests that express intent per-tool.
 */
export function evaluateCompanyCommand(
  command: string,
  projectRoot: string,
  opts: { cwd?: string; allowRemote?: boolean } = {},
): CompanyVerdict {
  const scan = analyzeDestructiveCommand(command, {
    cwd: absoluteCwd(projectRoot, opts.cwd || projectRoot),
    projectRoot,
  })
  return scan.blockReason ? deny(scan.blockReason) : ALLOW
}

/**
 * The company verdict for one tool call. Allow/deny only — callers must never
 * open a dialog for a company session.
 *
 * Async because the delete check may stat the target (a directory outside the
 * workspace is the one case where we look at the filesystem before deciding).
 */
export async function evaluateCompanyToolCall(input: {
  name: string
  arguments?: Record<string, any>
  projectPath: string
  allowRemote?: boolean
}): Promise<CompanyVerdict> {
  const { name } = input
  const projectPath = String(input.projectPath || '')

  if (UNATTENDED_BLOCKED.has(name)) {
    if (name === 'ask_user_question' || name === 'submit_plan') {
      return deny('公司模式不等待用户回答。请自行决策并把假设写入文档；确需用户决定时，在最终汇报中说明。')
    }
    return deny('公司会话不允许修改自身工作区/审批模式或向 IM 发起人工确认。')
  }

  // Narrow deletion guard: only catastrophic / non-restorable targets.
  if (name === 'delete_file') {
    const target = String(input.arguments?.path || '')
    const fatal = protectedDeleteReason(target, projectPath)
    if (fatal) return deny(fatal)

    const abs = resolveAgainst(projectPath, target)
    if (projectPath && isInsideProject(projectPath, abs)) return ALLOW

    // Outside the workspace: a whole directory is not covered by any snapshot.
    // Files are allowed (the per-file checkpoint covers readable ones); generated
    // dirs and temp dirs are allowed because they are rebuildable/disposable.
    const st = await statSafe(abs)
    if (
      st?.isDirectory &&
      !isRebuildablePath(abs) &&
      !isTempPath(abs)
    ) {
      return deny(
        `拒绝删除工作区外的目录：${abs}。它不在任何快照范围内，删除后无法恢复；` +
        `生成目录（build/dist/node_modules 等）或临时目录会被放行。`,
      )
    }
    return ALLOW
  }

  // Command-level narrow deletion guard (rm -rf / Remove-Item -Recurse / del /s …).
  if (name === 'run_command') {
    const scan = analyzeDestructiveCommand(String(input.arguments?.command || ''), {
      cwd: absoluteCwd(projectPath, input.arguments?.cwd || projectPath),
      projectRoot: projectPath,
    })
    if (scan.blockReason) return deny(scan.blockReason)
    return ALLOW
  }

  return ALLOW
}
