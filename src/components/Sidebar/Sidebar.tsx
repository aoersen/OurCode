import ProjectListPanel from './ProjectListPanel'
import { PanelActivityProvider } from './panelActivity'

/**
 * Left sidebar — project list, and the project-internal accordion once a
 * project is entered.
 *
 * The former activity bar is gone: 代码管理 / 文件变更 follow the project (the
 * sidebar shows 文件 / 代码管理 / 文件变更 as one accordion after entering a
 * project), the remaining tool panels (Agent 任务 / 使用统计 / 技能 / MCP /
 * 渠道接入) live in Settings, and 「一人公司」/「设置」entered the title bar's
 * top-left corner. Keeping this component as the single sidebar surface means
 * the layout and the panel-activity contract stay in one place.
 */
export default function Sidebar() {
  return (
    <div className="h-full flex flex-col bg-transparent">
      <PanelActivityProvider value>
        <div className="h-full min-h-0 flex-1" data-sidebar-panel="files">
          <ProjectListPanel />
        </div>
      </PanelActivityProvider>
    </div>
  )
}
