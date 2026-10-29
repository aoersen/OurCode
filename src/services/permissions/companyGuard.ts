/**
 * One-person-company guard: the ONLY hard boundary in company mode.
 *
 * Company mode deliberately has no permission tiers. Everything inside the
 * workspace is allowed and checkpointed; this guard only rejects what the
 * checkpoint cannot make reversible:
 *   1. paths outside the workspace;
 *   2. commands that leave the machine or rewrite git history;
 *   3. commands we cannot statically scope (subshells, -c/-e, pipes to shells).
 *
 * A rejection is a plain tool result — never a dialog, never a wait.
 */
import { analyzeDangerousCommand } from '@/services/tools/dangerousCommands'

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

function isWindows(): boolean {
  try {
    const api = (globalThis as any).electronAPI
    if (api?.platform) return api.platform === 'win32'
    return typeof process !== 'undefined' && process.platform === 'win32'
  } catch {
    return false
  }
}

/** Normalize to forward slashes + lowercase on Windows for comparison only. */
function norm(p: string): string {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return isWindows() ? s.toLowerCase() : s
}

/** Resolve `p` against the project root and collapse `.`/`..` segments. */
export function resolveAgainst(projectRoot: string, p: string): string {
  const raw = String(p || '').trim()
  if (!raw) return projectRoot
  const absolute = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')
  const base = absolute ? '' : projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const joined = absolute ? raw.replace(/\\/g, '/') : `${base}/${raw.replace(/\\/g, '/')}`
  const drive = /^[a-zA-Z]:/.exec(joined)?.[0] ?? ''
  const rest = drive ? joined.slice(drive.length) : joined
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) parts.pop()
      else return `${drive}/..` // escaped above the root
      continue
    }
    parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}

export function isInsideProject(projectRoot: string, absPath: string): boolean {
  const root = norm(resolveAgainst(projectRoot, '.'))
  const p = norm(absPath)
  if (!root) return false
  return p === root || p.startsWith(root + '/')
}

/** All paths a tool call is about to touch (read or write). */
export function targetPathsOf(toolName: string, args: Record<string, any> | undefined): string[] {
  const a = args || {}
  const single = (): string[] => {
    const v = a.path ?? a.filePath ?? a.target
    return typeof v === 'string' && v.trim() ? [v.trim()] : []
  }
  switch (toolName) {
    case 'multi_edit_file': {
      const edits = Array.isArray(a.edits) ? a.edits : []
      return edits
        .map((e: any) => (e && typeof e === 'object' ? String(e.path || '') : ''))
        .filter(Boolean)
    }
    case 'read_multiple_files':
      return (Array.isArray(a.paths) ? a.paths : []).map(String).filter(Boolean)
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'create_directory':
    case 'list_directory':
    case 'get_directory_tree':
    case 'search_files':
    case 'search_in_files':
      return single()
    default:
      return []
  }
}

const PATH_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'write_file', 'edit_file', 'multi_edit_file',
  'delete_file', 'create_directory', 'list_directory', 'get_directory_tree',
  'search_files', 'search_in_files',
])

const WRITE_PATH_TOOLS = new Set([
  'write_file', 'edit_file', 'multi_edit_file', 'delete_file', 'create_directory',
])

/** Project-relative POSIX path, or null when outside the project. */
function relToProject(projectRoot: string, absPath: string): string | null {
  const root = norm(resolveAgainst(projectRoot, '.'))
  const p = norm(absPath)
  if (p === root) return ''
  if (!p.startsWith(root + '/')) return null
  return p.slice(root.length + 1)
}

/** Files an agent must never write/delete: they define its own permissions. */
function protectedWriteReason(projectRoot: string, absPath: string): string | null {
  const rel = relToProject(projectRoot, absPath)
  if (rel == null) return null
  if (rel === '.git' || rel.startsWith('.git/')) return '已拒绝：.git 目录不可由 Agent 修改。'
  if (rel === '.ourcode' || rel === '.ourcode/company' || rel === '.ourcode/agents' || rel === '.ourcode/targemode') {
    return '已拒绝：该目录包含授权/角色/目标状态，只能由用户修改。'
  }
  if (rel === '.ourcode/company/policy.json') return '已拒绝：公司授权策略只能由用户修改。'
  if (rel.startsWith('.ourcode/agents/')) return '已拒绝：角色定义（权限边界）只能由用户修改。'
  if (rel === '.ourcode/targemode/budget.md') return '已拒绝：预算文件只能由用户修改。'
  if (/^\.ourcode\/targemode\/finalgoal[^/]*\.md$/i.test(rel)) return '已拒绝：目标文件只能由用户修改。'
  return null
}

