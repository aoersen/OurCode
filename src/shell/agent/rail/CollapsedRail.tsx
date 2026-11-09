import { ChevronRightIcon, FilesIcon, PlusIcon, SearchIcon, SessionsIcon } from './railIcons'

/** 收起态点击后展开成什么：restore = 保持上次模式，其余三个明确落到某个模式。 */
export type CollapsedRailIntent = 'restore' | 'sessions' | 'search' | 'files'

export interface CollapsedRailProps {
  /** 展开会话栏；intent 决定展开到哪个模式、焦点放哪。 */
  onExpand: (intent: CollapsedRailIntent) => void
  onNewSession: () => void
}

/**
 * 收起态会话栏：48px 图标条（展开 / 新对话 / 搜索 / 会话 / 文件）。
 * 无文字标签；图标默认是灰的，只在 hover 时变深并给底色（「active state on
 * hover only」）—— 收起态不显示任何常驻选中色块。
 */
export default function CollapsedRail({ onExpand, onNewSession }: CollapsedRailProps) {
  const itemClass =
    'w-8 h-8 rounded-lg flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors'

  return (
    <aside
      className="w-12 shrink-0 h-full flex flex-col items-center gap-1 py-3 bg-[var(--pure-rail)]"
      aria-label="会话栏（已收起）"
    >
      <button
        type="button"
        onClick={() => onExpand('restore')}
        className={itemClass}
        title="展开会话栏"
        aria-label="展开会话栏"
      >
        <ChevronRightIcon />
      </button>

      <button
        type="button"
        onClick={onNewSession}
        className={itemClass}
        title="新对话"
        aria-label="新对话"
      >
        <PlusIcon className="w-[16px] h-[16px]" />
      </button>

      <button
        type="button"
        onClick={() => onExpand('search')}
        className={itemClass}
        title="搜索"
        aria-label="搜索项目与会话"
      >
        <SearchIcon />
      </button>

      <button
        type="button"
        onClick={() => onExpand('sessions')}
        className={itemClass}
        title="会话列表"
        aria-label="会话列表"
      >
        <SessionsIcon />
      </button>

      {/* 直接展开到文件模式（不是先回会话再点一次「文件」） */}
      <button
        type="button"
        onClick={() => onExpand('files')}
        className={itemClass}
        title="文件"
        aria-label="文件树"
      >
        <FilesIcon />
      </button>
    </aside>
  )
}
