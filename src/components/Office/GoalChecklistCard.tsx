/**
 * 右栏「目标达成」卡（V12 审查 #2）：comparison.md 可视化 —— 逐项 ✅/⏳/⬜ +
 * 覆盖率 + 轮间 delta。数据来自 useGoalChecklist（5s 轮询 + 事件触发），无清单
 * 时显示空态。
 *
 * 两个进度口径：
 * - 清单通过率：轮级验证（comparison.md 随每轮比对更新）；
 * - 执行进度：implementationStatus.md 的总体百分比/阶段（模型每阶段更新）——
 *   执行期间卡片上「会动」的正是这一条，否则轮中只有等到比对结束才有变化。
 */
import { useI18n } from '@/i18n/useI18n'
import { useChatStore } from '@/stores/chatStore'
import { useGoalChecklist } from './useGoalChecklist'
import { TASK_5STATE } from './officeTheme'

const MONO_FONT = "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace"

export default function GoalChecklistCard({ active = true }: { active?: boolean }) {
  const t = useI18n()
  // 数据根 = 激活会话绑定的项目（目标模式文档都在会话项目下），而不是窗口
  // 级 rootPath——两者在跨会话切换时可能不一致，读错项目会让整卡永不更新。
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const rootPath = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId)?.projectPath ?? null : null,
  )
  const { summary, status: liveStatus } = useGoalChecklist(rootPath, active, activeSessionId)

  const pct = summary?.coverage ?? 0
  const delta =
    summary?.previousCoverage != null
      ? pct - summary.previousCoverage
      : null

  const liveStage =
    liveStatus?.stageCurrent != null && liveStatus.stageTotal != null
      ? `${t('office.wbStage')} ${liveStatus.stageCurrent}/${liveStatus.stageTotal}`
      : ''

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
          {/* 清单通过率：轮级验证口径，随 comparison.md 更新 */}
          <div className="flex items-center justify-between mb-1">
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{t('office.achievedLabel')}</span>
          </div>
          <div
            className="h-1.5 rounded-full mb-2.5 overflow-hidden"
            style={{ background: '#EEF1F6' }}
          >
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#0058bc,#8b5cf6)' }}
            />
          </div>

          {/* 执行进度：implementationStatus.md 总体百分比（模型每阶段更新），
              执行期间卡片上「会动」的数字来自这里 */}
          {liveStatus?.percent != null && (
            <div className="mb-2.5">
              <div className="flex items-center justify-between mb-1">
                <span style={{ fontSize: 11, color: '#64748b' }}>{t('office.goalLiveProgress')}</span>
                <span style={{ fontFamily: MONO_FONT, fontSize: 10.5, color: '#334155' }}>
                  {Math.round(liveStatus.percent)}%{liveStage ? ` · ${liveStage}` : ''}
                </span>
              </div>
              <div
                className="h-1 rounded-full overflow-hidden"
                style={{ background: '#EEF1F6' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.max(0, liveStatus.percent))}%`, background: '#94a3b8' }}
                />
              </div>
            </div>
          )}

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
