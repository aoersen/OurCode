/**
 * 目标模式看板：映射层纯函数单测。
 * 覆盖：8 工位编制、角色→槽位分配、进度估计、任务摘要。
 */
import { describe, expect, it } from 'vitest'
import type { SubAgentProgress } from '@shared/types'
import {
  OFFICE_SLOTS,
  SLOT_GROUP,
  assignSlot,
  computeSlotAssignments,
  envelopeRole,
  estimateProgress,
  summarizeTask,
} from '@/services/office/mapping'

describe('office/mapping: OFFICE_SLOTS', () => {
  it('槽位静态信息与编制（M4 定稿）一致', () => {
    expect(OFFICE_SLOTS[0]).toMatchObject({ id: 1, role: '总监', codeName: 'Director-01' })
    expect(OFFICE_SLOTS[6]).toMatchObject({ id: 7, role: '测试-1', codeName: 'QA-07' })
  })
})

describe('office/mapping: assignSlot', () => {
  it('固定角色命中专属槽位', () => {
    expect(assignSlot('tm-requirement-analyst', new Set())).toBe(2)
    expect(assignSlot('tm-ui-developer', new Set())).toBe(3)
    expect(assignSlot('tm-tester', new Set())).toBe(7)
  })

  it('developer 池按 4→5→6 分配，满则返回 null', () => {
    const occupied = new Set<number>()
    expect(assignSlot('tm-developer', occupied)).toBe(4)
    occupied.add(4)
    expect(assignSlot('tm-developer', occupied)).toBe(5)
    occupied.add(5)
    expect(assignSlot('tm-developer', occupied)).toBe(6)
    occupied.add(6)
    expect(assignSlot('tm-developer', occupied)).toBeNull()
  })

  it('tester 池 7→8，全满返回 null', () => {
    const occupied = new Set([7])
    expect(assignSlot('tm-tester', occupied)).toBe(8)
    expect(assignSlot('tm-tester', new Set([7, 8]))).toBeNull()
  })

  it('兼容不带 tm- 前缀的内建角色名', () => {
    expect(assignSlot('developer', new Set())).toBe(4)
    expect(assignSlot('tester', new Set())).toBe(7)
  })

  it('未知角色返回 null', () => {
    expect(assignSlot('unknown-role', new Set())).toBeNull()
  })
})

describe('office/mapping: estimateProgress', () => {
  const base: SubAgentProgress = {
    status: 'running',
    sessionId: 's1',
    name: 'tm-developer',
    task: 'task',
    startedAt: 0,
    thinking: '',
    steps: [],
    toolCallCount: 0,
    tokenCount: 0,
  }

  it('终态为 100%', () => {
    expect(estimateProgress({ ...base, status: 'done' })).toBe(100)
    expect(estimateProgress({ ...base, status: 'error' })).toBe(100)
    expect(estimateProgress({ ...base, status: 'stopped' })).toBe(100)
  })

  it('按工具调用步数分级', () => {
    expect(estimateProgress({ ...base, toolCallCount: 0 })).toBe(25)
    expect(estimateProgress({ ...base, toolCallCount: 2 })).toBe(40)
    expect(estimateProgress({ ...base, toolCallCount: 5 })).toBe(60)
    expect(estimateProgress({ ...base, toolCallCount: 10 })).toBe(85)
  })
})

describe('office/mapping: summarizeTask', () => {
  it('超长任务截断为一行并加省略号', () => {
    const long = 'a'.repeat(120)
    const s = summarizeTask(long, 60)
    expect(s).toHaveLength(61)
    expect(s.endsWith('…')).toBe(true)
  })
  it('空任务给占位文案', () => {
    expect(summarizeTask('')).toBe('（无任务描述）')
  })
  it('压缩换行', () => {
    expect(summarizeTask('a\nb\nc')).toBe('a b c')
  })
})

