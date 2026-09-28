import { describe, it, expect } from 'vitest'
import {
  INBOUND_RE,
  isUserRequestMessage,
  requestTitle,
  buildTaskRequests,
  buildDirectorActivities,
} from '@/services/office/taskRequests'
import type { ChatMessage, ChatSession, SubAgentProgress } from '@shared/types'

/** 构造消息（缺省字段按测试所需补齐）。 */
function msg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'user',
    content: '',
    sortOrder: 0,
    contextFiles: [],
    tokenCount: 0,
    createdAt: 0,
    ...partial,
  } as ChatMessage
}

function session(partial: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    title: '新对话',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    agentMode: 'agent',
    todos: [],
    planStatus: 'none',
    mode: 'office',
    ...partial,
  } as ChatSession
}

function progress(partial: Partial<SubAgentProgress> & { sessionId: string }): SubAgentProgress {
  return {
    status: 'running',
    name: 'tm-developer',
    task: 'to: tm-developer\n\n实现登录',
    startedAt: 0,
    thinking: '',
    steps: [],
    toolCallCount: 0,
    tokenCount: 0,
    ...partial,
  } as SubAgentProgress
}

const inbound = (sender: string, text: string) => `[来自会话「${sender}」的会话间消息]\n\n${text}`

describe('office/taskRequests: 一个会话 = 一个任务', () => {
  it('员工回报（会话间前缀）不算新要求', () => {
    expect(isUserRequestMessage(msg({ id: 'u1', role: 'user', content: '做一个登录页' }))).toBe(true)
    expect(isUserRequestMessage(msg({ id: 'r1', role: 'user', content: inbound('研发', '已完成') }))).toBe(false)
    expect(isUserRequestMessage(msg({ id: 'a1', role: 'assistant', content: '好的' }))).toBe(false)
    expect(INBOUND_RE.test(inbound('总监', '开工'))).toBe(true)
  })

  it('一个会话 = 一个任务；后续补充的消息仍是同一个任务', () => {
    const director = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '重构首页',
      messages: [
        msg({ id: 'u1', role: 'user', content: '重构首页', createdAt: 100 }),
        msg({ id: 'a1', role: 'assistant', content: '收到', createdAt: 200 }),
        msg({ id: 'r1', role: 'user', content: inbound('研发', '完成'), createdAt: 300 }),
        msg({ id: 'u2', role: 'user', content: '顺便改一下配色', createdAt: 400 }),
      ],
    })
    const map = buildTaskRequests({ sessions: [director], progress: {}, runningSessionIds: [] })
    const tasks = map.get('/p')!
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('s1')
    expect(tasks[0].title).toBe('重构首页')
    expect(tasks[0].status).toBe('done')
  })

  it('标题 = 会话自动摘要；尚无标题时退回首条要求首行', () => {
    const titled = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: 'AI 生成的摘要',
      messages: [msg({ id: 'u1', role: 'user', content: '原始输入很长', createdAt: 100 })],
    })
    const untitled = session({
      id: 's2',
      targetMode: true,
      projectPath: '/p',
      title: '新对话',
      messages: [msg({ id: 'u1', role: 'user', content: '第一行要求\n第二行', createdAt: 100 })],
    })
    const map = buildTaskRequests({ sessions: [titled, untitled], progress: {}, runningSessionIds: [] })
    const byId = new Map(map.get('/p')!.map((t) => [t.id, t]))
    expect(byId.get('s1')!.title).toBe('AI 生成的摘要')
    expect(byId.get('s2')!.title).toBe('第一行要求')
  })

  it('一次要求派发多个角色 → 同一任务内的多条角色活动', () => {
    const director = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '加搜索功能',
      messages: [msg({ id: 'u1', role: 'user', content: '加搜索功能', createdAt: 100 })],
    })
    const dev = session({
      id: 'w4',
      workerRole: 'tm-developer',
      workerSlot: 4,
      title: '业务研发-1',
      hidden: true,
      projectPath: '/p',
      messages: [
        msg({ id: 'd1', role: 'user', content: inbound('加搜索功能', '实现搜索接口'), createdAt: 200 }),
        msg({ id: 'rep1', role: 'assistant', content: '完成', createdAt: 400 }),
      ],
    })
    const qa = session({
      id: 'w7',
      workerRole: 'tm-tester',
      workerSlot: 7,
      title: '测试-1',
      hidden: true,
      projectPath: '/p',
      messages: [msg({ id: 'd2', role: 'user', content: inbound('加搜索功能', '验证搜索'), createdAt: 500 })],
    })
    const map = buildTaskRequests({ sessions: [director, dev, qa], progress: {}, runningSessionIds: [] })
    const task = map.get('/p')![0]
    expect(task.activities.map((a) => a.label)).toEqual(['业务研发-1', '测试-1'])
    // 研发已回报 → done；测试刚派发、没在跑也没回报 → pending
    expect(task.activities[0].status).toBe('done')
    expect(task.activities[1].status).toBe('pending')
  })

  it('员工在跑 / 会话在跑 → 任务 running', () => {
    const director = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '加搜索功能',
      messages: [msg({ id: 'u1', role: 'user', content: '加搜索功能', createdAt: 100 })],
    })
    const dev = session({
      id: 'w4',
      workerRole: 'tm-developer',
      workerSlot: 4,
      title: '业务研发-1',
      hidden: true,
      projectPath: '/p',
      messages: [msg({ id: 'd1', role: 'user', content: inbound('加搜索功能', '实现搜索接口'), createdAt: 200 })],
    })
    expect(
      buildTaskRequests({ sessions: [director, dev], progress: {}, runningSessionIds: ['w4'] }).get('/p')![0].status,
    ).toBe('running')
    expect(
      buildTaskRequests({ sessions: [director, dev], progress: {}, runningSessionIds: ['s1'] }).get('/p')![0].status,
    ).toBe('running')
  })

  it('子智能体 error / 总监轮次出错 → 任务 failed；无异常 → done', () => {
    const mk = (extra: Record<string, SubAgentProgress>, msgs: ChatMessage[] = []) =>
      buildTaskRequests({
        sessions: [session({ id: 's1', targetMode: true, projectPath: '/p', title: 't', messages: [msg({ id: 'u1', role: 'user', content: 'x', createdAt: 100 }), ...msgs] })],
        progress: extra,
        runningSessionIds: [],
      }).get('/p')![0].status
    expect(mk({ t1: progress({ sessionId: 's1', startedAt: 200, status: 'error' }) })).toBe('failed')
    expect(mk({}, [msg({ id: 'a1', role: 'assistant', content: '', createdAt: 200, error: { message: 'boom' } as never })])).toBe('failed')
    expect(mk({ t1: progress({ sessionId: 's1', startedAt: 200, status: 'done' }) })).toBe('done')
    // 中途轮次报错、随后重试成功 → 只看最后一轮，任务 done
    expect(
      mk({}, [
        msg({ id: 'a1', role: 'assistant', content: '', createdAt: 200, error: { message: 'boom' } as never }),
        msg({ id: 'a2', role: 'assistant', content: '重试成功', createdAt: 300 }),
      ]),
    ).toBe('done')
  })

  it('挂起询问 → 任务 waiting（无活动运行中时）', () => {
    const director = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: 't',
      messages: [msg({ id: 'u1', role: 'user', content: 'x', createdAt: 100 })],
    })
    const map = buildTaskRequests({
      sessions: [director],
      progress: {},
      runningSessionIds: [],
      pendingQuestionSessionId: 's1',
    })
    expect(map.get('/p')![0].status).toBe('waiting')
  })

  it('员工回报失败/阻塞 → 该派发 failed、任务 failed；随后修好 → done', () => {
    const director = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '加搜索功能',
      messages: [msg({ id: 'u1', role: 'user', content: '加搜索功能', createdAt: 100 })],
    })
    const dev = session({
      id: 'w4',
      workerRole: 'tm-developer',
      workerSlot: 4,
      title: '业务研发-1',
      hidden: true,
      projectPath: '/p',
      messages: [
        msg({ id: 'd1', role: 'user', content: inbound('加搜索功能', '实现搜索接口'), createdAt: 200 }),
        msg({ id: 'rep1', role: 'assistant', content: '结论：失败\n原因：环境缺失', createdAt: 300 }),
      ],
    })
    const failed = buildTaskRequests({ sessions: [director, dev], progress: {}, runningSessionIds: [] }).get('/p')![0]
    expect(failed.activities[0].status).toBe('failed')
    expect(failed.status).toBe('failed')

    // 打回重派并修好 → 任务 done
    dev.messages.push(
      msg({ id: 'd2', role: 'user', content: inbound('加搜索功能', '修复问题'), createdAt: 400 }),
      msg({ id: 'rep2', role: 'assistant', content: '结论：完成\n已修复', createdAt: 500 }),
    )
    const fixed = buildTaskRequests({ sessions: [director, dev], progress: {}, runningSessionIds: [] }).get('/p')![0]
    expect(fixed.activities.map((a) => a.status)).toEqual(['failed', 'done'])
    expect(fixed.status).toBe('done')
  })

  it('多任务并存：员工派发按发送方标题归属对应总监会话，按时间兜底', () => {
    const taskA = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '任务A标题',
      messages: [msg({ id: 'u1', role: 'user', content: '任务A', createdAt: 100 })],
    })
    const taskB = session({
      id: 's2',
      targetMode: true,
      projectPath: '/p',
      title: '任务B标题',
      messages: [msg({ id: 'u1', role: 'user', content: '任务B', createdAt: 1000 })],
    })
    const dev = session({
      id: 'w4',
      workerRole: 'tm-developer',
      workerSlot: 4,
      title: '业务研发-1',
      hidden: true,
      projectPath: '/p',
      messages: [
        msg({ id: 'd1', role: 'user', content: inbound('任务A标题', 'A 的活'), createdAt: 200 }),
        msg({ id: 'd2', role: 'user', content: inbound('任务B标题', 'B 的活'), createdAt: 1200 }),
        // 标题匹配不上的旧派发（总监后来改了标题）→ 按时间兜底归 A
        msg({ id: 'd3', role: 'user', content: inbound('已改名的旧标题', 'A 的补充活'), createdAt: 500 }),
      ],
    })
    const map = buildTaskRequests({ sessions: [taskA, taskB, dev], progress: {}, runningSessionIds: [] })
    const byId = new Map(map.get('/p')!.map((t) => [t.id, t]))
    expect(byId.get('s1')!.activities.map((a) => a.task)).toEqual(['A 的活', 'A 的补充活'])
    expect(byId.get('s2')!.activities.map((a) => a.task)).toEqual(['B 的活'])
  })

  it('排序：running/waiting 在前、done 次之、failed 最后，同态新的在前', () => {
    const mkDirector = (id: string, title: string, at: number) =>
      session({
        id,
        targetMode: true,
        projectPath: '/p',
        title,
        messages: [msg({ id: `u-${id}`, role: 'user', content: title, createdAt: at })],
      })
    const s1 = mkDirector('s1', '旧任务', 100)
    const s2 = mkDirector('s2', '坏任务', 200)
    const s3 = mkDirector('s3', '新任务', 400)
    const map = buildTaskRequests({
      sessions: [s1, s2, s3],
      progress: { t1: progress({ sessionId: 's2', startedAt: 300, status: 'error' }) },
      runningSessionIds: ['s3'],
    })
    // s3 running；s1 done；s2 failed
    expect(map.get('/p')!.map((t) => t.id)).toEqual(['s3', 's1', 's2'])
  })

  it('requestTitle 取首行、压缩空白、截断', () => {
    expect(requestTitle('第一行\n第二行')).toBe('第一行')
    expect(requestTitle('  \n\n多   空格  标题  ')).toBe('多 空格 标题')
    expect(requestTitle('x'.repeat(100))).toBe('x'.repeat(44) + '…')
  })

  it('无真实用户消息的会话不出任务；非 targetMode/员工会话不出任务', () => {
    const onlyInbound = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      messages: [msg({ id: 'r1', role: 'user', content: inbound('研发', '回报'), createdAt: 100 })],
    })
    const plain = session({
      id: 's2',
      projectPath: '/p',
      messages: [msg({ id: 'u1', role: 'user', content: '普通对话', createdAt: 100 })],
    })
    const worker = session({
      id: 'w4',
      workerRole: 'tm-developer',
      hidden: true,
      projectPath: '/p',
      messages: [msg({ id: 'u1', role: 'user', content: '派发', createdAt: 100 })],
    })
    const map = buildTaskRequests({ sessions: [onlyInbound, plain, worker], progress: {}, runningSessionIds: [] })
    expect(map.size).toBe(0)
  })
})

