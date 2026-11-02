import { useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import type { ToolCall } from '@/services/tools/types'

/**
 * 批量审批 —— 内嵌于对话面板决策区（极简纯净版 V2 风格）：与单工具审批同款
 * 白卡 + 发丝线边框 + 左侧 2px 电光蓝边线，吸底在消息区最底部、模式栏上方，
 * 不再弹窗。选项对齐 Windsurf/Cursor 的审批模型：逐条确认 / 批准全部 / 全部
 * 拒绝；每行可勾选「始终允许该工具」持久化到项目白名单。
 */
export default function BatchApprovalDialog() {
  // Fine-grained selectors, not the whole store: while a parallel session
  // streams (~20 Hz) a whole-store subscription here would re-render the
  // dialog on every flush even though nothing it reads changed.
  const batchApproval = useChatStore((s) => s.batchApproval)
  const decideBatchApproval = useChatStore((s) => s.decideBatchApproval)
  const allowToolPermanently = useChatStore((s) => s.allowToolPermanently)
  // Parallel conversations: the dialog only renders for the active session —
  // switching to the owning session reveals it again.
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const [alwaysAllow, setAlwaysAllow] = useState<Set<string>>(new Set())
  const t = useI18n()

  if (!batchApproval || batchApproval.sessionId !== activeSessionId) return null
  const { tools, previews } = batchApproval

  const toggleAlwaysAllow = (tc: ToolCall) => {
    setAlwaysAllow((prev) => {
      const next = new Set(prev)
      if (next.has(tc.name)) next.delete(tc.name)
      else next.add(tc.name)
      return next
    })
  }

  // Persist checked tools, then resolve the pending batch decision
  const persistAllowlist = () => {
    alwaysAllow.forEach((name) => allowToolPermanently(name))
    setAlwaysAllow(new Set())
  }

  const approveAll = () => {
    persistAllowlist()
    decideBatchApproval('all')
  }
  const confirmOneByOne = () => {
    persistAllowlist()
    decideBatchApproval('confirm')
  }
  const rejectAll = () => {
    setAlwaysAllow(new Set())
    decideBatchApproval('reject')
  }

  return (
    <div
      role="region"
      aria-label={t('agent.batchTitle')}
      className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border border-l-2 rounded-xl overflow-hidden shadow-sm"
      style={{ borderLeftColor: 'var(--accent)' }}
    >
      {/* 头部：🤖 + 标题 + 操作数徽标 */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
        <span className="text-[16px] leading-none shrink-0" aria-hidden>🤖</span>
        <span className="text-[13px] font-semibold text-nova-text-primary">{t('agent.batchTitle')}</span>
        <span className="ml-auto text-[11px] px-2 py-0.5 rounded bg-nova-accent/5 text-nova-accent border border-nova-accent/10">
          {t('agent.batchToolCount', { count: tools.length })}
        </span>
      </div>

      {/* 正文：工具列表，每行 = 等宽工具名 + 预览 + 「始终允许」复选 */}
      <div className="px-4 py-3 flex flex-col gap-2 max-h-52 overflow-y-auto">
        <p className="text-[12px] text-nova-text-muted">{t('agent.batchDesc')}</p>
        {tools.map((tc, index) => (
          <div
            key={tc.id}
            className="flex items-start gap-2 bg-nova-hover/50 rounded-lg px-3 py-2 border border-nova-border"
          >
            <span className="font-mono text-nova-accent text-[12px] shrink-0 mt-px">{tc.name}</span>
            <span className="text-nova-text-secondary text-[12px] min-w-0 flex-1 whitespace-pre-line break-words">
              {previews?.[index] || JSON.stringify(tc.arguments || {})}
            </span>
            <label className="ml-auto flex items-center gap-1 text-[11px] text-nova-text-muted cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={alwaysAllow.has(tc.name)}
                onChange={() => toggleAlwaysAllow(tc)}
                className="accent-nova-accent w-3 h-3"
              />
              {t('agent.alwaysAllowTool')}
            </label>
          </div>
        ))}
      </div>

      {/* 操作条：全部拒绝 / 逐个确认 / 批准全部 */}
      <div className="px-4 py-3 border-t border-nova-border flex items-center justify-end gap-2 bg-nova-surface">
        <button
          onClick={rejectAll}
          className="px-3 py-1.5 text-[13px] text-nova-text-secondary hover:text-nova-text-primary border border-nova-border rounded-lg hover:bg-nova-hover transition-colors"
        >
          {t('agent.batchRejectAll')}
        </button>
        <button
          onClick={confirmOneByOne}
          className="px-3 py-1.5 text-[13px] text-nova-text-secondary hover:text-nova-text-primary border border-nova-border rounded-lg hover:bg-nova-hover transition-colors"
        >
          {t('agent.batchConfirm')}
        </button>
        <button
          onClick={approveAll}
          className="px-3 py-1.5 text-[13px] text-white bg-nova-accent hover:opacity-90 rounded-lg transition-opacity"
        >
          {t('agent.batchApproveAll')}
        </button>
      </div>
    </div>
  )
}
