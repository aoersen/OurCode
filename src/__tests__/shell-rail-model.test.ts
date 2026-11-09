import { describe, expect, it, beforeEach } from 'vitest'
import type { ChatMessage, ChatSession } from '@shared/types'
import {
  UNGROUPED_KEY,
  __resetRailSignatureCache,
  attentionSessionIds,
  buildRailGroups,
  compareRailSessions,
  isRailVisible,
  isUnusedSession,
  orderProjectPaths,
  projectLabel,
  railHasHits,
  railSignature,
} from '@/shell/agent/rail/railModel'

let seq = 0

function msg(content: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  seq += 1
  return {
    id: `m${seq}`,
    role,
    content,
    sortOrder: seq,
    contextFiles: [],
    tokenCount: 0,
    createdAt: seq,
  } as ChatMessage
}

function session(over: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    title: '对话',
    configGroupId: 'group-1',
    model: 'model-1',
    modelParams: {} as ChatSession['modelParams'],
    messages: [msg('hello')],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as ChatSession
}

beforeEach(() => {
  __resetRailSignatureCache()
})

describe('项目名 / 可见性', () => {
  it('项目名取路径最后一段，空路径归为「未归类」', () => {
    expect(projectLabel('C:\\work\\OurCode-ide')).toBe('OurCode-ide')
    expect(projectLabel('/home/yg/app')).toBe('app')
    expect(projectLabel(null)).toBe('未归类')
    expect(projectLabel('')).toBe('未归类')
  })

  it('空会话只在它就是当前会话时才进树', () => {
    const ghost = session({ id: 'ghost', title: '新对话', messages: [] })
    expect(isUnusedSession(ghost)).toBe(true)
    expect(isRailVisible(ghost, null)).toBe(false)
    expect(isRailVisible(ghost, 'ghost')).toBe(true)
  })

  it('claw 会话与隐藏的员工会话不进树', () => {
    expect(isRailVisible(session({ id: 'a', mode: 'claw' }), null)).toBe(false)
    expect(isRailVisible(session({ id: 'b', hidden: true }), null)).toBe(false)
    expect(isRailVisible(session({ id: 'c', title: '新对话', messages: [] }), null)).toBe(false)
    expect(isRailVisible(session({ id: 'd' }), null)).toBe(true)
  })
})

describe('对话排序：置顶优先，然后 updatedAt 倒序', () => {
  const row = (id: string, updatedAt: number, pinnedAt?: number) => ({
    id,
    title: id,
    updatedAt,
    pinnedAt: pinnedAt ?? null,
  })

  it('置顶的排在前面，置顶之间按置顶时间倒序', () => {
    const list = [
      row('plain-new', 900),
      row('pinned-old', 100, 10),
      row('pinned-new', 200, 20),
    ].sort(compareRailSessions)
    expect(list.map((r) => r.id)).toEqual(['pinned-new', 'pinned-old', 'plain-new'])
  })

  it('未置顶的按 updatedAt 倒序，相同时间用标题兜底（顺序稳定）', () => {
    const list = [
      { ...row('r-a', 100), title: 'bb' },
      { ...row('r-b', 100), title: 'aa' },
      row('c', 300),
    ].sort(compareRailSessions)
    expect(list.map((r) => r.id)).toEqual(['c', 'r-b', 'r-a'])
  })
})