/** Tools that are irrelevant in company mode (they would wait for a human). */
const COMPANY_FORBIDDEN = new Set([
  'ask_user_question',
  'submit_plan',
  'claw_state',
  'office_instruct',
])

/** External/remote commands: these leave the machine or rewrite history. */
const REMOTE_COMMAND_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bgit\s+push\b/, reason: 'git push 会把改动发到远端，checkpoint 无法回滚' },
  { re: /\bgit\s+(rebase|commit\s+--amend|clean\s+-[a-z]*f[a-z]*|reset\s+--hard)\b/i, reason: '改写了 git 历史/工作区，超出 checkpoint 的恢复范围' },
  { re: /\b(npm|pnpm|yarn|bun|cargo|deno)\s+publish\b/, reason: '发布会把包发到公共注册表，无法回滚' },
  { re: /\bdocker\s+push\b/, reason: '推送镜像到远端仓库，无法回滚' },
  { re: /\b(gh|glab)\s+(pr|release|repo)\s+(create|merge|delete|edit)\b/, reason: '对远端仓库的写操作，无法回滚' },
  { re: /\b(kubectl|helm)\s+(apply|delete|upgrade|rollout)\b/, reason: '变更集群状态，无法回滚' },
  { re: /\bterraform\s+(apply|destroy)\b/, reason: '变更基础设施，无法回滚' },
  { re: /\b(vercel|netlify|firebase|wrangler|flyctl|heroku)\s+(deploy|publish|release)\b/, reason: '部署到远端，无法回滚' },
  { re: /\b(ssh|scp|sftp|rsync)\b/, reason: '访问/同步远端机器，无法回滚' },
  { re: /\b(aws|gcloud|az|gsutil|azcopy)\s+\S+\s+(create|delete|update|put|deploy|cp|mv|sync|rm)\b/, reason: '变更云资源/远端存储，无法回滚' },
  { re: /\bgit\s+config\s+--global\b|\b(npm|pnpm|yarn)\s+(config\s+set|set)\b/, reason: '修改全局配置，checkpoint 只覆盖工作区' },
  { re: /\b(npm|pnpm|yarn)\b[^|;&]*\s(-g|--global)\b|\b(npm|pnpm|yarn)\s+global\b/, reason: '全局安装会修改工作区外环境，checkpoint 无法回滚' },
  { re: /\b(apt|apt-get|brew|choco|winget|snap)\s+(install|remove|uninstall)\b/, reason: '修改系统级软件，checkpoint 无法回滚' },
  { re: /\b(ln\s+-s|mklink)\b/i, reason: '创建符号链接会让后续写入逃出工作区，checkpoint 无法覆盖' },
  { re: /\b(shutdown|reboot|halt|poweroff|diskpart|format)\b/i, reason: '系统级不可逆命令' },
]

