import { useState, useMemo } from 'react'
import { useWorkflowStore } from '@/stores/workflowStore'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useI18n } from '@/i18n/useI18n'
import ModalPortal from '../Common/ModalPortal'

const CATEGORIES = [
  { key: 'all', label: '全部', icon: '📋' },
  { key: 'code-gen', label: '代码生成', icon: '⚡' },
  { key: 'review', label: '代码审查', icon: '🔍' },
  { key: 'refactor', label: '重构', icon: '🔧' },
  { key: 'docs', label: '文档', icon: '📝' },
  { key: 'debug', label: '调试', icon: '🐛' },
  { key: 'other', label: '其他', icon: '📌' },
]

type WorkflowCategory = typeof CATEGORIES[number]['key']

/** Simple keyword-based category detection */
function detectCategory(name: string, description: string, prompt: string): WorkflowCategory {
  const text = (name + ' ' + description + ' ' + prompt).toLowerCase()
  if (text.includes('生成') || text.includes('generate') || text.includes('create') || text.includes('写') || text.includes('write')) return 'code-gen'
  if (text.includes('审查') || text.includes('review') || text.includes('检查') || text.includes('check') || text.includes('lint')) return 'review'
  if (text.includes('重构') || text.includes('refactor') || text.includes('优化') || text.includes('optimize') || text.includes('改进')) return 'refactor'
  if (text.includes('文档') || text.includes('doc') || text.includes('注释') || text.includes('comment') || text.includes('readme')) return 'docs'
  if (text.includes('调试') || text.includes('debug') || text.includes('修复') || text.includes('fix') || text.includes('bug')) return 'debug'
  return 'other'
}

const CATEGORY_COLORS: Record<string, string> = {
  'code-gen': '#10b981', 'review': '#f59e0b', 'refactor': '#8b5cf6', 'docs': '#3b82f6', 'debug': '#ef4444', 'other': '#6b7280',
}