describe('buildRailGroups', () => {
  const sessions = [
    session({ id: 's1', title: '一', projectPath: 'C:\\p1', updatedAt: 10 }),
    session({ id: 's2', title: '二', projectPath: 'C:\\p1', updatedAt: 30 }),
    session({ id: 's3', title: '三', projectPath: 'C:\\p2', updatedAt: 20 }),
    session({ id: 'orphan', title: '孤儿', updatedAt: 5 }),
  ]

  it('按项目分组：项目顺序跟着 recentProjects，未归类固定置底', () => {
    const groups = buildRailGroups({
      sessions,
      recentProjects: ['C:\\p2', 'C:\\p1'],
    })
    expect(groups.map((g) => g.label)).toEqual(['p2', 'p1', '未归类'])
    expect(groups.map((g) => g.count)).toEqual([1, 2, 1])
    expect(groups[2].key).toBe(UNGROUPED_KEY)
    expect(groups[2].path).toBeNull()
  })

  it('组内：置顶优先，其余 updatedAt 倒序', () => {
    const groups = buildRailGroups({
      sessions: [
        session({ id: 'kid', title: '新', projectPath: 'C:\\p', updatedAt: 100 }),
        session({ id: 'pinned', title: '钉', projectPath: 'C:\\p', updatedAt: 1, pinnedAt: 5 }),
      ],
      recentProjects: ['C:\\p'],
    })
    expect(groups[0].sessions.map((r) => r.id)).toEqual(['pinned', 'kid'])
  })

  it('运行中 / 等待处理各自带标记（红点优先于运行点由行组件决定，数据都保留）', () => {
    const groups = buildRailGroups({
      sessions,
      recentProjects: ['C:\\p1', 'C:\\p2'],
      runningSessionIds: ['s1'],
      attentionIds: new Set(['s2']),
    })
    const byId = new Map(groups.flatMap((g) => g.sessions).map((r) => [r.id, r]))
    expect(byId.get('s1')?.running).toBe(true)
    expect(byId.get('s1')?.blocked).toBe(false)
    expect(byId.get('s2')?.blocked).toBe(true)
    expect(byId.get('s3')?.running).toBe(false)
  })

  it('未搜索时，0 条对话的项目行也保留（计数与信任行挂在项目行上）', () => {
    const groups = buildRailGroups({ sessions: [], recentProjects: ['C:\\empty'] })
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(0)
  })

  it('搜索命中标题：只留命中的会话；其余全是空组就直接消失', () => {
    const groups = buildRailGroups({
      sessions,
      recentProjects: ['C:\\p1', 'C:\\p2'],
      query: '三',
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('p2')
    expect(groups[0].sessions.map((r) => r.id)).toEqual(['s3'])
  })

  it('搜索命中正文：会话保留并带一行片段', () => {
    const groups = buildRailGroups({
      sessions: [
        session({
          id: 'hit',
          title: '无关标题',
          projectPath: 'C:\\p',
          messages: [msg('请把左侧栏改成项目树\n第二行不该出现')],
        }),
      ],
      recentProjects: ['C:\\p'],
      query: '项目树',
    })
    const [row] = groups[0].sessions
    expect(row.snippet).toContain('项目树')
    expect(row.snippet).not.toContain('\n')
  })

  it('搜索命中项目名：整组保留（含它下面的全部会话）', () => {
    const groups = buildRailGroups({
      sessions,
      recentProjects: ['C:\\p1', 'C:\\p2'],
      query: 'p1',
    })
    expect(groups.map((g) => g.label)).toEqual(['p1'])
    expect(groups[0].sessions).toHaveLength(2)
  })

  it('搜索无命中 → 空组列表（渲染「没有匹配的会话」）', () => {
    const groups = buildRailGroups({ sessions, recentProjects: ['C:\\p1'], query: 'zzz' })
    expect(groups).toEqual([])
    expect(railHasHits(groups)).toBe(false)
  })
})

describe('orderProjectPaths', () => {
  it('保持 recentProjects 的添加顺序，只有会话的项目排在后面，当前工作区兜底', () => {
    expect(
      orderProjectPaths({
        recentProjects: ['C:\\b', 'C:\\a'],
        sessionPaths: ['C:\\c', 'C:\\a'],
        currentPath: 'C:\\d',
      }),
    ).toEqual(['C:\\b', 'C:\\a', 'C:\\c', 'C:\\d'])
  })

  it('已移除的项目不进列表', () => {
    expect(
      orderProjectPaths({
        recentProjects: ['C:\\a', 'C:\\b'],
        removedProjects: ['C:\\a'],
      }),
    ).toEqual(['C:\\b'])
  })

  it('用户固定顺序优先：不在固定序列里的新项目排最前', () => {
    expect(
      orderProjectPaths({
        recentProjects: ['C:\\a', 'C:\\new', 'C:\\b'],
        projectOrder: ['C:\\b', 'C:\\a'],
      }),
    ).toEqual(['C:\\new', 'C:\\b', 'C:\\a'])
  })
})

describe('attentionSessionIds', () => {
  it('四个来源取并集且去重', () => {
    const ids = attentionSessionIds({
      questionSessionId: 'q',
      approvalSessionId: 'a',
      batchSessionId: 'b',
      backlog: [{ sessionId: 'q' }, { sessionId: 'parked' }],
    })
    expect([...ids].sort()).toEqual(['a', 'b', 'parked', 'q'])
  })

  it('没在等用户时是空集合', () => {
    expect(attentionSessionIds({}).size).toBe(0)
  })
})

describe('railSignature（防止流式 chunk 重排的展示签名）', () => {
  it('字段不变 → 签名相同（数组引用变成新的也一样）', () => {
    const a = [session({ id: 'x', title: 'T', updatedAt: 5 })]
    const b = [{ ...a[0] }]
    expect(railSignature(a)).toBe(railSignature(b))
  })

  it('标题 / updatedAt / 消息数量变化 → 签名不同', () => {
    const base = [session({ id: 'x', title: 'T', updatedAt: 5 })]
    const sig = railSignature(base)
    expect(railSignature([{ ...base[0], title: 'T2' }])).not.toBe(sig)
    expect(railSignature([{ ...base[0], updatedAt: 6 }])).not.toBe(sig)
    expect(railSignature([{ ...base[0], messages: [...base[0].messages, msg('more')] }])).not.toBe(sig)
  })

  it('同一数组引用走缓存（同一个字符串对象）', () => {
    const list = [session({ id: 'y' })]
    const first = railSignature(list)
    const second = railSignature(list)
    expect(second).toBe(first)
  })
})
