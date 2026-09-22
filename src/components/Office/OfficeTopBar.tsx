/**
 * 顶部状态条（V12 审查 #4/#11/#12）：人话徽章（第 2 轮 · 阶段 3/5 · 清单通过率
 * 62%，hover 明细）+ 待决铃铛（计数徽章，点击聚焦右栏待决卡）+ 预算（≥80% 琥珀
 * 预警，点击展开按角色近似分布 popover）+ 停止按钮。
 *
 * 预算数据：budget.getBudgetUsage（全局，代码级累计）；按角色分布为
 * subagentProgress.tokenCount 的近似聚合（标注「约」，见 SPEC 十二）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { humanBadge } from '@/services/targetMode/goalChecklist'
import { getBudgetUsage, initBudgetTracking } from '@/services/targetMode/budget'
import { roleLabel } from '@/services/office/mapping'
import { useGoalChecklist } from './useGoalChecklist'
import { useThrottledValue } from '@/utils/useThrottledValue'
import { MONO } from './officeTheme'

function fmtTokens(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return String(Math.round(v))
}

export default function OfficeTopBar() {
  const t = useI18n()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // 停止按钮的状态基准：**任一会话正在运行**（含等待审批/提问期间——runAgentLoop
  // 在等待时 runningSessionIds 仍保留本会话）。公司层面的停止不能只看当前激活
  // 会话：左侧任务行展示的运行中任务可能属于另一个会话，按钮必须可用且能止住它。
  const runningSessionIds = useChatStore((s) => s.runningSessionIds)
  const running = runningSessionIds.length > 0
  const targetModeStatus = useChatStore((s) => s.targetModeStatus)
  // 进度表逐次推送换引用（思考节流/工具步骤），800ms 节流避免顶栏随每次推送
  // 整块重渲染——与看板/项目栏同一节流粒度（角色分布只是「约」统计）。
  const subagentProgress = useThrottledValue(useChatStore((s) => s.subagentProgress), 800)
  const rootPath = useUIStore((s) => s.rootPath)
  const pendingCount = useUIStore((s) => s.officePendingCount)
  const pulsePending = useUIStore((s) => s.pulseOfficePending)

  const summary = useGoalChecklist(rootPath, !!activeSessionId)
  const badge = humanBadge(targetModeStatus, summary?.coverage ?? null)

  // 预算（5s 轮询刷新上限/消耗；页面首次挂载即初始化追踪）
  const [usage, setUsage] = useState(() => ({ used: 0, limit: 2_000_000 }))
  useEffect(() => {
    if (!activeSessionId) return
    const cs = useChatStore.getState()
    const session = cs.sessions.find((s) => s.id === activeSessionId)
    if (session?.projectPath) initBudgetTracking(session.id, session.projectPath)
    let alive = true
    const poll = () => {
      const s = useChatStore.getState().sessions.find((x) => x.id === activeSessionId)
      if (!s?.projectPath) return
      initBudgetTracking(s.id, s.projectPath)
      if (alive) setUsage(getBudgetUsage(s.id))
    }
    poll()
    const timer = window.setInterval(poll, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [activeSessionId])

  // 按角色近似消耗（subagentProgress.tokenCount 聚合，标注「约」）
  const roleUsage = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of Object.values(subagentProgress)) {
      if (p.sessionId !== activeSessionId) continue
      const label = roleLabel(p.task, p.name)
      map.set(label, (map.get(label) ?? 0) + p.tokenCount)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [subagentProgress, activeSessionId])

  const ratio = usage.limit > 0 ? usage.used / usage.limit : 0
  const budgetColor = ratio >= 1 ? '#DC2626' : ratio >= 0.8 ? '#D97706' : '#334155'

  const [popOpen, setPopOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!popOpen) return
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setPopOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [popOpen])

  const badgeTip = [
    targetModeStatus?.round != null ? `${t('office.round')} ${targetModeStatus.round}` : null,
    targetModeStatus?.stageCurrent != null && targetModeStatus.stageTotal != null
      ? `${t('office.wbStage')} ${targetModeStatus.stageCurrent}/${targetModeStatus.stageTotal}`
      : null,
    summary ? `${t('office.checklistCount', { n: summary.items.length })} · ${t('office.achievedLabel')} ${summary.coverage}%` : null,
    targetModeStatus?.progressText || null,
  ]
    .filter(Boolean)
    .join(' · ')

  const stop = () => {
    const state = useChatStore.getState()
    if (!state.runningSessionIds.length) return
    // 优先停当前激活会话；否则把本窗口所有正在运行的任务一并终止——
    // 公司层面的「停止任务」语义，避免「点了没反应」（此前只 abort 激活
    // 会话的控制器，任务实际跑在别的会话时点击就是 no-op）。
    if (activeSessionId && state.runningSessionIds.includes(activeSessionId)) {
      state.stopGeneration(activeSessionId)
      return
    }
    for (const id of [...state.runningSessionIds]) state.stopGeneration(id)
  }

  return (
    <div
      data-testid="office-topbar"
      className="shrink-0 flex items-center gap-3 px-4"
      style={{ height: 40, background: '#fff', borderBottom: '1px solid rgba(15,23,42,0.08)' }}
    >
      <span className="text-[13px] font-bold whitespace-nowrap" style={{ color: '#0f172a' }}>
        🏢 {t('office.company')}
      </span>

      {badge && (
        <span
          title={badgeTip}
          className="whitespace-nowrap"
          style={{
            fontSize: 12, color: '#0058bc',
            background: 'rgba(0,88,188,0.08)',
            border: '1px solid rgba(0,88,188,0.35)',
            borderRadius: 8, padding: '2px 10px', cursor: 'default',
          }}
        >
          {badge}
        </span>
      )}

      <div className="flex-1" />

      {/* 待决铃铛 */}
      <button
        onClick={pulsePending}
        title={t('office.pendBellTip')}
        className="relative transition-colors rounded-md"
        style={{ width: 30, height: 30, fontSize: 15 }}
      >
        🔔
        {pendingCount > 0 && (
          <span
            className="absolute flex items-center justify-center rounded-full"
            style={{
              top: 1, right: 0, minWidth: 15, height: 15, padding: '0 3px',
              fontSize: 10, fontWeight: 700, color: '#fff', background: '#DC2626',
            }}
          >
            {pendingCount}
          </span>
        )}
      </button>

      {/* 预算（popover 含按角色分布） */}
      <div ref={popRef} className="relative">
        <button
          onClick={() => setPopOpen((v) => !v)}
          className="transition-colors rounded-md whitespace-nowrap"
          style={{
            fontSize: 12, color: MONO.t2, padding: '4px 10px',
            border: '1px solid rgba(15,23,42,0.12)', background: '#fff',
          }}
        >
          {t('office.budget')} <b style={{ color: budgetColor, fontWeight: 600 }}>{fmtTokens(usage.used)}</b>
          /{fmtTokens(usage.limit)} ▾
        </button>

        {popOpen && (
          <div
            className="absolute right-0 z-50 rounded-xl p-3.5"
            style={{
              top: 34, width: 300, background: '#fff',
              border: '1px solid rgba(15,23,42,0.08)',
              boxShadow: '0 12px 32px rgba(15,23,42,0.14)',
            }}
          >
            <div className="text-xs font-bold mb-2.5" style={{ color: '#334155' }}>
              {t('office.budgetPopTitle')}
            </div>
            <div className="flex items-center gap-2 mb-2.5">
              <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: '#EEF1F6' }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(ratio * 100, 100)}%`,
                    background: ratio >= 0.8 ? budgetColor : 'linear-gradient(90deg,#0058bc,#3b82f6)',
                  }}
                />
              </div>
              <span className="text-xs whitespace-nowrap" style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: budgetColor }}>
                {Math.round(ratio * 100)}%
              </span>
            </div>
            {roleUsage.length === 0 ? (
              <div className="text-xs" style={{ color: MONO.t3 }}>{t('office.budgetNoRoles')}</div>
            ) : (
              <>
                <div className="text-[11px] mb-1.5" style={{ color: MONO.t3 }}>
                  {t('office.budgetPerRole')}
                </div>
                {roleUsage.map(([label, tokens]) => (
                  <div key={label} className="flex items-center gap-2 mb-1.5">
                    <span className="w-12 text-xs shrink-0" style={{ color: MONO.t2 }}>{label}</span>
                    <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: '#EEF1F6' }}>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min((tokens / Math.max(usage.limit, 1)) * 100, 100)}%`,
                          background: tokens / Math.max(usage.limit, 1) >= 0.4 ? '#D97706' : '#0058BC',
                        }}
                      />
                    </div>
                    <span className="w-10 text-right text-xs shrink-0" style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: MONO.t3 }}>
                      {fmtTokens(tokens)}
                    </span>
                  </div>
                ))}
                <div className="text-[11px] mt-2" style={{ color: MONO.t3 }}>
                  {t('office.budgetApprox')}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <button
        onClick={stop}
        disabled={!running}
        title={running ? t('office.stopTaskHint') : t('office.stopTaskIdle')}
        className="whitespace-nowrap transition-colors rounded-md"
        style={{
          fontSize: 12, color: '#DC2626', padding: '4px 12px',
          background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.4)',
          opacity: running ? 1 : 0.4,
          cursor: running ? 'pointer' : 'default',
        }}
      >
        {t('office.stopGoal')}
      </button>
    </div>
  )
}
