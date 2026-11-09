import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getModel } from '@/editor/modelRegistry'
import { previewFileUrl } from '@/editor/fileViews'
import type { FileViewMode } from '@/editor/fileViews'
import MarkdownRenderer from '@/components/Common/MarkdownRenderer'

// Debounce between the last keystroke and the live HTML preview reload, so
// rapid typing reloads at most every ~300ms instead of per keypress.
const LIVE_REFRESH_DEBOUNCE_MS = 300

interface PreviewPaneProps {
  path: string
  mode: FileViewMode
  /** Bumped by the toolbar's refresh button; forces the HTML iframe to reload. */
  refreshToken?: number
}

/** Preview of the active file when its extension has a dedicated view mode
 *  (html browser preview / markdown / image). Content comes from the live
 *  Monaco model so the preview follows edits without saving. */
export default function PreviewPane({ path, mode, refreshToken = 0 }: PreviewPaneProps) {
  if (mode === 'html') return <HtmlPreview path={path} refreshToken={refreshToken} />
  // key=path remounts the markdown preview per file so its debounce state
  // (and the live-model content) never bleeds stale content across file switches.
  if (mode === 'markdown') return <MarkdownPreview path={path} key={path} />
  return <ImagePreview path={path} />
}

/**
 * Subscribe to a Monaco model's live content, falling back to the store's
 * initial copy until the model exists. Monaco creates the model asynchronously
 * when the tab becomes active (lazy language service), so a short poll covers
 * the gap — after that, changes arrive via onDidChangeContent.
 */
function useModelLiveContent(path: string): string | null {
  const [content, setContent] = useState<string | null>(() => getModel(path)?.getValue() ?? null)

  useEffect(() => {
    let disposed = false
    let sub: { dispose(): void } | null = null
    let timer: number | undefined

    const attach = () => {
      const model = getModel(path)
      if (!model || model.isDisposed()) return false
      sub?.dispose()
      setContent(model.getValue())
      sub = model.onDidChangeContent(() => {
        if (!disposed) setContent(model.getValue())
      })
      return true
    }

    if (!attach()) {
      timer = window.setInterval(() => {
        if (attach() && timer) window.clearInterval(timer)
      }, 150)
    }

    return () => {
      disposed = true
      if (timer) window.clearInterval(timer)
      sub?.dispose()
    }
  }, [path])

  return content
}

/** ourcode-file:// URL of a path's parent directory, trailing slash included. */
function dirUrlOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dir = idx >= 0 ? path.slice(0, idx) : path
  const base = previewFileUrl(dir)
  return base.endsWith('/') ? base : `${base}/`
}

/** Resolve a markdown image href to an absolute URL. Remote/data/protocol URLs
 *  pass through; Windows drive paths map to local files; bare relative paths
 *  resolve against the markdown file's directory. */
