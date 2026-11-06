import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@/i18n/useI18n'
import { askText } from '@/components/Common/PromptDialog'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { runGitCommand } from '@/services/git'
import {
  branchPushState,
  buildPrBody,
  commentPullRequest,
  createPullRequest,
  fetchGhAvailability,
  formatPullRequestForModel,
  listPullRequests,
  viewPullRequest,
  type GhAvailability,
  type PullRequestDetail,
  type PullRequestSummary,
} from '@/services/github'

interface PullRequestSectionProps {
  branch: string
  /** Re-read git state after this section mutates it (push before creating a PR). */
  onRefresh: () => void
}

function checkTally(checks: PullRequestDetail['checks']): { passed: number; failed: number; running: number } {
  return checks.reduce(
    (acc, c) => {
      const verdict = (c.conclusion || '').toUpperCase()
      if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)) acc.passed += 1
      else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED'].includes(verdict)) acc.failed += 1
      else acc.running += 1
      return acc
    },
    { passed: 0, failed: 0, running: 0 },
  )
}

/** Small stroke icons kept local so the panel has one icon language. */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

function IconChevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

function IconRefresh({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  )
}

function IconArrow({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M4 12h15M14 7l5 5-5 5" />
    </svg>
  )
}

/**
 * Pull-request workflow for the current branch, over the user's own `gh`.
 *
 * Collapsed by default: the strip shows the one sentence that matters (open
 * PR, or commits not on the remote) plus a single CTA. The form only appears
 * after 创建 PR, so it stops pushing the working-tree list below the fold.
 * The section degrades to a one-line explanation when `gh` is missing or
 * logged out.
 */
