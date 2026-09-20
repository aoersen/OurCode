/**
 * Argument gate for the `git:exec` / `gh:exec` IPC channels.
 *
 * Both channels hand an argv array straight to execFile, so the renderer (and
 * through it the model) chooses which subcommand runs. git has several
 * "porcelain that is really a shell" surfaces, all reached through arguments
 * rather than paths:
 *   -c / --config key=value ......... core.pager / core.fsmonitor / diff.external run a program
 *   --exec-path, --git-dir, --work-tree, --namespace ... relocate the repo (and hooks)
 *   ext::<cmd> transport ............. `git archive --remote=ext::touch x` executes <cmd>
 *   --output=<path> .................. writes outside the workspace guard
 * The subcommand allowlist plus the flag block below is what turns "runs any git
 * command" into "runs git commands that only touch this repository".
 */

/** git subcommands the app is allowed to run — exactly what the panels, the
 *  diff editor and the agent tools send (see electron/__tests__/vcs-compat.test.ts,
 *  which fails if a call site adds a shape not listed here). Anything else is
 *  refused — notably `config` (persistent RCE primitive), `clone`/`init`/`clean`,
 *  and the plumbing group. */
export const GIT_ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'diff', 'show', 'log', 'rev-parse', 'rev-list', 'branch',
  'add', 'reset', 'commit', 'stash', 'checkout',
  'fetch', 'pull', 'push',
  // merge/rebase are allowed ONLY in the recovery forms listed in
  // GIT_SUBCOMMAND_ARGS; apply only in the stdin shapes in GIT_TOKEN_ARGS.
  'merge', 'rebase', 'apply',
])

/** Subcommands whose ONLY permitted form is a fixed set of second-args —
 *  these are recovery operations, and the open-ended form (`merge <sha>`,
 *  `rebase -i`) is not needed by the UI. */
export const GIT_SUBCOMMAND_ARGS: Readonly<Record<string, ReadonlySet<string>>> = {
  merge: new Set(['--abort', '--continue', '--no-edit']),
  rebase: new Set(['--abort', '--continue', '--skip']),
}

/** Subcommands where EVERY argument must be listed — `git apply` takes a patch
 *  from stdin and otherwise accepts arbitrary paths, so it is only allowed in
 *  the four shapes the central diff editor actually sends (per-hunk stage /
 *  unstage / revert). Read with the `GIT_SUBCOMMAND_ARGS` note above: this one
 *  is a token set, not a second-arg set. */
export const GIT_TOKEN_ARGS: Readonly<Record<string, ReadonlySet<string>>> = {
  apply: new Set(['apply', '--cached', '--whitespace=nowarn', '--check', '-R', '-']),
}

/** gh subcommands exposed to the renderer. `api` is deliberately absent — it is
 *  an arbitrary HTTP escape. `gh pr` verbs are filtered further down. */
export const GH_ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set(['pr', 'auth'])

export const GH_PR_ALLOWED_VERBS: ReadonlySet<string> = new Set([
  'list', 'view', 'create', 'comment', 'ready', 'merge', 'checkout', 'status',
])

/** Anything from this list appearing as an argument is refused, wherever it sits.
 *  The transport family is the reason: `git fetch --upload-pack=<cmd> <path>`
 *  (and push's `--receive-pack` / `--exec`) run <cmd> as part of a perfectly
 *  allowlisted subcommand, so a name check alone would not be a gate. */
const BLOCKED_FLAGS = [
  '-c', '--config', '--exec-path', '--git-dir', '--work-tree', '--namespace',
  '--module', '--super-prefix',
  '--upload-pack', '--receive-pack', '--send-pack', '--exec', '--ssh-command',
]

export interface VcsInvocation {
  ok: true
  bin: 'git' | 'gh'
  args: string[]
}

export interface VcsRejection {
  ok: false
  error: string
}

function blockedArg(args: string[]): string | null {
  for (const arg of args) {
    if (typeof arg !== 'string') return '参数必须是字符串'
    if (arg.includes('ext::')) return `不允许的参数：${arg}`
    for (const flag of BLOCKED_FLAGS) {
      if (arg === flag || arg.startsWith(`${flag}=`)) return `不允许的参数：${arg}`
    }
    if (arg.startsWith('--output')) return `不允许的参数：${arg}（git 可以在仓库外写文件）`
  }
  return null
}

/**
 * Validate a git/gh invocation. Returns the argv to run, or a rejection with a
 * message the model can act on (the allowlist is quoted back so it can pick a
 * supported command instead of retrying variants of a refused one).
 */
export function checkVcsArgs(bin: 'git' | 'gh', args: unknown): VcsInvocation | VcsRejection {
  if (!Array.isArray(args) || args.length === 0) {
    return { ok: false, error: `${bin} 需要一个非空参数数组` }
  }
  const argv = args as string[]
  const sub = argv[0]
  if (typeof sub !== 'string' || sub.startsWith('-')) {
    return { ok: false, error: `${bin} 的第一个参数必须是子命令（不接受前置选项）` }
  }
  const blocked = blockedArg(argv.slice(1))
  if (blocked) return { ok: false, error: blocked }

  if (bin === 'git') {
    if (!GIT_ALLOWED_SUBCOMMANDS.has(sub)) {
      return { ok: false, error: `不支持的 git 子命令：${sub}。可用：${[...GIT_ALLOWED_SUBCOMMANDS].join('、')}` }
    }
    const restricted = GIT_SUBCOMMAND_ARGS[sub]
    if (restricted && !restricted.has(argv[1])) {
      return { ok: false, error: `git ${sub} 只允许：${[...restricted].join('、')}` }
    }
    const tokens = GIT_TOKEN_ARGS[sub]
    if (tokens) {
      const stray = argv.filter((arg) => !tokens.has(arg))
      if (stray.length) {
        return { ok: false, error: `git ${sub} 只允许固定形态：${[...tokens].join(' ')}` }
      }
      // A patch is only ever fed through stdin; refusing a positional path keeps
      // `apply` from reading a file the patch named.
      if (!argv.includes('-')) return { ok: false, error: `git ${sub} 必须从标准输入读补丁（参数需含 -）` }
    }
    return { ok: true, bin, args: argv }
  }

  if (!GH_ALLOWED_SUBCOMMANDS.has(sub)) {
    return { ok: false, error: `不支持的 gh 子命令：${sub}。可用：${[...GH_ALLOWED_SUBCOMMANDS].join('、')}` }
  }
  if (sub === 'pr' && !GH_PR_ALLOWED_VERBS.has(argv[1])) {
    return { ok: false, error: `gh pr 只允许：${[...GH_PR_ALLOWED_VERBS].join('、')}` }
  }
  if (sub === 'auth' && argv[1] !== 'status' && argv[1] !== 'login') {
    return { ok: false, error: 'gh auth 只允许：status、login' }
  }
  return { ok: true, bin, args: argv }
}

/** Parse `gh auth status` output. It exits non-zero when logged out, so this
 *  runs on both the stdout and the stderr the CLI writes either way.
 *  Shape (gh 2.x):
 *    github.com
 *      ✓ Logged in to github.com account octocat (keyring)
 */
export function parseGhAuthStatus(text: string): { authed: boolean; host?: string; user?: string } {
  const match = /Logged in to\s+(\S+)\s+account\s+(\S+)/.exec(text || '')
  if (!match) return { authed: false }
  return { authed: true, host: match[1], user: match[2] }
}
