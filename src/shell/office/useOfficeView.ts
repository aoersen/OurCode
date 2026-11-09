/**
 * OfficeSurface 的数据装配层：把真实 store / service 的状态收敛成一个
 * 视图模型（全部 useMemo 记忆化），组件层只负责排版与键盘。
 *
 * 只读订阅：chatStore（sessions / runningSessionIds / subagentProgress /
 * pendingApproval / pendingQuestion / questionGate）+ uiStore（rootPath /
 * officeSelectedRole）。写操作一律走既有 action：
 *  - 目标模式开关 → chatStore.setTargetMode(sessionId, enabled)
 *  - 打开会话     → chatStore.setActiveSession(id) + onClose()
 *  - 公司开张     → chatStore.createOfficeTask(projectPath)
 *  - 补齐编制     → chatStore.ensureWorkers(projectPath)
 *  - 待决处理     → approveToolCall / rejectToolCall / setQuestionGate
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useThrottledValue } from '@/utils/useThrottledValue'
import {
  buildDirectorActivities,
  type DirectorActivity,
} from '@/services/office/taskRequests'
import { getProjectBudgetUsage, initBudgetTracking } from '@/services/targetMode/budget'
import { readGoalChecklist, type GoalChecklistSummary, type GoalItem } from '@/services/targetMode/goalChecklist'
import { readStatus, type TargetModeStatus } from '@/services/targetMode/targetModeService'
import type { GoalItemState } from '@/services/targetMode/goalChecklist'

import {
  buildChecklistRows,
  buildMetrics,
  buildPendingDescriptors,
  buildRoleRows,
  buildTaskRows,
  busyMsOf,
  checklistCountText,
  checklistProgress,
  companyName,
  companyStatus,
  groupTaskCounts,
  pickDirector,
  pendingCountBySession,
  resolveProjectPath,
  roundLine,
  stageLine,
  type ChecklistProgress,
  type CompanyStatus,
  type OfficeChecklistRow,
  type OfficeMetric,
  type OfficeRoleRow,
  type OfficeTaskRow,
  type PendingDescriptor,
  type PendingKind,
  type TaskCounts,
} from './officeModel'

const GOAL_POLL_MS = 5_000
const GOAL_DEBOUNCE_MS = 300
const BUDGET_POLL_MS = 5_000
const SESSIONS_THROTTLE_MS = 800
const PROGRESS_THROTTLE_MS = 800

/** 目标模式文档目录（文件事件过滤用）。 */
const TARGEMODE_SEGMENT = '/.ourcode/targemode'

function isTargemodeEventPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return normalized.includes(TARGEMODE_SEGMENT)
}

interface GoalData {
  summary: GoalChecklistSummary | null
  status: TargetModeStatus | null
}

/** 目标清单 + 实施状态：5s 轮询兜底 + 文件事件 / 运行态变化的即时刷新。 */
function useGoalData(
  projectPath: string | null,
  active: boolean,
  nonce: number,
  wakeKey: string,
): GoalData {
  const [summary, setSummary] = useState<GoalChecklistSummary | null>(null)
  const [status, setStatus] = useState<TargetModeStatus | null>(null)

  useEffect(() => {
    if (!projectPath || !active) {
      setSummary(null)
      setStatus(null)
      return
    }
    let alive = true
    let debounce: number | null = null
    const load = () => {
      Promise.all([readGoalChecklist(projectPath), readStatus(projectPath)])
        .then(([nextSummary, nextStatus]) => {
          if (!alive) return
          setSummary(nextSummary)
          setStatus(nextStatus)
        })
        .catch(() => {
          // 读不到（项目未信任 / 目录还没建）按空态处理，不吵用户
        })
    }
    const schedule = () => {
      if (debounce != null) window.clearTimeout(debounce)
      debounce = window.setTimeout(load, GOAL_DEBOUNCE_MS)
    }
    load()
    const onFileChanged = (event: Event) => {
      const path = (event as CustomEvent<string>).detail
      if (typeof path === 'string' && isTargemodeEventPath(path)) schedule()
    }
    window.addEventListener('ourcode:file-changed', onFileChanged)
    const timer = window.setInterval(load, GOAL_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
      if (debounce != null) window.clearTimeout(debounce)
      window.removeEventListener('ourcode:file-changed', onFileChanged)
    }
  }, [projectPath, active, nonce, wakeKey])

  return { summary, status }
}

