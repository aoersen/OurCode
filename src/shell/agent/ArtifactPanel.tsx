import { useState } from 'react'
import MarkdownRenderer from '@/components/Common/MarkdownRenderer'
import PreviewPane from '@/components/Editor/PreviewPane'
import { getFileViewMode } from '@/editor/fileViews'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'

type ArtifactTab = 'plan' | 'file' | 'browser'

const TABS: Array<{ id: ArtifactTab; label: string }> = [
  { id: 'plan', label: '计划' },
  { id: 'file', label: '文件' },
  { id: 'browser', label: '浏览器' },
]

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">{children}</div>
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

/**
 * 产物面板（右栏 400px，默认关闭，flex 兄弟节点而非 overlay）。
 *
 * v1 三个查看器：
 *  - 计划：会话的 planContent（Markdown）
 *  - 文件：当前编辑器活动文件的预览（md / html / 图片走 PreviewPane，代码给跳转提示）
 *  - 浏览器：内嵌 iframe + 地址栏（本地预览用）
 *
 * diff 查看器下一轮接现有 DiffView（需要 original/modified，属于 P2）。
 */
export default function ArtifactPanel() {
  const session = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null,
  )
  const activeFilePath = useEditorStore((s) => s.activeFilePath)
  const setArtifactPanelOpen = useUIStore((s) => s.setArtifactPanelOpen)

  const [tab, setTab] = useState<ArtifactTab>(session?.planContent ? 'plan' : activeFilePath ? 'file' : 'browser')
  const [url, setUrl] = useState('http://localhost:5173')
  const [reloadKey, setReloadKey] = useState(0)

  const viewMode = activeFilePath ? getFileViewMode(activeFilePath) : null

  return (
    <aside className="w-[400px] shrink-0 min-h-0 flex flex-col border-l border-[var(--pure-border)] bg-white">
      <div className="shrink-0 h-12 px-3 flex items-center gap-3">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`text-[13px] transition-colors ${
              tab === item.id
                ? 'text-[var(--pure-ink)]'
                : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
            }`}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setArtifactPanelOpen(false)}
          className="ml-auto w-7 h-7 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:bg-[var(--pure-hover)]"
          title="关闭"
          aria-label="关闭产物面板"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pure-scroll">
        {tab === 'plan' && (
          <div className="px-4 py-3">
            {session?.planContent ? (
              <>
                <div className="mb-3 flex items-center gap-2 text-[12px] text-[var(--pure-muted)]">
                  <span>计划</span>
                  <span>·</span>
                  <span>{session.planStatus === 'approved' ? '已批准' : session.planStatus === 'pending_approval' ? '待确认' : '草稿'}</span>
                </div>
                <div className="pure-prose text-[13.5px] leading-[24px]">
                  <MarkdownRenderer content={session.planContent} />
                </div>
              </>
            ) : (
              <EmptyHint>当前会话还没有计划。让 agent 先出一版方案，批准后会显示在这里。</EmptyHint>
            )}
          </div>
        )}

        {tab === 'file' && (
          <>
            {activeFilePath && viewMode && viewMode !== 'code' ? (
              <div className="h-full min-h-0 flex flex-col">
                <div className="shrink-0 px-4 py-2 text-[12px] text-[var(--pure-muted)] truncate">
                  {baseName(activeFilePath)}
                </div>
                <div className="flex-1 min-h-0">
                  <PreviewPane path={activeFilePath} mode={viewMode} refreshToken={reloadKey} />
                </div>
              </div>
            ) : (
              <EmptyHint>
                {activeFilePath
                  ? `${baseName(activeFilePath)} 是代码文件：在编辑器里查看更合适。按 Ctrl+Alt+M 切到工作台。`
                  : '先在编辑器里打开一个文件（Markdown、图片或 HTML），这里会显示预览。'}
              </EmptyHint>
            )}
          </>
        )}

        {tab === 'browser' && (
          <div className="h-full min-h-0 flex flex-col">
            <div className="shrink-0 px-3 py-2 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:bg-[var(--pure-hover)]"
                title="重新加载"
                aria-label="重新加载"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 11-3-6.7" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
              </button>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setReloadKey((k) => k + 1)
                }}
                spellCheck={false}
                className="flex-1 min-w-0 h-7 px-2.5 rounded-full bg-[var(--pure-hover)] text-[12px] outline-none border-0"
                placeholder="http://localhost:5173"
                aria-label="地址"
              />
            </div>
            <iframe
              key={`${url}-${reloadKey}`}
              src={url}
              title="内嵌浏览器"
              className="flex-1 w-full min-h-0 border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            />
            <div className="shrink-0 px-3 py-1.5 text-[11.5px] text-[var(--pure-muted)]">
              本地预览 · 需要先启动开发服务器
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
