import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import { readStatus, type TargetModeStatus } from '@/services/targetMode/targetModeService'
import { readSupervisorLog, type LogEntry } from '@/services/targetMode/dashboardData'
import {
  roleLabel,
  summarizeTask,
  roleGroup,
  ROLE_GROUPS,
  OFFICE_SLOTS,
  computeSlotAssignments,
  SLOT_GROUP,
  type RoleGroup,
  type SlotStatus,
} from '@/services/office/mapping'
import { MONO, CANVAS, GRADIENT, roleAvatar } from './officeTheme'
import { useThrottledValue } from '@/utils/useThrottledValue'
import type { SubAgentProgress } from '@shared/types'

const POLL_INTERVAL = 5000

/** 主循环相位的用户可读文案（相位 id 不直接上屏）。 */
const SUPERVISOR_PHASE_TEXT: Record<string, string> = {
  preparing: '准备上下文',
  compacting: '压缩历史',
  waiting: '等待模型响应',
  streaming: '执行中',
}

/** 数据/状态专用等宽字体(时间戳、代号、百分比、状态词)。 */
const MONO_FONT = "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace"

/** 看板发丝线色(与设计稿 rgba(15,23,42,0.08) 对齐)。 */
const HAIRLINE = 'rgba(15, 23, 42, 0.08)'

/** HH:MM 紧凑时间戳(工作记录 / 汇报条)。 */
function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 运行中任务的真实耗时(mm:ss / h:mm:ss)。 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 工具参数摘要(工作记录里步骤的可读描述,截断到一行)。 */
function summarizeArgs(args: Record<string, any>): string {
  try {
    const s = JSON.stringify(args ?? {})
    return s.length > 44 ? s.slice(0, 44) + '…' : s
  } catch {
    return ''
  }
}

/**
 * 角色行状态(对齐设计稿 V_K:左侧整条色条 + 右侧中文状态药片 + 悬浮窗角标)。
 * labelKey 走 i18n,渲染处用 t() 解析。
 */
const GROUP_STATUS = {
  working: { dot: '#0058bc', text: '#0058bc', pillBg: 'rgba(0, 88, 188, 0.08)', bar: '#0058bc', labelKey: 'office.statusWorking' },
  completed: { dot: '#16a34a', text: '#16a34a', pillBg: 'rgba(22, 163, 74, 0.08)', bar: 'rgba(22, 163, 74, 0.4)', labelKey: 'office.statusDone' },
  error: { dot: '#dc2626', text: '#dc2626', pillBg: 'rgba(220, 38, 38, 0.08)', bar: '#dc2626', labelKey: 'office.statusError' },
  idle: { dot: '#CBD5E1', text: '#94A3B8', pillBg: 'rgba(148, 163, 184, 0.14)', bar: 'transparent', labelKey: 'office.statusIdle' },
} as const
type GroupStatus = keyof typeof GROUP_STATUS

/** 工作记录条目(全部来自真实事件:任务开始有真实时间;工具步骤/结束态无时间戳则省略)。 */
interface WorkEntry {
  t: string | null
  kind: 'start' | 'step' | 'done' | 'error'
  title: string
  desc?: string
  meta?: string
}

interface GroupedTask {
  key: string
  p: SubAgentProgress
}

/** 子 Agent 状态排序:运行中在前,其余按启动时间倒序。 */
const rankTask = (s: SubAgentProgress['status']) => (s === 'running' ? 0 : s === 'done' ? 1 : 2)

/** 工作记录/选中目标:4 大角色组或 1 号监管(架构总监,无 subagent 进度,看经营日志)。 */
type BoardSelection = RoleGroup | '监管'

/** 选中目标的展示名:监管显示工位角色名(架构总监),角色组用组名。 */
function selectionName(sel: BoardSelection): string {
  return sel === '监管' ? '架构总监' : sel
}

/** 团队状态栏 8 工位常驻卡的展示信息。 */
interface SlotCard {
  slot: (typeof OFFICE_SLOTS)[number]
  st: SlotStatus
  doing: string
  selection: BoardSelection
}

