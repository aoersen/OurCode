import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore, type ContextMenuItem } from '@/stores/uiStore'
import { useConfigStore } from '@/stores/configStore'
import { sendLLMRequest } from '@/services/llm/LLMClient'
import { runLifeguardCheck, LifeguardFinding } from '@/services/lifeguard'
import { fetchGitDiffSides, onGitChanged, runGitCommand as gitRun } from '@/services/git'
import {
  parseGitStatusPorcelain,
  committableFiles,
  conflictedFiles,
  type GitFileStatus,
  type GitStatusEntry,
} from '@/utils/gitStatus'
import PullRequestSection from './PullRequestSection'
import { useI18n } from '@/i18n/useI18n'
import { askText } from '@/components/Common/PromptDialog'

interface GitCommit {
  hash: string
  message: string
  author: string
  date: string
}

interface SyncState {
  hasUpstream: boolean
  ahead: number
  behind: number
}

/** Status letter + tint. Everything is a semantic token so dark mode follows. */
const STATUS_STYLE: Record<GitFileStatus, { letter: string; chip: string }> = {
  modified: { letter: 'M', chip: 'border-warning-30 bg-warning-10 text-warning-text' },
  added: { letter: 'A', chip: 'border-success-20 bg-success-10 text-success-text' },
  deleted: { letter: 'D', chip: 'border-error-20 bg-error-10 text-error-text' },
  renamed: { letter: 'R', chip: 'border-accent-30 bg-accent-10 text-accent-text' },
  untracked: { letter: 'U', chip: 'border-nova-border bg-nova-hover text-nova-text-muted' },
}

function splitPath(file: string): { name: string; dir: string } {
  const parts = file.split(/[/\\]/)
  const name = parts.pop() || file
  return { name, dir: parts.join('/') }
}

/* ── Icons ────────────────────────────────────────────────────────────────
   Small inline strokes (1.8px) so the panel keeps one icon language without
   pulling in the (very small) Material subset. */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

