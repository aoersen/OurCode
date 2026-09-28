/**
 * 「一人公司」左侧任务区派生层：一个任务 = 一个总监会话。
 *
 * 用户在会话里首次发出要求时，sendMessage 与普通对话一样自动生成摘要标题
 * （即时占位 + AI 精修），此后在该对话里说的一切都属于同一个任务。任务行
 * 标题即会话标题；该任务触发的全部角色活动（send_message 派发给员工、总监/
 * 员工的子智能体运行）收进任务内部的 activities，由面板在任务行下缩进展示。
 *
 * 纯函数无副作用，便于单测。同一项目可并存多个总监会话（先后多个任务）：
 * 员工派发消息以「[来自会话「<总监标题>」的会话间消息]」开头，按发送方标题
 * 归属到对应的总监会话；标题匹配不上时按派发时间落到当时活跃的任务。
 */
import type { ChatMessage, ChatSession, SubAgentProgress } from '@shared/types'
import { DEFAULT_SESSION_TITLE } from '@shared/constants'
import { roleLabel } from './mapping'

/** 会话间消息前缀（与 chatStore.receiveInboundMessage / OfficeStream 同源）。 */
export const INBOUND_RE = /^\[来自会话「(.+?)」的会话间消息\]\n\n?/

/** 总监会话里的真实用户消息 = 一次工作要求；员工回报带会话间前缀，不算。 */
export function isUserRequestMessage(m: ChatMessage): boolean {
  return m.role === 'user' && !INBOUND_RE.test(m.content)
}

export type RoleActivityStatus = 'running' | 'done' | 'failed' | 'pending'
export type TaskRequestStatus = 'running' | 'waiting' | 'done' | 'failed'

/** 任务内部的一条角色活动（一次派发或一次子智能体运行）。 */
export interface TaskRequestActivity {
  /** 稳定 key（子智能体运行 = toolCallId；派发 = `disp:<workerId>:<at>`）。 */
  key: string
  /** 角色标签（需求分析师 / UI 研发 / 业务研发-1 / 研发 / 调研…）。 */
  label: string
  /** 该角色具体干的活（派发消息或子任务信封的摘要，面板里截断展示）。 */
  task: string
  status: RoleActivityStatus
  startedAt: number
  /** 对应子智能体进度（run_subagent 类活动才有；面板「回滚到此」依赖它）。 */
  progress?: SubAgentProgress
}

/** 一个任务（左侧任务区的一行 = 一个总监会话）。 */
export interface TaskRequest {
  /** 总监会话 id（持久化，跨重启稳定；也是移除时的标识）。 */
  id: string
  sessionId: string
  /** 会话自动摘要标题（首条消息自动生成，与普通对话同机制）。 */
  title: string
  startedAt: number
  status: TaskRequestStatus
  activities: TaskRequestActivity[]
}

/** 取用户消息首行做任务标题（会话尚无自动标题时的兜底）。 */
export function requestTitle(content: string, max = 44): string {
  const line = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  const single = (line ?? '').replace(/\s+/g, ' ')
  if (!single) return '（无描述）'
  return single.length > max ? single.slice(0, max) + '…' : single
}

/** 员工会话的一次派发及其回报情况（员工会话的 user 消息全是总监派发）。 */
interface WorkerDispatch {
  at: number
  task: string
  /** 派发方总监会话的标题（用于多任务并存时归属到正确会话）。 */
  senderTitle: string
  /** 该次派发之后、下一次派发之前是否已有回报（assistant 消息）。 */
  reported: boolean
  /** 回报正文首行（员工协议要求首行给结论：完成/失败/阻塞…）。 */
  reportFirstLine: string | null
  /** 是否为该员工最近一次派发（员工正在跑 = 属于最近一次派发）。 */
  latest: boolean
}

