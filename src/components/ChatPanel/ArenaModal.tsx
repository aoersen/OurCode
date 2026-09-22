import { useState, useCallback, useMemo } from 'react'
import { useConfigStore } from '@/stores/configStore'
import { useChatStore } from '@/stores/chatStore'
import { runArenaPrompt, ArenaResult } from '@/services/arena'
import MarkdownRenderer from '../Common/MarkdownRenderer'
import ModalPortal from '../Common/ModalPortal'
import { lookupModelMetadata } from '@/types'
import { useI18n } from '@/i18n/useI18n'

function getProviderFromModelId(modelId: string): string {
  const lower = modelId.toLowerCase()
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3')) return 'openai'
  if (lower.startsWith('claude')) return 'anthropic'
  if (lower.startsWith('gemini')) return 'google'
  if (lower.startsWith('deepseek')) return 'deepseek'
  return 'other'
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f', anthropic: '#d47757', google: '#4285f4', deepseek: '#4f46e5', other: '#2563eb',
}

/**
 * Arena — parallel model comparison. Run the same prompt on
 * several models and adopt the best answer into the conversation.
 */
export default function ArenaModal({ onClose }: { onClose: () => void }) {
  const models = useConfigStore((s) => s.models)
  const getActiveConfigGroup = useConfigStore((s) => s.getActiveConfigGroup)

  const activeSession = useChatStore((s) => s.getActiveSession())
  const addMessage = useChatStore((s) => s.addMessage)
  const saveSession = useChatStore((s) => s.saveSession)
  const t = useI18n()

  // Default prompt = last user message
  const lastUserMessage = [...(activeSession?.messages || [])].reverse().find((m) => m.role === 'user')
  const [prompt, setPrompt] = useState(lastUserMessage?.content || '')
  const [selected, setSelected] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<ArenaResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return models
    const q = searchQuery.toLowerCase()
    return models.filter((m) => m.id.toLowerCase().includes(q))
  }, [models, searchQuery])

  const toggleModel = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]))
  }

  const handleRun = useCallback(async () => {
    if (!prompt.trim() || selected.length < 2) return
    const configGroup = getActiveConfigGroup()
    if (!configGroup) return
    setRunning(true)
    setError(null)
    setResults([])
    try {
      const res = await runArenaPrompt(prompt.trim(), selected, configGroup)
      setResults(res)
    } catch (e: any) {
      setError(e.message || t('chat.arenaRunFailed'))
    } finally {
      setRunning(false)
    }
  }, [prompt, selected, getActiveConfigGroup, t])

  const adopt = (result: ArenaResult) => {
    if (!activeSession || !result.content) return
    addMessage(activeSession.id, {
      role: 'assistant',
      content: result.content,
      contextFiles: [],
    })
    saveSession(activeSession.id)
    onClose()
  }

  const adoptAll = () => {
    if (!activeSession) return
    const combined = results
      .filter((r) => !r.error && r.content)
      .map((r) => `## ${r.model}\n\n${r.content}`)
      .join('\n\n---\n\n')
    if (combined) {
      addMessage(activeSession.id, {
        role: 'assistant',
        content: combined,
        contextFiles: [],
      })
      saveSession(activeSession.id)
      onClose()
    }
  }

  const maxDuration = Math.max(...results.map((r) => r.durationMs), 1)

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="w-[900px] max-w-[95vw] max-h-[90vh] flex flex-col rounded-2xl glass-modal" style={{ boxShadow: 'var(--shadow-xl)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-nova-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚖️</span>
            <div>
              <strong className="text-sm text-nova-text-primary">{t('chat.arenaCompare')}</strong>
              <div className="text-[10px] text-nova-text-muted">{t('chat.arenaSubtitle')}</div>
            </div>
          </div>
          <button onClick={onClose} className="text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover p-1 rounded transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Prompt & model selection */}
        <div className="px-5 py-4 border-b border-nova-border shrink-0 space-y-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('chat.arenaPlaceholder')}
            rows={2}
            className="w-full px-3 py-2 text-sm bg-nova-bg border border-nova-border rounded-lg outline-none focus:border-nova-accent/60 text-nova-text-primary placeholder:text-nova-text-muted resize-none"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-xs text-nova-text-muted shrink-0">{t('chat.arenaSelectModels')}:</span>
              <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
                {selected.map((id) => {
                  const provider = getProviderFromModelId(id)
                  return (
                    <span key={id}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border border-nova-accent/40 bg-nova-accent/10 text-nova-accent">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: PROVIDER_COLORS[provider] || '#2563eb' }} />
                      <span className="truncate max-w-[100px]">{id.split('/').pop() || id}</span>
                      <button onClick={() => toggleModel(id)} className="text-nova-text-muted hover:text-red-400 ml-0.5">×</button>
                    </span>
                  )
                })}
                {selected.length === 0 && (
                  <span className="text-[10px] text-nova-text-muted">{t('chat.arenaNoModels')}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative">
                <button onClick={() => setShowModelPicker(!showModelPicker)}
                  className="px-2.5 py-1 text-[11px] bg-nova-hover text-nova-text-secondary rounded-md hover:text-nova-text-primary transition-colors">
                  + 添加
                </button>
                {showModelPicker && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowModelPicker(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-nova-surface border border-nova-border rounded-xl shadow-2xl overflow-hidden">
                      <div className="p-2">
                        <input
                          type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="搜索模型..." autoFocus
                          className="w-full px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded text-[11px] text-nova-text-primary outline-none focus:border-nova-accent/50 mb-2"
                        />
                        <div className="max-h-44 overflow-y-auto space-y-0.5">
                          {filteredModels.slice(0, 30).map((m) => {
                            const isSel = selected.includes(m.id)
                            return (
                              <button key={m.id} onClick={() => toggleModel(m.id)}
                                className={`w-full text-left px-2.5 py-1.5 text-[11px] rounded transition-colors flex items-center gap-2 ${
                                  isSel ? 'bg-nova-accent/10 text-nova-accent' : 'text-nova-text-secondary hover:bg-nova-hover'
                                }`}>
                                <span className={`w-3 h-3 rounded border ${isSel ? 'bg-nova-accent border-nova-accent' : 'border-nova-border'}`}>
                                  {isSel && <svg viewBox="0 0 24 24" fill="white" className="w-3 h-3"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>}
                                </span>
                                <span className="truncate">{m.id.split('/').pop() || m.id}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={handleRun}
                disabled={running || !prompt.trim() || selected.length < 2}
                className="px-4 py-1.5 text-xs text-white rounded-lg disabled:opacity-30 hover:opacity-90 transition-opacity"
                style={{ background: 'var(--grad-brand)' }}
              >
                {running ? '⏳ ' + t('chat.arenaRunning') : t('chat.arenaStart', { count: selected.length })}
              </button>
            </div>
          </div>
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20">{error}</div>
          )}
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {results.length === 0 && !running && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="text-4xl mb-3">⚖️</div>
              <div className="text-sm text-nova-text-muted mb-1">{t('chat.arenaEmpty')}</div>
              <div className="text-[11px] text-nova-text-muted">选择至少 2 个模型并输入提示词开始对比</div>
            </div>
          )}

          {/* Duration comparison bar */}
          {results.length > 0 && (
            <div className="mb-4 p-3 bg-nova-card/70 rounded-xl border border-nova-border">
              <div className="text-[10px] font-semibold text-nova-text-muted uppercase tracking-wider mb-2">⏱ 响应耗时对比</div>
              <div className="space-y-1.5">
                {results.map((r) => {
                  const pct = maxDuration > 0 ? (r.durationMs / maxDuration) * 100 : 0
                  return (
                    <div key={r.model} className="flex items-center gap-2">
                      <span className="text-[10px] text-nova-text-secondary w-[120px] truncate shrink-0">{r.model}</span>
                      <div className="flex-1 h-3 bg-nova-hover rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${pct}%`,
                            background: r.error ? '#ef4444' : `linear-gradient(90deg, var(--accent), #8b5cf6)`,
                          }}
                        />
                      </div>
                      <span className="text-[10px] text-nova-text-muted font-mono w-[40px] text-right shrink-0">
                        {r.error ? '❌' : `${(r.durationMs / 1000).toFixed(1)}s`}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Result cards */}
          <div className="grid gap-3" style={{ gridTemplateColumns: results.length > 1 ? 'repeat(auto-fit, minmax(260px, 1fr))' : '1fr' }}>
            {results.map((r) => {
              const meta = lookupModelMetadata(r.model)
              const provider = getProviderFromModelId(r.model)
              const isFastest = r.durationMs === Math.min(...results.filter((x) => !x.error).map((x) => x.durationMs))
              return (
                <div key={r.model} className="rounded-xl border border-nova-border bg-nova-card/70 overflow-hidden flex flex-col hover:border-nova-accent/40 hover:shadow-sm transition-all">
                  {/* Card header */}
                  <div className="flex items-center gap-2 px-3 py-2.5 border-b border-nova-border/60 bg-nova-hover/20">
                    <div className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0"
                      style={{ background: `${PROVIDER_COLORS[provider] || '#2563eb'}20`, color: PROVIDER_COLORS[provider] || '#2563eb' }}>
                      {provider.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-nova-text-primary truncate block">{r.model.split('/').pop() || r.model}</span>
                      {meta?.contextWindow && (
                        <span className="text-[11px] text-nova-text-muted">{Math.round(meta.contextWindow / 1000)}K context</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isFastest && !r.error && (
                        <span className="text-[11px] px-1 py-0.5 rounded bg-green-500/15 text-green-400">最快 🚀</span>
                      )}
                      <span className="text-[10px] text-nova-text-muted font-mono">
                        {(r.durationMs / 1000).toFixed(1)}s
                      </span>
                    </div>
                  </div>

                  {/* Card body */}
                  <div className="flex-1 px-3 py-2.5 text-xs text-nova-text-secondary max-h-56 overflow-y-auto">
                    {r.error ? (
                      <span className="text-red-400 text-[11px]">❌ {r.error}</span>
                    ) : (
                      <MarkdownRenderer content={r.content} />
                    )}
                  </div>

                  {/* Card actions */}
                  {!r.error && r.content && (
                    <div className="flex items-center gap-2 px-3 py-2 border-t border-nova-border/50">
                      <button
                        onClick={() => adopt(r)}
                        className="px-3 py-1.5 text-xs text-white rounded-lg hover:opacity-90 transition-opacity"
                        style={{ background: 'var(--grad-brand)' }}
                      >
                        {t('chat.arenaAdopt')}
                      </button>
                      <button
                        onClick={() => navigator.clipboard.writeText(r.content)}
                        className="px-3 py-1.5 text-xs text-nova-text-muted hover:text-nova-text-primary rounded-lg hover:bg-nova-hover transition-colors"
                      >
                        📋 {t('common.copy')}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Loading state */}
          {running && results.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full animate-think-bounce" style={{ background: '#838485' }} />
                <span className="w-2 h-2 rounded-full animate-think-bounce" style={{ background: '#838485', animationDelay: '0.2s' }} />
                <span className="w-2 h-2 rounded-full animate-think-bounce" style={{ background: '#838485', animationDelay: '0.4s' }} />
              </div>
              <div className="text-sm text-nova-text-muted">{t('chat.arenaInferring')}</div>
              <div className="text-[11px] text-nova-text-muted">
                正在并行调用 {selected.length} 个模型...
              </div>
            </div>
          )}
        </div>

        {/* Adopt all button */}
        {results.length > 0 && results.some((r) => !r.error && r.content) && (
          <div className="px-5 py-3 border-t border-nova-border shrink-0 flex items-center justify-between">
            <span className="text-[10px] text-nova-text-muted">
              点击「采纳此回答」将单个结果添加到对话 · 或
            </span>
            <button
              onClick={adoptAll}
              className="px-4 py-1.5 text-xs text-white rounded-lg hover:opacity-90 transition-opacity"
              style={{ background: 'var(--grad-brand)' }}
            >
              📥 采纳全部回答
            </button>
          </div>
        )}
      </div>
    </div>
    </ModalPortal>
  )
}
