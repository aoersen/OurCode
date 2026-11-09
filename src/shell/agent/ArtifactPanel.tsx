import { useEffect, useMemo, useState } from 'react'
import MarkdownRenderer from '@/components/Common/MarkdownRenderer'
import { getModel, unregisterModel } from '@/editor/modelRegistry'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import CheckpointTimeline from './artifact/CheckpointTimeline'
import DocumentTabs from './artifact/DocumentTabs'
import FileArtifactView from './artifact/FileArtifactView'
import PanelDiff from './artifact/PanelDiff'
import PanelFilePicker from './artifact/PanelFilePicker'
import {
  buildDocTabs,
  docIdAfterClose,
  docIdOfFile,
  pathOfDocId,
  resolveActiveDocId,
  type DocTab,
} from './artifact/docModel'
import SurfaceHost from './surfaces/SurfaceHost'
import type { SurfaceId } from './surfaces/surfaceModel'

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full px-5 py-6 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">
      {children}
    </div>
  )
}

/** 关闭文件标签后把它的 Monaco 模型一并释放（内容已被保存或用户放弃）。 */
function disposeModel(path: string) {
  const model = getModel(path)
  if (!model) return
  if (!model.isDisposed()) model.dispose()
  unregisterModel(path)
}

/**
 * 右侧文档面板（400px，flex 兄弟节点，默认关闭）。
 *
 * **导航 = 打开的文件**：每个打开的文件一条标签，类型由扩展名自动识别
 * （TS / MD / JSON / PNG …），计划 / 变更 / 浏览器退化成标签条右端的「会话视图」组。
 * 不再是「计划 / 变更 / 文件 / 浏览器」四个类型页签 —— 那样切文件要多点一层，
 * 关掉文件还会自己跳回别的类型。
 *
 * 只读的字面契约：
 *  - 文件标签：类型短标 + 文件名 + 未保存圆点 + 关闭；
 *  - 会话视图：常驻、无关闭，与文件组之间一条 1px 竖线；
 *  - 整条标签行底边一条 1px 分隔线，与下方内容明确分开。
 *
 * 两层覆盖：`editorStore.activeDiff` 有值时整个面板换成 diff 查看器；
 * 「管理」打开时内容区换成 SurfaceHost（标签行保留但不再画活动下划线）。
 */
