import { DEFAULT_SESSION_TITLE } from '@shared/constants'
import type { ChatSession } from '@shared/types'
import { matchProject, matchSession } from './railSearch'

/**
 * 会话栏（项目树）的派生逻辑 —— 纯函数，不碰 store、不碰 React。
 *
 * 为什么要单独抽出来：
 *  1. 单测（`src/__tests__/shell-rail-*.test.ts`）能直接跑排序 / 分组 / 搜索，
 *     不需要 jsdom；
 *  2. 组件里用一份 `railSignature()` 当 memo 键，让「另一个会话在流式输出」
 *     不触发整栏重排（见 SessionRail 里那段注释）。
 */

export const UNGROUPED_KEY = '__ungrouped__'
export const UNGROUPED_LABEL = '未归类'

/**
 * 一条对话的生命周期状态 —— 会话栏要能一眼看出「这条还在跑 / 出错了 / 结束了」。
 *
 * 判定顺序（先到先得）：
 *  running  正在跑 agent
 *  waiting  等用户处理（提问 / 审批 / 计划待批准）
 *  error    最近一次运行失败，或最后一条回复带错误
 *  done     跑过并正常结束（有运行记录或已有回复）
 *  idle     还没有任何产出（草稿会话）
 */
export type SessionState = 'running' | 'waiting' | 'error' | 'done' | 'idle'

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  running: '进行中',
  waiting: '待处理',
  error: '异常',
  done: '结束',
  idle: '',
}

/** 状态筛选项（会话栏顶部一行纯文字）。 */
export type RailStateFilter = 'all' | 'active' | 'error' | 'done'

export const RAIL_STATE_FILTERS: ReadonlyArray<{ id: RailStateFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中' },
  { id: 'error', label: '异常' },
  { id: 'done', label: '结束' },
]

export function matchesStateFilter(state: SessionState, filter: RailStateFilter): boolean {
  switch (filter) {
    case 'active':
      return state === 'running' || state === 'waiting'
    case 'error':
      return state === 'error'
    case 'done':
      return state === 'done'
    default:
      return true
  }
}

/** 会话状态的纯函数判定（输入全部压平，方便单测）。 */
export function deriveSessionState(input: {
  running: boolean
  blocked: boolean
  lastRunStatus?: string | null
  lastAssistantHadError?: boolean
  hasAssistantOutput?: boolean
}): SessionState {
  if (input.running) return 'running'
  if (input.blocked) return 'waiting'
  if (input.lastRunStatus === 'waiting_plan') return 'waiting'
  if (
    input.lastRunStatus === 'error' ||
    input.lastRunStatus === 'rejected' ||
    input.lastAssistantHadError
  ) {
    return 'error'
  }
  if (
    input.lastRunStatus === 'done' ||
    input.lastRunStatus === 'stopped' ||
    input.hasAssistantOutput
  ) {
    return 'done'
  }
  return 'idle'
}

/** 从一条会话推导状态（兼容老数据：没有 agentRuns 时看消息）。 */
export function sessionStateOf(
  s: ChatSession,
  running: boolean,
  blocked: boolean,
): SessionState {
  const runs = s.agentRuns ?? []
  const lastRun = runs.length ? runs[runs.length - 1] : null
  const messages = s.messages ?? []
  let lastAssistant: ChatSession['messages'][number] | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistant = messages[i]
      break
    }
  }
  return deriveSessionState({
    running,
    blocked,
    lastRunStatus: lastRun?.status ?? null,
    lastAssistantHadError: !!lastAssistant?.error,
    hasAssistantOutput: !!lastAssistant?.content,
  })
}

/** 一行对话（已经把展示需要的所有信息压平，行组件不再读 store）。 */
export interface RailSessionRow {
  id: string
  title: string
  projectPath: string | null
  updatedAt: number
  pinnedAt: number | null
  archivedAt: number | null
  /** 该会话正在跑 agent（6px 实心点）。 */
  running: boolean
  /** 该会话在等用户（提问 / 审批 / 批量审批 / 决策积压）——红点。 */
  blocked: boolean
  /** 生命周期状态（进行中 / 待处理 / 异常 / 结束 / 未开始）。 */
  state: SessionState
  /** 搜索命中正文时的一行片段（标题命中 / 未搜索为 null）。 */
  snippet: string | null
  /** 搜索命中标题（或项目路径）—— 命中标题时不再显示正文片段。 */
  titleHit: boolean
}

