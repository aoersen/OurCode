import { useMemo } from 'react'
import ProjectListPanel from './ProjectListPanel'
import FileChangesPanel from './FileChangesPanel'
import AgentTasksPanel from './AgentTasksPanel'
import UsagePanel from './UsagePanel'
import SkillPanel from '../Skills/SkillPanel'
import McpPanel from '../Mcp/McpPanel'
import GitPanel from '../Git/GitPanel'
import BrowserPanel from '../Browser/BrowserPanel'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'

export default function Sidebar() {
  const activeSidebarTab = useUIStore((s) => s.activeSidebarTab)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const rootPath = useUIStore((s) => s.rootPath)
  const projectListView = useUIStore((s) => s.projectListView)
  const t = useI18n()

  const headerTitle = useMemo(() => {
    switch (activeSidebarTab) {
      case 'files':
        return projectListView === 'tree' && rootPath
          ? (rootPath.split(/[/\\]/).pop() || '项目')
          : '项目列表'
      case 'git':
        return '代码管理'
      case 'changes':
        return '文件变更历史'
      case 'agent':
        return t('agent.tasksPanelTitle')
      case 'usage':
        return t('usage.panelTitle')
      case 'mcp':
        return 'MCP 服务器'
      case 'skills':
        return t('skillPanel.title')
      default:
        return ''
    }
    // `t` must be a dependency — otherwise switching the app language leaves
    // the panel title in the old locale until another dep happens to change.
  }, [activeSidebarTab, projectListView, rootPath, t])

  // Sidebar header icon
  const HeaderIcon = () => {
    if (activeSidebarTab === 'files') {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      )
    }
    if (activeSidebarTab === 'git') {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" />
          <line x1="6" y1="8.5" x2="6" y2="15.5" />
          <path d="M6 12C6 12 12 9 15.5 6" /><path d="M6 12C6 12 12 15 15.5 18" />
        </svg>
      )
    }
    if (activeSidebarTab === 'changes') {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
          <path d="M14 2v6h6" />
          <path d="M12.2 17.8l.9-2.6 4.2-4.2 1.7 1.7-4.2 4.2-2.6.9z" />
        </svg>
      )
    }
    if (activeSidebarTab === 'agent') {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="8" width="16" height="12" rx="2" />
          <path d="M12 8V4" />
          <circle cx="12" cy="3" r="1.2" />
          <path d="M9 13h.01M15 13h.01M9 17h6" />
        </svg>
      )
    }
    if (activeSidebarTab === 'usage') {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="20" x2="4" y2="14" />
          <line x1="10" y1="20" x2="10" y2="6" />
          <line x1="16" y1="20" x2="16" y2="11" />
          <line x1="22" y1="20" x2="22" y2="3" />
          <path d="M2 20h22" />
        </svg>
      )
    }
    if (activeSidebarTab === 'skills') {
      return (
        <svg width="14" height="14" viewBox="0 0 1024 1024" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M823.296 64.96l135.744 135.744-769.28 769.28-135.808-135.68L823.296 64.96z m0 108.544L162.432 834.24l27.2 27.136L850.432 200.704l-27.2-27.2zM803.2 512a15.68 15.68 0 0 1 15.232 14.336 146.88 146.88 0 0 0 127.68 133.12 15.68 15.68 0 0 1-0.64 31.232 146.752 146.752 0 0 0-133.12 127.744 15.68 15.68 0 0 1-31.104-0.64 146.816 146.816 0 0 0-127.488-133.184 15.68 15.68 0 0 1 0.64-31.232 146.752 146.752 0 0 0 132.992-127.744 15.68 15.68 0 0 1 12.032-13.248l3.84-0.384z m-576-448a15.68 15.68 0 0 1 15.232 14.336 146.88 146.88 0 0 0 127.68 133.12 15.68 15.68 0 0 1-0.64 31.232 146.752 146.752 0 0 0-133.12 127.744 15.68 15.68 0 0 1-31.104-0.64 146.816 146.816 0 0 0-127.488-133.184 15.68 15.68 0 0 1 0.64-31.232 146.752 146.752 0 0 0 132.992-127.744 15.68 15.68 0 0 1 12.032-13.248L227.328 64z m282.624 0a10.24 10.24 0 0 1 10.496 8.832c3.328 23.36 22.4 41.216 45.952 42.944a10.24 10.24 0 0 1 0.64 20.48 50.112 50.112 0 0 0-42.944 45.888 10.24 10.24 0 0 1-20.48 0.64 50.112 50.112 0 0 0-45.888-42.944 10.24 10.24 0 0 1-0.64-20.416 50.112 50.112 0 0 0 42.944-45.952 10.24 10.24 0 0 1 6.912-8.96L509.888 64z" />
        </svg>
      )
    }
    if (activeSidebarTab === 'mcp') {
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      )
    }
    return null
  }

  return (
    <div className="h-full flex flex-col bg-transparent">
      {/* Sidebar Header — files 页的标题/返回/折叠都在面板内部（列表视图标题行、树视图「← 项目列表」行），头栏不渲染以免顶部留大片空白；skills 页同理（SkillPanel 自带 header：管理按钮 + 折叠） */}
      {activeSidebarTab !== 'files' && activeSidebarTab !== 'skills' && (
        <div
          className="flex items-center justify-between shrink-0"
          style={{ padding: '0 12px', height: 36 }}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-nova-text-muted flex items-center">
              <HeaderIcon />
            </span>
            <span
              className="font-bold uppercase tracking-[0.08em]"
              style={{ fontSize: 11, color: 'var(--text-secondary)', letterSpacing: '0.08em' }}
            >
              {headerTitle}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            {activeSidebarTab === 'changes' && (
              <button
                onClick={() => window.location.reload()}
                className="w-6 h-6 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
                title="刷新"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            )}
            <button
              onClick={toggleSidebar}
              className="w-6 h-6 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
              title={t('sidebar.collapse')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeSidebarTab === 'files' ? (
          <ProjectListPanel />
        ) : activeSidebarTab === 'git' ? (
          <GitPanel />
        ) : activeSidebarTab === 'changes' ? (
          <FileChangesPanel />
        ) : activeSidebarTab === 'agent' ? (
          <AgentTasksPanel />
        ) : activeSidebarTab === 'usage' ? (
          <UsagePanel />
        ) : activeSidebarTab === 'skills' ? (
          <SkillPanel />
        ) : activeSidebarTab === 'mcp' ? (
          <McpPanel />
        ) : activeSidebarTab === 'browser' ? (
          <BrowserPanel />
        ) : null}
      </div>
    </div>
  )
}
