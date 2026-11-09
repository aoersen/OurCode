import { memo } from 'react'
import type { RailGroup } from './railModel'
import { ChevronIcon, FolderIcon } from './railIcons'
import { StateSummary } from './StateBadge'

export interface ProjectRowProps {
  group: RailGroup
  collapsed: boolean
  /** 当前工作区就是这个项目（rootPath === group.path）。 */
  active: boolean
  /** 该项目的路径 == uiStore.untrustedProjectPath（主进程拒绝过它）。 */
  untrusted: boolean
  /** 正在等原生授权结果 —— 行内文案保持「授权中…」且点击无效。 */
  trusting: boolean
  onToggleCollapse: (key: string) => void
  onTrust: (path: string) => void
  /** 打开项目 → 左栏切到「文件」模式浏览这个项目的文件（可点开编辑）。 */
  onOpenProject: (path: string) => void
  /** 右键 / 「⋯」：复制路径、新建对话、从列表移除… */
  onOpenMenu: (group: RailGroup, x: number, y: number) => void
}

/**
 * 项目行（重新设计后的形态）：
 *
 *   [⌄] [📁] 项目名            ●2  ●1     4  [⋯]
 *    └ 折叠开关  └ 点名称 = 打开项目并进入文件模式
 *
 * 与旧版的差别：
 *  1. 折叠与会话不再混在一起 —— chevron 只管折叠，名称是「打开项目」；
 *  2. 右侧先给状态摘要（进行中 / 待处理 / 异常），安静时退回对话数；
 *  3. hover / 键盘聚焦才露出「⋯」菜单，行内不放时间戳、不放路径。
 */
function ProjectRowInner({
  group,
  collapsed,
  active,
  untrusted,
  trusting,
  onToggleCollapse,
  onTrust,
  onOpenProject,
  onOpenMenu,
}: ProjectRowProps) {
  return (
    <div className="shrink-0">
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={!collapsed}
        aria-selected={active}
        data-rail-row={group.key}
        tabIndex={0}
        title={group.path ?? group.label}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpenMenu(group, event.clientX, event.clientY)
        }}
        onKeyDown={(event) => {
          const key = event.key
          if (key === 'ArrowLeft' && !collapsed) {
            event.preventDefault()
            onToggleCollapse(group.key)
          } else if (key === 'ArrowRight' && collapsed) {
            event.preventDefault()
            onToggleCollapse(group.key)
          } else if (key === 'Enter' || key === ' ') {
            if (!group.path) return
            event.preventDefault()
            onOpenProject(group.path)
          } else if ((key === 'F10' && event.shiftKey) || key === 'ContextMenu') {
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            onOpenMenu(group, rect.left + 24, rect.bottom)
          }
        }}
        className={`group/project w-full h-8 pl-1 pr-1 flex items-center gap-1 rounded-lg transition-colors ${
          active ? 'bg-[var(--pure-active)]' : 'hover:bg-[var(--pure-hover)]'
        }`}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onToggleCollapse(group.key)
          }}
          aria-label={collapsed ? `展开 ${group.label} 的对话` : `收起 ${group.label} 的对话`}
          aria-expanded={!collapsed}
          tabIndex={-1}
          className="pure-focus shrink-0 w-5 h-6 flex items-center justify-center rounded text-[var(--pure-muted)] hover:text-[var(--pure-ink)]"
        >
          <ChevronIcon collapsed={collapsed} />
        </button>

        <button
          type="button"
          onClick={() => {
            if (group.path) onOpenProject(group.path)
            else onToggleCollapse(group.key)
          }}
          tabIndex={-1}
          aria-label={`打开项目 ${group.label}`}
          className="pure-focus min-w-0 flex-1 h-6 flex items-center gap-2 text-[13.5px] text-[var(--pure-ink)] text-left"
        >
          <FolderIcon />
          <span className="min-w-0 truncate">{group.label}</span>
        </button>

        <StateSummary states={group.states} />

        <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--pure-muted)]">
          {group.count}
        </span>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            onOpenMenu(group, rect.left, rect.bottom)
          }}
          aria-label={`${group.label} 的更多操作`}
          title="更多操作"
          tabIndex={-1}
          className="pure-focus shrink-0 w-5 h-6 rounded flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)] opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 transition-opacity"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      </div>

      {untrusted && (
        <button
          type="button"
          onClick={() => {
            if (group.path) onTrust(group.path)
          }}
          disabled={trusting}
          title={group.path ?? undefined}
          className="w-full h-6 pl-[30px] pr-2 flex items-center text-left text-[11.5px] text-[var(--pure-warn)] hover:underline transition-colors disabled:opacity-60"
        >
          {trusting ? '授权中…' : '未信任，点击授权'}
        </button>
      )}
    </div>
  )
}

const ProjectRow = memo(ProjectRowInner)
ProjectRow.displayName = 'ProjectRow'
export default ProjectRow