/** 一个项目下各状态的会话数（项目行上的状态摘要）。 */
export interface RailStateCounts {
  running: number
  waiting: number
  error: number
  done: number
  idle: number
}

export function countStates(rows: ReadonlyArray<Pick<RailSessionRow, 'state'>>): RailStateCounts {
  const counts: RailStateCounts = { running: 0, waiting: 0, error: 0, done: 0, idle: 0 }
  for (const row of rows) counts[row.state] += 1
  return counts
}

export interface RailGroup {
  /** 项目路径，或 `UNGROUPED_KEY`。 */
  key: string
  label: string
  path: string | null
  /** 对话数（= sessions.length，折叠时仍然显示）。 */
  count: number
  /** 状态摘要（不受顶部状态筛选影响，始终是这一组的全量）。 */
  states: RailStateCounts
  sessions: RailSessionRow[]
}

/** 项目行的名字：路径最后一段（与旧侧栏一致）。 */
export function projectLabel(path: string | null | undefined): string {
  if (!path) return UNGROUPED_LABEL
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

/**
 * 从未用过的空会话（新建后没发消息、标题还是默认的「新对话」）。
 * 判定与 `chatStore.isGhostSession` 完全一致 —— 这里复制一份是为了让本模块保持
 * 纯函数（可在 node 环境直接单测）。**两处必须同步修改**。
 */
export function isUnusedSession(
  s: Pick<ChatSession, 'messages' | 'title' | 'pinnedAt' | 'archivedAt'>,
): boolean {
  return (
    s.messages.length === 0 &&
    (!s.title || s.title === DEFAULT_SESSION_TITLE) &&
    !s.pinnedAt &&
    !s.archivedAt
  )
}

/** 这条会话是否进项目树：claw 会话 / 员工会话不进；空会话只在「它就是当前会话」时进。 */
export function isRailVisible(s: ChatSession, activeSessionId?: string | null): boolean {
  if (s.mode === 'claw' || s.hidden) return false
  if (activeSessionId != null && s.id === activeSessionId) return true
  return !isUnusedSession(s)
}

/**
 * 对话排序：置顶优先（最近置顶的在上），其余按 updatedAt 倒序。
 * updatedAt 相同（并发写入）时用标题 / id 兜底，保证顺序稳定、不随渲染抖动。
 */
export function compareRailSessions(
  a: Pick<RailSessionRow, 'pinnedAt' | 'updatedAt' | 'title' | 'id'>,
  b: Pick<RailSessionRow, 'pinnedAt' | 'updatedAt' | 'title' | 'id'>,
): number {
  const ap = a.pinnedAt ?? 0
  const bp = b.pinnedAt ?? 0
  if (ap && !bp) return -1
  if (!ap && bp) return 1
  if (ap && bp && ap !== bp) return bp - ap
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  const byTitle = a.title.localeCompare(b.title, 'zh-Hans-CN')
  return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id)
}

/**
 * 项目行的顺序。
 *
 * 与旧项目列表同一套约定（用户的面包屑不能自己跳）：
 *  - `recentProjects` 保持「添加顺序」（打开已有项目不会把它顶到最前）；
 *  - 只有会话、不在 recent 里的项目排在后面（调用方按最近活动排好序）；
 *  - 用户拖拽固定的 `projectOrder` 优先，不在固定序列里的新项目排最前；
 *  - 已移除的项目、以及当前工作区（兜底）单独处理。
 */
export function orderProjectPaths(input: {
  recentProjects?: readonly string[]
  projectOrder?: readonly string[] | null
  removedProjects?: readonly string[]
  sessionPaths?: readonly string[]
  currentPath?: string | null
}): string[] {
  const removed = new Set(input.removedProjects ?? [])
  const base: string[] = []
  const seen = new Set<string>()
  const add = (p?: string | null) => {
    if (!p || removed.has(p) || seen.has(p)) return
    seen.add(p)
    base.push(p)
  }
  for (const p of input.recentProjects ?? []) add(p)
  for (const p of input.sessionPaths ?? []) add(p)
  add(input.currentPath ?? null)

  const pinned = (input.projectOrder ?? []).filter((p) => seen.has(p))
  if (pinned.length === 0) return base
  const pinnedSet = new Set(pinned)
  return [...base.filter((p) => !pinnedSet.has(p)), ...pinned]
}