/**
 * 「一人公司」看板 — 版本 K「融合采纳版」落地。
 *
 * 三栏布局(与设计稿对齐):
 *   栏 1 总任务进度:整体进度条 + 任务分组(进行中/已完成/失败/待办空态)
 *   栏 2 团队状态:8 个工位角色常驻卡(与 3D 办公室工位一致,数量固定不随任务增减),
 *        按真实状态排列(工作中 → 失败 → 已完成 → 空闲中);点击角色卡 →
 *        右侧工作记录切换为该角色(1 号监管显示经营日志)
 *   栏 3 工作记录 · <角色>:选中角色的时间线(任务开始/工具步骤/结束态 + NOW 实时行)
 *   底部 最新状态:渐变描边汇报条(经营日志最新一条)
 *
 * 数据全部来自真实状态(subagentProgress / implementationStatus.md / supervisor.md),
 * 不造假:进度百分比来自模型自报;工作记录的时间只来自有真实时间戳的事件。
 *
 * 性能三点:
 * - active=false(场景 Tab 被切走 / 面板被收起)时停止文件轮询,回到前台立即刷新;
 * - subagentProgress 订阅走 800ms 节流(高频进度推送逐帧跟会让三栏看板每秒
 *   重渲染多次),监控粒度 1Hz 足以;
 * - 工作记录时间线只渲染最近 60 条(子任务步骤全量可达上千行 DOM,反复重建
 *   会让看板在长任务期间明显卡顿);grid 行高用 minmax(0,1fr) 保证三栏在
 *   内容超高时收缩滚动而不是整体溢出被裁(竖向展示不全)。
 */