function resolveMarkdownImageSrc(href: string, dirUrl: string): string {
  if (/^(https?:|data:|blob:|ourcode-file:|#)/i.test(href)) return href
  if (/^[a-zA-Z]:[\\/]/.test(href)) return previewFileUrl(href)
  if (href.startsWith('/')) return href
  return dirUrl + href
}

// ── HTML: embedded browser preview ──────────────────────────────────────────

function HtmlPreview({ path, refreshToken }: { path: string; refreshToken: number }) {
  const content = useModelLiveContent(path)
  const [version, setVersion] = useState(0)
  const pushedOnceRef = useRef(false)

  // Push the latest content into the main-process preview buffer and reload the
  // iframe. The buffer is awaited before the reload so the iframe never renders
  // stale disk content. The first content pushes immediately (no debounce), so
  // the preview shows the live file right away; subsequent edits are debounced
  // so rapid typing reloads at most every ~300ms. Only the newest push survives
  // (timeouts are cleared).
  useEffect(() => {
    if (content === null) return
    const push = () => {
      void window.electronAPI.setPreviewContent(path, content)
        .catch(() => { /* preview buffer is best-effort */ })
        .then(() => setVersion((v) => v + 1))
    }
    if (!pushedOnceRef.current) {
      pushedOnceRef.current = true
      push()
      return
    }
    const id = window.setTimeout(push, LIVE_REFRESH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [content, path])

  // Manual refresh button — reload the iframe from the current buffer
  useEffect(() => {
    setVersion((v) => v + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  // Drop the buffer when this pane unmounts (file closed / switched away) so
  // the protocol falls back to the on-disk content.
  useEffect(() => {
    return () => {
      void window.electronAPI.clearPreviewContent(path).catch(() => {})
    }
  }, [path])

  return (
    <iframe
      title="HTML Preview"
      className="w-full h-full border-0 bg-white"
      src={`${previewFileUrl(path)}?v=${version}`}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
    />
  )
}

// ── Markdown: rendered preview (relative local images resolved) ─────────────

function MarkdownPreview({ path }: { path: string }) {
  const content = useModelLiveContent(path) ?? ''
  // Debounce the live markdown so rapid typing re-renders the whole document at
  // most every ~300ms instead of per keystroke — re-parsing a large markdown
  // file on every keypress froze the input. The first render is immediate; the
  // component is remounted per file (key=path in PreviewPane), so a file switch
  // shows the new content right away without any stale flash.
  const [debouncedContent, setDebouncedContent] = useState(content)
  const firstRef = useRef(true)
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false
      setDebouncedContent(content)
      return
    }
    const id = window.setTimeout(() => setDebouncedContent(content), LIVE_REFRESH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [content])

  const dirUrl = useMemo(() => dirUrlOf(path), [path])

  const rewriteImageSrc = useCallback(
    (href: string) => resolveMarkdownImageSrc(href, dirUrl),
    [dirUrl],
  )

  return (
    <div className="h-full overflow-y-auto px-5 py-4 bg-[var(--pure-canvas)]">
      <MarkdownRenderer content={debouncedContent} rewriteImageSrc={rewriteImageSrc} />
    </div>
  )
}

// ── Image: read-only preview ────────────────────────────────────────────────

function formatBytes(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 图片预览：给一块「画布」而不是把图直接贴在白底上。
 *
 * 视觉：
 *  - 四周 12px 内边距 + 1px 边框 + 12px 圆角，棋盘格承托透明图（深色截图也不会
 *    直接变成一块无边界的黑板）；
 *  - 图按 contain 居中，不放大到失真；
 *  - 底部一条信息栏：类型 / 像素尺寸 / 文件大小 / 只读，和编辑器状态栏同一套语气。
 *
 * 加载失败不再是一片空白：显示文件名、路径与「重试」。
 */
function ImagePreview({ path }: { path: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [bytes, setBytes] = useState<number | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)

  const ext = (path.split('.').pop() ?? '').toUpperCase()

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setSize(null)
    void window.electronAPI
      .stat(path)
      .then((stat) => {
        if (!cancelled) setBytes(stat?.size)
      })
      .catch(() => {
        /* 大小拿不到不影响看图 */
      })
    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 p-3">
        <div className="pure-checker relative h-full w-full rounded-xl border border-[var(--pure-border)] overflow-auto pure-scroll flex items-center justify-center">
          {status === 'error' ? (
            <div className="px-4 py-6 text-center">
              <div className="text-[12.5px] text-[var(--pure-ink)]">这张图读不出来</div>
              <div className="mt-1 max-w-[280px] truncate font-mono text-[11px] text-[var(--pure-muted)]" title={path}>
                {path}
              </div>
              <button
                type="button"
                onClick={() => {
                  setAttempt((n) => n + 1)
                  setStatus('loading')
                }}
                className="pure-focus mt-3 text-[12px] text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:underline"
              >
                重试
              </button>
            </div>
          ) : (
            <img
              key={attempt}
              src={previewFileUrl(path)}
              alt=""
              draggable={false}
              onLoad={(event) => {
                setStatus('ready')
                setSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }}
              onError={() => setStatus('error')}
              className={`max-w-full max-h-full object-contain select-none ${
                status === 'ready' ? '' : 'opacity-0'
              }`}
            />
          )}
          {status === 'loading' && (
            <div className="pointer-events-none absolute text-[11.5px] text-[var(--pure-muted)]">
              正在读取图片…
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 h-8 px-3 flex items-center gap-3 border-t border-[var(--pure-border)] text-[11px] tabular-nums text-[var(--pure-muted)]">
        <span className="shrink-0 font-mono uppercase">{ext || 'IMG'}</span>
        {size ? (
          <span className="shrink-0">
            {size.width} × {size.height}
          </span>
        ) : null}
        {formatBytes(bytes) ? <span className="shrink-0">{formatBytes(bytes)}</span> : null}
        <span className="ml-auto shrink-0">只读预览</span>
      </div>
    </div>
  )
}