/** 等用户处理的会话集合（红点）。只认这四个来源，与设计稿一致。 */
export function attentionSessionIds(input: {
  questionSessionId?: string | null
  approvalSessionId?: string | null
  batchSessionId?: string | null
  backlog?: readonly { sessionId: string }[]
}): Set<string> {
  const ids = new Set<string>()
  if (input.questionSessionId) ids.add(input.questionSessionId)
  if (input.approvalSessionId) ids.add(input.approvalSessionId)
  if (input.batchSessionId) ids.add(input.batchSessionId)
  for (const parked of input.backlog ?? []) if (parked.sessionId) ids.add(parked.sessionId)
  return ids
}

export interface RailGroupInput {
  sessions: readonly ChatSession[]
  activeSessionId?: string | null
  query?: string
  runningSessionIds?: readonly string[]
  attentionIds?: ReadonlySet<string>
  recentProjects?: readonly string[]
  projectOrder?: readonly string[] | null
  removedProjects?: readonly string[]
  currentPath?: string | null
  /** 顶部状态筛选（默认「全部」）。 */
  stateFilter?: RailStateFilter
}

/**
 * 把会话组织成「项目 → 对话」两级。
 *
 * 搜索时：项目名/路径命中的项目整组保留（含它下面的会话）；否则只保留标题或正文
 * 命中的会话，空组直接消失。未搜索时：项目行即使 0 条对话也保留（计数 + 信任行
 * 都挂在项目行上）。
 *
 * 状态筛选（进行中 / 异常 / 结束）只过滤**对话行**：项目行的状态摘要始终是这一组
 * 的全量，否则「这个项目里有 3 个异常」在筛选后反而会消失。
 */
export function buildRailGroups(input: RailGroupInput): RailGroup[] {
  const query = input.query ?? ''
  const hasQuery = query.trim().length > 0
  const running = new Set(input.runningSessionIds ?? [])
  const attention = input.attentionIds ?? new Set<string>()
  const activeId = input.activeSessionId ?? null
  const stateFilter = input.stateFilter ?? 'all'

  // 1) 可见会话按项目归桶（这一遍不做搜索过滤 —— 项目名命中时要整组保留）
  const buckets = new Map<string, RailSessionRow[]>()
  const lastActivity = new Map<string, number>()
  for (const s of input.sessions) {
    if (!isRailVisible(s, activeId)) continue
    const path = s.projectPath ?? null
    const key = path ?? UNGROUPED_KEY
    if (path) {
      const prev = lastActivity.get(path) ?? 0
      if (s.updatedAt > prev) lastActivity.set(path, s.updatedAt)
    }
    const match = hasQuery ? matchSession(s, query) : { inTitle: false, snippet: null }
    const isRunning = running.has(s.id)
    const isBlocked = attention.has(s.id)
    const row: RailSessionRow = {
      id: s.id,
      title: s.title || DEFAULT_SESSION_TITLE,
      projectPath: path,
      updatedAt: s.updatedAt,
      pinnedAt: s.pinnedAt ?? null,
      archivedAt: s.archivedAt ?? null,
      running: isRunning,
      blocked: isBlocked,
      state: sessionStateOf(s, isRunning, isBlocked),
      snippet: match.snippet,
      titleHit: match.inTitle,
    }
    const list = buckets.get(key)
    if (list) list.push(row)
    else buckets.set(key, [row])
  }

  // 2) 项目顺序：recent 顺序优先，只有会话的项目按最近活动排在后面
  const sessionPaths = [...lastActivity.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p)
  const ordered = orderProjectPaths({
    recentProjects: input.recentProjects,
    projectOrder: input.projectOrder,
    removedProjects: input.removedProjects,
    sessionPaths,
    currentPath: input.currentPath,
  })
  const removed = new Set(input.removedProjects ?? [])
  // 兜底：会话里出现、但顺序表没覆盖到的项目（防御性，正常不会发生）
  for (const path of sessionPaths) if (!ordered.includes(path) && !removed.has(path)) ordered.push(path)

  // 3) 组内过滤 + 排序
  const groups: RailGroup[] = []
  for (const path of ordered) {
    const rows = buckets.get(path) ?? []
    const label = projectLabel(path)
    const nameHit = hasQuery ? matchProject(label, path, query) : false
    let picked = rows
    if (hasQuery && !nameHit) {
      picked = rows.filter((r) => r.titleHit || r.snippet !== null)
      if (picked.length === 0) continue
    }
    const states = countStates(picked)
    if (stateFilter !== 'all') {
      picked = picked.filter((r) => matchesStateFilter(r.state, stateFilter))
      // 状态筛选下空组直接消失（没有命中的对话，留着只是一行噪音）
      if (picked.length === 0) continue
    }
    groups.push({
      key: path,
      label,
      path,
      count: picked.length,
      states,
      sessions: [...picked].sort(compareRailSessions),
    })
  }

  // 4) 未归类会话固定置底（没有项目名可匹配，搜索时同样只看命中）
  const ungroupedAll = buckets.get(UNGROUPED_KEY) ?? []
  let ungrouped = hasQuery
    ? ungroupedAll.filter((r) => r.titleHit || r.snippet !== null)
    : ungroupedAll
  const ungroupedStates = countStates(ungrouped)
  if (stateFilter !== 'all') {
    ungrouped = ungrouped.filter((r) => matchesStateFilter(r.state, stateFilter))
  }
  if (ungrouped.length > 0) {
    groups.push({
      key: UNGROUPED_KEY,
      label: UNGROUPED_LABEL,
      path: null,
      count: ungrouped.length,
      states: ungroupedStates,
      sessions: [...ungrouped].sort(compareRailSessions),
    })
  }

  return groups
}

