import { useEffect, useMemo, useState } from 'react'
import { useMemoryStore } from '@/stores/memoryStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import MemoryAddModal from './MemoryAddModal'

/**
 * Memory manager — project-aware. Memories are injected into the
 * agent's system prompt when they match the current message. Project-scoped
 * memories are only used when the current project matches.
 *
 * 顶栏：项目（可下拉切换到任意已添加项目查看其记忆）+ 条数 + 「添加记忆」按钮。
 * 添加记忆弹出独立对话框，选择保存到哪个项目或全局（原底部输入框已移除）。
 * 注意：这里的项目切换只影响「查看/管理」，不影响记忆上报（注入系统提示词时
 * 仍按当前项目匹配）。
 */
export default function MemoryModal({ onClose, currentProjectPath }: { onClose: () => void; currentProjectPath: string | null }) {
  const memories = useMemoryStore((s) => s.memories)
  const deleteMemory = useMemoryStore((s) => s.deleteMemory)
  const getMemoriesByProject = useMemoryStore((s) => s.getMemoriesByProject)
  const getGlobalMemories = useMemoryStore((s) => s.getGlobalMemories)
  const getProjectPaths = useMemoryStore((s) => s.getProjectPaths)
  const [filterTab, setFilterTab] = useState<'all' | 'global' | 'project'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showOtherProjects, setShowOtherProjects] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [justAdded, setJustAdded] = useState<string | null>(null)
  // 当前查看的项目 — 默认跟随当前项目，可在顶栏下拉切换到别的项目查看其记忆
  const [viewProjectPath, setViewProjectPath] = useState<string | null>(currentProjectPath)
  const t = useI18n()
  // 已添加过的所有项目（左侧项目列表），用于顶栏/添加记忆时选择任意项目查看或保存
  const recentProjects = useUIStore((s) => s.recentProjects)

  // 当前项目切换（例如换了个工作区）时，查看目标跟随当前项目
  useEffect(() => {
    setViewProjectPath(currentProjectPath)
  }, [currentProjectPath])

  const projectName = (p: string) => p.split(/[/\\]/).pop() || p
  const hasProject = !!currentProjectPath

  // 所有可选项目 = 当前项目 + 已添加过的项目（recentProjects）+ 记忆库里出现
  // 过的项目（去重）。只影响查看/管理，记忆上报仍按当前项目匹配，逻辑不变。
  const allProjectPaths = useMemo(() => {
    const paths = new Set<string>()
    if (currentProjectPath) paths.add(currentProjectPath)
    recentProjects.forEach((p) => { if (p) paths.add(p) })
    getProjectPaths().forEach((p) => paths.add(p))
    return Array.from(paths)
  }, [getProjectPaths, currentProjectPath, recentProjects])

  // 下拉当前选中的项目（null = 没有任何项目可看）。未打开项目但记忆库里
  // 有其他项目时，默认查看第一个，保证「下拉选择别的项目查看」始终可用。
  const activeViewPath = viewProjectPath ?? currentProjectPath ?? allProjectPaths[0] ?? null
  const viewedProjectMemories = activeViewPath ? getMemoriesByProject(activeViewPath) : []
  const globalMemories = getGlobalMemories()
  const otherProjectPaths = allProjectPaths.filter((p) => p !== activeViewPath)

  // Filtered & grouped memories
  const { filteredMemories } = useMemo(() => {
    let filtered = [...memories]
    if (filterTab === 'global') filtered = getGlobalMemories()
    else if (filterTab === 'project') filtered = activeViewPath ? getMemoriesByProject(activeViewPath) : []
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter((m) => m.content.toLowerCase().includes(q))
    }
    // Sort: newest first
    filtered.sort((a, b) => b.createdAt - a.createdAt)
    return { filteredMemories: filtered }
  }, [memories, filterTab, searchQuery, activeViewPath, getMemoriesByProject, getGlobalMemories])

  const handleAddSaved = () => {
    setShowAddModal(false)
    setJustAdded(t('chat.memorySaved'))
    setTimeout(() => setJustAdded(null), 2000)
  }

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const shortenPath = (p: string) => {
    const parts = p.split(/[/\\]/)
    if (parts.length <= 2) return p
    return '.../' + parts.slice(-2).join('/')
  }

  const tabCounts = {
    all: memories.length,
    global: globalMemories.length,
    project: viewedProjectMemories.length,
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="w-[640px] max-w-[94vw] max-h-[85vh] flex flex-col rounded-2xl glass-modal" style={{ boxShadow: 'var(--shadow-xl)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-nova-border shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-lg">🧠</span>
            <div>
              <strong className="text-sm text-nova-text-primary">{t('chat.memory')}</strong>
              <div className="text-[11px] text-nova-text-muted">
                {memories.length} 条记忆 · {globalMemories.length} 全局 · {tabCounts.project} 项目
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover p-1 rounded transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Project context bar — 当前项目可下拉切换查看别的项目；右侧添加记忆 */}
        <div className="px-5 py-2.5 border-b border-nova-border shrink-0 flex items-center gap-2 text-[11px]">
          {hasProject ? (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-gray-500 shrink-0" />
          )}
          <span className="text-nova-text-secondary shrink-0">项目:</span>
          <select
            value={activeViewPath ?? ''}
            onChange={(e) => setViewProjectPath(e.target.value || null)}
            title={t('chat.memoryViewProjectHint')}
            className="max-w-[180px] text-[11px] bg-nova-input-bg text-nova-text-primary border border-nova-border rounded px-1.5 py-0.5 outline-none cursor-pointer hover:border-nova-accent/50"
          >
            {allProjectPaths.length === 0 && <option value="">未打开项目</option>}
            {allProjectPaths.map((p) => (
              <option key={p} value={p}>{p === currentProjectPath ? `${projectName(p)}（当前）` : projectName(p)}</option>
            ))}
          </select>
          {!hasProject && allProjectPaths.length === 0 && (
            <span className="text-yellow-400/80 truncate">未打开项目 — 项目范围记忆不可用</span>
          )}
          <span className="text-nova-text-muted ml-auto shrink-0">{viewedProjectMemories.length} 条项目记忆</span>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-white rounded-full hover:opacity-90 transition-all shadow-sm shrink-0"
            style={{ background: 'var(--grad-brand)' }}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            {t('chat.addMemory')}
          </button>
        </div>

        {/* Filter tabs + search */}
        <div className="px-5 py-2.5 border-b border-nova-border shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 bg-nova-hover rounded-lg p-0.5">
              {([
                { key: 'all' as const, label: '全部', icon: '📋' },
                { key: 'global' as const, label: '全局', icon: '🌐' },
                { key: 'project' as const, label: '项目', icon: '📁' },
              ]).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setFilterTab(tab.key)}
                  className={`flex items-center gap-1 px-3 py-1 text-xs rounded-md transition-colors ${
                    filterTab === tab.key
                      ? 'bg-nova-card text-nova-text-primary shadow-sm'
                      : 'text-nova-text-muted hover:text-nova-text-secondary'
                  }`}
                >
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                  <span className="text-[11px] opacity-60">({tabCounts[tab.key]})</span>
                </button>
              ))}
            </div>
            <div className="flex-1 relative">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-nova-text-muted pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8" strokeWidth="2" /><line x1="21" y1="21" x2="16.65" y2="16.65" strokeWidth="2" />
              </svg>
              <input
                type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索记忆..."
                className="w-full pl-7 pr-2 py-1.5 bg-nova-input-bg border border-nova-border rounded-full text-[11px] text-nova-text-primary outline-none focus:border-nova-accent/50 placeholder-nova-text-muted"
              />
            </div>
          </div>
        </div>

        {/* Memory list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {filteredMemories.length === 0 ? (
            <div className="text-center py-10">
              <div className="text-3xl mb-2">🧠</div>
              <div className="text-sm text-nova-text-muted mb-1">
                {searchQuery ? '没有匹配的记忆' : filterTab === 'project' && !activeViewPath ? '未打开项目' : filterTab === 'project' ? t('chat.memoryProjectEmpty') : t('chat.memoryEmpty')}
              </div>
              <div className="text-[11px] text-nova-text-muted">
                {searchQuery ? '尝试其他关键词' : '点击右上角「添加记忆」，AI 助手将记住你的偏好'}
              </div>
            </div>
          ) : (
            <>
              {/* Viewed project memories section */}
              {filterTab === 'all' && activeViewPath && viewedProjectMemories.length > 0 && (
                <div className="mb-1">
                  <div className="flex items-center gap-1.5 mb-1.5 px-1">
                    <span className="text-[11px]">📁</span>
                    <span className="text-[11px] font-semibold text-nova-text-muted uppercase tracking-wider">{projectName(activeViewPath)}</span>
                  </div>
                  {viewedProjectMemories.filter((m) => !searchQuery || m.content.toLowerCase().includes(searchQuery.toLowerCase())).map((m) => (
                    <MemoryCard key={m.id} memory={m} onDelete={deleteMemory} formatDate={formatDate} isProject projectPath={activeViewPath} shortenPath={shortenPath} />
                  ))}
                </div>
              )}

              {/* Global memories section */}
              {filterTab === 'all' && globalMemories.length > 0 && (
                <div className="mb-1">
                  <div className="flex items-center gap-1.5 mb-1.5 px-1">
                    <span className="text-[11px]">🌐</span>
                    <span className="text-[11px] font-semibold text-nova-text-muted uppercase tracking-wider">全局记忆</span>
                  </div>
                  {globalMemories.filter((m) => !searchQuery || m.content.toLowerCase().includes(searchQuery.toLowerCase())).map((m) => (
                    <MemoryCard key={m.id} memory={m} onDelete={deleteMemory} formatDate={formatDate} />
                  ))}
                </div>
              )}

              {/* Other projects section (collapsible) */}
              {filterTab === 'all' && otherProjectPaths.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowOtherProjects(!showOtherProjects)}
                    className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-semibold text-nova-text-muted uppercase tracking-wider hover:text-nova-text-secondary transition-colors w-full text-left"
                  >
                    <span>{showOtherProjects ? '▾' : '▸'}</span>
                    <span>📂</span>
                    <span>其他项目记忆 ({otherProjectPaths.length})</span>
                  </button>
                  {showOtherProjects && otherProjectPaths.map((projPath) => {
                    const projMemories = memories.filter((m) => m.scope === 'project' && m.projectPath === projPath && (!searchQuery || m.content.toLowerCase().includes(searchQuery.toLowerCase())))
                    if (projMemories.length === 0) return null
                    return (
                      <div key={projPath} className="ml-4 mb-1">
                        <div className="text-[11px] text-nova-text-muted px-1 py-0.5 truncate">{shortenPath(projPath)}</div>
                        {projMemories.map((m) => (
                          <MemoryCard key={m.id} memory={m} onDelete={deleteMemory} formatDate={formatDate} isProject projectPath={projPath} shortenPath={shortenPath} />
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Flat list for filtered tabs */}
              {(filterTab !== 'all') && filteredMemories.map((m) => (
                <MemoryCard key={m.id} memory={m} onDelete={deleteMemory} formatDate={formatDate} isProject={m.scope === 'project'} projectPath={m.projectPath} shortenPath={shortenPath} />
              ))}
            </>
          )}
        </div>

        {/* 保存提示 */}
        {justAdded && (
          <div className="px-5 py-1.5 border-t border-nova-border shrink-0">
            <span className="text-xs text-green-400 animate-fade-in">{justAdded}</span>
          </div>
        )}

        {/* 添加记忆对话框 */}
        {showAddModal && (
          <MemoryAddModal
            initialScope={hasProject ? 'project' : 'global'}
            initialProjectPath={currentProjectPath}
            projectPaths={allProjectPaths}
            onClose={() => setShowAddModal(false)}
            onSaved={handleAddSaved}
          />
        )}
      </div>
    </div>
  )
}

/** Single memory card */
function MemoryCard({ memory, onDelete, formatDate, isProject, projectPath, shortenPath }: {
  memory: import('@/types').Memory
  onDelete: (id: string) => void
  formatDate: (ts: number) => string
  isProject?: boolean
  projectPath?: string
  shortenPath?: (p: string) => string
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = memory.content.length > 120

  return (
    <div className="flex items-start gap-2 rounded-xl border border-nova-border bg-nova-card/60 px-3 py-2.5 group hover:border-nova-accent/40 hover:shadow-sm transition-all mb-1.5">
      <span
        className={`mt-0.5 text-[11px] px-1.5 py-0.5 rounded-full shrink-0 font-medium ${
          isProject ? 'bg-purple-500/15 text-purple-400' : 'bg-blue-500/15 text-blue-400'
        }`}
      >
        {isProject ? '📁 项目' : '🌐 全局'}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-nova-text-primary whitespace-pre-wrap break-all">
          {isLong && !expanded ? memory.content.slice(0, 120) + '...' : memory.content}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[11px] text-nova-text-muted">{formatDate(memory.createdAt)}</span>
          {isProject && projectPath && shortenPath && (
            <span className="text-[11px] text-nova-text-muted truncate">{shortenPath(projectPath)}</span>
          )}
          {isLong && (
            <button onClick={() => setExpanded(!expanded)}
              className="text-[11px] text-nova-accent hover:underline">
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      </div>
      <button
        onClick={() => onDelete(memory.id)}
        className="opacity-0 group-hover:opacity-100 text-nova-text-muted hover:text-red-400 transition-all shrink-0 p-0.5"
        title="删除记忆"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  )
}
