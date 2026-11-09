/**
 * 「一人公司 / Office」面纯视图模型单测（src/shell/office/officeModel.ts）。
 *
 * 这里只测纯函数：指标格式、任务分组、检查清单进度、工位排序、待决条目、
 * 键盘选择位、以及「没数据源就标未接入」这条底线。
 */
import { describe, expect, it } from 'vitest'

import type { ChatMessage, ChatSession, SubAgentProgress } from '@shared/types'
import {
  activeRoleCount,
  basename,
  buildChecklistRows,
  buildMetrics,
  buildPendingDescriptors,
  buildRoleRows,
  buildTaskRows,
  busyMsOf,
  checklistCountText,
  checklistMark,
  checklistProgress,
  companyName,
  companyStatus,
  directorTaskLine,
  formatClock,
  formatDuration,
  formatHours,
  formatTokens,
  groupTaskCounts,
  initialSelectionIndex,
  isSelectionKey,
  lastRunFailed,
  moveSelection,
  oneLine,
  pendingCountBySession,
  pickDirector,
  resolveProjectPath,
  roleStatusWord,
  roundLine,
  stageLine,
  taskStatusWord,
  workerTaskLine,
  type OfficeRoleRow,
  type OfficeTaskRow,
} from '@/shell/office/officeModel'
import type { DirectorActivity } from '@/services/office/taskRequests'

// ── fixtures ─────────────────────────────────────────────────────────────

const MODEL_PARAMS = {
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  thinking: false,
  reasoningEffort: 'medium' as const,
}

function msg(partial: Partial<ChatMessage> & { role: ChatMessage['role']; content: string; createdAt: number }): ChatMessage {
  return {
    id: `m-${partial.role}-${partial.createdAt}`,
    sortOrder: partial.createdAt,
    contextFiles: [],
    tokenCount: 0,
    ...partial,
  }
}

function session(partial: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    title: partial.id,
    configGroupId: 'cfg',
    model: 'gpt',
    modelParams: MODEL_PARAMS,
    messages: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...partial,
  }
}

function activity(partial: Partial<DirectorActivity> & { key: string; startedAt: number }): DirectorActivity {
  return {
    label: '研发',
    task: '实现登录接口',
    status: 'running',
    group: '研发',
    ...partial,
  }
}

const ROOT = 'E:/work/ourcode'

// ── 格式 ─────────────────────────────────────────────────────────────────

describe('office 格式工具', () => {
  it('formatClock：当天只给 HH:mm，跨天带日期，0 给空串（不造时间）', () => {
    const now = new Date(2026, 10, 6, 18, 30).getTime()
    const sameDay = new Date(2026, 10, 6, 9, 5).getTime()
    const otherDay = new Date(2026, 9, 2, 7, 3).getTime()
    expect(formatClock(sameDay, now)).toBe('09:05')
    expect(formatClock(otherDay, now)).toBe('10月2日 07:03')
    expect(formatClock(0, now)).toBe('')
    expect(formatClock(Number.NaN, now)).toBe('')
  })

  it('formatHours / formatDuration：分 / 小时两档，负数与 NaN 归零', () => {
    expect(formatHours(0)).toEqual({ value: '0', suffix: '分' })
    expect(formatHours(20_000)).toEqual({ value: '0', suffix: '分' })
    expect(formatHours(12 * 60_000)).toEqual({ value: '12', suffix: '分' })
    expect(formatHours(90 * 60_000)).toEqual({ value: '1.5', suffix: '小时' })
    expect(formatHours(-5)).toEqual({ value: '0', suffix: '分' })
    expect(formatDuration(90 * 60_000)).toBe('1.5 小时')
  })

  it('formatTokens：1.2M / 320k / 12', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(2_000_000)).toBe('2M')
    expect(formatTokens(320_400)).toBe('320k')
    expect(formatTokens(12)).toBe('12')
  })

  it('oneLine：压空白、截断、空值回退', () => {
    expect(oneLine('  a\n\nb  ')).toBe('a b')
    expect(oneLine('', 10, '兜底')).toBe('兜底')
    expect(oneLine('x'.repeat(20), 5)).toBe('xxxxx…')
  })

  it('basename / companyName：项目目录名，空路径回退到一人公司', () => {
    expect(basename('E:\\ls\\ideUtil\\OurCode-ide\\')).toBe('OurCode-ide')
    expect(basename('E:/work/ourcode')).toBe('ourcode')
    expect(companyName(null)).toBe('一人公司')
    expect(companyName('')).toBe('一人公司')
  })
})

