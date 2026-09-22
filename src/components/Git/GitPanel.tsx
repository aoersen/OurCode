import { useState, useEffect, useCallback } from 'react'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { useConfigStore } from '@/stores/configStore'
import { sendLLMRequest } from '@/services/llm/LLMClient'
import { runLifeguardCheck, LifeguardFinding } from '@/services/lifeguard'
import { fetchGitDiffSides, onGitChanged, runGitCommand as gitRun } from '@/services/git'
import { parseGitStatusPorcelain, committableFiles, conflictedFiles, type GitStatusEntry } from '@/utils/gitStatus'
import PullRequestSection from './PullRequestSection'
import { useI18n } from '@/i18n/useI18n'
import { askText } from '@/components/Common/PromptDialog'

interface GitCommit {
  hash: string
  message: string
  author: string
  date: string
}

export default function GitPanel() {
  const [gitStatus, setGitStatus] = useState<GitStatusEntry[]>([])
  const [gitBranch, setGitBranch] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [log, setLog] = useState<GitCommit[]>([])
  const [lastCommit, setLastCommit] = useState<GitCommit | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [generatingCommit, setGeneratingCommit] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const t = useI18n()
  const showNotification = useUIStore((s) => s.showNotification)

  /** Report a failed git operation where the user will see it. Before this,
   *  push/pull failures went to console.error only, so the button looked like
   *  it had done nothing at all. */
  const report = useCallback(
    (label: string, result: { success: boolean; error?: string; output?: string }) => {
      if (result.success) {
        const detail = (result.output || '').split('\n').filter(Boolean).slice(-1)[0]
        showNotification(detail ? `${label}：${detail}` : `${label}完成`, 'success')
        return
      }
      showNotification(`${label}失败：${(result.error || '未知错误').split('\n')[0]}`, 'error', { duration: 10_000 })
    },
    [showNotification],
  )

  // Select the ACTION only — a whole-store subscription would re-render the
  // git panel on every editorStore change (each cursor move / dirty toggle
  // while this sidebar tab is open).
  const openFile = useEditorStore((s) => s.openFile)
  const openDiff = useEditorStore((s) => s.openDiff)

  // Get root path from store
  const getRootPath = useCallback(() => {
    return useUIStore.getState().rootPath
  }, [])

  /** Resolve a repo-relative path (from `git status --porcelain`) to an absolute path */
  const resolveFilePath = useCallback((file: string): string => {
    const rootPath = getRootPath()
    if (!rootPath) return file
    const sep = rootPath.includes('/') ? '/' : '\\'
    return rootPath.replace(/[/\\]$/, '') + sep + file
  }, [getRootPath])

  const runGitCommand = useCallback((args: string[], input?: string) => gitRun(args, input), [])
  const refreshStatus = useCallback(async () => {
    const rootPath = getRootPath()
    if (!rootPath) return

    setIsLoading(true)
    try {
      // Get current branch
      const branchResult = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'])
      if (branchResult.success) {
        setGitBranch(branchResult.output)
      }

      // Get status with porcelain format
      const statusResult = await runGitCommand(['status', '--porcelain=v1'])
      setGitStatus(statusResult.success ? parseGitStatusPorcelain(statusResult.output) : [])
    } catch (error) {
      console.error('获取 Git 状态失败:', error)
      setGitStatus([])
      setGitBranch('')
    } finally {
      setIsLoading(false)
    }

    // Keep the recent-commit footer in sync with every status refresh
    // (Stitch: 最近提交脚注 — history icon + hash + message + time).
    const logResult = await runGitCommand(['log', '-1', '--format=%H|%s|%an|%ar'])
    if (logResult.success && logResult.output) {
      const [hash, message, author, date] = logResult.output.trim().split('|')
      setLastCommit({ hash, message, author, date })
    }
  }, [getRootPath, runGitCommand])

  useEffect(() => {
    refreshStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshStatus])

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'modified': return { icon: 'M', color: 'var(--yellow, #d97706)' }
      case 'added': return { icon: 'A', color: 'var(--green, #16a34a)' }
      case 'deleted': return { icon: 'D', color: 'var(--red, #dc2626)' }
      case 'renamed': return { icon: 'R', color: '#3B82F6' }
      case 'untracked': return { icon: 'U', color: 'var(--text-muted, #64748b)' }
      default: return { icon: '?', color: 'var(--text-muted, #64748b)' }
    }
  }

  const handleToggleStage = async (file: string, currentlyStaged: boolean) => {
    if (currentlyStaged) {
      await runGitCommand(['reset', 'HEAD', file])
    } else {
      await runGitCommand(['add', file])
    }
    refreshStatus()
  }

  const handleStageAll = async () => {
    await runGitCommand(['add', '-A'])
    refreshStatus()
  }

  const handleUnstageAll = async () => {
    await runGitCommand(['reset', 'HEAD'])
    refreshStatus()
  }

  const handleCommit = async () => {
    const message = commitMessage.trim()
    if (!message) return
    // Commit exactly what is staged. This used to run `add -A` first, which
    // silently swept untracked files (and whatever else sat in the worktree)
    // into the commit — including right after the user deliberately unstaged
    // something in this panel.
    const staged = committableFiles(gitStatus)
    if (!staged.length) {
      showNotification(t('git.nothingStaged'), 'warning')
      return
    }
    setBusy('commit')
    try {
      const result = await runGitCommand(['commit', '-m', message])
      if (result.success) {
        setCommitMessage('')
        setLifeguardFindings([])
        refreshStatus()
        report(t('git.committed'), result)
      } else {
        report(t('git.commitFailed'), result)
      }
    } finally {
      setBusy(null)
    }
  }

  // Lifeguard: pre-commit AI bug check
  const [lifeguardFindings, setLifeguardFindings] = useState<LifeguardFinding[]>([])
  const [lifeguardRunning, setLifeguardRunning] = useState(false)
  const [lifeguardError, setLifeguardError] = useState<string | null>(null)

  const handleLifeguard = async () => {
    const configGroup = useConfigStore.getState().getActiveConfigGroup()
    if (!configGroup || !configGroup.defaultModel) {
      alert(t('git.configureModel'))
      return
    }
    const diffResult = await runGitCommand(['diff', 'HEAD'])
    const diffText = diffResult.success ? diffResult.output : ''
    if (!diffText) {
      setLifeguardFindings([])
      setLifeguardError(t('git.noDiff'))
      return
    }
    setLifeguardRunning(true)
    setLifeguardError(null)
    try {
      const findings = await runLifeguardCheck(diffText, configGroup)
      setLifeguardFindings(findings)
    } catch (e: any) {
      setLifeguardError(e.message || t('git.lifeguardFailed'))
      setLifeguardFindings([])
    } finally {
      setLifeguardRunning(false)
    }
  }

  const handlePush = async () => {
    setBusy('push')
    try {
      // -u so a first push of a new branch actually creates the remote ref;
      // without it `git push` fails on branch-name mismatches and the user had
      // no idea (the error went to console.error).
      const result = await runGitCommand(['push', '-u', 'origin', 'HEAD'])
      report(t('git.push'), result)
      if (result.success) refreshStatus()
    } finally {
      setBusy(null)
    }
  }

  const handlePull = async () => {
    setBusy('pull')
    try {
      const result = await runGitCommand(['pull'])
      report(t('git.pull'), result)
      refreshStatus()
    } finally {
      setBusy(null)
    }
  }

  const handleFetch = async () => {
    setBusy('fetch')
    try {
      const result = await runGitCommand(['fetch', '--all', '--prune'])
      report(t('git.fetch'), result)
      refreshStatus()
    } finally {
      setBusy(null)
    }
  }

  const handleStash = async () => {
    setBusy('stash')
    try {
      const result = await runGitCommand(['stash', 'push', '--include-untracked'])
      report(t('git.stash'), result)
      refreshStatus()
    } finally {
      setBusy(null)
    }
  }

  const handleStashPop = async () => {
    setBusy('stash-pop')
    try {
      const result = await runGitCommand(['stash', 'pop'])
      report(t('git.stashPop'), result)
      refreshStatus()
    } finally {
      setBusy(null)
    }
  }

  const handleCreateBranch = async () => {
    const name = (await askText({ title: t('git.newBranchPrompt') })) ?? ''
    if (!name) return
    if (!/^[a-zA-Z0-9._/-]+$/.test(name)) {
      showNotification(t('git.badBranchName'), 'error')
      return
    }
    setBusy('branch')
    try {
      const result = await runGitCommand(['checkout', '-b', name])
      report(t('git.createBranch'), result)
      refreshStatus()
    } finally {
      setBusy(null)
    }
  }

  /** Porcelain alone can't tell a merge conflict from a rebase or a stash-pop
   *  one, and `merge --abort` errors on the latter two — so try them in order
   *  and report only if every form refused. */
  const handleAbortMerge = async () => {
    setBusy('abort')
    try {
      const merge = await runGitCommand(['merge', '--abort'])
      if (merge.success) report(t('git.abortMerge'), merge)
      else {
        const rebase = await runGitCommand(['rebase', '--abort'])
        report(t('git.abortMerge'), rebase.success ? rebase : merge)
      }
      refreshStatus()
    } finally {
      setBusy(null)
    }
  }

  const handleViewDiff = useCallback(async (file: string, staged: boolean, untracked = false) => {
    // Open the change in the CENTRAL editor area as a Monaco side-by-side diff
    // (VS Code "Open Changes") — left = HEAD/index, right = index/worktree,
    // with per-change revert/stage arrows in both gutters.
    const absPath = resolveFilePath(file)
    const fileName = file.split(/[/\\]/).pop() || file
    const sides = await fetchGitDiffSides(file, staged, untracked)
    openDiff({
      path: absPath,
      fileName,
      original: sides.original,
      modified: sides.modified,
      language: useEditorStore.getState().getLanguageByPath(absPath),
      kind: 'git',
      git: { repoFile: file, staged, untracked, diffText: sides.diffText },
    })
  }, [openDiff, resolveFilePath])

  // Keep the status list in sync when the central diff editor mutates git state
  // (revert/stage a hunk, revert everything, ...).
  useEffect(() => onGitChanged(() => void refreshStatus()), [refreshStatus])

  const handleViewLog = async () => {
    setShowLog(true)
    const result = await runGitCommand(['log', '--oneline', '-20', '--format=%H|%s|%an|%ar'])
    if (result.success && result.output) {
      const commits = result.output.split('\n').filter(Boolean).map((line) => {
        const [hash, message, author, date] = line.split('|')
        return { hash, message, author, date }
      })
      setLog(commits)
    }
  }

  const handleGenerateCommitMessage = async () => {
    const diffResult = await runGitCommand(['diff', '--cached'])
    const diffText = diffResult.success ? diffResult.output : ''

    // Prefer the AI-generated message when a model is configured
    const configGroup = useConfigStore.getState().getActiveConfigGroup()
    if (configGroup && configGroup.defaultModel && (diffText || gitStatus.length)) {
      setGeneratingCommit(true)
      try {
        const diff = diffText || gitStatus.map((s) => `${s.status === 'untracked' ? t('git.newFile') : s.status} ${s.file}`).join('\n')
        const prompt = `请根据以下 git 变更生成一条简洁的提交信息（一行，中文，不要引号，不要前缀 emoji）：\n\n${diff.slice(0, 12000)}`
        const req = {
          model: configGroup.defaultModel,
          messages: [
            { role: 'system' as const, content: '你是一个 git 提交信息生成器，只输出一行提交信息。' },
            { role: 'user' as const, content: prompt },
          ],
          stream: false,
          temperature: 0.3,
          maxTokens: 80,
          topP: 1,
          frequencyPenalty: 0,
          presencePenalty: 0,
        }
        let msg = ''
        for await (const chunk of sendLLMRequest(req, configGroup)) {
          if (chunk.content) msg += chunk.content
          if (chunk.done) break
        }
        const cleaned = msg.trim().split('\n')[0].replace(/^[#\-*`"\s]+/, '').trim()
        if (cleaned) setCommitMessage(cleaned)
      } catch (error: any) {
        console.error('AI 生成提交信息失败:', error.message)
      } finally {
        setGeneratingCommit(false)
      }
      return
    }

    // Fallback: heuristic summary from the diff stat
    const statResult = await runGitCommand(['diff', '--cached', '--stat'])
    if (statResult.success && statResult.output) {
      const lines = statResult.output.split('\n').filter(Boolean)
      const summary = lines[lines.length - 1] || t('git.updateFiles')
      setCommitMessage(summary.trim())
    }
  }

  const conflicts = conflictedFiles(gitStatus)
  const stagedChanges = gitStatus.filter((s) => s.staged && !s.conflict)
  const unstagedChanges = gitStatus.filter((s) => !s.staged && !s.conflict && s.status !== 'untracked')
  const untrackedFiles = gitStatus.filter((s) => s.status === 'untracked')

  return (
    <div className="h-full flex flex-col text-sm">
      {/* Header (Stitch: branch capsule + refresh circle button) */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-1.5 bg-white/70 dark:bg-white/10 border border-glass-border rounded-full px-3 py-1.5 shadow-sm hover:scale-[1.02] transition-transform cursor-pointer">
          <svg className="w-3.5 h-3.5 text-primary shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />
          </svg>
          <span className="text-[11px] font-mono font-medium tracking-wide truncate max-w-[180px]">
            {gitBranch || t('git.title')}
          </span>
        </div>
        <button
          onClick={refreshStatus}
          className="w-8 h-8 flex items-center justify-center rounded-full text-nova-text-muted hover:text-nova-text-primary hover:bg-white/70 dark:hover:bg-white/10 transition-colors"
          title={t('git.refresh')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Commit message input (Stitch: glass block, capsule buttons) */}
      <div className="mx-2 mb-2 flex flex-col gap-1.5 bg-glass-bg rounded-lg p-3 border border-glass-border">
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder={t('git.commitPlaceholder')}
          className="w-full bg-white/60 dark:bg-white/10 border border-glass-border rounded-md px-2.5 py-2 text-xs text-nova-text-primary placeholder:text-nova-text-muted outline-none focus:border-nova-accent focus:ring-1 focus:ring-blue-500/30 resize-none transition-all"
          rows={2}
          style={{ minHeight: 44, lineHeight: 1.5 }}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              handleCommit()
            }
          }}
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleCommit}
            disabled={!commitMessage.trim() || !!busy}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-white rounded-full hover:scale-[1.02] hover:brightness-110 active:scale-[0.98] disabled:opacity-30 shadow-sm border border-transparent transition-all"
            style={{ background: 'linear-gradient(135deg, #0ea5e9, #6366f1, #a855f7)' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            提交
          </button>
          <button
            onClick={handlePush}
            disabled={!!busy}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-nova-text-secondary rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-40"
            title={t('git.pushTitle')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
            推送
          </button>
          <button
            onClick={handlePull}
            disabled={!!busy}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-nova-text-secondary rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-40"
            title={t('git.pullTitle')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
            拉取
          </button>
          <button
            onClick={() => { showLog ? setShowLog(false) : handleViewLog() }}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-nova-text-secondary rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15 hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 8v4l2.5 2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
            </svg>
            日志
          </button>
          <button
            onClick={handleFetch}
            disabled={!!busy}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-nova-text-secondary rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15 active:scale-[0.98] transition-all disabled:opacity-40"
            title={t('git.fetchHint')}
          >
            {t('git.fetch')}
          </button>
          <button
            onClick={handleCreateBranch}
            disabled={!!busy}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-nova-text-secondary rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15 active:scale-[0.98] transition-all disabled:opacity-40"
            title={t('git.createBranchHint')}
          >
            {t('git.createBranch')}
          </button>
          <button
            onClick={handleStash}
            disabled={!!busy}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-nova-text-secondary rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15 active:scale-[0.98] transition-all disabled:opacity-40"
            title={t('git.stashHint')}
          >
            {t('git.stash')}
          </button>
          <button
            onClick={handleStashPop}
            disabled={!!busy}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-nova-text-secondary rounded-full bg-white/70 dark:bg-white/10 border border-glass-border hover:bg-white/90 dark:hover:bg-white/15 active:scale-[0.98] transition-all disabled:opacity-40"
            title={t('git.stashPopHint')}
          >
            {t('git.stashPop')}
          </button>
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={handleGenerateCommitMessage}
            disabled={generatingCommit}
            className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-bold rounded-full border transition-all disabled:opacity-40 hover:scale-[1.01] active:scale-[0.99]"
            style={{ border: '1px solid color-mix(in srgb, var(--accent, #0058bc) 50%, transparent)', background: 'color-mix(in srgb, var(--accent, #0058bc) 5%, transparent)', color: 'var(--accent)' }}
            title={t('git.generateCommitHint')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 8V4M9 4h6M6 9h.01M18 9h.01M6 13h.01M18 13h.01M7 17c1 1 3 1.5 5 1.5s4-.5 5-1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            {generatingCommit ? t('git.generating') : 'AI 生成提交消息'}
          </button>
          <button
            onClick={handleLifeguard}
            disabled={lifeguardRunning}
            className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-bold rounded-full border border-nova-border bg-white/30 dark:bg-white/5 text-nova-text-secondary hover:bg-white/60 dark:hover:bg-white/10 transition-all disabled:opacity-40"
            title={t('git.lifeguardHint')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z" />
              <path d="M12 8v5M12 16.5h.01" />
            </svg>
            {lifeguardRunning ? t('git.lifeguardRunning') : '提交前检查'}
          </button>
        </div>

        {/* Lifeguard findings (Stitch: warning panel) */}
        {lifeguardError && (
          <div className="mx-2 mb-2 px-3 py-2.5 rounded-lg bg-warning-10 border border-warning-30 flex items-center gap-1.5 text-warning font-semibold text-xs backdrop-blur-md">
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z" />
            </svg>
            {lifeguardError}
          </div>
        )}
        {lifeguardFindings.length > 0 && (
          <div className="mx-2 mb-2 rounded-lg bg-warning-10 border border-warning-30 backdrop-blur-md overflow-hidden">
            <div className="px-3 py-2.5 flex items-center gap-1.5 text-warning font-semibold text-xs">
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z" />
              </svg>
              <span>
                {t('git.lifeguardFindings', { count: lifeguardFindings.length })} ·{' '}
                {t('git.errorCount', { count: lifeguardFindings.filter((f) => f.severity === 'error').length })} 错误{' '}
                {t('git.warningCount', { count: lifeguardFindings.filter((f) => f.severity === 'warning').length })} 警告
              </span>
            </div>
            <div className="px-1 pb-1">
              {lifeguardFindings.map((f, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-[11px] text-warning-90 hover:bg-warning-5 rounded px-2 py-1 transition-colors"
                >
                  <span className="font-code truncate max-w-[230px]">
                    {f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : ''} — {f.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Pull requests (gh CLI) — only when the repo has a remote worth asking */}
      <PullRequestSection branch={gitBranch} onRefresh={refreshStatus} />

      {/* Changed files */}
      <div className="flex-1 overflow-y-auto">
        {/* Merge conflicts — listed separately because they are not "staged
            changes": git shows them with both columns set, and a commit with
            them in the index fails. */}
        {conflicts.length > 0 && (
          <div className="mx-1 my-2 rounded-lg bg-warning-10 border border-warning-30 backdrop-blur-md overflow-hidden">
            <div className="px-3 py-2 flex items-center gap-1.5 text-warning font-semibold text-xs">
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z" />
              </svg>
              {t('git.conflictCount', { count: conflicts.length })}
              <button
                onClick={handleAbortMerge}
                disabled={!!busy}
                className="ml-auto text-[10px] font-bold underline disabled:opacity-40"
                title={t('git.abortMergeHint')}
              >
                {t('git.abortMerge')}
              </button>
            </div>
            {conflicts.map((file) => (
              <button
                key={file}
                onClick={() => handleViewDiff(file, true)}
                className="block w-full text-left px-3 py-1 text-[11px] font-code text-warning-90 hover:bg-warning-5 truncate"
              >
                {file}
              </button>
            ))}
          </div>
        )}
        {isLoading && (
          <div className="p-4 text-center text-nova-text-muted text-xs">
            {t('git.loading')}
          </div>
        )}

        {!isLoading && gitStatus.length === 0 && (
          <div className="p-4 text-center text-nova-text-muted text-xs">
            {gitBranch ? t('git.noChanges') : t('git.noRepo')}
          </div>
        )}

        {/* Staged changes */}
        {stagedChanges.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[10px] font-bold tracking-widest uppercase text-nova-text-muted flex items-center gap-1.5">
                {t('git.staged')}
                <span className="bg-white/70 dark:bg-white/10 px-1.5 rounded-full text-[11px]">{stagedChanges.length}</span>
              </span>
              <button
                onClick={handleUnstageAll}
                className="text-[10px] text-nova-text-muted hover:text-nova-accent"
                title={t('git.unstageAll')}
              >
                {t('git.unstageAllShort')}
              </button>
            </div>
            <div className="flex flex-col gap-0.5">
              {stagedChanges.map((item) => {
                const { icon, color } = getStatusIcon(item.status)
                const fileName = item.file.split(/[/\\]/).pop() || item.file
                return (
                  <div
                    key={item.file}
                    className="group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors mx-1 hover:bg-white/70 dark:hover:bg-white/10"
                    onClick={() => handleViewDiff(item.file, true)}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleStage(item.file, true) }}
                      className="text-nova-text-muted hover:text-nova-text-primary rounded p-0.5 transition-colors"
                      title={t('git.unstage')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M5 12h14" />
                      </svg>
                    </button>
                    <span className="font-mono text-[12px] font-medium w-4 text-center" style={{ color }}>
                      {icon}
                    </span>
                    <span
                      className="font-mono text-[12px] text-nova-text-primary truncate flex-1 hover:text-nova-accent transition-colors"
                      onClick={(e) => { e.stopPropagation(); openFile(resolveFilePath(item.file)) }}
                    >
                      {fileName}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleViewDiff(item.file, true) }}
                      className="hidden group-hover:block text-[10px] text-primary font-medium tracking-wide"
                      title={t('git.viewDiff')}
                    >
                      {t('git.viewDiff')}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Unstaged changes */}
        {unstagedChanges.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[10px] font-bold tracking-widest uppercase text-nova-text-muted flex items-center gap-1.5">
                {t('git.changes')}
                <span className="bg-white/70 dark:bg-white/10 px-1.5 rounded-full text-[11px]">{unstagedChanges.length}</span>
              </span>
              <button
                onClick={handleStageAll}
                className="text-[10px] text-nova-text-muted hover:text-nova-accent"
                title={t('git.stageAll')}
              >
                {t('git.stageAllShort')}
              </button>
            </div>
            <div className="flex flex-col gap-0.5">
              {unstagedChanges.map((item) => {
                const { icon, color } = getStatusIcon(item.status)
                const fileName = item.file.split(/[/\\]/).pop() || item.file
                return (
                  <div
                    key={item.file}
                    className="group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors mx-1 hover:bg-white/70 dark:hover:bg-white/10"
                    onClick={() => handleViewDiff(item.file, false)}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleStage(item.file, false) }}
                      className="text-nova-text-muted hover:text-nova-accent rounded p-0.5 transition-colors"
                      title={t('git.stage')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                    <span className="font-mono text-[12px] font-medium w-4 text-center" style={{ color }}>
                      {icon}
                    </span>
                    <span
                      className="font-mono text-[12px] text-nova-text-primary truncate flex-1 hover:text-nova-accent transition-colors"
                      onClick={(e) => { e.stopPropagation(); openFile(resolveFilePath(item.file)) }}
                    >
                      {fileName}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleViewDiff(item.file, false) }}
                      className="hidden group-hover:block text-[10px] text-primary font-medium tracking-wide"
                      title={t('git.viewDiff')}
                    >
                      {t('git.viewDiff')}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Untracked files */}
        {untrackedFiles.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[10px] font-bold tracking-widest uppercase text-nova-text-muted flex items-center gap-1.5">
                {t('git.untracked')}
                <span className="bg-white/70 dark:bg-white/10 px-1.5 rounded-full text-[11px]">{untrackedFiles.length}</span>
              </span>
            </div>
            <div className="flex flex-col gap-0.5 opacity-70 hover:opacity-100 transition-opacity">
              {untrackedFiles.map((item) => {
                const fileName = item.file.split(/[/\\]/).pop() || item.file
                return (
                  <div
                    key={item.file}
                    className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/70 dark:hover:bg-white/10 cursor-pointer transition-colors mx-1"
                    onClick={() => handleViewDiff(item.file, false, true)}
                  >
                    <span className="w-[18px]" />
                    <span className="font-mono text-[12px] font-medium text-nova-text-muted w-4 text-center">U</span>
                    <span
                      className="font-mono text-[12px] text-nova-text-muted truncate flex-1 hover:text-nova-accent transition-colors"
                      onClick={() => openFile(resolveFilePath(item.file))}
                    >
                      {fileName}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleStage(item.file, false) }}
                      className="hidden group-hover:block text-[10px] text-primary font-medium tracking-wide"
                      title={t('git.track')}
                    >
                      跟踪
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Recent commits (Stitch: footer section with history list) */}
        {lastCommit && (
          <div className="border-t border-glass-border mt-3 pt-3">
            <button
              onClick={() => { showLog ? setShowLog(false) : handleViewLog() }}
              className="text-[10px] font-bold tracking-widest uppercase text-nova-text-muted mb-2 px-1 flex items-center gap-1 hover:text-nova-text-primary transition-colors w-full text-left"
              title={t('git.recentCommits')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 8v4l2.5 2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
              </svg>
              近期提交
              <span className={`ml-auto transition-transform ${showLog ? 'rotate-180' : ''}`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </span>
            </button>
            {!showLog && (
              <div className="flex flex-col gap-0.5">
                <div
                  className="flex flex-col gap-0.5 p-2 rounded-md hover:bg-white/70 dark:hover:bg-white/10 transition-colors cursor-pointer"
                  onClick={() => handleViewLog()}
                >
                  <span className="font-mono text-[11px] text-nova-text-primary group-hover:text-primary truncate">
                    {lastCommit.message}
                  </span>
                  <div className="flex items-center gap-1.5 text-[10px] text-nova-text-muted">
                    <span className="font-mono bg-white/70 dark:bg-white/10 px-1 rounded">{lastCommit.hash.slice(0, 7)}</span>
                    <span>·</span>
                    <span className="truncate">{lastCommit.author}</span>
                    <span>·</span>
                    <span>{lastCommit.date}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Git Log */}
      {showLog && (
        <div className="border-t border-nova-border max-h-[200px] overflow-y-auto overflow-x-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-nova-text-muted bg-nova-bg">
            <span>{t('git.recentCommits')}</span>
            <button onClick={() => setShowLog(false)} className="hover:text-nova-text-primary">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {log.length === 0 ? (
            <div className="p-3 text-center text-nova-text-muted text-xs">
              {t('git.noCommits')}
            </div>
          ) : (
            log.map((commit) => (
              <div key={commit.hash} className="px-3 py-1.5 hover:bg-nova-hover">
                <div className="text-xs text-nova-text-primary truncate">{commit.message}</div>
                <div className="text-[10px] text-nova-text-muted truncate">
                  {commit.hash.slice(0, 7)} · {commit.author} · {commit.date}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
