import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import MSIcon from '@/components/Common/icons/MSIcon'

/**
 * 计划外写入拦截 —— 计划模式批准后，Agent 尝试写入未在计划声明中的路径时，
 * 在对话面板底部展示的决策卡片（琥珀左边条，与 ZCode 拦截提示一致）。
 *
 * 三个动作：
 *   加入计划并执行 — 把本次目标路径并入计划声明（作为最终产物）后放行本次写入
 *   切换模式继续   — 切到自动编辑模式并放行
 *   拒绝           — 拒绝本次写入（工具结果记为「计划外写入被拦截」）
 * 权限请求不超时：一直等待用户决策。
 */
export default function ScopeBlockDialog() {
  const pendingScope = useChatStore((s) => s.pendingScope)
  const resolveScopeDecision = useChatStore((s) => s.resolveScopeDecision)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const t = useI18n()

  if (!pendingScope || pendingScope.sessionId !== activeSessionId) return null

  const { toolCall, paths } = pendingScope
  const shown = paths.slice(0, 3).join('、') + (paths.length > 3 ? ` 等 ${paths.length} 个路径` : '')

  return (
    <div
      className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border border-l-2 rounded-xl overflow-hidden shadow-sm"
      style={{ borderLeftColor: 'var(--warning, #eab308)' }}
      role="region"
      aria-label={t('plan.writeBlockedTitle')}
    >
      <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
        <MSIcon name="error" className="text-[18px] leading-none text-warning shrink-0" />
        <span className="text-[13px] font-semibold text-nova-text-primary">{t('plan.writeBlockedTitle')}</span>
        <span className="ml-auto font-mono text-[12px] px-2 py-0.5 rounded bg-nova-accent/5 text-nova-accent border border-nova-accent/10">
          {toolCall.name}
        </span>
      </div>

      <div className="px-4 py-3 flex flex-col gap-2.5">
        <p className="text-[12px] text-nova-text-secondary leading-relaxed">
          {t('plan.writeBlockedBody', { path: shown })}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => resolveScopeDecision('add_to_plan')}
            className="flex-1 px-3 py-1.5 text-[13px] text-nova-text-secondary border border-nova-border rounded-lg hover:bg-nova-hover transition-colors"
          >
            {t('plan.addToPlanAndRun')}
          </button>
          <button
            onClick={() => resolveScopeDecision('switch_mode')}
            className="flex-1 px-3 py-1.5 text-[13px] text-warning border border-nova-border rounded-lg hover:bg-nova-hover transition-colors"
          >
            {t('plan.switchModeToContinue')}
          </button>
          <button
            onClick={() => resolveScopeDecision('reject')}
            className="px-3 py-1.5 text-[13px] text-red-500 border border-red-500/25 rounded-lg hover:bg-red-500/5 transition-colors"
          >
            {t('approval.denyOnce')}
          </button>
        </div>
      </div>
    </div>
  )
}
