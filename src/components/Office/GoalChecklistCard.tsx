/**
 * 右栏「目标达成」卡（V12 审查 #2）：comparison.md 可视化 —— 逐项 ✅/⏳/⬜ +
 * 覆盖率 + 轮间 delta。数据来自 useGoalChecklist（5s 轮询），无清单时显示空态。
 */
import { useI18n } from '@/i18n/useI18n'
import { useUIStore } from '@/stores/uiStore'
import { useGoalChecklist } from './useGoalChecklist'
import { TASK_5STATE } from './officeTheme'

export default function GoalChecklistCard({ active = true }: { active?: boolean }) {
  const t = useI18n()
  const rootPath = useUIStore((s) => s.rootPath)
  const summary = useGoalChecklist(rootPath, active)

  const pct = summary?.coverage ?? 0
  const delta =
    summary?.previousCoverage != null
      ? pct - summary.previousCoverage
      : null

  return (
    <div
      data-testid="office-goal-card"
      className="shrink-0 rounded-xl border px-3.5 py-3"
      style={{ background: '#fff', borderColor: 'rgba(15,23,42,0.08)' }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[13px] font-bold" style={{ color: '#0f172a' }}>
          {t('office.goalAchieved')}
        </span>
        <span className="font-bold" style={{ color: '#0058bc', fontSize: 13 }}>
          {summary ? `${pct}%` : '—'}
        </span>
      </div>

      {!summary ? (
        <div className="text-xs leading-5" style={{ color: '#94a3b8' }}>
          {t('office.noChecklist')}
          <br />
          {t('office.noChecklistHint')}
        </div>
      ) : summary.items.length === 0 ? (
        <div className="text-xs" style={{ color: '#94a3b8' }}>
          {t('office.noChecklist')}
        </div>
      ) : (
        <>
          <div
            className="h-1.5 rounded-full mb-2.5 overflow-hidden"
            style={{ background: '#EEF1F6' }}
          >
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#0058bc,#8b5cf6)' }}
            />
          </div>
          {summary.items.map((g, i) => {
            const meta = TASK_5STATE[g.state === 'todo' ? 'idle' : g.state]
            const mark = g.state === 'done' ? '✓' : g.state === 'waiting' ? '…' : '○'
            return (
              <div key={i} className="flex items-center gap-2 h-[27px]">
                <span
                  className="inline-flex items-center justify-center rounded-full flex-none"
                  style={{
                    width: 17, height: 17, fontSize: 10, fontWeight: 700, color: '#fff',
                    background: meta.dot,
                  }}
                >
                  {mark}
                </span>
                <span
                  className="flex-1 truncate"
                  style={{ fontSize: 12, color: g.state === 'todo' ? '#334155' : '#334155' }}
                >
                  {g.text}
                </span>
              </div>
            )
          })}
          <div
            className="mt-2 pt-2 border-t text-xs"
            style={{ borderColor: 'rgba(15,23,42,0.08)', color: '#94a3b8' }}
          >
            {delta != null ? (
              <>
                {t('office.coverDelta', { prev: summary.previousCoverage ?? 0, delta: delta >= 0 ? `+${delta}` : String(delta) })}
              </>
            ) : (
              t('office.coverFirst', { pct })
            )}
          </div>
        </>
      )}
    </div>
  )
}
