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
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const questionGate = useChatStore((s) => s.questionGate)
  const pendingPulse = useUIStore((s) => s.officePendingPulse)

  const [extras, setExtras] = useState<PendingItem[]>([])
  const seenRevisions = useRef<Set<string>>(new Set())
  // 按会话记「已忽略」：预算触顶被忽略后不再重复弹，但一旦退出触顶状态
  // （用户调高了 budget.md 上限），标记即清除——下次再触顶会重新提醒。
  const budgetDismissed = useRef<Set<string>>(new Set())
  const cardRef = useRef<HTMLDivElement>(null)

  // 预算触顶 / 目标修订检测（5s 轮询；approval/question 直接订阅 store）。
  // 扫描本窗口**所有**目标模式会话（公司整体运营 = 可多项目并行）——此前只
  // 盯激活会话：后台项目的预算触顶/目标修订在切到该会话前完全不可见。
  useEffect(() => {
    if (!active) return
    let alive = true
    const poll = () => {
      const cs = useChatStore.getState()
      const tmSessions = cs.sessions.filter((s) => s.targetMode === true && s.projectPath)
      const next: PendingItem[] = []
      for (const session of tmSessions) {
        initBudgetTracking(session.id, session.projectPath!)
        if (budgetExceeded(session.id)) {
          if (!budgetDismissed.current.has(session.id)) {
            const u = getBudgetUsage(session.id)
            next.push({
              key: `budget:${session.id}`,
              kind: 'budget',
              type: 'amber',
              title: `${t('office.pendBudgetTitle')} · ${session.title || t('chat.untitled')}`,
              sub: `${t('office.pendBudgetSub')} ${(u.used / 1e6).toFixed(1)}M / ${(u.limit / 1e6).toFixed(0)}M`,
              actions: [
                {
                  label: t('office.pendAck'),
                  primary: true,
                  run: () => {
                    budgetDismissed.current.add(session.id)
                    useUIStore
                      .getState()
                      .showNotification(t('office.pendBudgetAck'), 'warning')
                    setExtras((cur) => cur.filter((x) => x.key !== `budget:${session.id}`))
                  },
                },
                {
                  label: t('office.pendIgnore'),
                  run: () => {
                    budgetDismissed.current.add(session.id)
                    setExtras((cur) => cur.filter((x) => x.key !== `budget:${session.id}`))
                  },
                },
              ],
            })
          }
        } else {
          // 退出触顶：清除忽略标记，下次触顶重新提醒（注释与行为一致）
          budgetDismissed.current.delete(session.id)
        }
      }
      // finalGoal_v{N}.md 新增 → 目标修订待确认（按项目分键，两个项目同名文件不冲突）
      void Promise.all(
        tmSessions.map((session) => {
          const base = `${session.projectPath!.replace(/[\\/]+$/, '')}/.ourcode/targemode`
          return window.electronAPI
            .listDir(base)
            .then((entries) => {
              const revisions = entries
                .filter((e) => !e.isDirectory && /^finalGoal_v\d+\.md$/.test(e.name))
                .map((e) => e.name)
              for (const name of revisions) {
                const revKey = `${session.projectPath}:${name}`
                if (seenRevisions.current.has(revKey)) continue
                seenRevisions.current.add(revKey)
                const v = name.match(/v(\d+)/)?.[1] ?? ''
                next.push({
                  key: `revision:${revKey}`,
                  kind: 'revision',
                  type: 'amber',
                  title: `${t('office.pendRevisionTitle', { v })} · ${session.title || t('chat.untitled')}`,
                  sub: t('office.pendRevisionSub'),
                  actions: [
                    {
                      label: t('office.pendConfirm'),
                      primary: true,
                      run: () => {
                        useUIStore
                          .getState()
                          .showNotification(t('office.pendRevisionDone', { v }), 'success')
                        setExtras((cur) => cur.filter((x) => x.key !== `revision:${revKey}`))
                      },
                    },
                    {
                      label: t('office.pendIgnore'),
                      run: () => setExtras((cur) => cur.filter((x) => x.key !== `revision:${revKey}`)),
                    },
                  ],
                })
              }
            })
            .catch(() => {})
        }),
      ).then(() => {
        if (!alive || next.length === 0) return
        setExtras((cur) => {
          const merged = [...cur]
          for (const item of next) {
            if (!merged.some((x) => x.key === item.key)) merged.push(item)
          }
          return merged
        })
      })
    }
    poll()
    const timer = window.setInterval(poll, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [active, t])

  // 收集全部待决（store 单槽 + 本地 extras），计数同步 TopBar 铃铛。
  // approval/question 是全局单槽——属于哪个会话都该在此呈现（后台会话的审批
  // 若被激活会话过滤掉，就等于没入口处理）。
  const items = useMemo<PendingItem[]>(() => {
    const cs = useChatStore.getState()
    const list: PendingItem[] = []
    if (pendingApproval) {
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
  }, [pendingApproval, pendingQuestion, questionGate, extras, t])

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
