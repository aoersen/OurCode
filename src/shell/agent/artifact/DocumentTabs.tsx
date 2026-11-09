import { useEffect, useRef } from 'react'
import DocIcon from './DocIcon'
import { docIdForNavKey, type DocTab } from './docModel'

interface DocumentTabsProps {
  /** 打开的文件标签（按打开顺序）——**一个文件一条**，不是按类型分组。 */
  fileDocs: ReadonlyArray<DocTab>
  activeId: string | null
  onSelect: (doc: DocTab) => void
  onClose: (doc: DocTab) => void
  onOpenPicker: () => void
  pickerOpen: boolean
  onClosePanel: () => void
}

/**
 * 文档标签条（右侧面板第一行）。
 *
 * 视觉：
 *  - 整条是浅灰带（--pure-rail），与下面的白色内容之间有 1px 分隔线；
 *  - 活动标签是白色小卡片 + 1px 边框（在灰带上读作「浮起来」），其余透明，
 *    hover 才给一层极浅灰 —— 不再用文字型「PNG」前缀，类型交给线性图标；
 *  - 文件名截断在 136px，关闭按钮位置固定（不可见时也占位），标签切换不跳动；
 *  - 两端有渐隐遮罩，标签多的时候能看出「还能继续滚」。
 *
 * 交互：单击选中；中键 / × 关闭；←→ Home End 在标签间移动；滚轮横向翻页。
 */
export default function DocumentTabs({
  fileDocs,
  activeId,
  onSelect,
  onClose,
  onOpenPicker,
  pickerOpen,
  onClosePanel,
}: DocumentTabsProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    if (!activeId) return
    buttonRefs.current[activeId]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const host = listRef.current
    if (!host) return
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    if (host.scrollWidth <= host.clientWidth) return
    host.scrollLeft += event.deltaY
  }

  const move = (next: string | null) => {
    if (!next) return
    const doc = fileDocs.find((item) => item.id === next)
    if (!doc) return
    onSelect(doc)
    requestAnimationFrame(() => buttonRefs.current[next]?.focus())
  }

  return (
    <div className="shrink-0 h-10 flex items-center gap-1 border-b border-[var(--pure-border)] bg-[var(--pure-canvas)]">
      <div
        ref={listRef}
        role="tablist"
        aria-label="打开的文件"
        onWheel={onWheel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') return
          const next = docIdForNavKey(fileDocs, activeId, event.key)
          if (!next) return
          event.preventDefault()
          move(next)
        }}
        className="flex-1 min-w-0 h-full flex items-center gap-1 px-2 overflow-x-auto pure-scroll [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
        style={{
          maskImage:
            'linear-gradient(to right, transparent 0, black 10px, black calc(100% - 10px), transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to right, transparent 0, black 10px, black calc(100% - 10px), transparent 100%)',
        }}
      >
        {fileDocs.length === 0 && (
          <button
            type="button"
            onClick={onOpenPicker}
            className="pure-focus h-7 px-2 rounded-lg text-[12px] leading-[18px] text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
          >
            还没有打开文件 · 点这里打开
          </button>
        )}

        {fileDocs.map((doc) => {
          const isActive = doc.id === activeId
          return (
            <span
              key={doc.id}
              className={`group/tab shrink-0 inline-flex items-center rounded-md transition-colors ${
                isActive ? 'bg-[var(--pure-active)]' : 'hover:bg-[var(--pure-hover)]'
              }`}
            >
              <button
                ref={(node) => {
                  buttonRefs.current[doc.id] = node
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls="artifact-panel-body"
                aria-label={`${doc.title}${doc.dirty ? '（未保存）' : ''}`}
                title={`${doc.title}${doc.typeLabel ? `\n${doc.typeLabel} 类型` : ''}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onSelect(doc)}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault()
                    onClose(doc)
                  }
                }}
                className={`pure-focus h-[26px] max-w-[148px] pl-1.5 pr-0.5 flex items-center gap-1.5 rounded-md text-[11.5px] leading-[18px] transition-colors ${
                  isActive
                    ? 'text-[var(--pure-ink)]'
                    : 'text-[var(--pure-secondary)] group-hover/tab:text-[var(--pure-ink)]'
                }`}
              >
                <span className={isActive ? 'text-[var(--pure-ink)]' : 'text-[var(--pure-muted)]'}>
                  <DocIcon tone={doc.tone ?? 'other'} className="w-3 h-3" />
                </span>
                <span className="min-w-0 truncate">{doc.shortLabel ?? doc.label}</span>
                {doc.dirty ? (
                  <span
                    aria-hidden="true"
                    className="shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--pure-ink)]"
                    title="有未保存修改"
                  />
                ) : null}
              </button>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(doc)
                }}
                aria-label={`关闭 ${doc.label}`}
                title="关闭"
                tabIndex={-1}
                className={`pure-focus shrink-0 w-4 h-4 mr-0.5 rounded flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)] transition-opacity ${
                  isActive ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100'
                }`}
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </span>
          )
        })}
      </div>

      <button
        type="button"
        onClick={onOpenPicker}
        aria-label="打开文件"
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        title="打开文件（最近文件 / 已打开）"
        className={`pure-focus shrink-0 w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
          pickerOpen
            ? 'text-[var(--pure-ink)] bg-[var(--pure-hover)]'
            : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]'
        }`}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      <span aria-hidden="true" className="shrink-0 w-px h-4 bg-[var(--pure-border)]" />

      <button
        type="button"
        onClick={onClosePanel}
        className="pure-focus shrink-0 w-6 h-6 mr-1.5 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
        title="关闭文档面板"
        aria-label="关闭文档面板"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )
}
