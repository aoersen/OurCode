import { useState, useMemo } from 'react'
import { useConfigStore } from '@/stores/configStore'
import { lookupModelMetadata } from '@/types'

interface ModelCompareViewProps {
  onClose: () => void
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f', anthropic: '#d47757', google: '#4285f4', deepseek: '#4f46e5', groq: '#f97316', other: '#2563eb',
}

function getProviderFromModelId(modelId: string): string {
  const lower = modelId.toLowerCase()
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3')) return 'openai'
  if (lower.startsWith('claude')) return 'anthropic'
  if (lower.startsWith('gemini')) return 'google'
  if (lower.startsWith('deepseek')) return 'deepseek'
  return 'other'
}

const PRICING: Record<string, { input: string; output: string }> = {
  'gpt-4o': { input: '$5.00', output: '$15.00' },
  'gpt-4o-mini': { input: '$0.15', output: '$0.60' },
  'gpt-4-turbo': { input: '$10.00', output: '$30.00' },
  'gpt-3.5-turbo': { input: '$0.50', output: '$1.50' },
  'claude-3-opus': { input: '$15.00', output: '$75.00' },
  'claude-3-sonnet': { input: '$3.00', output: '$15.00' },
  'claude-3-haiku': { input: '$0.25', output: '$1.25' },
  'deepseek-chat': { input: '$0.27', output: '$1.10' },
  'deepseek-coder': { input: '$0.27', output: '$1.10' },
  'deepseek-reasoner': { input: '$0.55', output: '$2.19' },
  'gemini-1.5-pro': { input: '$3.50', output: '$10.50' },
  'gemini-1.5-flash': { input: '$0.075', output: '$0.30' },
}

const KNOWLEDGE_CUTOFF: Record<string, string> = {
  'gpt-4o': '2024-06',
  'gpt-4-turbo': '2023-12',
  'claude-3-opus': '2024-08',
  'claude-3-sonnet': '2024-08',
  'deepseek-chat': '2024-07',
  'gemini-1.5-pro': '2024-05',
}