// ── 公司状态词 ───────────────────────────────────────────────────────────

describe('companyStatus', () => {
  it('优先级：未连接 → 待决策 → 运行中 → 空闲', () => {
    expect(companyStatus({ connected: false, running: true, pending: 3 }).word).toBe('未连接')
    expect(companyStatus({ connected: true, running: true, pending: 2 })).toEqual({
      key: 'deciding',
      word: '待决策 2',
    })
    expect(companyStatus({ connected: true, running: true, pending: 0 })).toEqual({
      key: 'running',
      word: '运行中',
    })
    expect(companyStatus({ connected: true, running: false, pending: 0 })).toEqual({
      key: 'idle',
      word: '空闲',
    })
  })
})

// ── 角色 / 工位 ──────────────────────────────────────────────────────────

describe('buildRoleRows', () => {
  const director = session({
    id: 'dir',
    projectPath: ROOT,
    targetMode: true,
    updatedAt: 5_000,
    messages: [
      msg({ role: 'user', content: '做一个登录页', createdAt: 1_000 }),
      msg({ role: 'user', content: '再补一个验证码', createdAt: 2_000 }),
    ],
  })
  const worker = session({
    id: 'w4',
    projectPath: ROOT,
    workerRole: 'tm-developer',
    workerSlot: 4,
    title: '业务研发-1',
    messages: [
      msg({
        role: 'user',
        content: '[来自会话「总监」的会话间消息]\n\n实现登录接口',
        createdAt: 3_000,
      }),
    ],
  })
  const otherProject = session({ id: 'x', projectPath: 'E:/other', targetMode: true })

  it('没有项目 → 空列表', () => {
    expect(buildRoleRows({ sessions: [director], projectPath: null, runningSessionIds: [], pendingBySession: new Map() })).toEqual([])
  })

  it('总监第一行 + 编制内空缺工位保留 + 动态工位追加，按工位号排序', () => {
    const rows = buildRoleRows({
      sessions: [director, worker, otherProject],
      projectPath: ROOT,
      runningSessionIds: ['w4'],
      pendingBySession: new Map([['w4', 2]]),
    })
    const slots = rows.map((r: OfficeRoleRow) => r.slot)
    expect(slots).toEqual([1, 2, 3, 4, 7])
    expect(rows[0].role).toBe('总监')
    expect(rows[0].taskLine).toBe('再补一个验证码')
    // 需求分析师 / UI 研发 / 测试-1 编制内没有员工 → 空缺（不隐藏、不臆造员工）
    expect(rows[1].staffed).toBe(false)
    expect(rows[1].statusWord).toBe('空缺')
    // 业务研发-1 在岗、运行中、有 2 件待处理
    const dev = rows.find((r) => r.slot === 4)!
    expect(dev.role).toBe('业务研发-1')
    expect(dev.running).toBe(true)
    expect(dev.pending).toBe(2)
    expect(dev.taskLine).toBe('实现登录接口')
    expect(dev.sessionId).toBe('w4')
  })

  it('动态增员的工位（5/6/8）在没有员工时不出现在列表里', () => {
    const rows = buildRoleRows({
      sessions: [director, worker],
      projectPath: ROOT,
      runningSessionIds: [],
      pendingBySession: new Map(),
    })
    expect(rows.some((r) => r.slot === 5)).toBe(false)
    expect(rows.some((r) => r.slot === 8)).toBe(false)
  })

  it('activeRoleCount 只数在岗且有动静的工位', () => {
    const rows = buildRoleRows({
      sessions: [director, worker],
      projectPath: ROOT,
      runningSessionIds: ['w4'],
      pendingBySession: new Map(),
    })
    expect(activeRoleCount(rows)).toBe(1)
  })
})

