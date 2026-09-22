/**
 * GitHub PR workflow, driven by the locally installed `gh` CLI.
 *
 * Deliberately `gh` rather than a hand-rolled REST client: the user keeps their
 * own credentials (`gh auth login`, or GH_TOKEN), the app stores no token, and
 * this stays consistent with the project's BYOK / local-first stance. Everything
 * that can fail because `gh` is missing or logged out is reported as a distinct
 * state the panel renders, instead of surfacing as a failed git operation.
 *
 * Pure shaping (args builders, JSON parsing, check rollups) lives here as
 * exported functions so the unit tests can cover it without a binary.
 */
import { useUIStore } from '@/stores/uiStore'
import { runGitCommand } from '@/services/git'

export interface PullRequestSummary {
  number: number
  title: string
  state: string
  isDraft: boolean
  url: string
  headRefName: string
  baseRefName: string
  author?: string
}

export interface PullRequestCheck {
  name: string
  status: string
  conclusion: string
}

export interface PullRequestComment {
  author: string
  body: string
  createdAt: string
  /** 'review' for inline review comments (they carry a path/line), else 'issue'. */
  kind: 'review' | 'issue'
  path?: string
  line?: number
}

export interface PullRequestDetail extends PullRequestSummary {
  mergeable?: string
  mergeStateStatus?: string
  checks: PullRequestCheck[]
  comments: PullRequestComment[]
}

export type GhResult<T> = { ok: true; data: T } | { ok: false; error: string; notFound?: boolean }

export interface GhAvailability {
  installed: boolean
  authed: boolean
  host?: string
  user?: string
  error?: string
}

const PR_VIEW_FIELDS =
  'number,title,state,isDraft,url,headRefName,baseRefName,author,mergeable,mergeStateStatus,statusCheckRollup,reviews,comments'

function ghExec(args: string[]): Promise<{ success: boolean; output: string; error?: string }> {
  const rootPath = useUIStore.getState().rootPath
  if (!rootPath) return Promise.resolve({ success: false, output: '', error: '未打开项目文件夹' })
  return window.electronAPI.ghExec(rootPath, args)
}

/** Parse a `gh --json` payload. gh sometimes prefixes warnings to stdout, so a
 *  bare JSON.parse failure retries from each line that opens a JSON value —
 *  bounded to line starts on purpose: shrinking the string character by
 *  character would be O(n²) parse attempts and freeze the renderer on a big
 *  payload that never was JSON. */
export function parseGhJson<T>(raw: string): T | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    /* fall through to the line scan */
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart()
    if (line[0] !== '{' && line[0] !== '[') continue
    const candidate = lines.slice(i).join('\n').trim()
    try {
      return JSON.parse(candidate) as T
    } catch {
      /* try the next line that could open a payload */
    }
  }
  return null
}

/** `gh pr create` arguments. Title/body are always passed explicitly — with a
 *  missing flag gh drops into an interactive prompt, and there is no TTY here
 *  to answer it (the process would just sit until the timeout). */
export function buildPrCreateArgs(input: {
  title: string
  body: string
  base?: string
  head?: string
  draft?: boolean
}): string[] {
  const args = ['pr', 'create', '--title', input.title, '--body', input.body]
  if (input.base) args.push('--base', input.base)
  if (input.head) args.push('--head', input.head)
  if (input.draft) args.push('--draft')
  return args
}

/** Flatten `statusCheckRollup`, which gh emits either as a flat array or as an
 *  array-of-arrays (one group per check run / commit status). */
export function summarizeChecks(rollup: unknown): PullRequestCheck[] {
  if (!Array.isArray(rollup)) return []
  const out: PullRequestCheck[] = []
  const push = (item: unknown): void => {
    if (!item || typeof item !== 'object') return
    const row = item as Record<string, unknown>
    out.push({
      name: String(row.name ?? row.context ?? row.__typename ?? 'check'),
      status: String(row.status ?? ''),
      conclusion: String(row.conclusion ?? row.state ?? ''),
    })
  }
  for (const entry of rollup) {
    if (Array.isArray(entry)) entry.forEach(push)
    else push(entry)
  }
  return out
}

/** Map a PR detail payload onto the UI shape. */
export function toPullRequestDetail(raw: Record<string, unknown>): PullRequestDetail {
  return {
    number: Number(raw.number) || 0,
    title: String(raw.title ?? ''),
    state: String(raw.state ?? ''),
    isDraft: raw.isDraft === true,
    url: String(raw.url ?? ''),
    headRefName: String(raw.headRefName ?? ''),
    baseRefName: String(raw.baseRefName ?? ''),
    author: typeof raw.author === 'object' && raw.author ? String((raw.author as Record<string, unknown>).login ?? '') : String(raw.author ?? ''),
    mergeable: raw.mergeable ? String(raw.mergeable) : undefined,
    mergeStateStatus: raw.mergeStateStatus ? String(raw.mergeStateStatus) : undefined,
    checks: summarizeChecks(raw.statusCheckRollup),
    comments: [
      ...((raw.comments as Array<Record<string, unknown>> | undefined) ?? []).map((c) => ({
        author: String((c.author as Record<string, unknown> | undefined)?.login ?? c.author ?? ''),
        body: String(c.body ?? ''),
        createdAt: String(c.createdAt ?? ''),
        kind: 'issue' as const,
      })),
      ...((raw.reviews as Array<Record<string, unknown>> | undefined) ?? []).flatMap((r) =>
        ((r.comments as Array<Record<string, unknown>> | undefined) ?? []).map((c) => ({
          author: String((r.author as Record<string, unknown> | undefined)?.login ?? ''),
          body: String(c.body ?? ''),
          createdAt: String(c.submittedAt ?? r.submittedAt ?? ''),
          kind: 'review' as const,
          path: c.path ? String(c.path) : undefined,
          line: typeof c.line === 'number' ? c.line : undefined,
        })),
      ),
    ],
  }
}