/** Constructs we cannot statically scope. */
const UNSCOPABLE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\$\(|`/, reason: '包含命令替换，无法静态判断影响范围' },
  { re: /\b(ba|z)?sh\s+-c\b|\bcmd\s+\/c\b|\bpowershell(\.exe)?\b[^|;&]*-(enc|e|command)\b/i, reason: '通过 shell 解释器执行，无法静态判断影响范围' },
  { re: /\b(python|python3|py|node|ruby|perl|php)\s+-[ce]\b/, reason: '内联脚本可以执行任意操作，无法静态判断影响范围' },
  { re: /\beval\b/, reason: '动态求值，无法静态判断影响范围' },
]

function isWithinCwd(projectRoot: string, cwd: string): boolean {
  return isInsideProject(projectRoot, resolveAgainst(projectRoot, cwd))
}

/** Strip quotes around a token for path checking. */
function cleanToken(token: string): string {
  return token.replace(/^['"]|['"]$/g, '')
}

/**
 * Check every path-looking token in a command. Absolute paths and `..`
 * escapes must stay inside the project; `~`/env homes are always refused.
 */
function checkCommandPaths(command: string, projectRoot: string, cwd: string): string | null {
  // Split on shell separators, then whitespace. This is intentionally rough:
  // a token we cannot classify is treated as a path and checked.
  const segments = command.split(/&&|\|\||;|\n|\|/).map((s) => s.trim()).filter(Boolean)
  for (const segment of segments) {
    const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) || []
    for (let i = 0; i < tokens.length; i++) {
      const token = cleanToken(tokens[i])
      if (!token) continue
      if (token.includes('://')) continue // URL, not a local path
      // `npm --prefix=../other` / `--cwd=...` embed the path in the flag —
      // check it BEFORE the generic flag skip below.
      const embedded = /^--(prefix|cwd|dir)=(.+)$/i.exec(token)
      if (embedded) {
        const value = embedded[2]
        const resolved = resolveAgainst(projectRoot, value)
        if (resolved.endsWith('/..') || !isInsideProject(projectRoot, resolved)) {
          return `命令引用了工作区外路径（${value}），checkpoint 无法覆盖`
        }
      }
      if (token.startsWith('-') && !token.startsWith('../') && !token.startsWith('..\\')) continue

      if (/^~($|[\\/])/.test(token) || /^\$HOME($|[\\/])/.test(token) || /^%USERPROFILE%/i.test(token)) {
        return `命令引用了用户目录（${token}），checkpoint 无法覆盖工作区外文件`
      }
      if (token === 'cd' && ['..', '../..'].includes(cleanToken(tokens[i + 1] || ''))) {
        return '命令尝试切到工作区外（cd ..），checkpoint 无法覆盖'
      }
      if (token === 'cd' && /[$~%]/.test(cleanToken(tokens[i + 1] || ''))) {
        return '命令用变量/用户目录切换工作目录，无法静态判断是否在工作区内'
      }
      // Permission/state directories are user-owned: no command reads/writes them.
      if (/^\.(git|ourcode)([\\/]|$)/i.test(token)) {
        return '命令不能读写 .git/.ourcode（权限/状态目录）'
      }

      const looksLikePath =
        token === '..' ||
        token.startsWith('/') ||
        /^[a-zA-Z]:[\\/]/.test(token) ||
        token.startsWith('./') ||
        token.startsWith('../') ||
        token.startsWith('.\\') ||
        token.startsWith('..\\') ||
        token.includes('/') ||
        token.includes('\\')
      if (!looksLikePath) continue

      const isAbsolutePath = /^[a-zA-Z]:[\\/]/.test(token) || token.startsWith('/')
      if (isAbsolutePath) {
        const resolved = resolveAgainst(projectRoot, token)
        if (resolved.endsWith('/..') || !isInsideProject(projectRoot, resolved)) {
          return `命令引用了工作区外路径（${token}），checkpoint 无法覆盖`
        }
        const protectedReason = protectedWriteReason(projectRoot, resolved)
        if (protectedReason) return protectedReason
      } else {
        // A relative path is relative to cwd, not the project root.
        const fromCwd = resolveAgainst(projectRoot, `${cwd.replace(/\\/g, '/')}/${token}`)
        if (fromCwd.endsWith('/..') || !isInsideProject(projectRoot, fromCwd)) {
          return `命令引用了工作区外路径（${token}），checkpoint 无法覆盖`
        }
        const protectedReason = protectedWriteReason(projectRoot, fromCwd)
        if (protectedReason) return protectedReason
      }
    }
  }
  return null
}

/** Evaluate a run_command call. */
export function evaluateCompanyCommand(
  command: string,
  projectRoot: string,
  opts: { cwd?: string; allowRemote?: boolean } = {},
): CompanyVerdict {
  const cmd = String(command || '').trim()
  if (!cmd) return ALLOW
  if (!opts.allowRemote) {
    for (const { re, reason } of REMOTE_COMMAND_PATTERNS) {
      if (re.test(cmd)) return deny(`已拒绝：${reason}。请让用户手动执行，或继续其他工作。`)
    }
  }
  for (const { re, reason } of UNSCOPABLE_PATTERNS) {
    if (re.test(cmd)) return deny(`已拒绝：${reason}。请改用工作区内的具体命令/脚本文件，或继续其他工作。`)
  }

  const cwd = opts.cwd || projectRoot
  if (!isWithinCwd(projectRoot, cwd)) {
    return deny(`已拒绝：命令的工作目录在工作区外（${cwd}）。`)
  }

  // Destructive patterns (rm -rf /, format, ...). Local deletions inside the
  // workspace are allowed — they are checkpointed.
  const danger = analyzeDangerousCommand(cmd)
  if (danger) return deny(`已拒绝：${danger.reason}（不可逆，checkpoint 无法恢复）。`)

  const pathIssue = checkCommandPaths(cmd, projectRoot, cwd)
  if (pathIssue) return deny(`已拒绝：${pathIssue}。`)
  return ALLOW
}

/**
 * The company verdict for one tool call. Returns allow/deny only — callers
 * must never open a dialog for a company session.
 */
export function evaluateCompanyToolCall(input: {
  name: string
  arguments?: Record<string, any>
  projectPath: string
  allowRemote?: boolean
}): CompanyVerdict {
  const { name, arguments: args, projectPath, allowRemote } = input
  if (!projectPath) return deny('已拒绝：公司会话没有绑定项目目录，无法保证可回滚。')

  if (COMPANY_FORBIDDEN.has(name)) {
    if (name === 'ask_user_question' || name === 'submit_plan') {
      return deny('公司模式不等待用户回答。请自行决策并把假设写入文档；确需用户决定时，在最终汇报中说明。')
    }
    return deny('公司会话不允许修改自身工作区/审批模式或向 IM 发起人工确认。')
  }

  if (name === 'browser_act' || name === 'git_push' || name === 'create_pull_request') {
    if (allowRemote) return ALLOW
    return deny(
      name === 'browser_act'
        ? '已拒绝：浏览器写操作会离开本机，checkpoint 无法回滚。只读浏览允许。'
        : '已拒绝：该操作会把改动发到远端，checkpoint 无法回滚。请让用户手动执行，或继续其他工作。',
    )
  }

  // MCP: local filesystem servers write inside the checkpointed workspace and
  // are allowed; other servers' obvious write verbs are external side effects.
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    const server = (parts[1] || '').toLowerCase()
    const tool = parts.slice(2).join('__')
    const localFs = /^(filesystem|fs|file|local)/.test(server)
    if (!localFs && !allowRemote && /(?:^|_)(create|update|delete|write|push|publish|send|post|put|merge|deploy|remove|add)(?:_|$)/i.test(tool)) {
      return deny('已拒绝：MCP 外部写操作会离开本机，checkpoint 无法回滚。只读 MCP 调用允许。')
    }
    return ALLOW
  }

  if (name === 'run_command') {
    return evaluateCompanyCommand(String(args?.command || ''), projectPath, {
      cwd: typeof args?.cwd === 'string' ? args.cwd : undefined,
      allowRemote,
    })
  }

  if (PATH_TOOLS.has(name)) {
    for (const p of targetPathsOf(name, args)) {
      const resolved = resolveAgainst(projectPath, p)
      if (resolved.endsWith('/..') || !isInsideProject(projectPath, resolved)) {
        return deny(`已拒绝：路径在工作区外（${p}），checkpoint 无法覆盖。`)
      }
      const rel = relToProject(projectPath, resolved)
      // .git contains credentials/hooks; no tool (read or write) touches it.
      if (rel === '.git' || rel?.startsWith('.git/')) {
        return deny('已拒绝：.git 目录不可由 Agent 访问。')
      }
      if (WRITE_PATH_TOOLS.has(name)) {
        const protectedReason = protectedWriteReason(projectPath, resolved)
        if (protectedReason) return deny(protectedReason)
        if (name === 'delete_file' && norm(resolved) === norm(resolveAgainst(projectPath, '.'))) {
          return deny('已拒绝：不能删除项目根目录。')
        }
      }
    }
  }

  // Local writes, git add/commit, MCP local tools, send_message, subagents,
  // restore_changes, todo/memory, read-only tools: allowed. The checkpoint
  // hooks snapshot before/after mutations.
  return ALLOW
}