describe('任务行文案', () => {
  it('workerTaskLine 去掉会话间前缀；没有派发时给待命文案', () => {
    const worker = session({
      id: 'w',
      workerRole: 'tm-tester',
      workerSlot: 7,
      messages: [
        msg({ role: 'user', content: '[来自会话「总监」的会话间消息]\n\n跑一遍回归', createdAt: 10 }),
      ],
    })
    expect(workerTaskLine(worker)).toBe('跑一遍回归')
    expect(workerTaskLine(session({ id: 'e' }))).toBe('待命中 · 等待派发')
  })

  it('directorTaskLine 只看用户真实要求（回报 / 会话间消息不算）', () => {
    const director = session({
      id: 'd',
      targetMode: true,
      messages: [
        msg({ role: 'user', content: '目标：登录页', createdAt: 1 }),
        msg({ role: 'user', content: '[来自会话「测试-1」的会话间消息]\n\n已完成', createdAt: 2 }),
        msg({ role: 'assistant', content: '好的', createdAt: 3 }),
      ],
    })
    expect(directorTaskLine(director)).toBe('目标：登录页')
    expect(directorTaskLine(session({ id: 'empty', targetMode: true }))).toBe('待命中 · 等待你下目标')
  })

  it('roleStatusWord 五态都带文字', () => {
    expect(roleStatusWord({ staffed: false, running: false, pending: 0, failed: false })).toBe('空缺')
    expect(roleStatusWord({ staffed: true, running: true, pending: 2, failed: true })).toBe('运行中')
    expect(roleStatusWord({ staffed: true, running: false, pending: 0, failed: true })).toBe('失败')
    expect(roleStatusWord({ staffed: true, running: false, pending: 1, failed: false })).toBe('待处理')
    expect(roleStatusWord({ staffed: true, running: false, pending: 0, failed: false })).toBe('空闲')
  })

  it('lastRunFailed 看最新一条 agent run', () => {
    const failed = session({
      id: 'f',
      agentRuns: [
        { id: 'a', task: 't', status: 'error', startedAt: 10, toolCallCount: 0, fileChangeCount: 0, stepCount: 0 } as never,
      ],
    })
    const ok = session({
      id: 'o',
      agentRuns: [
        { id: 'a', task: 't', status: 'error', startedAt: 10, toolCallCount: 0, fileChangeCount: 0, stepCount: 0 } as never,
        { id: 'b', task: 't2', status: 'done', startedAt: 20, toolCallCount: 0, fileChangeCount: 0, stepCount: 0 } as never,
      ],
    })
    expect(lastRunFailed(failed)).toBe(true)
    expect(lastRunFailed(ok)).toBe(false)
    expect(lastRunFailed(null)).toBe(false)
  })
})

describe('pickDirector / resolveProjectPath', () => {
  const older = session({ id: 'old', projectPath: ROOT, targetMode: true, updatedAt: 100 })
  const newer = session({ id: 'new', projectPath: ROOT, targetMode: true, updatedAt: 900 })
  const worker = session({ id: 'w', projectPath: ROOT, workerRole: 'tm-developer', workerSlot: 4, updatedAt: 9_999 })

  it('取最近更新的目标模式非员工会话', () => {
    expect(pickDirector([older, worker, newer])?.id).toBe('new')
    expect(pickDirector([worker])).toBeNull()
  })

  it('项目根：激活会话优先 → 总监 → 任一公司会话 → 兜底 root', () => {
    const active = session({ id: 'act', projectPath: 'E:/active' })
    expect(resolveProjectPath([active, newer], 'act', 'E:/root')).toBe('E:/active')
    expect(resolveProjectPath([newer, worker], null, 'E:/root')).toBe(ROOT)
    expect(resolveProjectPath([session({ id: 'plain' })], null, 'E:/root')).toBe('E:/root')
    expect(resolveProjectPath([], null, null)).toBeNull()
  })
})

// ── 任务流 ──────────────────────────────────────────────────────────────

describe('buildTaskRows / groupTaskCounts', () => {
  it('状态词四态 + 新的在上面 + 打开会话指向总监会话', () => {
    const rows = buildTaskRows(
      [
        activity({ key: 'a', startedAt: 100, status: 'running' }),
        activity({ key: 'b', startedAt: 300, status: 'done' }),
        activity({ key: 'c', startedAt: 200, status: 'pending', label: '测试-1' }),
        activity({ key: 'd', startedAt: 50, status: 'failed' }),
      ],
      'dir',
    )
    expect(rows.map((r: OfficeTaskRow) => r.key)).toEqual(['b', 'c', 'a', 'd'])
    expect(rows.map((r) => r.statusWord)).toEqual(['已完成', '待回报', '运行中', '失败'])
    expect(rows.every((r) => r.sessionId === 'dir')).toBe(true)
  })

  it('label 缺失时回退「子任务」，描述缺失时给占位', () => {
    const rows = buildTaskRows([activity({ key: 'x', startedAt: 1, label: '', task: '' })], null)
    expect(rows[0].role).toBe('子任务')
    expect(rows[0].task).toBe('（无任务描述）')
    expect(rows[0].sessionId).toBeNull()
  })

  it('组计数：运行中 / 待回报 / 已完成 / 失败', () => {
    const rows = buildTaskRows(
      [
        activity({ key: 'a', startedAt: 4, status: 'running' }),
        activity({ key: 'b', startedAt: 3, status: 'running' }),
        activity({ key: 'c', startedAt: 2, status: 'pending' }),
        activity({ key: 'd', startedAt: 1, status: 'done' }),
        activity({ key: 'e', startedAt: 0, status: 'failed' }),
      ],
      'dir',
    )
    expect(groupTaskCounts(rows)).toEqual({ running: 2, waiting: 1, done: 1, failed: 1, total: 5 })
    expect(groupTaskCounts([])).toEqual({ running: 0, waiting: 0, done: 0, failed: 0, total: 0 })
  })

  it('taskStatusWord 每个状态都有中文词（不靠颜色）', () => {
    expect(taskStatusWord('running')).toBe('运行中')
    expect(taskStatusWord('pending')).toBe('待回报')
    expect(taskStatusWord('done')).toBe('已完成')
    expect(taskStatusWord('failed')).toBe('失败')
  })
})

