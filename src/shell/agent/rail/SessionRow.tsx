import { memo, useEffect, useRef, useState } from 'react'
import { isComposingEvent } from '@/utils/composition'
import { SESSION_STATE_LABEL, type RailSessionRow } from './railModel'
import { StateBadge } from './StateBadge'

export interface SessionRowProps {
  row: RailSessionRow
  active: boolean
  /** 这一行正在行内重命名（input 取代标题）。 */
  editing: boolean
  /** 回调都以 id / row 为参数且由父组件 useCallback 固化 —— memo 才有意义。 */
  onSelect: (id: string) => void
  onStartRename: (id: string) => void
  /** 提交新标题（父组件负责 renameSession + 退出编辑态）。 */
  onRename: (id: string, title: string) => void
  /** 放弃编辑（Esc / 失焦 / 标题没变）。 */
  onCancelRename: () => void
  /** 打开上下文菜单（右键与键盘 Shift+F10 共用）。 */
  onOpenMenu: (row: RailSessionRow, x: number, y: number) => void
}

/**
 * 对话行（设计稿「项目树」）：
 *   缩进 20px、13px、单行；激活态浅灰填充；运行中 6px 实心点；等用户处理时红点
 *   （红点**不带文字**）。行内没有时间戳。
 * 搜索命中正文时，标题下面多一行灰色片段（截断在命中点附近）。
 * 双击 / F2 行内重命名；右键 / Shift+F10 开上下文菜单。
 */
function SessionRowInner({
  row,
  active,
  editing,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onOpenMenu,
}: SessionRowProps) {
  const [draft, setDraft] = useState(row.title)
  const settled = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!editing) return
    settled.current = false
    setDraft(row.title)
    // 聚焦并全选：改名通常是从头写，而不是在末尾接字
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [editing, row.title])

  const finish = (commit: boolean) => {
    if (settled.current) return
    settled.current = true
    const next = draft.trim()
    if (commit && next && next !== row.title) onRename(row.id, next)
    else onCancelRename()
  }

  if (editing) {
    return (
      <div
        role="treeitem"
        aria-level={2}
        aria-selected={active}
        tabIndex={-1}
        data-rail-row={row.id}
        className="w-full min-h-8 pl-5 pr-2 py-1 flex items-center rounded-lg bg-[var(--pure-active)]"
      >
        <input
          ref={inputRef}
          value={draft}
          aria-label="重命名对话"
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            // 输入法组合期间的回车是在确认候选词，不是提交
            if (isComposingEvent(e)) return
            if (e.key === 'Enter') {
              e.preventDefault()
              finish(true)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              finish(false)
            }
          }}
          className="w-full min-w-0 bg-transparent border-0 outline-none text-[13px] leading-[18px] text-[var(--pure-ink)]"
        />
      </div>
    )
  }

  const state = row.blocked ? '等待处理' : row.running ? '运行中' : row.archivedAt ? '已归档' : ''
  const title = `${row.title}${row.state !== 'idle' ? ` · ${SESSION_STATE_LABEL[row.state]}` : ''}${
    state ? `（${state}）` : ''
  }${row.pinnedAt ? '（已置顶）' : ''}`

  return (
    <button
      ref={buttonRef}
      type="button"
      role="treeitem"
      aria-level={2}
      aria-selected={active}
      tabIndex={0}
      data-rail-row={row.id}
      onClick={() => onSelect(row.id)}
      onDoubleClick={() => onStartRename(row.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onOpenMenu(row, e.clientX, e.clientY)
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') {
          e.preventDefault()
          onStartRename(row.id)
        } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
          e.preventDefault()
          const rect = buttonRef.current?.getBoundingClientRect()
          onOpenMenu(row, rect ? rect.left + 24 : 0, rect ? rect.bottom : 0)
        }
      }}
      title={title}
      className={`group/row w-full pl-5 pr-2 flex flex-col justify-center gap-0.5 rounded-lg text-left text-[13px] leading-[18px] transition-colors ${
        row.snippet ? 'py-1' : 'min-h-8 py-0'
      } ${
        active
          ? 'bg-[var(--pure-active)] text-[var(--pure-ink)]'
          : row.archivedAt
            ? 'text-[var(--pure-muted)] hover:bg-[var(--pure-hover)]'
            : 'text-[var(--pure-secondary)] hover:bg-[var(--pure-hover)]'
      }`}
    >
      <span className="flex items-center gap-2 min-w-0 w-full">
        <span className="min-w-0 flex-1 truncate">{row.title}</span>
        {/* 状态：进行中 / 待处理 / 异常 显示文字，结束只留一个安静的圆环 */}
        <StateBadge state={row.state} label={SESSION_STATE_LABEL[row.state]} />
      </span>
      {row.snippet && (
        <span className="w-full truncate text-[12px] leading-4 text-[var(--pure-muted)]">
          {row.snippet}
        </span>
      )}
    </button>
  )
}

const SessionRow = memo(SessionRowInner)
SessionRow.displayName = 'SessionRow'
export default SessionRow