function workerDispatchStates(w: ChatSession): WorkerDispatch[] {
  const sorted = [...w.messages].sort((a, b) => a.createdAt - b.createdAt)
  const dispatches = sorted.filter((m) => m.role === 'user')
  return dispatches.map((d, i) => {
    const end = dispatches[i + 1]?.createdAt ?? Number.POSITIVE_INFINITY
    const report = sorted.find(
      (m) => m.role === 'assistant' && m.createdAt > d.createdAt && m.createdAt < end,
    )
    const firstLine = report
      ? (report.content ?? '')
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? null
      : null
    const sender = INBOUND_RE.exec(d.content)?.[1] ?? ''
    return {
      at: d.createdAt,
      task: d.content.replace(INBOUND_RE, '').trim(),
      senderTitle: sender,
      reported: !!report,
      reportFirstLine: firstLine,
      latest: i === dispatches.length - 1,
    }
  })
}

/** 员工回报首行结论是否为失败/阻塞（员工协议：回报首行给结论）。 */
function reportFailed(line: string | null): boolean {
  return !!line && /失败|阻塞/.test(line)
}

function progressStatus(p: SubAgentProgress): RoleActivityStatus {
  if (p.status === 'running') return 'running'
  if (p.status === 'done') return 'done'
  return 'failed'
}

export interface TaskRequestsInput {
  sessions: ChatSession[]
  /** 父 run_subagent toolCallId → 子智能体进度（面板传入节流后的引用）。 */
  progress: Record<string, SubAgentProgress>
  runningSessionIds: string[]
  /** 当前挂起询问的会话 id（其任务显示「等待输入」）。 */
  pendingQuestionSessionId?: string | null
}

/** 任务状态排序：运行中/等待 → 完成 → 失败，同状态新的在前。 */
const rankTask = (s: TaskRequestStatus) => (s === 'running' || s === 'waiting' ? 0 : s === 'done' ? 1 : 2)

/**
 * 派生所有项目的一人公司任务：key = projectPath。只有总监会话（targetMode、
 * 非员工）出任务；员工会话只作为活动来源。一个总监会话 = 一个任务。
 */