export default function ArtifactPanel() {
  const session = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null,
  )
  const openFiles = useEditorStore((s) => s.openFiles)
  const activeFilePath = useEditorStore((s) => s.activeFilePath)
  const activeDiff = useEditorStore((s) => s.activeDiff)
  const closeDiff = useEditorStore((s) => s.closeDiff)
  const setArtifactPanelOpen = useUIStore((s) => s.setArtifactPanelOpen)
  const rootPath = useUIStore((s) => s.rootPath)
  const artifactRequest = useUIStore((s) => s.artifactRequest)
  const clearArtifactRequest = useUIStore((s) => s.clearArtifactRequest)

  const planContent = session?.planContent
  const { fileDocs, viewDocs, all } = useMemo(
    () => buildDocTabs(openFiles, { hasPlan: !!planContent }),
    [openFiles, planContent],
  )

  /** 用户显式选中的标签；null = 跟随编辑器活动文件。 */
  const [preferredDocId, setPreferredDocId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  /** 地址栏草稿；只有点「打开」才真正加载（避免边打字边刷新 iframe）。 */
  const [urlDraft, setUrlDraft] = useState(() => {
    try {
      return localStorage.getItem('ourcode.preview.url') ?? 'http://localhost:5173'
    } catch {
      return 'http://localhost:5173'
    }
  })
  /** 正在预览的地址。空 = 还没打开（显示引导，而不是把应用自己嵌进面板）。 */
  const [previewUrl, setPreviewUrl] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [surface, setSurface] = useState<SurfaceId | null>(null)
  const [lastSurface, setLastSurface] = useState<SurfaceId>('memory')

  const activeDocId = resolveActiveDocId(all, preferredDocId, activeFilePath)
  const activeDoc: DocTab | null = all.find((doc) => doc.id === activeDocId) ?? null
  const projectPath = session?.projectPath || rootPath || null

  // 外部请求（左栏文件树 / 文件选择器）：一次性消费，选中对应文档
  useEffect(() => {
    if (!artifactRequest) return
    setSurface(null)
    if (artifactRequest.tab === 'file' && artifactRequest.path) {
      setPreferredDocId(docIdOfFile(artifactRequest.path))
    } else if (artifactRequest.tab === 'plan') {
      setPreferredDocId('plan')
    } else if (artifactRequest.tab === 'changes') {
      setPreferredDocId('changes')
    } else if (artifactRequest.tab === 'browser') {
      setPreferredDocId('browser')
    }
    clearArtifactRequest()
  }, [artifactRequest, clearArtifactRequest])

  // diff 打开时，Esc 无论焦点在面板内还是 Monaco 里都关闭它（浮层开着时不抢键）
  useEffect(() => {
    if (!activeDiff) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const ui = useUIStore.getState()
      if (ui.isSettingsOpen || ui.isCommandPaletteOpen) return
      closeDiff()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDiff, closeDiff])

  const handleSelectDoc = (doc: DocTab) => {
    setPreferredDocId(doc.id)
    setPickerOpen(false)
    setSurface(null)
    // 选中文件标签 = 同时把它设为编辑器活动文件（左栏高亮、脏状态一致）
    const path = doc.kind === 'file' ? doc.path : pathOfDocId(doc.id)
    if (path) {
      const state = useEditorStore.getState()
      if (state.activeFilePath !== path && state.openFiles.some((file) => file.path === path)) {
        state.setActiveFile(path)
      }
    }
  }

  const handleCloseDoc = (doc: DocTab) => {
    if (!doc.closable) return
    const path = doc.path ?? pathOfDocId(doc.id)
    if (!path) return
    const editor = useEditorStore.getState()
    // 先算好关闭后该落到哪条标签（用关闭前的列表）
    const nextId = docIdAfterClose(all, doc.id)
    if (editor.activeFilePath !== path) editor.setActiveFile(path)
    void editor.closeFileWithConfirm(path).then((closed) => {
      if (!closed) return
      disposeModel(path)
      setPreferredDocId(nextId)
    })
  }

  const handleOpenSurface = (id: SurfaceId) => {
    setLastSurface(id)
    setSurface(id)
    setPickerOpen(false)
  }

  const handleToggleManage = () => {
    setSurface((current) => (current ? null : lastSurface))
    setPickerOpen(false)
  }

  const handlePickFile = (path: string) => {
    setPreferredDocId(docIdOfFile(path))
    setSurface(null)
  }

  const showTabsQuiet = surface !== null

  return (
    <aside
      className="relative w-[400px] shrink-0 min-h-0 flex flex-col border-l border-[var(--pure-border)] bg-[var(--pure-canvas)]"
      aria-label="文档面板"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        if (activeDiff) {
          event.stopPropagation()
          closeDiff()
        } else if (surface) {
          event.stopPropagation()
          setSurface(null)
        } else if (pickerOpen) {
          event.stopPropagation()
          setPickerOpen(false)
        }
      }}
    >
      {activeDiff ? (
        <PanelDiff />
      ) : (
        <>
          {/* 第一行：打开的文件（一个文件一条标签，类型自动识别） */}
          <DocumentTabs
            fileDocs={fileDocs}
            activeId={activeDocId}
            onSelect={handleSelectDoc}
            onClose={handleCloseDoc}
            onOpenPicker={() => setPickerOpen((open) => !open)}
            pickerOpen={pickerOpen}
            onClosePanel={() => setArtifactPanelOpen(false)}
          />

          {/* 第二行：会话视图（计划 / 变更 / 浏览器）+ 管理入口。
              与文件标签分两行、有一条 1px 分隔，避免又变成「按类型分页签」。
              没有计划时「计划」只是安静地变灰，不会整条消失。 */}
          <div
            className={`shrink-0 h-8 px-3 flex items-center gap-4 border-b border-[var(--pure-border)] bg-[var(--pure-canvas)]${
              showTabsQuiet ? ' pure-tabs-quiet' : ''
            }`}
          >
            {viewDocs.map((doc) => {
              const isActive = doc.id === activeDocId
              const empty = doc.id === 'plan' && !planContent
              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => handleSelectDoc(doc)}
                  aria-pressed={isActive}
                  title={empty ? '当前会话还没有计划' : doc.title}
                  className={`pure-focus shrink-0 text-[12px] leading-[18px] transition-colors ${
                    isActive
                      ? 'pure-tab-underline text-[var(--pure-ink)]'
                      : empty
                        ? 'text-[var(--pure-muted)] opacity-60 hover:opacity-100 hover:text-[var(--pure-ink)]'
                        : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
                  }`}
                >
                  {doc.label}
                </button>
              )
            })}

            <span aria-hidden="true" className="ml-auto shrink-0 w-px h-3 bg-[var(--pure-border)]" />

            <button
              type="button"
              onClick={handleToggleManage}
              aria-expanded={surface !== null}
              aria-controls="artifact-panel-body"
              title={surface ? '回到文档' : '管理：记忆 / 技能 / MCP / 工作流 / 用量 / 渠道'}
              className={`pure-focus shrink-0 text-[12px] leading-[18px] transition-colors ${
                surface
                  ? 'pure-tab-underline text-[var(--pure-ink)]'
                  : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
              }`}
            >
              管理
            </button>
          </div>

          <div id="artifact-panel-body" className="flex-1 min-h-0 overflow-hidden">
            {surface && (
              <SurfaceHost active={surface} onSelect={handleOpenSurface} projectPath={projectPath} />
            )}

            {!surface && activeDoc?.kind === 'plan' && (
              <div className="h-full min-h-0 overflow-y-auto pure-scroll px-5 py-4">
                {planContent ? (
                  <>
                    <div className="mb-3 flex items-center gap-2 text-[12px] leading-[18px] text-[var(--pure-muted)]">
                      <span>计划</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {session?.planStatus === 'approved'
                          ? '已批准'
                          : session?.planStatus === 'pending_approval'
                            ? '待确认'
                            : '草稿'}
                      </span>
                    </div>
                    <div className="pure-prose text-[13.5px] leading-[24px]">
                      <MarkdownRenderer content={planContent} />
                    </div>
                  </>
                ) : (
                  <EmptyHint>当前会话还没有计划。让 agent 先出一版方案，批准后会显示在这里。</EmptyHint>
                )}
              </div>
            )}

            {!surface && activeDoc?.kind === 'changes' && <CheckpointTimeline />}

            {!surface && activeDoc?.kind === 'file' && activeDoc.path && (
              <FileArtifactView key={activeDoc.path} path={activeDoc.path} />
            )}

            {!surface && activeDoc?.kind === 'browser' && (
              <div className="h-full min-h-0 flex flex-col">
                <div className="shrink-0 px-3 py-2 flex items-center gap-1.5 border-b border-[var(--pure-border)]">
                  <button
                    type="button"
                    onClick={() => {
                      setReloadKey((k) => k + 1)
                    }}
                    disabled={!previewUrl}
                    className="pure-focus w-6 h-6 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] disabled:opacity-40 transition-colors"
                    title="重新加载"
                    aria-label="重新加载预览"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 11-3-6.7" />
                      <polyline points="21 3 21 9 15 9" />
                    </svg>
                  </button>
                  <input
                    value={urlDraft}
                    onChange={(event) => setUrlDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      const next = urlDraft.trim()
                      if (!next) return
                      setPreviewUrl(next)
                      setReloadKey((k) => k + 1)
                      try {
                        localStorage.setItem('ourcode.preview.url', next)
                      } catch {
                        /* 隐私模式：只在本会话内生效 */
                      }
                    }}
                    spellCheck={false}
                    className="flex-1 min-w-0 h-7 px-2.5 rounded-md bg-[var(--pure-code)] text-[12px] text-[var(--pure-ink)] outline-none border-0 placeholder:text-[var(--pure-muted)]"
                    placeholder="http://localhost:5173"
                    aria-label="地址"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const next = urlDraft.trim()
                      if (!next) return
                      setPreviewUrl(next)
                      setReloadKey((k) => k + 1)
                      try {
                        localStorage.setItem('ourcode.preview.url', next)
                      } catch {
                        /* ignore */
                      }
                    }}
                    className="pure-focus shrink-0 h-7 px-2 rounded-md text-[12px] text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
                  >
                    打开
                  </button>
                </div>

                {previewUrl ? (
                  <iframe
                    key={`${previewUrl}-${reloadKey}`}
                    src={previewUrl}
                    title="内嵌浏览器预览"
                    className="flex-1 w-full min-h-0 border-0 bg-[var(--pure-canvas)]"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                  />
                ) : (
                  <div className="flex-1 min-h-0 px-5 py-6">
                    <div className="text-[12.5px] leading-[20px] text-[var(--pure-ink)]">预览本地开发服务</div>
                    <p className="mt-1 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
                      在上面填一个地址回车即可。开发服务器需要先跑起来（例如 vite dev）。
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {['http://localhost:5173', 'http://localhost:3000', 'http://localhost:8080'].map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => {
                            setUrlDraft(item)
                            setPreviewUrl(item)
                            setReloadKey((k) => k + 1)
                            try {
                              localStorage.setItem('ourcode.preview.url', item)
                            } catch {
                              /* ignore */
                            }
                          }}
                          className="pure-focus h-7 px-2.5 rounded-md bg-[var(--pure-code)] font-mono text-[11px] text-[var(--pure-secondary)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
                        >
                          {item.replace('http://', '')}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="shrink-0 px-4 py-1.5 text-[11px] leading-[16px] text-[var(--pure-muted)] border-t border-[var(--pure-border)]">
                  {previewUrl ? `预览中 · ${previewUrl}` : '本地预览 · 需要先启动开发服务器'}
                </div>
              </div>
            )}

            {!surface && !activeDoc && (
              <EmptyHint>
                还没有打开的文档。从左栏文件树打开一个文件，或点标签条右端的＋从最近文件里挑一个。
              </EmptyHint>
            )}
          </div>
        </>
      )}

      {pickerOpen && !activeDiff && (
        <PanelFilePicker onPick={handlePickFile} onClose={() => setPickerOpen(false)} />
      )}
    </aside>
  )
}