// ── 指标 ────────────────────────────────────────────────────────────────

describe('buildMetrics', () => {
  it('营收没有数据源 → 未接入（wired=false），其余三个用真实数据', () => {
    const metrics = buildMetrics({
      counts: { running: 1, waiting: 0, done: 3, failed: 0, total: 7 },
      pending: 2,
      busyMs: 90 * 60_000,
    })
    expect(metrics.map((m) => m.key)).toEqual(['revenue', 'throughput', 'backlog', 'hours'])

    const revenue = metrics[0]
    expect(revenue.wired).toBe(false)
    expect(revenue.value).toBe('未接入')
    expect(revenue.value).not.toMatch(/[0-9]/)

    expect(metrics[1]).toMatchObject({ wired: true, value: '3', suffix: '/ 7' })
    expect(metrics[2]).toMatchObject({ wired: true, value: '2' })
    expect(metrics[3]).toMatchObject({ wired: true, value: '1.5', suffix: '小时' })
  })

  it('没有活动时不拼 `/ 0` 尾缀', () => {
    const metrics = buildMetrics({ counts: { running: 0, waiting: 0, done: 0, failed: 0, total: 0 }, pending: 0, busyMs: 0 })
    expect(metrics[1].suffix).toBeUndefined()
    expect(metrics[3]).toMatchObject({ value: '0', suffix: '分' })
  })

  it('busyMsOf 汇总真实时间戳：已结束取 finishedAt-startedAt，在跑取到 now', () => {
    const now = 100_000
    const s = session({
      id: 's',
      agentRuns: [
        { id: 'r1', task: 'a', status: 'done', startedAt: 1_000, finishedAt: 4_000 } as never,
        { id: 'r2', task: 'b', status: 'running', startedAt: 90_000 } as never,
        { id: 'r3', task: 'c', status: 'done', startedAt: 0, finishedAt: 2_000 } as never,
      ],
    })
    expect(busyMsOf([s], now)).toBe(3_000 + 10_000)
    expect(busyMsOf([], now)).toBe(0)
  })
})

// ── 待决中心 ────────────────────────────────────────────────────────────

describe('buildPendingDescriptors', () => {
  it('审批 + 提问 + 预算触顶三件都进待决中心，动作文案是文字', () => {
    const rows = buildPendingDescriptors({
      approval: { sessionId: 'dir', toolName: 'write_file', preview: 'src/a.ts' },
      question: { sessionId: 'dir', question: '要删掉旧文件吗？', options: ['删', '留'], dismissed: false },
      budget: { exceeded: true, used: 2_000_000, limit: 2_000_000 },
    })
    expect(rows.map((r) => r.kind)).toEqual(['approval', 'question', 'budget'])
    expect(rows[0]).toMatchObject({ title: '工具审批：write_file', primaryLabel: '批准', secondaryLabel: '拒绝' })
    // 待决中心不替用户选选项：提问行只提供「去回答」
    expect(rows[1]).toMatchObject({ primaryLabel: '去回答', secondaryLabel: '稍后' })
    expect(rows[2].detail).toBe('2M / 2M · 总监与员工合计')
  })

  it('已「稍后」的提问、未触顶的预算、空槽都不出现', () => {
    expect(
      buildPendingDescriptors({
        approval: null,
        question: { sessionId: 'd', question: 'q', options: [], dismissed: true },
        budget: { exceeded: false, used: 1, limit: 2 },
      }),
    ).toEqual([])
  })

  it('pendingCountBySession 归属到工位会话；预算条目无会话不计', () => {
    const rows = buildPendingDescriptors({
      approval: { sessionId: 'w4', toolName: 'run_command', preview: '' },
      question: { sessionId: 'w7', question: 'q', options: [], dismissed: false },
      budget: { exceeded: true, used: 2, limit: 2 },
    })
    const map = pendingCountBySession(rows)
    expect(map.get('w4')).toBe(1)
    expect(map.get('w7')).toBe(1)
    expect(map.size).toBe(2)
  })
})

