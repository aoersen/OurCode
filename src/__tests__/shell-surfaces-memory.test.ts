import { describe, expect, it } from 'vitest'
import type { Memory } from '@/types'
import {
  filterMemories,
  memoryCounts,
  memoryGroups,
  memoryProjectTitle,
  memoryScopeLabel,
} from '@/shell/agent/surfaces/memory/memoryModel'

const PROJECT = 'E:\\ls\\ideUtil\\OurCode-ide'
const OTHER = 'E:\\ls\\other\\Q3报表'

function memory(over: Partial<Memory> & { id: string; content: string }): Memory {
  return {
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as Memory
}

const list: Memory[] = [
  memory({ id: 'p1', content: '这个项目统一用 pnpm', scope: 'project', projectPath: PROJECT, createdAt: 30 }),
  memory({ id: 'p2', content: '测试跑 vitest', scope: 'project', projectPath: PROJECT, createdAt: 10 }),
  memory({ id: 'g1', content: '回答尽量短', scope: 'global', createdAt: 20 }),
  memory({ id: 'o1', content: '报表用 xlsx', scope: 'project', projectPath: OTHER, createdAt: 5 }),
]

describe('memoryModel · 计数', () => {
  it('全部 / 全局 / 当前项目三个口径', () => {
    expect(memoryCounts(list, PROJECT)).toEqual({ all: 4, global: 1, project: 2 })
  })

  it('没有项目时项目计数为 0，但其他项目仍计入全部', () => {
    expect(memoryCounts(list, null)).toEqual({ all: 4, global: 1, project: 0 })
  })
})

describe('memoryModel · 过滤', () => {
  it('全部按时间倒序', () => {
    const result = filterMemories(list, { filter: 'all', query: '', projectPath: PROJECT })
    expect(result.map((entry) => entry.id)).toEqual(['p1', 'g1', 'p2', 'o1'])
  })

  it('全局只留 scope=global', () => {
    const result = filterMemories(list, { filter: 'global', query: '', projectPath: PROJECT })
    expect(result.map((entry) => entry.id)).toEqual(['g1'])
  })

  it('项目只留当前项目', () => {
    const result = filterMemories(list, { filter: 'project', query: '', projectPath: PROJECT })
    expect(result.map((entry) => entry.id)).toEqual(['p1', 'p2'])
  })

  it('没有项目时项目过滤为空', () => {
    expect(filterMemories(list, { filter: 'project', query: '', projectPath: null })).toEqual([])
  })

  it('搜索命中内容，且与其他条件叠加', () => {
    expect(filterMemories(list, { filter: 'all', query: 'PNPM', projectPath: PROJECT }).map((m) => m.id)).toEqual(['p1'])
    expect(filterMemories(list, { filter: 'global', query: 'pnpm', projectPath: PROJECT })).toEqual([])
  })
})

describe('memoryModel · 分组', () => {
  it('全部：当前项目 → 全局 → 其他项目', () => {
    const groups = memoryGroups(list, { filter: 'all', query: '', projectPath: PROJECT })
    expect(groups.map((group) => group.key)).toEqual([`project:${PROJECT}`, 'global', `project:${OTHER}`])
    expect(groups.map((group) => group.scope)).toEqual(['project', 'global', 'other'])
    expect(groups[0].label).toBe('OurCode-ide')
    expect(groups[2].label).toBe('…/other/Q3报表')
  })

  it('组内保持时间倒序，空组不返回', () => {
    const groups = memoryGroups(list, { filter: 'all', query: '', projectPath: PROJECT })
    expect(groups[0].memories.map((entry) => entry.id)).toEqual(['p1', 'p2'])
    const onlyGlobal = memoryGroups([list[2]], { filter: 'all', query: '', projectPath: PROJECT })
    expect(onlyGlobal.map((group) => group.key)).toEqual(['global'])
  })

  it('全局与项目过滤各自只有一个组', () => {
    const globalGroups = memoryGroups(list, { filter: 'global', query: '', projectPath: PROJECT })
    expect(globalGroups).toHaveLength(1)
    expect(globalGroups[0].key).toBe('global')
    const projectGroups = memoryGroups(list, { filter: 'project', query: '', projectPath: PROJECT })
    expect(projectGroups).toHaveLength(1)
    expect(projectGroups[0].key).toBe(`project:${PROJECT}`)
    expect(memoryGroups(list, { filter: 'project', query: '', projectPath: null })).toEqual([])
  })

  it('搜索后分组只包含命中项', () => {
    const groups = memoryGroups(list, { filter: 'all', query: 'xlsx', projectPath: PROJECT })
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe(`project:${OTHER}`)
  })
})

describe('memoryModel · 文案', () => {
  it('行尾作用域文案', () => {
    expect(memoryScopeLabel(list[0], PROJECT)).toBe('项目')
    expect(memoryScopeLabel(list[2], PROJECT)).toBe('全局')
    expect(memoryScopeLabel(list[3], PROJECT)).toBe('其他项目 · Q3报表')
    expect(memoryScopeLabel(list[0], null)).toBe('其他项目 · OurCode-ide')
  })

  it('项目标题与空项目提示', () => {
    expect(memoryProjectTitle(PROJECT)).toBe('OurCode-ide')
    expect(memoryProjectTitle(null)).toBe('未打开项目')
  })
})