export function buildTaskRequests(input: TaskRequestsInput): Map<string, TaskRequest[]> {
  const { progress, runningSessionIds, pendingQuestionSessionId } = input
  const running = new Set(runningSessionIds)

  const directors = input.sessions.filter((s) => s.targetMode === true && !s.workerRole && !!s.projectPath)
  const projectWorkers = new Map<string, ChatSession[]>()
  const progressBySession = new Map<string, Array<{ key: string; p: SubAgentProgress }>>()
  for (const [key, p] of Object.entries(progress)) {
    const list = progressBySession.get(p.sessionId)
    if (list) list.push({ key, p })
    else progressBySession.set(p.sessionId, [{ key, p }])
  }
  // 员工会话按项目预分组（活动归属要按派发方落到具体任务）。
  for (const w of input.sessions) {
    if (!w.workerRole || !w.projectPath) continue
    const list = projectWorkers.get(w.projectPath)
    if (list) list.push(w)
    else projectWorkers.set(w.projectPath, [w])
  }

  const byProject = new Map<string, TaskRequest[]>()

  for (const [projectPath, sessionList] of groupDirectorsByProject(directors)) {
    const workers = projectWorkers.get(projectPath) ?? []
    // 员工派发状态只与员工会话自身消息有关，先算一次再归属到各任务。
    const workerDispatches = new Map(workers.map((w) => [w.id, workerDispatchStates(w)]))
    // 每个总监会话首个真实用户消息时间（多任务并存时按时间兜底归属）。
    const firstUserAt = new Map(
      sessionList.map((s) => {
        const sorted = [...s.messages].sort((a, b) => a.createdAt - b.createdAt)
        const first = sorted.find(isUserRequestMessage)
        return [s.id, first?.createdAt ?? Number.POSITIVE_INFINITY]
      }),
    )
    const byTitle = new Map<string, ChatSession>()
    for (const s of sessionList) if (!byTitle.has(s.title)) byTitle.set(s.title, s)
    /** 按时间兜底：派发发生时「最近开工」的总监会话。 */
    const directorAt = (at: number): ChatSession | null => {
      let best: ChatSession | null = null
      let bestAt = Number.NEGATIVE_INFINITY
      for (const s of sessionList) {
        const t = firstUserAt.get(s.id) ?? Number.POSITIVE_INFINITY
        if (t <= at && t > bestAt) {
          best = s
          bestAt = t
        }
      }
      return best ?? sessionList[0] ?? null
    }
    /** 一次派发归属的总监会话：先按发送方标题，再按时间兜底。 */
    const ownerOfDispatch = (d: WorkerDispatch): ChatSession | null =>
      byTitle.get(d.senderTitle) ?? directorAt(d.at)

    const tasks: TaskRequest[] = []
    for (const session of sessionList) {
      const sorted = [...session.messages].sort((a, b) => a.createdAt - b.createdAt)
      const firstUserMsg = sorted.find(isUserRequestMessage)
      if (!firstUserMsg) continue

      const activities: TaskRequestActivity[] = []

      // 总监本会话的子智能体运行（降级通道 run_subagent / 调研助手）。
      for (const { key, p } of progressBySession.get(session.id) ?? []) {
        activities.push({
          key,
          label: roleLabel(p.task, p.name),
          task: p.task,
          status: progressStatus(p),
          startedAt: p.startedAt,
          progress: p,
        })
      }

      // 员工派发 + 员工只读子智能体（调研助手），仅归属本会话的纳入。
      for (const w of workers) {
        const workerRunning = running.has(w.id)
        const states = workerDispatches.get(w.id) ?? []
        for (const d of states) {
          if (ownerOfDispatch(d)?.id !== session.id) continue
          const status: RoleActivityStatus = workerRunning && d.latest
            ? 'running'
            : d.reported
              ? reportFailed(d.reportFirstLine)
                ? 'failed'
                : 'done'
              : 'pending'
          activities.push({
            key: `disp:${w.id}:${d.at}`,
            label: w.title || '员工',
            task: d.task,
            status,
            startedAt: d.at,
          })
        }
        for (const { key, p } of progressBySession.get(w.id) ?? []) {
          // 调研助手归到启动前最近一次派发所属的总监会话。
          let owner: ChatSession | null = null
          for (const d of states) if (d.at <= p.startedAt) owner = ownerOfDispatch(d)
          if (!owner) owner = directorAt(p.startedAt)
          if (owner?.id !== session.id) continue
          activities.push({
            key,
            label: w.title || roleLabel(p.task, p.name),
            task: p.task,
            status: progressStatus(p),
            startedAt: p.startedAt,
            progress: p,
          })
        }
      }
      activities.sort((a, b) => a.startedAt - b.startedAt)

      const anyRunning = running.has(session.id) || activities.some((a) => a.status === 'running')
      // 任务级失败取「最后一个已结束活动的结局」：先失败后修好（打回重派）
      // 的任务是 done，而不是被早期失败钉死；总监轮次出错同样只看最后一轮
      // （中途报错后用户重试成功 → 任务仍是 done）。
      const terminal = activities.filter((a) => a.status === 'done' || a.status === 'failed')
      const lastOutcome = terminal.length > 0 ? terminal[terminal.length - 1].status : null
      const lastAssistant = [...sorted].reverse().find((m) => m.role === 'assistant')
      const directorError = lastAssistant?.error != null
      const pendingQuestion = pendingQuestionSessionId === session.id

      const status: TaskRequestStatus = anyRunning
        ? 'running'
        : pendingQuestion
          ? 'waiting'
          : directorError || lastOutcome === 'failed'
            ? 'failed'
            : 'done'

      tasks.push({
        id: session.id,
        sessionId: session.id,
        // 与普通对话同机制的自动摘要标题；尚无标题时退回首条要求首行。
        title:
          session.title && session.title !== DEFAULT_SESSION_TITLE
            ? session.title
            : requestTitle(firstUserMsg.content),
        startedAt: firstUserMsg.createdAt,
        status,
        activities,
      })
    }

    tasks.sort((a, b) => rankTask(a.status) - rankTask(b.status) || b.startedAt - a.startedAt)
    if (tasks.length > 0) byProject.set(projectPath, tasks)
  }

  return byProject
}

/** 总监会话按项目分组（保持 store 原有顺序）。 */
function groupDirectorsByProject(directors: ChatSession[]): Map<string, ChatSession[]> {
  const map = new Map<string, ChatSession[]>()
  for (const s of directors) {
    const list = map.get(s.projectPath!)
    if (list) list.push(s)
    else map.set(s.projectPath!, [s])
  }
  return map
}