describe('office/taskRequests: buildDirectorActivities（看板工作记录 / 任务流）', () => {
  it('只返回指定总监的活动；员工派发按标题归属并带角色分组', () => {
    const taskA = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '任务A标题',
      messages: [msg({ id: 'u1', role: 'user', content: '任务A', createdAt: 100 })],
    })
    const taskB = session({
      id: 's2',
      targetMode: true,
      projectPath: '/p',
      title: '任务B标题',
      messages: [msg({ id: 'u1', role: 'user', content: '任务B', createdAt: 1000 })],
    })
    const dev = session({
      id: 'w4',
      workerRole: 'tm-developer',
      workerSlot: 4,
      title: '业务研发-1',
      hidden: true,
      projectPath: '/p',
      messages: [
        msg({ id: 'd1', role: 'user', content: inbound('任务A标题', 'A 的活'), createdAt: 200 }),
        msg({ id: 'd2', role: 'user', content: inbound('任务B标题', 'B 的活'), createdAt: 1200 }),
      ],
    })
    const input = { sessions: [taskA, taskB, dev], progress: {}, runningSessionIds: [] }
    const actsA = buildDirectorActivities(input, 's1')
    expect(actsA.map((a) => a.task)).toEqual(['A 的活'])
    expect(actsA[0].label).toBe('业务研发-1')
    expect(actsA[0].group).toBe('研发')

    const actsB = buildDirectorActivities(input, 's2')
    expect(actsB.map((a) => a.task)).toEqual(['B 的活'])
  })

  it('各角色工位映射到 产品/设计/研发/测试 分组', () => {
    const director = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '任务',
      messages: [msg({ id: 'u1', role: 'user', content: 'x', createdAt: 100 })],
    })
    const mkWorker = (id: string, role: string, slot: number, title: string, at: number) =>
      session({
        id,
        workerRole: role,
        workerSlot: slot,
        title,
        hidden: true,
        projectPath: '/p',
        messages: [msg({ id: `d-${id}`, role: 'user', content: inbound('任务', `${title}的活`), createdAt: at })],
      })
    const acts = buildDirectorActivities(
      {
        sessions: [
          director,
          mkWorker('w2', 'tm-requirement-analyst', 2, '需求分析师', 200),
          mkWorker('w3', 'tm-ui-developer', 3, 'UI 研发', 300),
          mkWorker('w4', 'tm-developer', 4, '业务研发-1', 400),
          mkWorker('w7', 'tm-tester', 7, '测试-1', 500),
        ],
        progress: {},
        runningSessionIds: [],
      },
      's1',
    )
    expect(acts.map((a) => [a.label, a.group])).toEqual([
      ['需求分析师', '产品'],
      ['UI 研发', '设计'],
      ['业务研发-1', '研发'],
      ['测试-1', '测试'],
    ])
  })

  it('派发状态推导：running（员工在跑）/ done（回报完成）/ failed（回报失败）/ pending（未回报）', () => {
    const director = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '加搜索功能',
      messages: [msg({ id: 'u1', role: 'user', content: '加搜索功能', createdAt: 100 })],
    })
    const dev = session({
      id: 'w4',
      workerRole: 'tm-developer',
      workerSlot: 4,
      title: '业务研发-1',
      hidden: true,
      projectPath: '/p',
      messages: [
        msg({ id: 'd1', role: 'user', content: inbound('加搜索功能', '实现搜索接口'), createdAt: 200 }),
        msg({ id: 'rep1', role: 'assistant', content: '结论：完成\n已上线', createdAt: 300 }),
      ],
    })
    const qa = session({
      id: 'w7',
      workerRole: 'tm-tester',
      workerSlot: 7,
      title: '测试-1',
      hidden: true,
      projectPath: '/p',
      messages: [msg({ id: 'd2', role: 'user', content: inbound('加搜索功能', '验证搜索'), createdAt: 500 })],
    })

    // 研发已回报完成；测试在跑（runningSessionIds）→ 最新一次派发 running
    const running = buildDirectorActivities({ sessions: [director, dev, qa], progress: {}, runningSessionIds: ['w7'] }, 's1')
    expect(running.map((a) => [a.label, a.status])).toEqual([
      ['业务研发-1', 'done'],
      ['测试-1', 'running'],
    ])
    expect(running[0].reportFirstLine).toBe('结论：完成')

    // 测试回报失败 → failed，回报首行保留
    qa.messages.push(msg({ id: 'rep2', role: 'assistant', content: '结论：失败\n环境缺失', createdAt: 600 }))
    const reported = buildDirectorActivities({ sessions: [director, dev, qa], progress: {}, runningSessionIds: [] }, 's1')
    expect(reported[1].status).toBe('failed')
    expect(reported[1].reportFirstLine).toBe('结论：失败')

    // 无回报且未在跑 → pending
    const idle = session({
      id: 'w8',
      workerRole: 'tm-tester',
      workerSlot: 8,
      title: '测试-2',
      hidden: true,
      projectPath: '/p',
      messages: [msg({ id: 'd3', role: 'user', content: inbound('加搜索功能', '回归验证'), createdAt: 700 })],
    })
    const pendingActs = buildDirectorActivities({ sessions: [director, idle], progress: {}, runningSessionIds: [] }, 's1')
    expect(pendingActs[0].status).toBe('pending')
  })

  it('员工只读调研子代理归属派发方总监；总监本会话子代理也纳入', () => {
    const director = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '任务',
      messages: [msg({ id: 'u1', role: 'user', content: 'x', createdAt: 100 })],
    })
    const dev = session({
      id: 'w4',
      workerRole: 'tm-developer',
      workerSlot: 4,
      title: '业务研发-1',
      hidden: true,
      projectPath: '/p',
      messages: [msg({ id: 'd1', role: 'user', content: inbound('任务', '实现功能'), createdAt: 200 })],
    })
    const research = progress({ sessionId: 'w4', name: 'researcher', task: '调研方案', startedAt: 300 })
    const ownTest = progress({ sessionId: 's1', name: 'tm-tester', task: '跑测试', startedAt: 400 })

    const acts = buildDirectorActivities(
      { sessions: [director, dev], progress: { r1: research, t1: ownTest }, runningSessionIds: [] },
      's1',
    )
    expect(acts.map((a) => a.label)).toEqual(['业务研发-1', '业务研发-1', '测试'])
    // 员工调研子代理：归到派发方总监、展示员工工位名、分组按子代理角色推导
    expect(acts[1].progress).toBe(research)
    expect(acts[1].status).toBe('running')
    expect(acts[1].group).toBe('研发')
    // 总监本会话子代理：分组按信封角色（tm-tester → 测试）
    expect(acts[2].progress).toBe(ownTest)
    expect(acts[2].group).toBe('测试')
  })

  it('非总监会话 id → 空数组', () => {
    const director = session({
      id: 's1',
      targetMode: true,
      projectPath: '/p',
      title: '任务',
      messages: [msg({ id: 'u1', role: 'user', content: 'x', createdAt: 100 })],
    })
    expect(buildDirectorActivities({ sessions: [director], progress: {}, runningSessionIds: [] }, 'ghost')).toEqual([])
    expect(
      buildDirectorActivities(
        { sessions: [session({ id: 'w4', workerRole: 'tm-developer', hidden: true, projectPath: '/p', messages: [] })], progress: {}, runningSessionIds: [] },
        'w4',
      ),
    ).toEqual([])
  })
})