export default function PullRequestSection({ branch, onRefresh }: PullRequestSectionProps) {
  const t = useI18n()
  const notify = useUIStore((s) => s.showNotification)
  const [gh, setGh] = useState<GhAvailability | null>(null)
  const [pr, setPr] = useState<PullRequestDetail | null>(null)
  const [others, setOthers] = useState<PullRequestSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('main')
  const [draft, setDraft] = useState(false)
  const [push, setPush] = useState<{ hasUpstream: boolean; ahead: number } | null>(null)
  const [confirmMerge, setConfirmMerge] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [noRemote, setNoRemote] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const availability = await fetchGhAvailability()
      setGh(availability)
      if (!availability.installed || !availability.authed) return
      const viewed = await viewPullRequest()
      if (viewed.ok) {
        setNoRemote(false)
        setPr(viewed.data)
        setBase(viewed.data.baseRefName || base)
      } else if (viewed.notFound) {
        setNoRemote(false)
        setPr(null)
        // Pre-fill the create form from the branch itself, so "submit" is a
        // click rather than a writing task.
        const subjects = await runGitCommand(['log', '-8', '--format=%s'])
        const stat = await runGitCommand(['diff', 'HEAD', '--stat'])
        const commits = subjects.success ? subjects.output.split('\n').filter(Boolean) : []
        setTitle((current) => current || commits[0] || '')
        setBody((current) => current || buildPrBody(commits, stat.success ? stat.output : ''))
        const pushState = await branchPushState()
        setPush(pushState)
      } else if (/no git remotes?/i.test(viewed.error || '')) {
        // A local branch with no remote is normal, not an error worth showing.
        setNoRemote(true)
        setPr(null)
        setPush({ hasUpstream: false, ahead: 0 })
      } else {
        setError(viewed.error)
      }
      const list = await listPullRequests(8)
      if (list.ok) setOthers(list.data.filter((row) => row.headRefName !== branch))
    } finally {
      setLoading(false)
    }
  }, [base, branch])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch])

  const run = async (label: string, action: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    setLoading(true)
    try {
      const result = await action()
      if (!result.ok) notify(`${label}：${result.error || t('git.prFailed')}`, 'error', { duration: 12_000 })
      return result.ok
    } catch (error: any) {
      // Without this the section would sit at loading forever (and the refresh
      // button is disabled while loading, so the user could not even retry).
      notify(`${label}：${error?.message || String(error)}`, 'error', { duration: 12_000 })
      return false
    } finally {
      setLoading(false)
    }
  }

  const needsPush = !!push && (!push.hasUpstream || push.ahead > 0)

  const handleCreate = async (): Promise<void> => {
    const label = needsPush ? t('git.prPushCreate') : t('git.prCreate')
    const ok = await run(label, async () => {
      // The strip says "1 commit not on the remote yet": fold that push into
      // the same action instead of leaving a second, duplicate Push button.
      if (needsPush) {
        const pushed = await runGitCommand(['push', '-u', 'origin', 'HEAD'])
        if (!pushed.success) {
          return { ok: false, error: (pushed.error || '').split('\n')[0] }
        }
        setPush({ hasUpstream: true, ahead: 0 })
        onRefresh()
      }
      return createPullRequest({ title: title.trim(), body, base: base.trim() || undefined, draft })
    })
    if (ok) {
      notify(t('git.prCreated'), 'success')
      setExpanded(false)
      void load()
    }
  }

  const handleComment = async (): Promise<void> => {
    if (!pr) return
    const text = await askText({ title: t('git.prCommentPrompt'), multiline: true })
    if (!text?.trim()) return
    if (await run(t('git.prComment'), () => commentPullRequest(pr.number, text))) void load()
  }

  const handleMerge = async (): Promise<void> => {
    if (!pr) return
    if (!confirmMerge) {
      setConfirmMerge(true)
      window.setTimeout(() => setConfirmMerge(false), 5000)
      return
    }
    setConfirmMerge(false)
    // execFile path is allowlisted for `gh pr merge`; squash only, no branch
    // deletion — the user's local branch state stays exactly as it was.
    const ok = await run(t('git.prMerge'), async () => {
      const rootPath = useUIStore.getState().rootPath
      if (!rootPath) return { ok: false, error: t('git.noFolder') }
      const res = await window.electronAPI.ghExec(rootPath, ['pr', 'merge', '--squash'])
      return { ok: res.success, error: res.error }
    })
    if (ok) void load()
  }

  const handToAgent = async (): Promise<void> => {
    if (!pr) return
    const chat = useChatStore.getState()
    if (!chat.activeSessionId) {
      notify(t('git.prNoSession'), 'warning')
      return
    }
    await chat.sendMessage(
      chat.activeSessionId,
      `${t('git.prReviewPromptHeader')}\n\n${formatPullRequestForModel(pr)}`,
    )
  }

  const tally = pr ? checkTally(pr.checks) : null
  const summary = !branch
    ? t('git.noFolder')
    : noRemote
      ? t('git.prNoRemote')
      : push && !push.hasUpstream
        ? t('git.prNotPushed')
        : push && push.ahead > 0
          ? t('git.prAhead', { count: push.ahead })
          : t('git.prNoOpen')

  const stateDot = pr
    ? pr.isDraft
      ? 'bg-warning'
      : pr.state === 'OPEN'
        ? 'bg-success'
        : pr.state === 'MERGED'
          ? 'bg-nova-accent'
          : 'bg-nova-text-muted'
    : noRemote
      ? 'bg-nova-text-muted/50'
      : needsPush
        ? 'bg-warning'
        : 'bg-nova-text-muted/50'

  return (
    <section
      aria-label={t('git.prTitle')}
      className="mx-2 mt-2 shrink-0 overflow-hidden rounded-xl border border-nova-border bg-nova-card shadow-[var(--shadow-sm)]"
    >
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-nova-text-muted">
          {t('git.prTitle')}
        </span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateDot}`} aria-hidden />
        {pr ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            title={expanded ? t('git.prCollapse') : t('git.prExpand')}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
          >
            <span className="min-w-0 truncate text-[11px] font-medium text-nova-text-primary">
              #{pr.number} {pr.title}
            </span>
            <IconChevron
              className={`h-3 w-3 shrink-0 text-nova-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
        ) : !gh ? (
          <span
            aria-label={t('git.loading')}
            className="h-2 w-24 animate-pulse rounded-full bg-nova-hover"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-nova-text-muted" title={summary}>
            {summary}
          </span>
        )}
        {gh?.authed && !pr && !noRemote && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="shrink-0 rounded-lg border border-nova-border bg-nova-surface px-2 py-1 text-[10px] font-semibold text-nova-text-secondary transition-colors hover:bg-nova-hover hover:text-nova-text-primary"
          >
            {expanded ? t('git.prCollapse') : t('git.prCreate')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          title={t('git.refresh')}
          aria-label={t('git.refresh')}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-nova-text-muted transition-colors hover:bg-nova-hover hover:text-nova-text-primary disabled:opacity-40"
        >
          <IconRefresh className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {branch && (
        <div className="flex items-center gap-1 px-3 pb-2 text-[9.5px] font-mono text-nova-text-muted">
          <span className="max-w-[45%] truncate">{branch}</span>
          <IconArrow className="h-3 w-3 shrink-0" />
          <span className="truncate">{pr?.baseRefName || base || 'main'}</span>
          {pr && (
            <span className="ml-auto shrink-0 rounded-full border border-nova-border px-1.5 py-px text-[9px]">
              {pr.isDraft ? 'Draft' : pr.state}
            </span>
          )}
        </div>
      )}

      {gh && !gh.installed && (
        <div className="px-3 pb-2 text-[10px] leading-relaxed text-nova-text-muted">{t('git.prNeedGh')}</div>
      )}
      {gh?.installed && !gh.authed && (
        <div className="px-3 pb-2 text-[10px] leading-relaxed text-nova-text-muted">{t('git.prNeedAuth')}</div>
      )}
      {error && <div className="px-3 pb-2 text-[10px] text-warning-text">{error}</div>}

      {expanded && gh?.authed && !pr && !noRemote && (
        <div className="flex flex-col gap-1.5 border-t border-nova-border px-3 py-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('git.prTitlePlaceholder')}
            className="h-7 w-full rounded-md border border-nova-border bg-nova-surface px-2 text-[10.5px] text-nova-text-primary outline-none focus:border-nova-accent"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('git.prBodyPlaceholder')}
            rows={3}
            className="w-full resize-none rounded-md border border-nova-border bg-nova-surface px-2 py-1 text-[10.5px] text-nova-text-primary outline-none focus:border-nova-accent"
          />
          <div className="flex items-center gap-1.5">
            <span className="text-[9.5px] text-nova-text-muted">{t('git.prBase')}</span>
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="h-6 w-24 rounded-md border border-nova-border bg-nova-surface px-1.5 font-mono text-[10px] text-nova-text-primary outline-none focus:border-nova-accent"
            />
            <label className="flex items-center gap-1 text-[9.5px] text-nova-text-muted">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Draft
            </label>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="rounded-lg px-2 py-1 text-[10px] font-medium text-nova-text-muted transition-colors hover:bg-nova-hover hover:text-nova-text-primary"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={loading || !title.trim()}
                className="rounded-lg bg-nova-accent px-2.5 py-1 text-[10px] font-semibold text-nova-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {needsPush ? t('git.prPushCreate') : t('git.prCreate')}
              </button>
            </div>
          </div>
        </div>
      )}

      {expanded && pr && (
        <div className="flex flex-col gap-1.5 border-t border-nova-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9.5px] text-nova-text-muted">
            <span className="font-mono truncate">
              {pr.headRefName} → {pr.baseRefName}
            </span>
            {tally && (
              <span>
                {t('git.prChecks', { passed: tally.passed, failed: tally.failed, running: tally.running })}
              </span>
            )}
            <span>{t('git.prComments', { count: pr.comments.length })}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => window.open(pr.url, '_blank')}
              className="rounded-lg border border-nova-border bg-nova-surface px-2 py-1 text-[10px] font-medium text-nova-text-secondary transition-colors hover:bg-nova-hover hover:text-nova-text-primary"
            >
              {t('git.prOpen')}
            </button>
            <button
              type="button"
              onClick={() => void handleComment()}
              disabled={loading}
              className="rounded-lg border border-nova-border bg-nova-surface px-2 py-1 text-[10px] font-medium text-nova-text-secondary transition-colors hover:bg-nova-hover hover:text-nova-text-primary disabled:opacity-40"
            >
              {t('git.prComment')}
            </button>
            {pr.comments.length > 0 && (
              <button
                type="button"
                onClick={() => void handToAgent()}
                className="rounded-lg border border-accent-30 bg-accent-5 px-2 py-1 text-[10px] font-medium text-accent-text transition-colors hover:bg-accent-10"
                title={t('git.prHandToAgentHint')}
              >
                {t('git.prHandToAgent')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleMerge()}
              disabled={loading || pr.isDraft || pr.state !== 'OPEN'}
              className={`rounded-lg border px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-40 ${
                confirmMerge
                  ? 'border-warning-30 bg-warning-10 text-warning-text'
                  : 'border-nova-border bg-nova-surface text-nova-text-secondary hover:bg-nova-hover hover:text-nova-text-primary'
              }`}
              title={t('git.prMergeHint')}
            >
              {confirmMerge ? t('git.prMergeConfirm') : t('git.prMerge')}
            </button>
          </div>
          {pr.comments.length > 0 && (
            <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
              {pr.comments.slice(0, 6).map((c, i) => (
                <div key={i} className="rounded-md border border-nova-border bg-nova-surface px-2 py-1 text-[9.5px] leading-relaxed">
                  <div className="flex items-center gap-1 text-nova-text-muted">
                    <span className="font-semibold text-nova-text-secondary">{c.author}</span>
                    {c.path && (
                      <span className="truncate font-mono">
                        {c.path}
                        {c.line ? `:${c.line}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-nova-text-primary">{c.body.slice(0, 600)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {expanded && others.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-nova-border px-3 py-1.5">
          {others.slice(0, 4).map((row) => (
            <button
              key={row.number}
              type="button"
              onClick={() => window.open(row.url, '_blank')}
              className="truncate text-left text-[9.5px] text-nova-text-muted transition-colors hover:text-nova-accent"
            >
              #{row.number} {row.title}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