function IconBranch({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M6 8.5v7M18 8.5v1a4 4 0 0 1-4 4H9" />
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

function IconMore({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  )
}

function IconArrowUp({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
}

function IconArrowDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  )
}

function IconHistory({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M12 8v4l2.5 2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
    </svg>
  )
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function IconPlus({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function IconMinus({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M5 12h14" />
    </svg>
  )
}

function IconChevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

function IconSearch({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  )
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function IconSparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5z" />
      <path d="M18.5 16.5 19.2 18l1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7.7-1.5z" />
    </svg>
  )
}

function IconShield({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.6 7.5 9 4.3-1.4 7.5-4.4 7.5-9V6L12 3z" />
      <path d="M12 8v4.5M12 15.5h.01" />
    </svg>
  )
}

function IconFile({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

function IconCommit({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M3 12h5.5M15.5 12H21" />
    </svg>
  )
}

function IconWarning({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      <path d="M12 3.5 21 20H3l9-16.5z" />
      <path d="M12 9v5M12 17h.01" />
    </svg>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-nova-text-muted transition-colors hover:bg-nova-hover hover:text-nova-text-primary disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function ToolButton({
  label,
  title,
  onClick,
  disabled,
  className = '',
  children,
}: {
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1 rounded-lg border border-nova-border bg-nova-surface px-2 py-1 text-[10.5px] font-medium text-nova-text-secondary transition-colors hover:bg-nova-hover hover:text-nova-text-primary disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}

function ChangeGroup({
  title,
  count,
  action,
  collapsed,
  onToggle,
  children,
}: {
  title: string
  count: number
  action?: ReactNode
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="mt-1" aria-label={title}>
      <div className="flex items-center gap-1 px-2.5 py-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 items-center gap-1 rounded text-nova-text-muted transition-colors hover:text-nova-text-primary"
        >
          <IconChevron className={`h-3 w-3 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          <span className="text-[10.5px] font-semibold text-nova-text-secondary">{title}</span>
          <span className="rounded-full bg-nova-hover px-1.5 text-[10px] font-semibold tabular-nums text-nova-text-muted">
            {count}
          </span>
        </button>
        <div className="ml-auto flex items-center">{action}</div>
      </div>
      {!collapsed && <div className="flex flex-col">{children}</div>}
    </section>
  )
}

function FileRow({
  item,
  staged,
  busy,
  onToggleStage,
  onOpenDiff,
  onOpenFile,
  stageLabel,
  unstageLabel,
  openLabel,
  diffLabel,
}: {
  item: GitStatusEntry
  staged: boolean
  busy: boolean
  onToggleStage: () => void
  onOpenDiff: () => void
  onOpenFile: () => void
  stageLabel: string
  unstageLabel: string
  openLabel: string
  diffLabel: string
}) {
  const { name, dir } = splitPath(item.file)
  const status = STATUS_STYLE[item.status]
  return (
    <div
      title={item.file}
      onClick={onOpenDiff}
      className="group mx-1.5 flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-nova-hover focus-within:bg-nova-hover"
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border font-mono text-[9px] font-bold leading-none ${status.chip}`}
      >
        {status.letter}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onOpenDiff()
          }}
          aria-label={`${diffLabel}: ${item.file}`}
          className="min-w-0 truncate text-left font-mono text-[11.5px] font-medium text-nova-text-primary"
        >
          {name}
        </button>
        {dir && <span className="max-w-[48%] shrink-0 truncate font-mono text-[9.5px] text-nova-text-muted">{dir}</span>}
      </span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
        <IconButton
          label={staged ? unstageLabel : stageLabel}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            onToggleStage()
          }}
        >
          {staged ? <IconMinus className="h-3.5 w-3.5" /> : <IconPlus className="h-3.5 w-3.5" />}
        </IconButton>
        <IconButton
          label={openLabel}
          onClick={(event) => {
            event.stopPropagation()
            onOpenFile()
          }}
        >
          <IconFile className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  )
}

export default function GitPanel() {
  const [gitStatus, setGitStatus] = useState<GitStatusEntry[]>([])
  const [gitBranch, setGitBranch] = useState('')
  const [sync, setSync] = useState<SyncState | null>(null)
  const [hasRepo, setHasRepo] = useState(true)
  const [commitMessage, setCommitMessage] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [log, setLog] = useState<GitCommit[]>([])
  const [lastCommit, setLastCommit] = useState<GitCommit | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [generatingCommit, setGeneratingCommit] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const t = useI18n()
  const showNotification = useUIStore((s) => s.showNotification)
  const showContextMenu = useUIStore((s) => s.showContextMenu)
  const openFile = useEditorStore((s) => s.openFile)
  const openDiff = useEditorStore((s) => s.openDiff)

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

  const getRootPath = useCallback(() => useUIStore.getState().rootPath, [])

  const resolveFilePath = useCallback(
    (file: string): string => {
      const rootPath = getRootPath()
      if (!rootPath) return file
      const sep = rootPath.includes('/') ? '/' : '\\'
      return rootPath.replace(/[/\\]$/, '') + sep + file
    },
    [getRootPath],
  )

  const runGitCommand = useCallback((args: string[], input?: string) => gitRun(args, input), [])

  const refreshStatus = useCallback(async () => {
    const rootPath = getRootPath()
    if (!rootPath) {
      setGitStatus([])
      setGitBranch('')
      setSync(null)
      setHasRepo(false)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    try {
      const [branchResult, statusResult] = await Promise.all([
        runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']),
        runGitCommand(['status', '--porcelain=v1']),
      ])
      const repoOk = statusResult.success
      setHasRepo(repoOk)
      setGitBranch(branchResult.success ? branchResult.output.trim() : '')
      setGitStatus(repoOk ? parseGitStatusPorcelain(statusResult.output) : [])

      if (repoOk) {
        // Upstream + divergence drive the ↑/↓ badges. A fresh branch has no
        // upstream: git exits non-zero here, which is a normal state.
        const upstream = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
        if (upstream.success) {
          const counts = await runGitCommand(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
          const parts = counts.success ? counts.output.trim().split(/\s+/).map((n) => Number(n) || 0) : []
          setSync({ hasUpstream: true, ahead: parts[1] || 0, behind: parts[0] || 0 })
        } else {
          setSync({ hasUpstream: false, ahead: 0, behind: 0 })
        }
      } else {
        setSync(null)
      }
    } catch (error) {
      console.error('获取 Git 状态失败:', error)
      setGitStatus([])
      setGitBranch('')
      setSync(null)
      setHasRepo(false)
    } finally {
      setIsLoading(false)
    }

    const logResult = await runGitCommand(['log', '-1', '--format=%H|%s|%an|%ar'])
    if (logResult.success && logResult.output) {
      const [hash, message, author, date] = logResult.output.trim().split('|')
      setLastCommit({ hash, message, author, date })
    } else {
      setLastCommit(null)
    }
  }, [getRootPath, runGitCommand])

  useEffect(() => {
    refreshStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshStatus])

  useEffect(() => onGitChanged(() => void refreshStatus()), [refreshStatus])

  const stagedChanges = useMemo(() => gitStatus.filter((s) => s.staged && !s.conflict), [gitStatus])
  const unstagedChanges = useMemo(
    () => gitStatus.filter((s) => !s.staged && !s.conflict && s.status !== 'untracked'),
    [gitStatus],
  )
  const untrackedFiles = useMemo(() => gitStatus.filter((s) => s.status === 'untracked'), [gitStatus])
  const conflicts = useMemo(() => conflictedFiles(gitStatus), [gitStatus])
  const totalFiles = useMemo(() => new Set(gitStatus.map((entry) => entry.file)).size, [gitStatus])
  const dirCount = useMemo(() => {
    const dirs = new Set<string>()
    for (const entry of gitStatus) {
      const { dir } = splitPath(entry.file)
      if (dir) dirs.add(dir)
    }
    return dirs.size
  }, [gitStatus])

  const query = filter.trim().toLowerCase()
  const matches = useCallback(
    (entry: GitStatusEntry) => !query || entry.file.toLowerCase().includes(query),
    [query],
  )
  const stagedView = stagedChanges.filter(matches)
  const unstagedView = unstagedChanges.filter(matches)
  const untrackedView = untrackedFiles.filter(matches)
  const filteredEmpty = query.length > 0 && stagedView.length + unstagedView.length + untrackedView.length === 0

  const toggleGroup = (id: string) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }))

  const handleToggleStage = async (file: string, currentlyStaged: boolean) => {
    if (busy) return
    if (currentlyStaged) await runGitCommand(['reset', 'HEAD', file])
    else await runGitCommand(['add', file])
    refreshStatus()
  }

  const handleStageAll = async () => {
    if (busy) return
    await runGitCommand(['add', '-A'])
    refreshStatus()
  }

  const handleUnstageAll = async () => {
    if (busy) return
    await runGitCommand(['reset', 'HEAD'])
    refreshStatus()
  }

  const handleCommit = async () => {
    const message = commitMessage.trim()
    if (!message) return
    // Commit exactly what is staged — no implicit `add -A` (that used to sweep
    // untracked files into the commit after the user unstaged them).
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
      // -u so a first push of a new branch actually creates the remote ref.
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
   *  one, and `merge --abort` errors on the latter two — try them in order. */
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

  const handleViewDiff = useCallback(
    async (file: string, staged: boolean, untracked = false) => {
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
    },
    [openDiff, resolveFilePath],
  )

  const handleViewLog = async () => {
    if (showLog) {
      setShowLog(false)
      return
    }
    setShowLog(true)
    const result = await runGitCommand(['log', '--oneline', '-20', '--format=%H|%s|%an|%ar'])
    if (result.success && result.output) {
      const commits = result.output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, message, author, date] = line.split('|')
          return { hash, message, author, date }
        })
      setLog(commits)
    }
  }

  const handleGenerateCommitMessage = async () => {
    const diffResult = await runGitCommand(['diff', '--cached'])
    const diffText = diffResult.success ? diffResult.output : ''

    const configGroup = useConfigStore.getState().getActiveConfigGroup()
    if (configGroup && configGroup.defaultModel && (diffText || gitStatus.length)) {
      setGeneratingCommit(true)
      try {
        const diff =
          diffText ||
          gitStatus.map((s) => `${s.status === 'untracked' ? t('git.newFile') : s.status} ${s.file}`).join('\n')
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

  const openMoreMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const items: ContextMenuItem[] = [
      { label: t('git.fetch'), action: () => void handleFetch(), disabled: !!busy || !hasRepo },
      { label: t('git.createBranch'), action: () => void handleCreateBranch(), disabled: !!busy || !hasRepo },
      { label: t('git.stash'), action: () => void handleStash(), disabled: !!busy || !gitStatus.length },
      { label: t('git.stashPop'), action: () => void handleStashPop(), disabled: !!busy },
      ...(conflicts.length
        ? [{ label: t('git.abortMerge'), action: () => void handleAbortMerge(), disabled: !!busy }]
        : []),
      { separator: true, label: '' },
      { label: t('git.refresh'), action: () => void refreshStatus() },
    ]
    showContextMenu(rect.right - 8, rect.bottom + 4, items)
  }

  const stagedCount = stagedChanges.length
  const canCommit = hasRepo && stagedCount > 0 && !!commitMessage.trim() && !busy
  const commitTitle = stagedCount === 0 ? t('git.nothingStaged') : t('git.commit')

  return (
    <div className="flex h-full min-w-0 flex-col text-sm">
      {/* Branch + sync */}
      <section
        aria-label={t('git.title')}
        className="mx-2 mt-2 shrink-0 overflow-hidden rounded-xl border border-nova-border bg-nova-card shadow-[var(--shadow-sm)]"
      >
        <div className="flex items-center gap-1.5 px-3 py-2">
          <IconBranch className="h-3.5 w-3.5 shrink-0 text-nova-accent" />
          <span
            className="min-w-0 truncate font-mono text-[11.5px] font-semibold text-nova-text-primary"
            title={gitBranch || undefined}
          >
            {gitBranch || (hasRepo ? '—' : t('git.noRepo'))}
          </span>
          {sync && sync.ahead > 0 && (
            <span
              className="shrink-0 rounded-full border border-accent-20 bg-accent-10 px-1.5 py-px font-mono text-[9.5px] font-semibold text-accent-text"
              title={t('git.prAhead', { count: sync.ahead })}
            >
              ↑{sync.ahead}
            </span>
          )}
          {sync && sync.behind > 0 && (
            <span
              className="shrink-0 rounded-full border border-nova-border bg-nova-hover px-1.5 py-px font-mono text-[9.5px] font-semibold text-nova-text-muted"
              title={t('git.pullTitle')}
            >
              ↓{sync.behind}
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton label={t('git.refresh')} onClick={() => void refreshStatus()} disabled={isLoading}>
              <IconRefresh className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </IconButton>
            <IconButton label={t('git.moreActions')} onClick={openMoreMenu} disabled={!hasRepo}>
              <IconMore className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>

        <div className="grid grid-cols-3 border-t border-nova-border">
          <SyncButton
            icon={<IconArrowUp className="h-3.5 w-3.5" />}
            label={t('git.push')}
            badge={sync?.ahead || 0}
            title={t('git.pushTitle')}
            onClick={() => void handlePush()}
            disabled={!hasRepo || !!busy}
          />
          <SyncButton
            icon={<IconArrowDown className="h-3.5 w-3.5" />}
            label={t('git.pull')}
            badge={sync?.behind || 0}
            title={t('git.pullTitle')}
            onClick={() => void handlePull()}
            disabled={!hasRepo || !!busy}
            className="border-l border-nova-border"
          />
          <button
            type="button"
            onClick={() => void handleViewLog()}
            className="flex items-center justify-center gap-1 border-l border-nova-border px-1 py-1.5 text-[10.5px] font-medium text-nova-text-secondary transition-colors hover:bg-nova-hover hover:text-nova-text-primary"
          >
            <IconHistory className="h-3.5 w-3.5" />
            <span>{t('git.log')}</span>
          </button>
        </div>
      </section>

      {/* Commit composer */}
      <section className="mx-2 mt-2 shrink-0 rounded-xl border border-nova-border bg-nova-card shadow-[var(--shadow-sm)] transition-colors focus-within:border-accent-40">
        <div className="flex items-center justify-between px-3 pt-2">
          <label
            htmlFor="git-commit-message"
            className="text-[10px] font-bold uppercase tracking-[0.1em] text-nova-text-muted"
          >
            {t('git.commitMessage')}
          </label>
          <span
            className={`text-[10px] tabular-nums ${stagedCount ? 'text-success-text' : 'text-nova-text-muted'}`}
          >
            {stagedCount ? t('git.filesToCommit', { count: stagedCount }) : t('git.noneStaged')}
          </span>
        </div>
        <textarea
          id="git-commit-message"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder={t('git.commitHint')}
          disabled={!hasRepo}
          rows={3}
          className="mt-1 block max-h-28 w-full resize-none border-0 bg-transparent px-3 py-1 text-xs leading-relaxed text-nova-text-primary outline-none placeholder:text-nova-text-muted/70 disabled:opacity-50"
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') handleCommit()
          }}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          {/* Commit first in the DOM (tests and tab order), painted right via order. */}
          <button
            type="button"
            onClick={() => void handleCommit()}
            disabled={!canCommit}
            title={commitTitle}
            className="order-3 ml-auto inline-flex items-center gap-1 rounded-lg bg-nova-accent px-2.5 py-1 text-[11px] font-semibold text-nova-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconCheck className="h-3.5 w-3.5" />
            <span>{t('git.commit')}</span>
          </button>
          <ToolButton
            className="order-1"
            label={generatingCommit ? t('git.generatingShort') : t('git.generateShort')}
            title={t('git.generateCommitHint')}
            onClick={() => void handleGenerateCommitMessage()}
            disabled={generatingCommit || !hasRepo || !gitStatus.length}
          >
            <IconSparkle className="h-3.5 w-3.5 text-nova-accent" />
          </ToolButton>
          <ToolButton
            className="order-2"
            label={lifeguardRunning ? t('git.lifeguardChecking') : t('git.lifeguard')}
            title={t('git.lifeguardHint')}
            onClick={() => void handleLifeguard()}
            disabled={lifeguardRunning || !hasRepo}
          >
            <IconShield className="h-3.5 w-3.5 text-nova-text-muted" />
          </ToolButton>
        </div>
      </section>

      {/* Lifeguard findings */}
      {lifeguardError && (
        <div className="mx-2 mt-1.5 flex items-start gap-1.5 rounded-xl border border-warning-30 bg-warning-10 px-3 py-2 text-[10.5px] font-medium text-warning-text">
          <IconWarning className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{lifeguardError}</span>
          <button type="button" onClick={() => setLifeguardError(null)} title={t('common.close')} className="shrink-0">
            <IconClose className="h-3 w-3" />
          </button>
        </div>
      )}
      {lifeguardFindings.length > 0 && (
        <div className="mx-2 mt-1.5 overflow-hidden rounded-xl border border-warning-30 bg-warning-10">
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10.5px] font-semibold text-warning-text">
            <IconWarning className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t('git.lifeguardFindings', { count: lifeguardFindings.length })} ·{' '}
              {t('git.errorCount', { count: lifeguardFindings.filter((f) => f.severity === 'error').length })} ·{' '}
              {t('git.warningCount', { count: lifeguardFindings.filter((f) => f.severity === 'warning').length })}
            </span>
            <button
              type="button"
              onClick={() => setLifeguardFindings([])}
              title={t('common.close')}
              className="shrink-0"
            >
              <IconClose className="h-3 w-3" />
            </button>
          </div>
          <div className="px-1 pb-1">
            {lifeguardFindings.map((f, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded px-2 py-1 text-[10.5px] text-warning-text transition-colors hover:bg-warning-5"
              >
                <span className="max-w-full truncate font-mono">
                  {f.file ? `${f.file}${f.line ? `:${f.line}` : ''} — ` : ''}
                  {f.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pull request */}
      <PullRequestSection branch={gitBranch} onRefresh={refreshStatus} />

      {/* Working tree changes */}
      <section className="mx-2 mt-2 flex min-h-[140px] flex-1 flex-col overflow-hidden rounded-xl border border-nova-border bg-nova-card shadow-[var(--shadow-sm)]">
        <div className="flex items-center justify-between px-3 pb-1.5 pt-2">
          <div className="flex items-center gap-1.5">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.1em] text-nova-text-muted">
              {t('git.changes')}
            </h2>
            <span className="rounded-full bg-nova-hover px-1.5 text-[10px] font-semibold tabular-nums text-nova-text-muted">
              {totalFiles}
            </span>
          </div>
          {unstagedChanges.length + untrackedFiles.length > 0 && (
            <button
              type="button"
              onClick={() => void handleStageAll()}
              disabled={!!busy}
              className="text-[10px] font-medium text-nova-text-muted transition-colors hover:text-nova-accent disabled:opacity-40"
            >
              {t('git.stageAllShort')}
            </button>
          )}
        </div>

        {gitStatus.length > 5 && (
          <div className="px-2.5 pb-1.5">
            <div className="flex items-center gap-1.5 rounded-lg border border-nova-border bg-nova-surface px-2 py-1 focus-within:border-nova-accent">
              <IconSearch className="h-3 w-3 shrink-0 text-nova-text-muted" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('git.filterPlaceholder')}
                className="w-full bg-transparent text-[10.5px] text-nova-text-primary outline-none placeholder:text-nova-text-muted"
              />
              {filter && (
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  title={t('git.clearFilter')}
                  className="shrink-0 text-nova-text-muted hover:text-nova-text-primary"
                >
                  <IconClose className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-1">
          {conflicts.length > 0 && (
            <div className="mx-2 mt-1 overflow-hidden rounded-lg border border-warning-30 bg-warning-10">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10.5px] font-semibold text-warning-text">
                <IconWarning className="h-3.5 w-3.5 shrink-0" />
                <span>{t('git.conflictCount', { count: conflicts.length })}</span>
                <button
                  type="button"
                  onClick={() => void handleAbortMerge()}
                  disabled={!!busy}
                  className="ml-auto text-[10px] underline disabled:opacity-40"
                  title={t('git.abortMergeHint')}
                >
                  {t('git.abortMerge')}
                </button>
              </div>
              {conflicts.map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => void handleViewDiff(file, true)}
                  className="block w-full truncate px-2.5 py-1 text-left font-mono text-[10.5px] text-warning-text hover:bg-warning-5"
                >
                  {file}
                </button>
              ))}
            </div>
          )}

          {isLoading && gitStatus.length === 0 && (
            <div className="flex flex-col gap-1 px-2.5 py-2" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-pulse rounded bg-nova-hover" />
                  <div
                    className="h-3 animate-pulse rounded bg-nova-hover"
                    style={{ width: `${55 + ((i * 13) % 30)}%` }}
                  />
                </div>
              ))}
            </div>
          )}

          {!isLoading && hasRepo && gitStatus.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full border border-nova-border text-success-text">
                <IconCheck className="h-4 w-4" />
              </span>
              <p className="text-[11px] text-nova-text-muted">{t('git.noChanges')}</p>
            </div>
          )}

          {!isLoading && !hasRepo && (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full border border-nova-border text-nova-text-muted">
                <IconBranch className="h-4 w-4" />
              </span>
              <p className="text-[11px] text-nova-text-muted">{t('git.noRepo')}</p>
            </div>
          )}

          {!isLoading && filteredEmpty && (
            <div className="px-4 py-6 text-center text-[11px] text-nova-text-muted">{t('git.noMatch')}</div>
          )}

          {stagedView.length > 0 && (
            <ChangeGroup
              title={t('git.staged')}
              count={stagedView.length}
              collapsed={!!collapsed.staged}
              onToggle={() => toggleGroup('staged')}
              action={
                <button
                  type="button"
                  onClick={() => void handleUnstageAll()}
                  disabled={!!busy}
                  title={t('git.unstageAll')}
                  className="text-[10px] font-medium text-nova-text-muted transition-colors hover:text-nova-accent disabled:opacity-40"
                >
                  {t('git.unstageAllShort')}
                </button>
              }
            >
              {stagedView.map((item) => (
                <FileRow
                  key={`staged-${item.file}`}
                  item={item}
                  staged
                  busy={!!busy}
                  onToggleStage={() => void handleToggleStage(item.file, true)}
                  onOpenDiff={() => void handleViewDiff(item.file, true)}
                  onOpenFile={() => openFile(resolveFilePath(item.file))}
                  stageLabel={t('git.stage')}
                  unstageLabel={t('git.unstage')}
                  openLabel={t('git.openFile')}
                  diffLabel={t('git.viewDiff')}
                />
              ))}
            </ChangeGroup>
          )}

          {unstagedView.length > 0 && (
            <ChangeGroup
              title={t('git.changes')}
              count={unstagedView.length}
              collapsed={!!collapsed.changed}
              onToggle={() => toggleGroup('changed')}
            >
              {unstagedView.map((item) => (
                <FileRow
                  key={`changed-${item.file}`}
                  item={item}
                  staged={false}
                  busy={!!busy}
                  onToggleStage={() => void handleToggleStage(item.file, false)}
                  onOpenDiff={() => void handleViewDiff(item.file, false)}
                  onOpenFile={() => openFile(resolveFilePath(item.file))}
                  stageLabel={t('git.stage')}
                  unstageLabel={t('git.unstage')}
                  openLabel={t('git.openFile')}
                  diffLabel={t('git.viewDiff')}
                />
              ))}
            </ChangeGroup>
          )}

          {untrackedView.length > 0 && (
            <ChangeGroup
              title={t('git.untracked')}
              count={untrackedView.length}
              collapsed={!!collapsed.untracked}
              onToggle={() => toggleGroup('untracked')}
            >
              {untrackedView.map((item) => (
                <FileRow
                  key={`untracked-${item.file}`}
                  item={item}
                  staged={false}
                  busy={!!busy}
                  onToggleStage={() => void handleToggleStage(item.file, false)}
                  onOpenDiff={() => void handleViewDiff(item.file, false, true)}
                  onOpenFile={() => openFile(resolveFilePath(item.file))}
                  stageLabel={t('git.track')}
                  unstageLabel={t('git.unstage')}
                  openLabel={t('git.openFile')}
                  diffLabel={t('git.viewDiff')}
                />
              ))}
            </ChangeGroup>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-nova-border px-3 py-1.5 text-[10px] text-nova-text-muted">
          <span>{t('git.summary')}</span>
          <span className="tabular-nums">
            {t('git.fileCount', { count: totalFiles })}
            {dirCount > 0 ? ` · ${t('git.dirCount', { count: dirCount })}` : ''}
          </span>
        </div>
      </section>

      {/* Git log drawer */}
      {showLog && (
        <div className="mx-2 mt-2 max-h-[220px] shrink-0 overflow-y-auto rounded-xl border border-nova-border bg-nova-card shadow-[var(--shadow-sm)]">
          <div className="sticky top-0 flex items-center justify-between border-b border-nova-border bg-nova-surface px-3 py-1.5 text-[10px] text-nova-text-muted">
            <span>{t('git.recentCommits')}</span>
            <button type="button" onClick={() => setShowLog(false)} title={t('common.close')}>
              <IconClose className="h-3 w-3" />
            </button>
          </div>
          {log.length === 0 ? (
            <div className="px-3 py-3 text-center text-[10.5px] text-nova-text-muted">{t('git.noCommits')}</div>
          ) : (
            log.map((commit) => (
              <div key={commit.hash} className="px-3 py-1.5 transition-colors hover:bg-nova-hover">
                <div className="truncate text-[11px] text-nova-text-primary">{commit.message}</div>
                <div className="truncate font-mono text-[9.5px] text-nova-text-muted">
                  {commit.hash.slice(0, 7)} · {commit.author} · {commit.date}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Recent commit */}
      <button
        type="button"
        onClick={() => void handleViewLog()}
        className="mx-2 my-2 flex shrink-0 items-center gap-2 rounded-xl border border-nova-border bg-nova-card px-2.5 py-1.5 text-left shadow-[var(--shadow-sm)] transition-colors hover:bg-nova-hover"
        title={t('git.recentCommits')}
      >
        <IconCommit className="h-3.5 w-3.5 shrink-0 text-nova-text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] text-nova-text-primary">
            {lastCommit?.message || t('git.noCommits')}
          </span>
          <span className="block truncate font-mono text-[9.5px] text-nova-text-muted">
            {lastCommit ? `${lastCommit.hash.slice(0, 7)} · ${lastCommit.author} · ${lastCommit.date}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-[10px] text-nova-text-muted">{t('git.log')} ›</span>
      </button>
    </div>
  )
}

function SyncButton({
  icon,
  label,
  badge,
  title,
  onClick,
  disabled,
  className = '',
}: {
  icon: ReactNode
  label: string
  badge: number
  title: string
  onClick: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center justify-center gap-1 px-1 py-1.5 text-[10.5px] font-medium text-nova-text-secondary transition-colors hover:bg-nova-hover hover:text-nova-text-primary disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {icon}
      <span>{label}</span>
      {badge > 0 && (
        <span className="rounded-full bg-accent-10 px-1 text-[9px] font-semibold tabular-nums text-accent-text">
          {badge}
        </span>
      )}
    </button>
  )
}