/** 搜索是否一条都没命中（空态判定）。 */
export function railHasHits(groups: readonly RailGroup[]): boolean {
  return groups.some((g) => g.sessions.length > 0)
}

/**
 * 顶部状态筛选上的计数：先按全部状态统计「这一栏看得见的会话」，
 * 再按当前搜索条件过滤 —— 和项目行摘要一致，不会被状态筛选本身反噬。
 */
export function railStateTotals(input: RailGroupInput): RailStateCounts {
  return countStates(
    buildRailGroups({ ...input, stateFilter: 'all' }).flatMap((group) => group.sessions),
  )
}

let _sigCache: { list: readonly ChatSession[]; sig: string } | null = null

/**
 * 会话栏的「展示签名」—— zustand selector 直接返回它。
 *
 * 为什么不是直接订阅 `sessions`：agent 跑起来时 store 的每次通知（流式 chunk、
 * 队列、trace）都可能换掉 sessions 数组的引用，selector 返回新引用 → SessionRail
 * 每一帧都重渲染、整棵树重排。这里把「会影响这一栏像素」的字段压成一个字符串，
 * 内容没变时字符串相等（Object.is），React 就不重渲染。
 *
 * 正文只记「条数 + 总长度」这一份廉价摘要（够发现消息新增/改写，又不至于每次
 * 通知都把全部正文扫一遍）；真正的命中断言由 SessionRail 里的分组 memo 现算。
 * 按 sessions 数组引用做缓存：引用没变时连拼串都省了。
 */
export function railSignature(list: readonly ChatSession[]): string {
  if (_sigCache && _sigCache.list === list) return _sigCache.sig
  const parts: string[] = []
  for (const s of list) {
    const messages = s.messages ?? []
    let contentLength = 0
    let lastError = 0
    for (const m of messages) {
      contentLength += m.content.length
      if (m.error) lastError = 1
    }
    const runs = s.agentRuns ?? []
    const lastRun = runs.length ? runs[runs.length - 1] : null
    parts.push(
      [
        s.id,
        s.title,
        s.projectPath ?? '',
        s.updatedAt,
        s.pinnedAt ?? 0,
        s.archivedAt ?? 0,
        s.mode ?? '',
        s.hidden ? 1 : 0,
        messages.length,
        contentLength,
        lastError,
        runs.length,
        lastRun?.status ?? '',
      ].join('\u0001'),
    )
  }
  const sig = parts.join('\u0002')
  _sigCache = { list, sig }
  return sig
}

/** 仅供测试：清掉签名缓存，让同一份数组能被重新计算。 */
export function __resetRailSignatureCache(): void {
  _sigCache = null
}