export default function WorkflowModal({ onClose }: { onClose: () => void }) {
  const workflows = useWorkflowStore((s) => s.workflows)
  const addWorkflow = useWorkflowStore((s) => s.addWorkflow)
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [saved, setSaved] = useState(false)
  const [activeCategory, setActiveCategory] = useState<WorkflowCategory>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const t = useI18n()

  const resetForm = () => {
    setName('')
    setDescription('')
    setPrompt('')
    setEditingId(null)
  }

  const handleSave = async () => {
    if (!prompt.trim()) return
    if (editingId) {
      // Edit mode: delete old + create new
      await deleteWorkflow(editingId)
    }
    await addWorkflow({
      name: name.trim() || t('chat.workflowUntitled'),
      description: description.trim(),
      prompt: prompt.trim(),
    })
    resetForm()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleEdit = (w: typeof workflows[0]) => {
    setName(w.name)
    setDescription(w.description)
    setPrompt(w.prompt)
    setEditingId(w.id)
  }

  const handleRun = async (p: string) => {
    const chatStore = useChatStore.getState()
    if (!chatStore.activeSessionId) {
      const configStore = useConfigStore.getState()
      if (configStore.activeConfigGroupId) {
        chatStore.createSession(configStore.activeConfigGroupId)
      } else {
        alert(t('chat.configureApiKey'))
        return
      }
    }
    if (chatStore.activeSessionId) await chatStore.sendMessage(chatStore.activeSessionId, p)
    onClose()
  }

  const filteredWorkflows = useMemo(() => {
    let result = [...workflows]
    if (activeCategory !== 'all') {
      result = result.filter((w) => detectCategory(w.name, w.description, w.prompt) === activeCategory)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter((w) =>
        w.name.toLowerCase().includes(q) ||
        w.description.toLowerCase().includes(q) ||
        w.prompt.toLowerCase().includes(q)
      )
    }
    return result
  }, [workflows, activeCategory, searchQuery])

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="w-[720px] max-w-[94vw] max-h-[85vh] flex flex-col rounded-2xl glass-modal" style={{ boxShadow: 'var(--shadow-xl)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-nova-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">🔁</span>
            <div>
              <strong className="text-sm text-nova-text-primary">{t('chat.workflowManage')}</strong>
              <div className="text-[11px] text-nova-text-muted">{t('chat.workflowSubtitle')} · {workflows.length} 个工作流</div>
            </div>
          </div>
          <button onClick={onClose} className="text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover p-1 rounded transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Category tabs + search */}
        <div className="px-5 py-2.5 border-b border-nova-border shrink-0 space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {CATEGORIES.map((cat) => {
              const count = cat.key === 'all'
                ? workflows.length
                : workflows.filter((w) => detectCategory(w.name, w.description, w.prompt) === cat.key).length
              return (
                <button
                  key={cat.key}
                  onClick={() => setActiveCategory(cat.key)}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-full border transition-colors ${
                    activeCategory === cat.key
                      ? 'border-nova-accent bg-nova-accent/10 text-nova-accent'
                      : 'border-transparent text-nova-text-muted hover:text-nova-text-secondary hover:bg-nova-hover'
                  }`}
                >
                  <span>{cat.icon}</span>
                  <span>{cat.label}</span>
                  {count > 0 && <span className="text-[11px] opacity-60">({count})</span>}
                </button>
              )
            })}
          </div>
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-nova-text-muted pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" strokeWidth="2" /><line x1="21" y1="21" x2="16.65" y2="16.65" strokeWidth="2" />
            </svg>
            <input
              type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索工作流..."
              className="w-full pl-7 pr-2 py-1.5 bg-nova-input-bg border border-nova-border rounded-full text-[11px] text-nova-text-primary outline-none focus:border-nova-accent/50 placeholder-nova-text-muted"
            />
          </div>
        </div>

        {/* Workflow list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {filteredWorkflows.length === 0 ? (
            <div className="text-center py-10">
              <div className="text-3xl mb-2">🔁</div>
              <div className="text-sm text-nova-text-muted mb-1">
                {searchQuery ? '没有匹配的工作流' : t('chat.workflowEmpty')}
              </div>
              <div className="text-[11px] text-nova-text-muted">
                创建一个可复用的提示词模板，随时对当前项目运行
              </div>
            </div>
          ) : (
            filteredWorkflows.map((w) => {
              const category = detectCategory(w.name, w.description, w.prompt)
              const catColor = CATEGORY_COLORS[category] || '#6b7280'
              return (
                <div
                  key={w.id}
                  className="flex items-start gap-3 rounded-xl border border-nova-border bg-nova-card/70 hover:border-nova-accent/40 hover:shadow-sm transition-all p-3.5 group"
                >
                  {/* Category icon */}
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-sm"
                    style={{ background: `${catColor}15`, color: catColor }}>
                    {CATEGORIES.find((c) => c.key === category)?.icon || '📌'}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-semibold text-nova-text-primary">{w.name}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                        style={{ background: `${catColor}15`, color: catColor }}>
                        {CATEGORIES.find((c) => c.key === category)?.label || '其他'}
                      </span>
                    </div>
                    {w.description && (
                      <div className="text-[11px] text-nova-text-muted mb-1 truncate">{w.description}</div>
                    )}
                    <pre className="text-[11px] text-nova-text-secondary whitespace-pre-wrap break-all max-h-12 overflow-hidden opacity-70 leading-relaxed">{w.prompt}</pre>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleRun(w.prompt)}
                      className="px-3 py-1.5 text-xs text-white rounded-full hover:opacity-90 transition-all shadow-sm" style={{ background: 'var(--grad-brand)' }}
                    >
                      {t('chat.workflowRun')}
                    </button>
                    <button
                      onClick={() => handleEdit(w)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 text-nova-text-muted hover:text-nova-accent transition-all rounded"
                      title="编辑工作流"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => deleteWorkflow(w.id)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 text-nova-text-muted hover:text-red-400 transition-all rounded"
                      title={t('chat.deleteWorkflow')}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Add / Edit form */}
        <div className="px-5 py-4 border-t border-nova-border shrink-0 space-y-2">
          <div className="flex items-center gap-2 text-[11px] text-nova-text-muted mb-1">
            <span className="w-1 h-1 rounded-full bg-nova-accent" />
            {editingId ? '编辑工作流' : '新建工作流'}
          </div>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('chat.workflowNamePlaceholder')}
              className="flex-1 px-3 py-1.5 text-xs bg-nova-bg border border-nova-border rounded-lg outline-none focus:border-nova-accent/60 text-nova-text-primary placeholder:text-nova-text-muted"
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('chat.workflowDescPlaceholder')}
              className="flex-1 px-3 py-1.5 text-xs bg-nova-bg border border-nova-border rounded-lg outline-none focus:border-nova-accent/60 text-nova-text-primary placeholder:text-nova-text-muted"
            />
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('chat.workflowPromptPlaceholder')}
            rows={2}
            className="w-full px-3 py-2 text-sm bg-nova-bg border border-nova-border rounded-lg outline-none focus:border-nova-accent/60 text-nova-text-primary placeholder:text-nova-text-muted resize-none"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-nova-text-muted">
              提示词中可使用 {'{selection}'} 引用选中的代码
            </span>
            <div className="flex items-center gap-2">
              {editingId && (
                <button onClick={resetForm}
                  className="px-3 py-1.5 text-xs text-nova-text-muted hover:text-nova-text-primary transition-colors">
                  取消编辑
                </button>
              )}
              {saved && <span className="text-xs text-green-400">{t('chat.saved')}</span>}
              <button
                onClick={handleSave}
                disabled={!prompt.trim()}
                className="px-4 py-1.5 text-xs text-white rounded-lg disabled:opacity-30 hover:opacity-90 transition-opacity"
                style={{ background: 'var(--grad-brand)' }}
              >
                {editingId ? '更新工作流' : t('chat.saveWorkflow')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    </ModalPortal>
  )
}
