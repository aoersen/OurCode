/**
 * 右栏「待决中心」卡（V12 审查 #3）：统一队列 = 工具审批 + 询问（chatStore
 * 单槽）+ 预算触顶 + 目标修订（本地 5s 轮询）。计数同步到 TopBar 铃铛徽章
 * （uiStore.officePendingCount）；铃铛点击通过 officePendingPulse 触发本卡
 * 滚动闪烁。处理/忽略动作直接走 chatStore 现有 resolve 通道。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { budgetExceeded, getBudgetUsage, initBudgetTracking } from '@/services/targetMode/budget'

interface PendingItem {
  key: string
  kind: 'approval' | 'question' | 'budget' | 'revision'
  type: 'amber' | 'red'
  title: string
  sub: string
  actions: Array<{ label: string; primary?: boolean; run: () => void }>
}

const FLASH_STYLE = `
@keyframes officeCardFlash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0, 88, 188, 0); }
  35% { box-shadow: 0 0 0 3px rgba(0, 88, 188, 0.5); }
}
.office-pending-flash { animation: officeCardFlash 1.1s ease; }
`

function truncate(text: string, max = 90): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? single.slice(0, max) + '…' : single
}

export default function PendingCenterCard({ active = true }: { active?: boolean }) {
  const t = useI18n()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const questionGate = useChatStore((s) => s.questionGate)
  const pendingPulse = useUIStore((s) => s.officePendingPulse)

  const [extras, setExtras] = useState<PendingItem[]>([])
  const seenRevisions = useRef<Set<string>>(new Set())
  const budgetDismissed = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)

  // 预算触顶 / 目标修订检测（5s 轮询；approval/question 直接订阅 store）
  useEffect(() => {
    if (!active) return
    let alive = true
    const poll = () => {
      const cs = useChatStore.getState()
      const session = cs.sessions.find((s) => s.id === cs.activeSessionId)
      if (!session?.projectPath) return
      initBudgetTracking(session.id, session.projectPath)
      const next: PendingItem[] = []
      // 预算触顶 → 待决（忽略后不再提示，直到退出触顶）
      if (budgetExceeded(session.id) && !budgetDismissed.current) {
        const u = getBudgetUsage(session.id)
        next.push({
          key: 'budget',
          kind: 'budget',
          type: 'amber',
          title: t('office.pendBudgetTitle'),
          sub: `${t('office.pendBudgetSub')} ${(u.used / 1e6).toFixed(1)}M / ${(u.limit / 1e6).toFixed(0)}M`,
          actions: [
            {
              label: t('office.pendAck'),
              primary: true,
              run: () => {
                budgetDismissed.current = true
                useUIStore
                  .getState()
                  .showNotification(t('office.pendBudgetAck'), 'warning')
                setExtras((cur) => cur.filter((x) => x.kind !== 'budget'))
              },
            },
            {
              label: t('office.pendIgnore'),
              run: () => {
                budgetDismissed.current = true
                setExtras((cur) => cur.filter((x) => x.kind !== 'budget'))
              },
            },
          ],
        })
      }
      // finalGoal_v{N}.md 新增 → 目标修订待确认
      const base = `${session.projectPath.replace(/[\\/]+$/, '')}/.ourcode/targemode`
      window.electronAPI
        .listDir(base)
        .then((entries) => {
          if (!alive) return
          const revisions = entries
            .filter((e) => !e.isDirectory && /^finalGoal_v\d+\.md$/.test(e.name))
            .map((e) => e.name)
          for (const name of revisions) {
            if (seenRevisions.current.has(name)) continue
            seenRevisions.current.add(name)
            const v = name.match(/v(\d+)/)?.[1] ?? ''
            next.push({
              key: name,
              kind: 'revision',
              type: 'amber',
              title: t('office.pendRevisionTitle', { v }),
              sub: t('office.pendRevisionSub'),
              actions: [
                {
                  label: t('office.pendConfirm'),
                  primary: true,
                  run: () => {
                    useUIStore
                      .getState()
                      .showNotification(t('office.pendRevisionDone', { v }), 'success')
                    setExtras((cur) => cur.filter((x) => x.key !== name))
                  },
                },
                {
                  label: t('office.pendIgnore'),
                  run: () => setExtras((cur) => cur.filter((x) => x.key !== name)),
                },
              ],
            })
          }
          if (alive && next.length) {
            setExtras((cur) => {
              const merged = [...cur]
              for (const item of next) {
                if (!merged.some((x) => x.key === item.key)) merged.push(item)
              }
              return merged
            })
          }
        })
        .catch(() => {})
    }
    poll()
    const timer = window.setInterval(poll, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [active, t])

  // 收集全部待决（store 单槽 + 本地 extras），计数同步 TopBar 铃铛
  const items = useMemo<PendingItem[]>(() => {
    const cs = useChatStore.getState()
    const list: PendingItem[] = []
    if (pendingApproval && pendingApproval.sessionId === activeSessionId) {
      const tool = pendingApproval.toolCall
      list.push({
        key: 'approval',
        kind: 'approval',
        type: 'red',
        title: `${t('office.pendApprovalTitle')}：${tool.name}`,
        sub: truncate(
          pendingApproval.preview || JSON.stringify(tool.arguments) || '',
          90,
        ),
        actions: [
          { label: t('office.pendApprove'), primary: true, run: () => cs.approveToolCall() },
          { label: t('office.pendReject'), run: () => cs.rejectToolCall() },
        ],
      })
    }
    if (
      pendingQuestion &&
      pendingQuestion.sessionId === activeSessionId &&
      questionGate[pendingQuestion.sessionId] !== 'dismissed'
    ) {
      const q = pendingQuestion
      const opts = q.options ?? []
      list.push({
        key: 'question',
        kind: 'question',
        type: 'amber',
        title: q.question,
        sub: truncate(
          opts.length ? opts.join(' / ') : t('office.pendQuestionNoOpts'),
          90,
        ),
        actions: [
          ...opts.slice(0, 3).map((opt, i) => ({
            label: truncate(opt, 18),
            primary: i === 0,
            run: () => cs.answerQuestion(opt),
          })),
          {
            label: t('office.pendLater'),
            run: () => cs.setQuestionGate(q.sessionId, 'dismissed'),
          },
        ],
      })
    }
    return [...list, ...extras]
  }, [pendingApproval, pendingQuestion, questionGate, activeSessionId, extras, t])

  useEffect(() => {
    useUIStore.getState().setOfficePendingCount(items.length)
  }, [items.length])

  // 铃铛点击 → 本卡滚动 + 闪烁
  useEffect(() => {
    if (!pendingPulse || items.length === 0) return
    const el = cardRef.current
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    el.classList.add('office-pending-flash')
    const timer = window.setTimeout(() => el.classList.remove('office-pending-flash'), 1200)
    return () => window.clearTimeout(timer)
  }, [pendingPulse, items.length])

  return (
    <>
      <style>{FLASH_STYLE}</style>
      <div
        ref={cardRef}
        data-testid="office-pending-card"
        className="shrink-0 rounded-xl border px-3.5 py-3"
        style={{
          background: '#fff',
          borderColor: 'rgba(15,23,42,0.08)',
          borderLeft: '2px solid #D97706',
        }}
      >
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[13px] font-bold" style={{ color: '#0f172a' }}>
            {t('office.pendingCenter')}
            {items.length > 0 && (
              <span
                className="ml-1.5 inline-flex items-center justify-center rounded-full"
                style={{
                  minWidth: 16, height: 16, padding: '0 4px', fontSize: 10, fontWeight: 700,
                  color: '#fff', background: '#DC2626',
                }}
              >
                {items.length}
              </span>
            )}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="text-xs py-1.5" style={{ color: '#94a3b8' }}>
            {t('office.pendEmpty')}
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.key}
              className="flex gap-2.5 py-2 first:pt-0 last:pb-0"
              style={{ borderTop: '1px solid rgba(15,23,42,0.08)', marginTop: item.key ? 0 : undefined }}
            >
              <span
                className="inline-flex items-center justify-center rounded-md flex-none"
                style={{
                  width: 20, height: 20, fontSize: 11, fontWeight: 700,
                  color: item.type === 'amber' ? '#D97706' : '#DC2626',
                  background: item.type === 'amber' ? 'rgba(217,119,6,0.12)' : 'rgba(220,38,38,0.1)',
                }}
              >
                {item.type === 'amber' ? '⚠' : '✕'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-xs leading-4" style={{ color: '#0f172a' }}>
                  {item.title}
                </div>
                <div className="text-xs mt-0.5 truncate" style={{ color: '#94a3b8' }}>
                  {item.sub}
                </div>
                <div className="flex gap-1.5 mt-1.5 flex-wrap">
                  {item.actions.map((a, i) => (
                    <button
                      key={i}
                      onClick={() => a.run()}
                      className="px-2 py-0.5 rounded-md transition-colors"
                      style={
                        a.primary
                          ? { background: '#0058BC', color: '#fff', fontSize: 11 }
                          : {
                              border: '1px solid rgba(15,23,42,0.12)',
                              color: '#334155',
                              fontSize: 11,
                              background: 'transparent',
                            }
                      }
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  )
}
