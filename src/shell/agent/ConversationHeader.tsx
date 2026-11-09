import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'

function baseName(path?: string | null): string {
  if (!path) return '未打开项目'
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

/**
 * 对话顶栏：仓库/项目 · 会话标题 | 运行状态 · 产物面板开关 · 更多。
 * 48px，无描边，靠留白与顶栏同色区分（设计稿：不出现品牌块）。
 */
export default function ConversationHeader() {
  const session = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null,
  )
  const isRunning = useChatStore((s) =>
    s.activeSessionId ? s.runningSessionIds.includes(s.activeSessionId) : false,
  )
  const rootPath = useUIStore((s) => s.rootPath)
  const isArtifactPanelOpen = useUIStore((s) => s.isArtifactPanelOpen)
  const setArtifactPanelOpen = useUIStore((s) => s.setArtifactPanelOpen)
  const openSettings = useUIStore((s) => s.openSettings)

  const statusText = isRunning ? '执行中' : session ? '空闲' : '未开始'

  // 会话级 token 合计：优先用 run 记录（provider 真实回报），没有就退回消息累计
  const sessionTokens = (() => {
    if (!session) return 0
    const runs = session.agentRuns ?? []
    const runTotal = runs.reduce((sum, r) => sum + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0)
    if (runTotal > 0) return runTotal
    return session.messages.reduce((sum, m) => sum + (m.tokenCount ?? 0), 0)
  })()
  const tokensLabel =
    sessionTokens >= 1_000_000
      ? `${(sessionTokens / 1_000_000).toFixed(1)}M`
      : sessionTokens >= 1000
        ? `${(sessionTokens / 1000).toFixed(1)}k`
        : String(sessionTokens)

  return (
    <header className="shrink-0 h-12 px-5 flex items-center gap-2 border-b border-[var(--pure-border)]">
      <div className="min-w-0 flex items-center gap-2 text-[13px]">
        <span className="text-[var(--pure-muted)] truncate max-w-[220px]">{baseName(rootPath)}</span>
        <span className="text-[var(--pure-muted)]">/</span>
        <span className="text-[var(--pure-muted)]">main</span>
        <span className="w-px h-3 bg-[var(--pure-border)] mx-1" />
        <span className="text-[var(--pure-ink)] truncate max-w-[320px]">
          {session?.title || '新对话'}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        {sessionTokens > 0 && (
          <span
            className="mr-2 text-[11.5px] tabular-nums text-[var(--pure-muted)]"
            title={`本会话已消耗 ${sessionTokens.toLocaleString()} tokens`}
          >
            {tokensLabel} tokens
          </span>
        )}
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--pure-muted)] mr-1">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isRunning ? 'bg-[var(--pure-ink)] animate-pulse' : 'bg-[var(--pure-border)]'
            }`}
          />
          {statusText}
        </span>

        <button
          type="button"
          onClick={() => setArtifactPanelOpen(!isArtifactPanelOpen)}
          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
            isArtifactPanelOpen
              ? 'text-[var(--pure-ink)] bg-[var(--pure-hover)]'
              : 'text-[var(--pure-muted)] hover:bg-[var(--pure-hover)]'
          }`}
          title={isArtifactPanelOpen ? '关闭文档面板' : '打开文档面板'}
          aria-label={isArtifactPanelOpen ? '关闭文档面板' : '打开文档面板'}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M15 4v16" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => openSettings()}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--pure-muted)] hover:bg-[var(--pure-hover)]"
          title="设置"
          aria-label="设置"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      </div>
    </header>
  )
}