export default function ModelCompareView({ onClose }: ModelCompareViewProps) {
  const models = useConfigStore((s) => s.models)
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showAddDropdown, setShowAddDropdown] = useState(false)

  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return models.filter((m) => !selectedModels.includes(m.id))
    const q = searchQuery.toLowerCase()
    return models.filter((m) => !selectedModels.includes(m.id) && m.id.toLowerCase().includes(q))
  }, [models, searchQuery, selectedModels])

  const toggleModel = (id: string) => {
    setSelectedModels((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id].slice(0, 4)
    )
    setShowAddDropdown(false)
    setSearchQuery('')
  }

  const removeModel = (id: string) => {
    setSelectedModels((prev) => prev.filter((m) => m !== id))
  }

  const getPricing = (id: string) => PRICING[id] || PRICING[id.split('/').pop() || ''] || { input: 'N/A', output: 'N/A' }

  const getCutoff = (id: string) => KNOWLEDGE_CUTOFF[id] || 'N/A'

  const handleExportComparison = () => {
    if (selectedModels.length === 0) return
    let text = '模型对比\n' + '='.repeat(40) + '\n\n'
    for (const id of selectedModels) {
      const meta = lookupModelMetadata(id)
      const pricing = getPricing(id)
      text += `**${id}** (${getProviderFromModelId(id)})\n`
      text += `  上下文: ${meta?.contextWindow ? Math.round(meta.contextWindow / 1000) + 'K' : 'N/A'}\n`
      text += `  视觉: ${meta?.vision ? '✓' : '✗'} | 函数调用: ${meta?.functionCall ? '✓' : '✗'}\n`
      text += `  输入: ${pricing.input} | 输出: ${pricing.output}\n\n`
    }
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-modal rounded-2xl w-[880px] max-w-[96vw] max-h-[85vh] flex flex-col overflow-hidden" style={{ boxShadow: 'var(--shadow-xl)' }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nova-border shrink-0">
          <div className="flex items-center gap-2.5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            <h2 className="text-sm font-semibold text-nova-text-primary">模型对比</h2>
            <span className="text-[10px] text-nova-text-muted">最多 4 个模型</span>
          </div>
          <div className="flex items-center gap-2">
            {selectedModels.length > 1 && (
              <button onClick={handleExportComparison}
                className="px-3 py-1.5 text-[11px] bg-nova-hover text-nova-text-secondary rounded-md hover:text-nova-text-primary transition-colors flex items-center gap-1">
                📋 复制对比
              </button>
            )}
            <div className="relative">
              <button onClick={() => setShowAddDropdown(!showAddDropdown)}
                className="px-3 py-1.5 text-[11px] bg-nova-accent/15 text-nova-accent rounded-md hover:bg-nova-accent/25 transition-colors flex items-center gap-1">
                <span>+ 添加模型</span>
              </button>
              {showAddDropdown && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowAddDropdown(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-nova-surface border border-nova-border rounded-xl shadow-2xl overflow-hidden">
                    <div className="p-2">
                      <input
                        type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="搜索模型..."
                        autoFocus
                        className="w-full px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded text-xs text-nova-text-primary outline-none focus:border-nova-accent/50 mb-2"
                      />
                      <div className="max-h-48 overflow-y-auto space-y-0.5">
                        {filteredModels.slice(0, 20).map((m) => (
                          <button key={m.id} onClick={() => toggleModel(m.id)}
                            className="w-full text-left px-2.5 py-1.5 text-xs text-nova-text-secondary hover:bg-nova-hover rounded transition-colors flex items-center gap-2">
                            <div className="w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold shrink-0"
                              style={{ background: `${PROVIDER_COLORS[getProviderFromModelId(m.id)] || '#2563eb'}20`, color: PROVIDER_COLORS[getProviderFromModelId(m.id)] || '#2563eb' }}>
                              {getProviderFromModelId(m.id).charAt(0).toUpperCase()}
                            </div>
                            <span className="truncate">{m.id.split('/').pop() || m.id}</span>
                          </button>
                        ))}
                        {filteredModels.length === 0 && (
                          <div className="text-xs text-nova-text-muted text-center py-3">没有更多模型</div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
            <button onClick={onClose} className="p-1.5 text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover rounded transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* Content */}
        {selectedModels.length > 0 ? (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-nova-border bg-nova-hover/30 sticky top-0 z-10">
                  <th className="text-left px-4 py-2.5 font-semibold text-nova-text-secondary w-[140px] shrink-0">属性</th>
                  {selectedModels.map((id) => {
                    const provider = getProviderFromModelId(id)
                    return (
                      <th key={id} className="px-3 py-2.5 text-left min-w-[160px]">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold shrink-0"
                            style={{ background: `${PROVIDER_COLORS[provider] || '#2563eb'}20`, color: PROVIDER_COLORS[provider] || '#2563eb' }}>
                            {provider.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-nova-text-primary truncate">{id.split('/').pop() || id}</div>
                            <div className="text-[10px] text-nova-text-muted">{provider}</div>
                          </div>
                          <button onClick={() => removeModel(id)}
                            className="ml-auto text-nova-text-muted hover:text-red-400 transition-colors p-0.5">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
                          </button>
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {/* Provider row */}
                <tr className="border-b border-nova-border/50 hover:bg-nova-hover/20">
                  <td className="px-4 py-2.5 text-nova-text-muted font-medium">提供商</td>
                  {selectedModels.map((id) => {
                    const p = getProviderFromModelId(id)
                    return (
                      <td key={id} className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
                          style={{ background: `${PROVIDER_COLORS[p] || '#2563eb'}15`, color: PROVIDER_COLORS[p] || '#2563eb' }}>
                          {p}
                        </span>
                      </td>
                    )
                  })}
                </tr>

                {/* Context window */}
                <tr className="border-b border-nova-border/50 hover:bg-nova-hover/20">
                  <td className="px-4 py-2.5 text-nova-text-muted font-medium">上下文窗口</td>
                  {selectedModels.map((id) => {
                    const meta = lookupModelMetadata(id)
                    const ctx = meta?.contextWindow
                    return (
                      <td key={id} className="px-3 py-2.5">
                        <span className={`font-mono text-nova-text-primary ${ctx && ctx >= 131072 ? 'text-green-400' : ''}`}>
                          {ctx ? (ctx >= 1048576 ? `${Math.round(ctx / 1048576)}M tokens` : `${Math.round(ctx / 1000)}K tokens`) : 'N/A'}
                        </span>
                        {ctx && (
                          <div className="mt-1 w-full h-1 bg-nova-hover rounded-full overflow-hidden max-w-[100px]">
                            <div className="h-full bg-nova-accent/60 rounded-full" style={{ width: `${Math.min(100, (ctx / 1048576) * 100)}%` }} />
                          </div>
                        )}
                      </td>
                    )
                  })}
                </tr>

                {/* Knowledge cutoff */}
                <tr className="border-b border-nova-border/50 hover:bg-nova-hover/20">
                  <td className="px-4 py-2.5 text-nova-text-muted font-medium">知识截止</td>
                  {selectedModels.map((id) => (
                    <td key={id} className="px-3 py-2.5">
                      <span className="text-nova-text-primary">{getCutoff(id)}</span>
                    </td>
                  ))}
                </tr>

                {/* Vision */}
                <tr className="border-b border-nova-border/50 hover:bg-nova-hover/20">
                  <td className="px-4 py-2.5 text-nova-text-muted font-medium">视觉能力</td>
                  {selectedModels.map((id) => {
                    const meta = lookupModelMetadata(id)
                    return (
                      <td key={id} className="px-3 py-2.5">
                        {meta?.vision ? (
                          <span className="text-green-400 flex items-center gap-1"><span>✓</span> 支持</span>
                        ) : (
                          <span className="text-nova-text-muted flex items-center gap-1"><span>✗</span> 不支持</span>
                        )}
                      </td>
                    )
                  })}
                </tr>

                {/* Function calling */}
                <tr className="border-b border-nova-border/50 hover:bg-nova-hover/20">
                  <td className="px-4 py-2.5 text-nova-text-muted font-medium">函数调用</td>
                  {selectedModels.map((id) => {
                    const meta = lookupModelMetadata(id)
                    return (
                      <td key={id} className="px-3 py-2.5">
                        {meta?.functionCall ? (
                          <span className="text-green-400 flex items-center gap-1"><span>✓</span> 支持</span>
                        ) : (
                          <span className="text-nova-text-muted flex items-center gap-1"><span>✗</span> 不支持</span>
                        )}
                      </td>
                    )
                  })}
                </tr>

                {/* Input price */}
                <tr className="border-b border-nova-border/50 hover:bg-nova-hover/20">
                  <td className="px-4 py-2.5 text-nova-text-muted font-medium">输入价格 /1M tokens</td>
                  {selectedModels.map((id) => {
                    const price = getPricing(id).input
                    const isFree = price === '$0.00' || price === 'Free'
                    return (
                      <td key={id} className="px-3 py-2.5">
                        <span className={`font-mono ${isFree ? 'text-green-400' : 'text-nova-text-primary'}`}>
                          {isFree ? '免费 🎉' : price}
                        </span>
                      </td>
                    )
                  })}
                </tr>

                {/* Output price */}
                <tr className="border-b border-nova-border/50 hover:bg-nova-hover/20">
                  <td className="px-4 py-2.5 text-nova-text-muted font-medium">输出价格 /1M tokens</td>
                  {selectedModels.map((id) => {
                    const price = getPricing(id).output
                    return (
                      <td key={id} className="px-3 py-2.5">
                        <span className="font-mono text-nova-text-primary">{price}</span>
                      </td>
                    )
                  })}
                </tr>
              </tbody>
            </table>

            {/* Summary cards at bottom */}
            <div className="p-4 border-t border-nova-border">
              <div className="text-[10px] text-nova-text-muted mb-2">💡 提示：点击「复制对比」可将对比结果复制到剪贴板，或直接在下方查看详情</div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: 'rgba(37,99,235,0.1)' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round">
                <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </div>
            <div className="text-sm font-semibold text-nova-text-primary mb-1">选择模型进行对比</div>
            <div className="text-xs text-nova-text-muted mb-4 max-w-xs">
              点击上方「+ 添加模型」按钮，选择 2-4 个模型以并排对比它们的规格和价格
            </div>
            <button onClick={() => setShowAddDropdown(true)}
              className="px-4 py-2 text-xs bg-nova-accent text-white rounded-lg hover:opacity-90 transition-opacity">
              + 添加模型
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