// ── 目标检查清单 ─────────────────────────────────────────────────────────

describe('检查清单进度', () => {
  const items = [
    { text: 'A1 工程可跑', state: 'done' as const },
    { text: 'A2 登录接口', state: 'waiting' as const },
    { text: 'A3 回归测试', state: 'todo' as const },
    { text: 'A4 部署脚本', state: 'todo' as const },
  ]

  it('✓ / … / ○ 三档标记', () => {
    expect(checklistMark('done')).toBe('✓')
    expect(checklistMark('waiting')).toBe('…')
    expect(checklistMark('todo')).toBe('○')
  })

  it('行保持 finalGoal 顺序，key 稳定', () => {
    const rows = buildChecklistRows(items)
    expect(rows.map((r) => r.mark)).toEqual(['✓', '…', '○', '○'])
    expect(rows.map((r) => r.key)).toEqual([
      '0:A1 工程可跑',
      '1:A2 登录接口',
      '2:A3 回归测试',
      '3:A4 部署脚本',
    ])
  })

  it('n/m 计数与加权覆盖率（done=1 / waiting=0.5 / todo=0）', () => {
    const progress = checklistProgress(items)
    expect(progress).toMatchObject({ done: 1, waiting: 1, todo: 2, total: 4 })
    // (1 + 0.5) / 4 = 37.5% → 向下取整 37
    expect(progress.percent).toBe(37)
    expect(checklistCountText(progress)).toBe('1/4')
    expect(checklistProgress([])).toMatchObject({ total: 0, percent: 0 })
    expect(checklistCountText(checklistProgress([]))).toBe('0/0')
  })

  it('阶段行：阶段号优先，其次轮次；都有时轮次做副文本', () => {
    expect(stageLine({ round: 2, stageCurrent: 3, stageTotal: 5 })).toBe('阶段 3/5')
    expect(stageLine({ round: 2, stageCurrent: null, stageTotal: null })).toBe('第 2 轮')
    expect(stageLine({ round: null, stageCurrent: null, stageTotal: null })).toBe('')
    expect(stageLine(null)).toBe('')
    expect(roundLine({ round: 2, stageCurrent: 3, stageTotal: 5 })).toBe('第 2 轮')
    expect(roundLine({ round: 2, stageCurrent: null, stageTotal: null })).toBe('')
  })
})

// ── 键盘选择 ────────────────────────────────────────────────────────────

describe('列表键盘选择', () => {
  it('↓/↑ 闭环绕回，Home/End 到两端；空列表返回 -1', () => {
    expect(moveSelection(-1, 'ArrowDown', 3)).toBe(0)
    expect(moveSelection(0, 'ArrowDown', 3)).toBe(1)
    expect(moveSelection(2, 'ArrowDown', 3)).toBe(0)
    expect(moveSelection(0, 'ArrowUp', 3)).toBe(2)
    expect(moveSelection(1, 'ArrowUp', 3)).toBe(0)
    expect(moveSelection(2, 'Home', 3)).toBe(0)
    expect(moveSelection(0, 'End', 3)).toBe(2)
    expect(moveSelection(0, 'ArrowDown', 0)).toBe(-1)
  })

  it('isSelectionKey 只认四个导航键', () => {
    expect(isSelectionKey('ArrowDown')).toBe(true)
    expect(isSelectionKey('End')).toBe(true)
    expect(isSelectionKey('Enter')).toBe(false)
    expect(isSelectionKey('a')).toBe(false)
  })

  it('initialSelectionIndex 沿用已选 key，失效时回第一条', () => {
    expect(initialSelectionIndex(['slot:1', 'slot:2'], 'slot:2')).toBe(1)
    expect(initialSelectionIndex(['slot:1', 'slot:2'], '需求分析')).toBe(0)
    expect(initialSelectionIndex(['slot:1'], null)).toBe(0)
    expect(initialSelectionIndex([], 'slot:1')).toBe(-1)
  })
})

// 保持 SubAgentProgress 类型在编译期被引用（工位卡的进度来源）
export type _ProgressProbe = SubAgentProgress