describe('office/mapping: envelopeRole', () => {
  it('从任务信封 frontmatter 提取 to 角色', () => {
    const task = `---
from: supervisor
to: tm-developer
type: task
---
实现 xxx`
    expect(envelopeRole(task)).toBe('tm-developer')
  })
  it('无信封时返回 null', () => {
    expect(envelopeRole('普通任务描述')).toBeNull()
  })
})

describe('office/mapping: computeSlotAssignments', () => {
  const task = (key: string, name: string, status: SubAgentProgress['status'], startedAt = 0) => ({
    key,
    p: {
      status,
      sessionId: 's1',
      name,
      task: 'task',
      startedAt,
      thinking: '',
      steps: [],
      toolCallCount: 0,
      tokenCount: 0,
    } as SubAgentProgress,
  })

  const statuses = (out: ReturnType<typeof computeSlotAssignments>) => out.map((a) => a.status)

  it('无任务 → 8 槽全 idle', () => {
    expect(statuses(computeSlotAssignments([]))).toEqual(Array(8).fill('idle'))
  })

  it('按角色槽位池占位:研发→4, 测试→7, 需求分析→2', () => {
    const out = computeSlotAssignments([
      task('d1', 'tm-developer', 'running'),
      task('t1', 'tm-tester', 'running'),
      task('p1', 'tm-requirement-analyst', 'running'),
    ])
    expect(statuses(out)).toEqual(['idle', 'working', 'idle', 'working', 'idle', 'idle', 'working', 'idle'])
    expect(out[1].key).toBe('p1')
    expect(out[3].key).toBe('d1')
    expect(out[6].key).toBe('t1')
  })

  it('同池占位依序:三个研发占 4/5/6,第四个溢出不占位', () => {
    const out = computeSlotAssignments([
      task('d1', 'tm-developer', 'done'),
      task('d2', 'tm-developer', 'done'),
      task('d3', 'tm-developer', 'done'),
      task('d4', 'tm-developer', 'running'),
    ])
    // 运行中优先抢位:槽 4 = running,已完成依次占 5/6,第四个完成溢出
    expect(statuses(out)).toEqual(['idle', 'idle', 'idle', 'working', 'completed', 'completed', 'idle', 'idle'])
    expect(out[3].key).toBe('d4')
  })

  it('运行中优先于已完成:同池先完成的子任务让位', () => {
    const out = computeSlotAssignments([
      task('old', 'tm-developer', 'done', 100),
      task('new', 'tm-developer', 'running', 200),
    ])
    expect(statuses(out)).toEqual(['idle', 'idle', 'idle', 'working', 'completed', 'idle', 'idle', 'idle'])
    expect(out[3].key).toBe('new')
    expect(out[4].key).toBe('old')
  })

  it('error / stopped → 失败态占位', () => {
    const out = computeSlotAssignments([task('e1', 'tm-tester', 'error'), task('s1', 'tm-developer', 'stopped')])
    expect(out[6]).toMatchObject({ key: 'e1', status: 'error' })
    expect(out[3]).toMatchObject({ key: 's1', status: 'error' })
  })

  it('未知角色不占位,保持 idle', () => {
    expect(statuses(computeSlotAssignments([task('x1', 'unknown-role', 'running')]))).toEqual(Array(8).fill('idle'))
  })

  it('1 号监管槽不参与子任务占位', () => {
    const out = computeSlotAssignments([task('d1', 'tm-developer', 'running')])
    expect(out[0]).toMatchObject({ key: null, status: 'idle' })
  })
})

describe('office/mapping: SLOT_GROUP', () => {
  it('槽位 2-8 映射到看板 4 大角色组,1 号监管不在池内', () => {
    expect(SLOT_GROUP[2]).toBe('产品')
    expect(SLOT_GROUP[3]).toBe('设计')
    expect([SLOT_GROUP[4], SLOT_GROUP[5], SLOT_GROUP[6]]).toEqual(['研发', '研发', '研发'])
    expect([SLOT_GROUP[7], SLOT_GROUP[8]]).toEqual(['测试', '测试'])
    expect(SLOT_GROUP[1]).toBeUndefined()
  })
})
