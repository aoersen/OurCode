/**
 * 右栏「待决中心」卡（V12 审查 #3）：只放**真的需要用户点一下**的东西 =
 * 工具审批 + 询问（chatStore 单槽）+ 预算触顶（本地 5s 轮询）。计数同步到
 * TopBar 铃铛徽章（uiStore.officePendingCount）；铃铛点击通过
 * officePendingPulse 触发本卡滚动闪烁。处理/忽略动作直接走 chatStore 现有通道。
 *
 * 目标修订（finalGoal_v{N}.md）**不在**待决中心：那是目标修订的历史快照
 * （见 services/office/pendingCenter.ts 的说明），当前目标已生效、无需确认。
 * 旧实现把它们当待办，且「已看过」只存在组件内存里 → 每次进来看板都重新
 * 报同一条，变成「每次点进来都叫我处理」。现在改成新快照出现时一次性提示，
 * 用持久化签名去重。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { getProjectBudgetUsage, initBudgetTracking } from '@/services/targetMode/budget'
import {
  collectFreshRevisions,
  mergeSeenRevisions,
  revisionSignature,
  type DirEntryLike,
} from '@/services/office/pendingCenter'

interface PendingItem {
  key: string
  kind: 'approval' | 'question' | 'budget'
  type: 'amber' | 'red'
  title: string
  sub: string
  actions: Array<{ label: string; primary?: boolean; run: () => void }>
}

/** 已提示过的目标修订签名（持久化，跨会话/重启都记住）。 */
const SEEN_REVISIONS_KEY = 'office.goalRevisionsSeen'

function loadSeenRevisions(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_REVISIONS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveSeenRevisions(seen: Iterable<string>): void {
  try {
    localStorage.setItem(SEEN_REVISIONS_KEY, JSON.stringify([...seen]))
  } catch {
    /* localStorage 不可用只是重复提示一次，不影响功能 */
  }
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
  // 已提示过的目标修订签名（持久化）：重启/切走再回来都不会把同一份快照
  // 重新报成待办。
  const seenRevisions = useRef<Set<string>>(loadSeenRevisions())
  // 按项目记「预算触顶已忽略」：忽略后不再重复弹，但一旦退出触顶状态
  // （用户调高了 budget.md 上限），标记即清除——下次再触顶会重新提醒。
  const budgetDismissed = useRef<Set<string>>(new Set())
  const cardRef = useRef<HTMLDivElement>(null)

  // 预算触顶 / 目标修订检测（5s 轮询；approval/question 直接订阅 store）。
  // 扫描本窗口**所有**公司会话（总监 + 角色员工，可多项目并行）——此前只
  // 盯激活会话：后台项目的预算触顶/目标修订在切到该会话前完全不可见。
  // 预算按项目聚合：公司预算 = 该项目的总监 + 全体员工的消耗之和。
  useEffect(() => {
    if (!active) return
    let alive = true
    const poll = () => {
      const cs = useChatStore.getState()
      const companySessions = cs.sessions.filter(
        (s) => s.projectPath && (s.targetMode === true || !!s.workerRole),
      )
      const byProject = new Map<string, typeof companySessions>()
      for (const s of companySessions) {
        initBudgetTracking(s.id, s.projectPath!)
        const list = byProject.get(s.projectPath!)
        if (list) list.push(s)
        else byProject.set(s.projectPath!, [s])
      }
      const next: PendingItem[] = []
      for (const [projectPath, members] of byProject) {
        const director = members.find((s) => s.targetMode === true && !s.workerRole) ?? members[0]
        // 预算状态按项目共享（总监 + 全体员工同一份账），直接读项目合计——
        // 再按会话求和会把同一个总额重复叠加 N 次。
        const { used, limit } = getProjectBudgetUsage(projectPath)
        const exceeded = limit > 0 && used >= limit
        if (exceeded) {
          if (!budgetDismissed.current.has(projectPath)) {
            next.push({
              key: `budget:${projectPath}`,
              kind: 'budget',
              type: 'amber',
              title: `${t('office.pendBudgetTitle')} · ${director.title || t('chat.untitled')}`,
              sub: `${t('office.pendBudgetSub')} ${(used / 1e6).toFixed(1)}M / ${(limit / 1e6).toFixed(0)}M（总监+员工合计）`,
              actions: [
                {
                  label: t('office.pendAck'),
                  primary: true,
                  run: () => {
                    budgetDismissed.current.add(projectPath)
                    useUIStore
                      .getState()
                      .showNotification(t('office.pendBudgetAck'), 'warning')
                    setExtras((cur) => cur.filter((x) => x.key !== `budget:${projectPath}`))
                  },
                },
                {
                  label: t('office.pendIgnore'),
                  run: () => {
                    budgetDismissed.current.add(projectPath)
                    setExtras((cur) => cur.filter((x) => x.key !== `budget:${projectPath}`))
                  },
                },
              ],
            })
          }
        } else {
          // 退出触顶：清除忽略标记，下次触顶重新提醒（注释与行为一致）
          budgetDismissed.current.delete(projectPath)
        }
      }
      // finalGoal_v{N}.md = 目标修订的历史快照（当前目标已生效），不进待决中心。
      // 只在**新快照**出现时给一条一次性提示；签名持久化，重启后不会重复。
      const projectRoots = [...byProject.keys()]
      void Promise.all(
        projectRoots.map(async (root) => {
          const base = `${root.replace(/[\\/]+$/, '')}/.ourcode/targemode`
          try {
            const entries: DirEntryLike[] = await window.electronAPI.listDir(base)
            const fresh = collectFreshRevisions(root, entries, seenRevisions.current)
            if (fresh.length === 0) return [] as string[]
            const merged = mergeSeenRevisions(
              seenRevisions.current,
              fresh.map((e) => revisionSignature(root, e)),
            )
            seenRevisions.current = new Set(merged)
            saveSeenRevisions(merged)
            return fresh.map((e) => e.name)
          } catch {
            return [] as string[] // 目录还不存在 = 没有修订
          }
        }),
      ).then((lists) => {
        if (!alive) return
        const names = lists.flat()
        if (names.length === 0) return
        useUIStore.getState().showNotification(
          t('office.goalRevisionNotice', { file: names[names.length - 1] }),
          'info',
          { duration: 6000 },
        )
      })
      // 预算项每次轮询整体重建（不在 extras 里残留已经恢复的触顶提示）
      setExtras(next)
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