interface BudgetUsage {
  used: number
  limit: number
}

/** 公司预算（总监 + 全体员工同一份账）：5s 轮询。 */
function useBudgetUsage(
  projectPath: string | null,
  sessionId: string | null,
  active: boolean,
): BudgetUsage {
  const [usage, setUsage] = useState<BudgetUsage>({ used: 0, limit: 0 })

  useEffect(() => {
    if (!projectPath || !active) return
    let alive = true
    const poll = () => {
      if (sessionId) initBudgetTracking(sessionId, projectPath)
      if (!alive) return
      setUsage(getProjectBudgetUsage(projectPath))
    }
    poll()
    const timer = window.setInterval(poll, BUDGET_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [projectPath, sessionId, active])

  return usage
}

/** 待决条目 + 已绑定动作（动作只能是既有 store action）。 */
export interface PendingRowView extends PendingDescriptor {
  primary: () => void
  secondary?: () => void
}

export interface OfficeEmptyState {
  kind: 'disconnected' | 'no-project' | 'no-goal'
  text: string
  actionLabel: string
  action: () => void
}

export interface OfficeViewModel {
  connected: boolean
  company: { name: string; projectPath: string | null }
  status: { key: CompanyStatus; word: string }
  /** 目标模式开关：真实 action 是 chatStore.setTargetMode。 */
  goalMode: {
    on: boolean
    sessionId: string | null
    /** 有会话可挂目标模式（否则开关只显示只读状态）。 */
    available: boolean
    toggle: () => void
  }
  roles: {
    rows: OfficeRoleRow[]
    selectedKey: string | null
    select: (key: string) => void
    /** 编制内一个员工都没有（用来引导「补齐编制」）。 */
    staffedCount: number
    ensureStaff: () => void
  }
  tasks: {
    rows: OfficeTaskRow[]
    counts: TaskCounts
    directorTitle: string
    directorSessionId: string | null
    hasDirector: boolean
  }
  metrics: OfficeMetric[]
  pending: PendingRowView[]
  checklist: {
    rows: OfficeChecklistRow[]
    progress: ChecklistProgress
    countText: string
    stage: string
    round: string
    liveText: string
    items: ReadonlyArray<{ text: string; state: GoalItemState }>
  }
  empty: OfficeEmptyState | null
  openSession: (sessionId: string | null) => void
  refresh: () => void
  createTask: () => void
}

export function useOfficeView(onClose: () => void): OfficeViewModel {
  const rawSessions = useChatStore((s) => s.sessions)
  const sessions = useThrottledValue(rawSessions, SESSIONS_THROTTLE_MS)
  const rawProgress = useChatStore((s) => s.subagentProgress)
  const subagentProgress = useThrottledValue(rawProgress, PROGRESS_THROTTLE_MS)
  const runningSessionIds = useChatStore((s) => s.runningSessionIds)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const pendingApproval = useChatStore((s) => s.pendingApproval)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const questionGate = useChatStore((s) => s.questionGate)

  const rootPath = useUIStore((s) => s.rootPath)
  const selectedRoleKey = useUIStore((s) => s.officeSelectedRole)
  const setSelectedRole = useUIStore((s) => s.setOfficeSelectedRole)

  const [nonce, setNonce] = useState(0)
  const [budgetDismissed, setBudgetDismissed] = useState(false)

  const projectPath = useMemo(
    () => resolveProjectPath(sessions, activeSessionId, rootPath),
    [sessions, activeSessionId, rootPath],
  )

  const companySessions = useMemo(
    () =>
      sessions.filter(
        (s) => !!projectPath && s.projectPath === projectPath && (s.targetMode === true || !!s.workerRole),
      ),
    [sessions, projectPath],
  )

  const director = useMemo(() => pickDirector(companySessions), [companySessions])
  const connected = !!projectPath && !!director

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )
  // 目标模式只能挂在「非员工」会话上（员工会话对用户隐藏，不该被开关命中）
  const goalSession = director ?? (activeSession && !activeSession.workerRole ? activeSession : null)

  const companyRunning = useMemo(
    () => companySessions.some((s) => runningSessionIds.includes(s.id)),
    [companySessions, runningSessionIds],
  )
  /** 运行态签名：任一公司会话开始/结束都会刷新目标清单（兜住收尾写盘）。 */
  const runningKey = useMemo(
    () => companySessions.filter((s) => runningSessionIds.includes(s.id)).map((s) => s.id).join('|'),
    [companySessions, runningSessionIds],
  )

  const activities = useMemo<DirectorActivity[]>(() => {
    if (!director) return []
    return buildDirectorActivities(
      {
        sessions: [...sessions],
        progress: subagentProgress,
        runningSessionIds: [...runningSessionIds],
      },
      director.id,
    )
  }, [sessions, subagentProgress, runningSessionIds, director])

  const taskRows = useMemo(() => buildTaskRows(activities, director?.id ?? null), [activities, director])
  const taskCounts = useMemo(() => groupTaskCounts(taskRows), [taskRows])

  const budget = useBudgetUsage(projectPath, director?.id ?? goalSession?.id ?? null, !!projectPath)
  const budgetExceeded = budget.limit > 0 && budget.used >= budget.limit

  useEffect(() => {
    if (!budgetExceeded) setBudgetDismissed(false)
  }, [budgetExceeded])

  const descriptors = useMemo(
    () =>
      buildPendingDescriptors({
        approval: pendingApproval
          ? {
              sessionId: pendingApproval.sessionId,
              toolName: pendingApproval.toolCall?.name ?? 'tool',
              preview: pendingApproval.preview ?? '',
            }
          : null,
        question: pendingQuestion
          ? {
              sessionId: pendingQuestion.sessionId,
              question: pendingQuestion.question,
              options: pendingQuestion.options ?? [],
              dismissed: questionGate[pendingQuestion.sessionId] === 'dismissed',
            }
          : null,
        budget:
          budgetExceeded && !budgetDismissed
            ? { exceeded: true, used: budget.used, limit: budget.limit }
            : null,
      }),
    [pendingApproval, pendingQuestion, questionGate, budgetExceeded, budgetDismissed, budget.used, budget.limit],
  )

  const openSession = useCallback(
    (sessionId: string | null) => {
      if (!sessionId) return
      useChatStore.getState().setActiveSession(sessionId)
      onClose()
    },
    [onClose],
  )

  const pendingRows = useMemo<PendingRowView[]>(() => {
    return descriptors.map((d) => {
      const chat = () => useChatStore.getState()
      const kind: PendingKind = d.kind
      if (kind === 'approval') {
        return { ...d, primary: () => chat().approveToolCall(), secondary: () => chat().rejectToolCall() }
      }
      if (kind === 'question') {
        return {
          ...d,
          primary: () => openSession(d.sessionId),
          secondary: () => {
            if (d.sessionId) chat().setQuestionGate(d.sessionId, 'dismissed')
          },
        }
      }
      return { ...d, primary: () => setBudgetDismissed(true), secondary: () => setBudgetDismissed(true) }
    })
  }, [descriptors, openSession])

  const pendingBySession = useMemo(() => pendingCountBySession(descriptors), [descriptors])

  const roleRows = useMemo(
    () =>
      buildRoleRows({
        sessions,
        projectPath,
        runningSessionIds,
        pendingBySession,
      }),
    [sessions, projectPath, runningSessionIds, pendingBySession],
  )

  const staffedCount = useMemo(() => roleRows.filter((r) => r.staffed && r.slot !== 1).length, [roleRows])

  const busyMs = useMemo(() => busyMsOf(companySessions), [companySessions])
  const metrics = useMemo(
    () => buildMetrics({ counts: taskCounts, pending: pendingRows.length, busyMs }),
    [taskCounts, pendingRows.length, busyMs],
  )

  const goal = useGoalData(projectPath, connected, nonce, runningKey)
  const checklistItems = useMemo<GoalItem[]>(() => goal.summary?.items ?? [], [goal.summary])
  const progress = useMemo(() => checklistProgress(checklistItems), [checklistItems])
  const checklistRows = useMemo(() => buildChecklistRows(checklistItems), [checklistItems])

  const toggleGoalMode = useCallback(() => {
    const id = goalSession?.id
    if (!id) return
    const current = useChatStore.getState().sessions.find((s) => s.id === id)
    if (!current) return
    useChatStore.getState().setTargetMode(id, current.targetMode !== true)
  }, [goalSession])

  const refresh = useCallback(() => {
    setNonce((n) => n + 1)
    // 目标模式状态来自 implementationStatus.md —— 刷新按钮顺带重读一次。
    void useChatStore.getState().refreshTargetModeStatus()
  }, [])

  const createTask = useCallback(() => {
    const id = useChatStore.getState().createOfficeTask(projectPath ?? undefined)
    if (id) openSession(id)
  }, [projectPath, openSession])

  const ensureStaff = useCallback(() => {
    if (!projectPath) return
    useChatStore.getState().ensureWorkers(projectPath)
  }, [projectPath])

  const status = useMemo(
    () => companyStatus({ connected, running: companyRunning, pending: pendingRows.length }),
    [connected, companyRunning, pendingRows.length],
  )

  const empty = useMemo<OfficeEmptyState | null>(() => {
    if (connected) return null
    // 目标模式开了但会话没绑项目：说清楚缺的是项目，而不是再让用户点一次开关
    if (!projectPath && goalSession?.targetMode === true) {
      return {
        kind: 'no-project',
        text: '目标模式已开启，但会话还没绑定项目 · 先打开一个项目',
        actionLabel: '创建公司任务',
        action: createTask,
      }
    }
    return {
      kind: projectPath ? 'no-goal' : 'disconnected',
      text: projectPath ? '公司还没开张 · 开启目标模式后总监与工位才会出现' : '未连接公司 · 先打开一个项目',
      actionLabel: goalSession ? '开启目标模式' : '创建公司任务',
      action: goalSession ? toggleGoalMode : createTask,
    }
  }, [connected, projectPath, goalSession, toggleGoalMode, createTask])

  /** 实施进度的人话（implementationStatus.md 的「实施进度」一行）。 */
  const liveText = goal.status?.progressText ?? ''

  return {
    connected,
    company: { name: companyName(projectPath), projectPath },
    status,
    goalMode: {
      on: goalSession?.targetMode === true,
      sessionId: goalSession?.id ?? null,
      available: !!goalSession,
      toggle: toggleGoalMode,
    },
    roles: {
      rows: roleRows,
      selectedKey: selectedRoleKey,
      select: setSelectedRole,
      staffedCount,
      ensureStaff,
    },
    tasks: {
      rows: taskRows,
      counts: taskCounts,
      directorTitle: director?.title ?? '',
      directorSessionId: director?.id ?? null,
      hasDirector: !!director,
    },
    metrics,
    pending: pendingRows,
    checklist: {
      rows: checklistRows,
      progress,
      countText: checklistCountText(progress),
      stage: stageLine(goal.status),
      round: roundLine(goal.status),
      liveText,
      items: checklistItems,
    },
    empty,
    openSession,
    refresh,
    createTask,
  }
}