export default function CompanyDashboard({ active = true }: { active?: boolean }) {
  const t = useI18n()

  const activeSession = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null,
  )
  const sessionId = activeSession?.id || ''
  const rawProgress = useChatStore((s) => s.subagentProgress)
  const subagentProgress = useThrottledValue(rawProgress, 800)
  // 主循环运行相位(驱动 1 号监管工位的状态):与 3D 场景 officeBridge 同源
  const phaseEntry = useChatStore((s) => (s.activeSessionId ? s.runPhaseBySession[s.activeSessionId] : undefined))

  const [status, setStatus] = useState<TargetModeStatus | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  const refresh = useCallback(async () => {
    const root = activeSession?.projectPath || ''
    if (!root) return
    const [s, l] = await Promise.all([readStatus(root), readSupervisorLog(root)])
    setStatus(s)
    setLog(l)
  }, [activeSession?.projectPath])

  useEffect(() => {
    if (!active) return
    refresh()
    const timer = window.setInterval(refresh, POLL_INTERVAL)
    return () => window.clearInterval(timer)
  }, [refresh, active])

  // 项目选择不在此处：项目切换统一走左侧「项目/任务」栏（双击项目/单击任务），
  // 看板只跟随当前激活会话所属的项目展示。
  const currentPath = activeSession?.projectPath ?? null

  // ── 本会话子任务 + 按角色组聚合 ────────────────────────────────────────────
  const sessionTasks = useMemo(
    () => Object.entries(subagentProgress).filter(([, p]) => p.sessionId === sessionId),
    [subagentProgress, sessionId],
  )

  const tasksByGroup = useMemo(() => {
    const map = new Map<RoleGroup, GroupedTask[]>()
    for (const [key, p] of sessionTasks) {
      const g = roleGroup(p.task, p.name)
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push({ key, p })
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => rankTask(a.p.status) - rankTask(b.p.status) || b.p.startedAt - a.p.startedAt)
    }
    return map
  }, [sessionTasks])

  // 8 工位常驻卡:子任务按角色槽位池占位(运行中优先),1 号监管由主循环相位
  // 驱动;按状态排列(工作中 → 失败 → 已完成 → 空闲中),同状态按工位号。
  const slotCards = useMemo<SlotCard[]>(() => {
    const assignments = computeSlotAssignments(sessionTasks.map(([key, p]) => ({ key, p })))
    const phase = phaseEntry?.phase
    const cards: SlotCard[] = OFFICE_SLOTS.map((slot) => {
      if (slot.id === 1) {
        // 1 号监管(架构总监):主循环运行相位驱动,不参与子任务占位
        return {
          slot,
          st: phase ? 'working' : 'idle',
          doing: phase ? `监管 Agent 调度中 · ${SUPERVISOR_PHASE_TEXT[phase] ?? '处理中'}` : '待命中 · 等待派发任务',
          selection: '监管',
        }
      }
      const a = assignments[slot.id - 1]
      const task = a.key != null ? sessionTasks.find(([k]) => k === a.key)?.[1] : undefined
      return {
        slot,
        st: a.status,
        doing: task ? summarizeTask(task.task, 30) : '待命中 · 等待派发任务',
        selection: SLOT_GROUP[slot.id] ?? '研发',
      }
    })
    const rank: Record<SlotStatus, number> = { working: 0, error: 1, completed: 2, idle: 3 }
    return cards.sort((x, y) => rank[x.st] - rank[y.st] || x.slot.id - y.slot.id)
  }, [sessionTasks, phaseEntry])

  // 默认选中:优先第一个有运行中任务的组;选中的组没有任务时回落到第一个活跃组
  const [selectedGroup, setSelectedGroup] = useState<BoardSelection>('研发')
  useEffect(() => {
    const running = ROLE_GROUPS.find((g) => tasksByGroup.get(g)?.some((x) => x.p.status === 'running'))
    if (running) {
      setSelectedGroup(running)
      return
    }
    if (selectedGroup !== '监管' && (tasksByGroup.get(selectedGroup)?.length ?? 0) === 0) {
      const firstActive = ROLE_GROUPS.find((g) => (tasksByGroup.get(g)?.length ?? 0) > 0)
      if (firstActive) setSelectedGroup(firstActive)
    }
  }, [tasksByGroup, selectedGroup])

  // ── 团队状态角色卡悬浮窗 ─────────────────────────────────────────────────
  // 对话里的角色汇报只有一句结论；完整工作内容（任务全文、每一步工具调用与
  // 参数、错误）在悬停/点击角色卡时以悬浮窗呈现。
  const [hoveredGroup, setHoveredGroup] = useState<BoardSelection | null>(null)
  const [hoverAnchor, setHoverAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  // 卡片 → 悬浮窗之间有微小间隙：离开卡片后延迟 120ms 再关闭，给鼠标跨越间隙
  // 的时间；进入悬浮窗或另一张卡片时取消挂起的关闭。
  const hoverCloseTimer = useRef<number | null>(null)
  const clearHoverClose = () => {
    if (hoverCloseTimer.current != null) {
      window.clearTimeout(hoverCloseTimer.current)
      hoverCloseTimer.current = null
    }
  }
  const scheduleHoverClose = () => {
    clearHoverClose()
    hoverCloseTimer.current = window.setTimeout(() => {
      hoverCloseTimer.current = null
      setHoveredGroup(null)
    }, 120)
  }
  const hoveredTasks = hoveredGroup && hoveredGroup !== '监管' ? (tasksByGroup.get(hoveredGroup) ?? []) : []

  // ── 角色组聚合状态:「在做什么」取运行中任务,无则按完成/失败/待命回落 ──
  function groupMeta(g: RoleGroup): { status: GroupStatus; doing: string } {
    const tasks = tasksByGroup.get(g) ?? []
    const running = tasks.find((x) => x.p.status === 'running')
    if (running) return { status: 'working', doing: summarizeTask(running.p.task, 30) }
    const failed = tasks.find((x) => x.p.status === 'error' || x.p.status === 'stopped')
    if (failed) return { status: 'error', doing: summarizeTask(failed.p.task, 30) }
    if (tasks.length > 0) return { status: 'completed', doing: '任务已完成' }
    return { status: 'idle', doing: '待命中 · 等待派发任务' }
  }

  // ── 选中角色的工作记录(时间线) ────────────────────────────────────────────
  const workLog = useMemo(() => {
    if (selectedGroup === '监管') {
      // 1 号监管没有 subagent 进度,时间线展示经营日志(supervisor.md 真实条目)
      const supervisorLog: WorkEntry[] = log.map((e) => ({ t: e.time, kind: 'start', title: e.text }))
      return supervisorLog
    }
    const tasks = tasksByGroup.get(selectedGroup) ?? []
    const out: WorkEntry[] = []
    for (const { p } of [...tasks].sort((a, b) => a.p.startedAt - b.p.startedAt)) {
      out.push({
        t: fmtTime(p.startedAt),
        kind: 'start',
        title: '开始任务',
        desc: summarizeTask(p.task, 42),
        meta: roleLabel(p.task, p.name),
      })
      for (const step of p.steps) {
        out.push({
          t: null,
          kind: step.status === 'error' ? 'error' : step.status === 'success' ? 'done' : 'step',
          title: step.name,
          desc: summarizeArgs(step.arguments),
          meta: step.status.toUpperCase(),
        })
      }
      if (p.status === 'done') {
        out.push({ t: null, kind: 'done', title: '任务完成', desc: '产出已交回监管 Agent 验收', meta: 'DONE' })
      } else if (p.status === 'error' || p.status === 'stopped') {
        out.push({
          t: null,
          kind: 'error',
          title: p.status === 'stopped' ? '已停止' : '执行异常',
          desc: p.error || '',
          meta: p.status.toUpperCase(),
        })
      }
    }
    // 时间线只保留最近 60 条:子任务步骤全量铺开可达上千行 DOM,看板 ~1Hz
    // 刷新时反复重建(卡顿主因之一);截断只牺牲「更早的过程」,最新进展完整。
    return out.slice(-60)
  }, [tasksByGroup, selectedGroup, log])

  const runningInGroup =
    selectedGroup !== '监管' ? (tasksByGroup.get(selectedGroup) ?? []).find((x) => x.p.status === 'running') : undefined

  // ── 汇总指标 ───────────────────────────────────────────────────────────────
  const percent = status?.percent ?? null
  const badgeRound = status?.round != null ? `R${status.round}` : null
  const runningCount = sessionTasks.filter(([, p]) => p.status === 'running').length
  const doneCount = sessionTasks.filter(([, p]) => p.status === 'done').length
  const failedCount = sessionTasks.filter(([, p]) => p.status === 'error' || p.status === 'stopped').length
  const todoCount = sessionTasks.length - runningCount - doneCount - failedCount
  const now = Date.now()

  // ── 最新状态汇报条:经营日志最新一条(真实) ─────────────────────────────────
  const latestLog = log[0] ?? null

  const headerStyle: CSSProperties = {
    padding: '10px 14px',
    borderBottom: `1px solid ${HAIRLINE}`,
    background: 'rgba(250, 250, 252, 0.6)',
  }

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ background: CANVAS }}>
      {/* 顶部:当前项目看板标题（项目选择统一在左侧项目/任务栏进行） */}
      <div className="shrink-0 px-4 pt-3 pb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-[17px] font-bold truncate min-w-0" style={{ color: '#0d1c2d' }}>
            {(currentPath?.split(/[/\\]/).pop() || t('office.currentProject'))}
            <span style={{ color: '#c2c6d5', fontWeight: 400, margin: '0 6px' }}>·</span>
            {t('office.boardTitle')}
          </h1>
        </div>
      </div>

      {/* 三栏看板(对齐设计稿 V_K 的 3:5:4 栏宽——团队状态栏最宽,容纳一排 4 个工位小方卡) */}
      <div
        className="flex-1 min-h-0 px-4 pb-2 grid gap-3"
        style={{
          minWidth: 0,
          gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 5fr) minmax(0, 4fr)',
          // 行高必须是可收缩的确定高度(minmax(0,1fr)),不能是默认 auto:
          // auto 行按内容撑高——任一栏内容超高时整行溢出面板,被底部汇报条/
          // 面板裁掉(竖向展示不全),栏内滚动区也因无确定高度而失效。
          gridTemplateRows: 'minmax(0, 1fr)',
        }}
      >
        {/* ── 栏 1:总任务进度 ── */}
        <div className="bg-white rounded-lg border flex flex-col overflow-hidden" style={{ borderColor: HAIRLINE, minWidth: 0 }}>
          <div style={headerStyle}>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-[13px] font-bold flex items-center gap-1.5" style={{ color: '#0d1c2d' }}>
                <span style={{ fontSize: 15, color: '#0058bc' }}>◧</span>
                {t('office.totalProgress')}
              </h2>
              {badgeRound && (
                <span
                  className="shrink-0"
                  style={{
                    fontFamily: MONO_FONT, fontSize: 10, color: MONO.t2,
                    background: '#F8F9FF', border: `1px solid ${HAIRLINE}`,
                    borderRadius: 4, padding: '1px 7px',
                  }}
                >
                  {badgeRound}
                </span>
              )}
            </div>
            {/* 整体进度条:渐变填充 */}
            <div className="h-2 w-full rounded-full overflow-hidden" style={{ background: '#e5efff' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${percent != null ? Math.min(100, Math.max(0, percent)) : 0}%`,
                  background: GRADIENT.blue,
                }}
              />
            </div>
            <div className="flex justify-between mt-1.5" style={{ fontFamily: MONO_FONT, fontSize: 10.5, color: MONO.t3 }}>
              <span>{percent != null ? `${Math.round(percent)}%` : '—'}</span>
              <span>
                {doneCount}/{sessionTasks.length} {t('office.taskCount')}
              </span>
            </div>
          </div>

          {/* 任务分组:进行中 / 已完成 / 失败 / 待办 */}
          <div className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col gap-2">
            {sessionTasks.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-center px-4" style={{ fontSize: 12, color: MONO.t3 }}>
                {t('office.noTasks')}
              </div>
            )}
            {sessionTasks
              .slice()
              .sort((a, b) => rankTask(a[1].status) - rankTask(b[1].status) || b[1].startedAt - a[1].startedAt)
              .map(([key, p]) => {
                const tm = p.status === 'done' ? { color: '#16a34a' } : p.status === 'error' || p.status === 'stopped' ? { color: '#dc2626' } : { color: '#0058bc' }
                return (
                  <div
                    key={key}
                    className="flex items-start gap-2.5 p-2 rounded-md border"
                    style={{
                      borderColor: p.status === 'running' ? 'rgba(0,88,188,0.2)' : HAIRLINE,
                      background: p.status === 'running' ? 'rgba(232,240,255,0.25)' : '#FBFBFC',
                      position: 'relative',
                    }}
                    title={p.status === 'running' ? `${t('office.toolCalls')}: ${p.toolCallCount}` : p.error || undefined}
                  >
                    {p.status === 'running' && (
                      <span
                        className="absolute left-0 top-0 bottom-0 rounded-l-md"
                        style={{ width: 3, background: '#0058bc' }}
                      />
                    )}
                    {/* 状态指示:运行中彩虹环旋转 / 完成绿勾 / 失败红叉 */}
                    {p.status === 'running' ? (
                      <span
                        className="shrink-0 rounded-full animate-spin"
                        style={{
                          width: 15, height: 15, padding: 2, marginTop: 1,
                          background: GRADIENT.rainbow,
                          animationDuration: '2s',
                        }}
                      >
                        <span className="block w-full h-full rounded-full" style={{ background: '#fff' }} />
                      </span>
                    ) : p.status === 'done' ? (
                      <span
                        className="shrink-0 rounded-full flex items-center justify-center mt-0.5"
                        style={{ width: 15, height: 15, border: '1.5px solid #16a34a', color: '#16a34a', fontSize: 10, fontWeight: 700, background: 'rgba(22,163,74,0.08)' }}
                      >
                        ✓
                      </span>
                    ) : (
                      <span
                        className="shrink-0 rounded-full flex items-center justify-center mt-0.5"
                        style={{ width: 15, height: 15, border: '1.5px solid #dc2626', color: '#dc2626', fontSize: 10, fontWeight: 700, background: 'rgba(220,38,38,0.06)' }}
                      >
                        ✕
                      </span>
                    )}
                    <div className="flex flex-col flex-1 min-w-0">
                      <span
                        className="truncate"
                        style={{
                          fontSize: 12.5, fontWeight: 500, color: '#0d1c2d',
                          textDecoration: p.status === 'done' ? 'line-through' : undefined,
                          opacity: p.status === 'done' ? 0.55 : 1,
                        }}
                      >
                        {summarizeTask(p.task, 34)}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 min-w-0">
                        <span
                          className="shrink-0 rounded flex items-center justify-center"
                          style={{
                            width: 16, height: 16, borderRadius: 999,
                            background: roleAvatar(roleLabel(p.task, p.name)).bg,
                            color: '#fff', fontSize: 9, fontWeight: 700,
                          }}
                        >
                          {roleAvatar(roleLabel(p.task, p.name)).char}
                        </span>
                        <span className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 9.5, color: MONO.t3 }}>
                          {roleLabel(p.task, p.name)}
                        </span>
                        <span className="shrink-0 ml-auto" style={{ fontFamily: MONO_FONT, fontSize: 9.5, color: tm.color, fontWeight: 600 }}>
                          {p.status === 'running'
                            ? `RUNNING ${formatDuration(now - p.startedAt)}`
                            : p.status === 'done' ? 'DONE' : 'FAILED'}
                        </span>
                      </span>
                    </div>
                  </div>
                )
              })}
            {/* 待办:暂无真实待办队列,虚线空态提示 */}
            {todoCount === 0 && sessionTasks.length > 0 && (
              <div
                className="rounded-md border border-dashed flex items-center justify-center px-3 py-2"
                style={{ borderColor: HAIRLINE, fontSize: 11, color: MONO.t3 }}
              >
                {t('office.noTodo')}
              </div>
            )}
          </div>
        </div>

        {/* ── 栏 2:团队状态(8 工位常驻) ── */}
        <div className="bg-white rounded-lg border flex flex-col overflow-hidden" style={{ borderColor: HAIRLINE, minWidth: 0 }}>
          <div style={headerStyle}>
            <h2 className="text-[13px] font-bold flex items-center gap-1.5" style={{ color: '#0d1c2d' }}>
              <span style={{ fontSize: 15, color: MONO.t2 }}>◈</span>
              {t('office.teamStatus')}
              <span className="shrink-0 ml-auto" style={{ fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 600, color: MONO.t3 }}>
                {OFFICE_SLOTS.length} 工位
              </span>
            </h2>
          </div>
          {/* 8 工位常驻小方卡(一排 4 个、共 2 行,数量固定与 3D 办公室工位一致),极简结构:
              状态点 + 角色名 + 状态词;按状态排列(工作中 → 失败 → 已完成 → 空闲中);
              点击切换右侧工作记录,悬停弹完整工作内容。
              卡片不放 overflow-hidden(会清零固有最小高度、把网格行压扁),
              配合 auto-rows-max 行高始终按内容;高度不够由容器滚动兜底。 */}
          <div
            className="flex-1 min-h-0 overflow-y-auto p-3 grid grid-cols-4 auto-rows-max content-start gap-2"
            style={{ background: 'rgba(15,23,42,0.02)' }}
          >
            {slotCards.map(({ slot, st, selection }) => {
              const meta = GROUP_STATUS[st]
              const selected = selection === selectedGroup
              const working = st === 'working'
              return (
                <button
                  key={slot.id}
                  onClick={() => setSelectedGroup(selection)}
                  onMouseEnter={(e) => {
                    clearHoverClose()
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setHoverAnchor({ top: rect.bottom + 6, left: rect.left })
                    setHoveredGroup(selection)
                  }}
                  onMouseLeave={scheduleHoverClose}
                  className="flex flex-col gap-1 text-left transition-colors"
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: '#fff',
                    border: selected ? `1.5px solid #0058bc` : `1px solid ${HAIRLINE}`,
                    cursor: 'pointer',
                  }}
                  title={`${t('office.viewWorkLog')}: ${slot.role}`}
                >
                  {/* 状态点 + 角色名(运行中状态点脉冲) */}
                  <span className="flex items-center gap-1.5 min-w-0 w-full">
                    <span
                      className="shrink-0 inline-block rounded-full"
                      style={{
                        width: 6, height: 6, background: meta.dot,
                        animation: working ? 'pulseSoft 1.6s ease-in-out infinite' : undefined,
                      }}
                    />
                    <span className="truncate text-[12px] font-bold" style={{ color: selected ? '#0058bc' : '#0d1c2d' }}>
                      {slot.role}
                    </span>
                  </span>
                  {/* 状态词,左缩进与角色名对齐 */}
                  <span className="truncate w-full" style={{ fontSize: 10, fontWeight: 600, color: meta.text, paddingLeft: 12 }}>
                    {t(meta.labelKey)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── 栏 3:工作记录 · <选中角色> ── */}
        <div className="bg-white rounded-lg border flex flex-col overflow-hidden relative" style={{ borderColor: HAIRLINE, minWidth: 0 }}>
          <div style={headerStyle}>
            <h2 className="text-[13px] font-bold flex items-center gap-1.5" style={{ color: '#0d1c2d' }}>
              <span style={{ fontSize: 15, color: MONO.t2 }}>◷</span>
              {t('office.workLog')}
              <span style={{ color: '#c2c6d5', fontWeight: 400, margin: '0 2px' }}>·</span>
              {selectionName(selectedGroup)}
            </h2>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4 relative">
            {/* 时间线竖线 */}
            <div
              className="absolute"
              style={{ left: 31, top: 16, bottom: 16, width: 1, background: 'rgba(15,23,42,0.08)' }}
            />
            <div className="flex flex-col gap-4 relative">
              {workLog.length === 0 && !runningInGroup && (
                <div className="text-center py-8" style={{ fontSize: 12, color: MONO.t3 }}>
                  {t('office.noWorkLog')}
                </div>
              )}
              {workLog.map((e, i) => {
                const dotColor =
                  e.kind === 'done' ? '#16a34a' : e.kind === 'error' ? '#dc2626' : e.kind === 'start' ? '#0058bc' : '#c2c6d5'
                const titleColor = e.kind === 'error' ? '#dc2626' : '#0d1c2d'
                return (
                  <div key={i} className="flex gap-3">
                    <div className="w-7 text-right shrink-0 pt-0.5">
                      <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: MONO.t3 }}>{e.t ?? ''}</span>
                    </div>
                    <span
                      className="shrink-0 rounded-full mt-1"
                      style={{ width: 10, height: 10, background: '#fff', border: `3px solid ${dotColor}`, zIndex: 1 }}
                    />
                    <div className="flex-1 min-w-0 pb-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate text-[12px]" style={{ color: titleColor, fontWeight: e.kind === 'start' ? 500 : 400 }}>
                          {e.title}
                        </span>
                        {e.meta && (
                          <span className="shrink-0" style={{ fontFamily: MONO_FONT, fontSize: 9, color: MONO.t3 }}>
                            {e.meta}
                          </span>
                        )}
                      </div>
                      {e.desc && (
                        <div
                          className="truncate mt-0.5"
                          style={{
                            fontFamily: e.kind === 'step' ? MONO_FONT : undefined,
                            fontSize: e.kind === 'step' ? 10.5 : 11,
                            color: e.kind === 'step' ? '#64748b' : MONO.t2,
                          }}
                        >
                          {e.desc}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {/* NOW 实时行:选中组有运行中任务时 */}
              {runningInGroup && (
                <div className="flex gap-3">
                  <div className="w-7 text-right shrink-0 pt-0.5">
                    <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, color: '#0058bc' }}>
                      {t('office.nowLabel')}
                    </span>
                  </div>
                  <span
                    className="shrink-0 rounded-full animate-spin"
                    style={{
                      width: 14, height: 14, padding: 2, marginTop: 0,
                      background: GRADIENT.rainbow, animationDuration: '2s', zIndex: 1,
                    }}
                  >
                    <span className="block w-full h-full rounded-full" style={{ background: '#fff' }} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium" style={{ color: '#0058bc' }}>
                        {t('office.workInProgress')}
                      </span>
                      <span
                        className="shrink-0"
                        style={{
                          fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 600, color: '#0058bc',
                          background: '#e8f0ff', borderRadius: 4, padding: '1px 7px',
                        }}
                      >
                        RUNNING {formatDuration(now - runningInGroup.p.startedAt)}
                      </span>
                    </div>
                    <div className="w-full h-1 rounded-full mt-2 overflow-hidden" style={{ background: '#e5efff' }}>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, Math.max(8, Math.round((runningInGroup.p.toolCallCount / 8) * 60 + 20)))}%`,
                          background: '#0058bc',
                          animation: 'pulseSoft 1.6s ease-in-out infinite',
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 底部:最新状态汇报条(渐变描边) */}
      <div className="shrink-0 px-4 pb-3">
        <div
          className="h-10 rounded-lg flex items-center px-4 justify-between gap-3"
          style={{
            background: 'linear-gradient(white, white) padding-box, linear-gradient(90deg, #0058bc, #8b5cf6, #ec4899) border-box',
            border: '1px solid transparent',
          }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span style={{ color: '#0058bc', fontSize: 14 }}>◉</span>
            <span className="shrink-0 text-[12px] font-bold" style={{ color: '#0d1c2d' }}>
              {t('office.latestStatus')}:
            </span>
            <span className="truncate text-[12px]" style={{ color: '#424753' }}>
              {latestLog ? latestLog.text : t('office.noLog')}
            </span>
          </div>
          {latestLog && (
            <span className="shrink-0" style={{ fontFamily: MONO_FONT, fontSize: 10.5, color: MONO.t3 }}>
              {latestLog.time}
            </span>
          )}
        </div>
      </div>

      {/* 团队状态角色卡悬浮窗：完整工作内容（任务全文 + 工具步骤 + 错误）。
          固定定位贴卡片下方，鼠标离开卡片即消失；越界时向上翻。 */}
      {hoveredGroup && (
        <div
          onMouseEnter={clearHoverClose}
          onMouseLeave={scheduleHoverClose}
          className="fixed z-[70] rounded-xl border shadow-xl"
          style={{
            top: Math.min(hoverAnchor.top, window.innerHeight - 420),
            left: hoverAnchor.left,
            width: 340,
            maxHeight: 400,
            overflowY: 'auto',
            background: '#fff',
            borderColor: HAIRLINE,
            boxShadow: '0 12px 40px rgba(15,23,42,0.16)',
          }}
        >
          <div className="sticky top-0 flex items-center justify-between px-3.5 py-2.5 border-b" style={{ borderColor: HAIRLINE, background: '#FAFAFC' }}>
            <span className="text-[12px] font-bold" style={{ color: '#0d1c2d' }}>{selectionName(hoveredGroup)} · 工作内容</span>
            <span
              className="rounded-full"
              style={{
                fontSize: 10, fontWeight: 600, padding: '2px 8px',
                color: (hoveredGroup === '监管'
                  ? GROUP_STATUS[phaseEntry ? 'working' : 'idle']
                  : GROUP_STATUS[groupMeta(hoveredGroup).status]).text,
                background: (hoveredGroup === '监管'
                  ? GROUP_STATUS[phaseEntry ? 'working' : 'idle']
                  : GROUP_STATUS[groupMeta(hoveredGroup).status]).pillBg,
              }}
            >
              {t((hoveredGroup === '监管'
                ? GROUP_STATUS[phaseEntry ? 'working' : 'idle']
                : GROUP_STATUS[groupMeta(hoveredGroup).status]).labelKey)}
            </span>
          </div>
          {hoveredGroup === '监管' ? (
            log.length === 0 ? (
              <div className="px-3.5 py-6 text-center" style={{ fontSize: 11.5, color: MONO.t3 }}>
                {t('office.noWorkLog')}
              </div>
            ) : (
              <div className="px-3.5 py-2.5 flex flex-col">
                {log.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 py-1.5 border-b last:border-b-0" style={{ borderColor: HAIRLINE }}>
                    <span className="shrink-0" style={{ fontFamily: MONO_FONT, fontSize: 9.5, color: MONO.t3, width: 58 }}>
                      {e.time}
                    </span>
                    <span className="min-w-0 flex-1" style={{ fontSize: 11, color: '#424753', lineHeight: 1.5 }}>
                      {e.text}
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : (
            <>
              {hoveredTasks.length === 0 && (
                <div className="px-3.5 py-6 text-center" style={{ fontSize: 11.5, color: MONO.t3 }}>
                  {t('office.noWorkLog')}
                </div>
              )}
              {hoveredTasks.map(({ key, p }) => (
                <div key={key} className="px-3.5 py-3 border-b last:border-b-0" style={{ borderColor: HAIRLINE }}>
                  <div className="flex items-start gap-2">
                    <span
                      className="shrink-0 rounded-full flex items-center justify-center mt-0.5"
                      style={{ width: 16, height: 16, background: roleAvatar(roleLabel(p.task, p.name)).bg, color: '#fff', fontSize: 8.5, fontWeight: 700 }}
                    >
                      {roleAvatar(roleLabel(p.task, p.name)).char}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[12px] font-semibold" style={{ color: '#0d1c2d' }}>{roleLabel(p.task, p.name)}</span>
                        <span
                          className="shrink-0"
                          style={{
                            fontFamily: MONO_FONT, fontSize: 9, fontWeight: 600,
                            color: p.status === 'running' ? '#0058bc' : p.status === 'done' ? '#16a34a' : '#dc2626',
                          }}
                        >
                          {p.status === 'running' ? 'RUNNING' : p.status === 'done' ? 'DONE' : 'FAILED'}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[12px] leading-relaxed break-words" style={{ color: '#424753' }}>
                        {summarizeTask(p.task, 240)}
                      </div>
                      {p.steps.length > 0 && (
                        <div className="mt-1.5 flex flex-col gap-1">
                          {p.steps.map((st) => (
                            <div key={st.id} className="flex items-start gap-1.5">
                              <span
                                className="shrink-0 mt-[3px] rounded-full"
                                style={{
                                  width: 5, height: 5,
                                  background: st.status === 'success' ? '#16a34a' : st.status === 'error' ? '#dc2626' : '#0058bc',
                                }}
                              />
                              <div className="min-w-0 flex-1" style={{ fontFamily: MONO_FONT, fontSize: 10, color: '#64748b' }}>
                                <span style={{ color: '#334155', fontWeight: 500 }}>{st.name}</span>
                                <span className="block truncate" title={summarizeArgs(st.arguments)}>{summarizeArgs(st.arguments)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {p.error && (
                        <div className="mt-1 text-[11px] leading-relaxed break-words" style={{ color: '#dc2626' }}>{p.error}</div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