/** Default PR body: the branch's own commit subjects plus a diffstat line.
 *  Keeps `gh pr create` from getting an empty body (GitHub rejects nothing, but
 *  a bodyless PR is unreviewable, and the model would have to guess intent). */
export function buildPrBody(commits: string[], diffStat: string): string {
  const lines = commits.map((c) => `- ${c}`).join('\n')
  return [lines || '- (无提交)', '', diffStat].join('\n')
}

/** `--json` shape differs between gh versions; treat any array as a list. */
export function toPullRequestSummaries(raw: unknown): PullRequestSummary[] {
  if (!Array.isArray(raw)) return []
  return raw.map((row) => toPullRequestDetail(row as Record<string, unknown>))
}

export async function fetchGhAvailability(): Promise<GhAvailability> {
  const rootPath = useUIStore.getState().rootPath
  if (!rootPath) return { installed: false, authed: false, error: '未打开项目文件夹' }
  const res = await window.electronAPI.ghStatus(rootPath)
  return { installed: !!res.installed, authed: !!res.authed, host: res.host, user: res.user, error: res.error }
}

export async function listPullRequests(limit = 20): Promise<GhResult<PullRequestSummary[]>> {
  const res = await ghExec(['pr', 'list', '--json', 'number,title,state,isDraft,url,headRefName,baseRefName,author', '--limit', String(limit)])
  if (!res.success) return { ok: false, error: res.error || 'gh pr list 失败' }
  return { ok: true, data: toPullRequestSummaries(parseGhJson<unknown[]>(res.output) ?? []) }
}

/** View a PR, or (with no number) the one opened for the current branch. */
export async function viewPullRequest(number?: number): Promise<GhResult<PullRequestDetail>> {
  const args = ['pr', 'view']
  if (number) args.push(String(number))
  args.push('--json', PR_VIEW_FIELDS)
  const res = await ghExec(args)
  if (!res.success) {
    const notFound = /no pull requests|not found|could not determine/i.test(res.error || '')
    return { ok: false, error: res.error || 'gh pr view 失败', notFound }
  }
  const parsed = parseGhJson<Record<string, unknown>>(res.output)
  if (!parsed) return { ok: false, error: '无法解析 gh 的输出' }
  return { ok: true, data: toPullRequestDetail(parsed) }
}

/** Current branch's upstream state — `gh pr create` fails without a pushed head. */
export async function branchPushState(): Promise<{ branch: string; hasUpstream: boolean; ahead: number }> {
  const branch = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch.success) return { branch: '', hasUpstream: false, ahead: 0 }
  const name = branch.output.trim()
  const upstream = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  let ahead = 0
  if (upstream.success) {
    const counts = await runGitCommand(['rev-list', '--left-right', '--count', `${upstream.output.trim()}...HEAD`])
    if (counts.success) ahead = Number(counts.output.trim().split(/\s+/)[1]) || 0
  }
  return { branch: name, hasUpstream: upstream.success, ahead }
}

export async function createPullRequest(input: {
  title: string
  body: string
  base?: string
  draft?: boolean
}): Promise<GhResult<{ url: string }>> {
  // No --head: gh defaults to the current branch, which is the branch the panel
  // is on and the one the user just pushed.
  const res = await ghExec(buildPrCreateArgs(input))
  if (!res.success) return { ok: false, error: res.error || 'gh pr create 失败' }
  const url = /https?:\/\/\S+/.exec(res.output)?.[0] || ''
  return { ok: true, data: { url } }
}

export async function commentPullRequest(number: number, body: string): Promise<GhResult<{ ok: true }>> {
  const res = await ghExec(['pr', 'comment', String(number), '--body', body])
  if (!res.success) return { ok: false, error: res.error || 'gh pr comment 失败' }
  return { ok: true, data: { ok: true } }
}

/** Plain-text rendering for the agent tool result and the "复制到对话" action. */
export function formatPullRequestForModel(detail: PullRequestDetail): string {
  const checks = detail.checks.length
    ? detail.checks
        .map((c) => `  - ${c.name}: ${c.conclusion || c.status || 'pending'}`)
        .join('\n')
    : '  (无检查)'
  const comments = detail.comments.length
    ? detail.comments
        .map((c) => `  - ${c.author}${c.path ? ` @ ${c.path}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body.slice(0, 800)}`)
        .join('\n')
    : '  (无评论)'
  return [
    `#${detail.number} ${detail.title}${detail.isDraft ? ' (draft)' : ''}`,
    `状态: ${detail.state} | ${detail.headRefName} → ${detail.baseRefName} | mergeable=${detail.mergeable ?? '未知'}/${detail.mergeStateStatus ?? '未知'}`,
    `链接: ${detail.url}`,
    '检查:',
    checks,
    '评论 / 审阅意见:',
    comments,
  ].join('\n')
}
