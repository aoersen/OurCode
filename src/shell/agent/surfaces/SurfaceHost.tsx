import ChannelSurface from './channel/ChannelSurface'
import McpSurface from './mcp/McpSurface'
import MemorySurface from './memory/MemorySurface'
import SkillsSurface from './skills/SkillsSurface'
import UsageSurface from './usage/UsageSurface'
import WorkflowSurface from './workflow/WorkflowSurface'
import { SURFACES, surfaceForNavKey, type SurfaceId } from './surfaceModel'

interface SurfaceHostProps {
  active: SurfaceId
  onSelect: (id: SurfaceId) => void
  /** 当前会话绑定的项目（记忆分组、项目级技能/MCP 都用它） */
  projectPath: string | null
}

/**
 * 管理面的宿主：一条纯文字选择条（记忆 / 技能 / MCP / 工作流 / 用量 / 渠道）
 * + 下面渲染当前面。
 *
 * 键盘：←/→/Home/End 在六项之间移动；Esc 回上一个产物页签（由 ArtifactPanel
 * 统一处理，避免两处监听抢事件）；列表里的 ↑/↓ 由各面自己接管。
 */
export default function SurfaceHost({ active, onSelect, projectPath }: SurfaceHostProps) {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div
        role="tablist"
        aria-label="管理面"
        className="shrink-0 flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 pb-1.5 border-b border-[var(--pure-border)]"
        onKeyDown={(event) => {
          const next = surfaceForNavKey(active, event.key)
          if (!next) return
          event.preventDefault()
          onSelect(next)
        }}
      >
        {SURFACES.map((entry) => {
          const isActive = entry.id === active
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              title={entry.title}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onSelect(entry.id)}
              className={`pure-focus text-[12.5px] leading-[20px] transition-colors ${
                isActive
                  ? 'pure-tab-underline text-[var(--pure-ink)]'
                  : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
              }`}
            >
              {entry.label}
            </button>
          )
        })}
      </div>

      <div className="flex-1 min-h-0">
        {active === 'memory' && <MemorySurface projectPath={projectPath} />}
        {active === 'skills' && <SkillsSurface projectPath={projectPath} />}
        {active === 'mcp' && <McpSurface projectPath={projectPath} />}
        {active === 'workflow' && <WorkflowSurface />}
        {active === 'usage' && <UsageSurface />}
        {active === 'channel' && <ChannelSurface />}
      </div>
    </div>
  )
}
