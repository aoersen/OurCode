import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@/i18n/useI18n'
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

/**
 * Pull-request workflow for the current branch, over the user's own `gh`.
 *
 * The whole section degrades to a one-line explanation when `gh` is missing or
 * logged out — the git panel stays usable, and the reason PR features aren't
 * there is stated instead of the section silently rendering nothing.
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

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const availability = await fetchGhAvailability()
      setGh(availability)
      if (!availability.installed || !availability.authed) return
      const viewed = await viewPullRequest()
      if (viewed.ok) {
        setPr(viewed.data)
        setBase(viewed.data.baseRefName || base)
      } else if (viewed.notFound) {
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

  const handleCreate = async (): Promise<void> => {
    const ok = await run(t('git.prCreate'), () => createPullRequest({ title: title.trim(), body, base: base.trim() || undefined, draft }))
    if (ok) {
      notify(t('git.prCreated'), 'success')
      void load()
    }
  }

  const handlePushBranch = async (): Promise<void> => {
    const result = await runGitCommand(['push', '-u', 'origin', 'HEAD'])
    if (result.success) {
      notify(t('git.pushed'), 'success')
      onRefresh()
      setPush({ hasUpstream: true, ahead: 0 })
    } else {
      notify(`${t('git.push')}：${(result.error || '').split('\n')[0]}`, 'error', { duration: 12_000 })
    }
  }

  const handleComment = async (): Promise<void> => {
    if (!pr) return
    const text = window.prompt(t('git.prCommentPrompt'))
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

  return (
    <div className="mx-2 mb-2 rounded-lg border border-glass-border bg-glass-bg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10px] font-bold tracking-widest uppercase text-nova-text-muted">{t('git.prTitle')}</span>
        {pr && (
          <span className="text-[10px] font-mono text-nova-text-secondary truncate flex-1">
            #{pr.number} {pr.title}
          </span>
        )}
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto text-[10px] text-nova-text-muted hover:text-nova-accent disabled:opacity-40"
          title={t('git.refresh')}
        >
          {loading ? t('git.loading') : t('git.prRefresh')}
        </button>
      </div>

      {!gh?.installed && (
        <div className="px-3 pb-2 text-[11px] text-nova-text-muted leading-relaxed">{t('git.prNeedGh')}</div>
      )}
      {gh?.installed && !gh.authed && (
        <div className="px-3 pb-2 text-[11px] text-nova-text-muted leading-relaxed">{t('git.prNeedAuth')}</div>
      )}
      {error && <div className="px-3 pb-2 text-[11px] text-warning">{error}</div>}

      {gh?.authed && pr && (
        <div className="px-3 pb-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[10px] text-nova-text-muted flex-wrap">
            <span className="px-1.5 rounded-full bg-white/70 dark:bg-white/10">{pr.isDraft ? 'Draft' : pr.state}</span>
            <span className="font-mono truncate">{pr.headRefName} → {pr.baseRefName}</span>
            {tally && (
              <span>
                {t('git.prChecks', { passed: tally.passed, failed: tally.failed, running: tally.running })}
              </span>
            )}
            <span>{t('git.prComments', { count: pr.comments.length })}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => window.open(pr.url, '_blank')}
              className="px-2 py-1 text-[10px] font-bold rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15"
            >
              {t('git.prOpen')}
            </button>
            <button
              onClick={handleComment}
              disabled={loading}
              className="px-2 py-1 text-[10px] font-bold rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15 disabled:opacity-40"
            >
              {t('git.prComment')}
            </button>
            {pr.comments.length > 0 && (
              <button
                onClick={handToAgent}
                className="px-2 py-1 text-[10px] font-bold rounded-full border hover:scale-[1.01] disabled:opacity-40"
                style={{
                  border: '1px solid color-mix(in srgb, var(--accent, #0058bc) 50%, transparent)',
                  background: 'color-mix(in srgb, var(--accent, #0058bc) 5%, transparent)',
                  color: 'var(--accent)',
                }}
                title={t('git.prHandToAgentHint')}
              >
                {t('git.prHandToAgent')}
              </button>
            )}
            <button
              onClick={handleMerge}
              disabled={loading || pr.isDraft || pr.state !== 'OPEN'}
              className={`px-2 py-1 text-[10px] font-bold rounded-full border disabled:opacity-40 ${
                confirmMerge ? 'bg-warning-10 border-warning-30 text-warning' : 'bg-white/70 dark:bg-white/10 border-glass-border'
              }`}
              title={t('git.prMergeHint')}
            >
              {confirmMerge ? t('git.prMergeConfirm') : t('git.prMerge')}
            </button>
          </div>
          {pr.comments.length > 0 && (
            <div className="max-h-28 overflow-y-auto flex flex-col gap-1">
              {pr.comments.map((c, i) => (
                <div key={i} className="text-[10px] leading-relaxed rounded bg-white/50 dark:bg-white/5 px-2 py-1">
                  <span className="font-bold text-nova-text-secondary">{c.author}</span>
                  {c.path && <span className="font-mono text-nova-text-muted"> {c.path}{c.line ? `:${c.line}` : ''}</span>}
                  <div className="text-nova-text-primary whitespace-pre-wrap break-words">{c.body.slice(0, 600)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {gh?.authed && !pr && branch && (
        <div className="px-3 pb-2 flex flex-col gap-1.5">
          {push && !push.hasUpstream && (
            <div className="text-[10px] text-warning">{t('git.prNotPushed')}</div>
          )}
          {push?.ahead ? (
            <div className="flex items-center gap-2 text-[10px] text-nova-text-muted">
              {t('git.prAhead', { count: push.ahead })}
              <button onClick={handlePushBranch} disabled={loading} className="underline disabled:opacity-40">
                {t('git.push')}
              </button>
            </div>
          ) : null}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('git.prTitlePlaceholder')}
            className="w-full bg-white/60 dark:bg-white/10 border border-glass-border rounded-md px-2 py-1 text-[11px] text-nova-text-primary outline-none focus:border-nova-accent"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('git.prBodyPlaceholder')}
            rows={3}
            className="w-full bg-white/60 dark:bg-white/10 border border-glass-border rounded-md px-2 py-1 text-[11px] text-nova-text-primary outline-none focus:border-nova-accent resize-none"
          />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-nova-text-muted">{t('git.prBase')}</span>
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="flex-1 min-w-0 bg-white/60 dark:bg-white/10 border border-glass-border rounded-md px-1.5 py-0.5 text-[11px] font-mono text-nova-text-primary outline-none focus:border-nova-accent"
            />
            <label className="flex items-center gap-1 text-[10px] text-nova-text-muted">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Draft
            </label>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleCreate}
              disabled={loading || !title.trim()}
              className="px-3 py-1 text-[10px] font-bold text-white rounded-full disabled:opacity-30 hover:brightness-110"
              style={{ background: 'linear-gradient(135deg, #0ea5e9, #6366f1, #a855f7)' }}
            >
              {t('git.prCreate')}
            </button>
            {push && (!push.hasUpstream || push.ahead > 0) && (
              <button
                onClick={handlePushBranch}
                disabled={loading}
                className="px-3 py-1 text-[10px] font-bold rounded-full bg-white/70 dark:bg-white/10 border border-glass-border disabled:opacity-40"
              >
                {t('git.push')}
              </button>
            )}
          </div>
        </div>
      )}

      {others.length > 0 && (
        <div className="border-t border-glass-border px-3 py-1.5 flex flex-col gap-0.5">
          {others.slice(0, 4).map((row) => (
            <button
              key={row.number}
              onClick={() => window.open(row.url, '_blank')}
              className="text-left text-[10px] text-nova-text-muted hover:text-nova-accent truncate"
            >
              #{row.number} {row.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
