/**
 * 「记忆」面的视图模型（纯函数）。
 *
 * 三件事：作用域计数、过滤（作用域 + 搜索）、分组（当前项目 / 全局 / 其他项目）。
 * 数据来自 `useMemoryStore`（SQLite，主进程读写），这里不碰 store 也不碰副作用。
 */
import type { Memory } from '@/types'
import { lastPathSegment, matchesQuery, shortenPath } from '../surfaceModel'

export type MemoryFilter = 'all' | 'global' | 'project'

export interface MemoryCounts {
  all: number
  global: number
  project: number
}

export interface MemoryGroup {
  /** `project:<path>` / `global`，供 React key 用 */
  key: string
  label: string
  scope: 'project' | 'global' | 'other'
  /** 其他项目分组才有值 */
  path: string | null
  memories: Memory[]
}

export const MEMORY_FILTERS: ReadonlyArray<{ id: MemoryFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'global', label: '全局' },
  { id: 'project', label: '项目' },
]

export function memoryCounts(memories: ReadonlyArray<Memory>, projectPath: string | null): MemoryCounts {
  let global = 0
  let project = 0
  for (const memory of memories) {
    if (memory.scope === 'global') global += 1
    else if (projectPath && memory.projectPath === projectPath) project += 1
  }
  return { all: memories.length, global, project }
}

/** 新的在前；同一毫秒按内容做稳定排序（避免列表抖动）。 */
function compareMemories(a: Memory, b: Memory): number {
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
  return a.content.localeCompare(b.content)
}

export interface MemoryFilterInput {
  filter: MemoryFilter
  query: string
  projectPath: string | null
}

/** 作用域过滤 + 内容搜索，结果按时间倒序。 */
export function filterMemories(
  memories: ReadonlyArray<Memory>,
  input: MemoryFilterInput,
): Memory[] {
  const { filter, query, projectPath } = input
  const result = memories.filter((memory) => {
    if (filter === 'global' && memory.scope !== 'global') return false
    if (filter === 'project') {
      if (memory.scope !== 'project') return false
      if (!projectPath || memory.projectPath !== projectPath) return false
    }
    return matchesQuery(memory.content, query)
  })
  return [...result].sort(compareMemories)
}

/**
 * 分组口径：
 *  - 全部：当前项目 → 全局 → 其他项目（每个项目一组，按路径字典序）
 *  - 全局：只有一个「全局」组
 *  - 项目：只有一个当前项目组（未打开项目时为空）
 * 空组不返回。
 */
export function memoryGroups(
  memories: ReadonlyArray<Memory>,
  input: MemoryFilterInput,
): MemoryGroup[] {
  const filtered = filterMemories(memories, input)
  const { filter, projectPath } = input

  if (filter === 'global') {
    const globalMemories = filtered.filter((memory) => memory.scope === 'global')
    return globalMemories.length > 0
      ? [{ key: 'global', label: '全局', scope: 'global', path: null, memories: globalMemories }]
      : []
  }

  if (filter === 'project') {
    if (!projectPath) return []
    const projectMemories = filtered.filter(
      (memory) => memory.scope === 'project' && memory.projectPath === projectPath,
    )
    return projectMemories.length > 0
      ? [
          {
            key: `project:${projectPath}`,
            label: lastPathSegment(projectPath),
            scope: 'project',
            path: projectPath,
            memories: projectMemories,
          },
        ]
      : []
  }

  const groups: MemoryGroup[] = []
  if (projectPath) {
    const projectMemories = filtered.filter(
      (memory) => memory.scope === 'project' && memory.projectPath === projectPath,
    )
    if (projectMemories.length > 0) {
      groups.push({
        key: `project:${projectPath}`,
        label: lastPathSegment(projectPath),
        scope: 'project',
        path: projectPath,
        memories: projectMemories,
      })
    }
  }

  const globalMemories = filtered.filter((memory) => memory.scope === 'global')
  if (globalMemories.length > 0) {
    groups.push({ key: 'global', label: '全局', scope: 'global', path: null, memories: globalMemories })
  }

  const otherPaths = Array.from(
    new Set(
      filtered
        .filter(
          (memory) =>
            memory.scope === 'project' &&
            !!memory.projectPath &&
            memory.projectPath !== projectPath,
        )
        .map((memory) => memory.projectPath as string),
    ),
  ).sort((a, b) => a.localeCompare(b))

  for (const path of otherPaths) {
    const projectMemories = filtered.filter(
      (memory) => memory.scope === 'project' && memory.projectPath === path,
    )
    if (projectMemories.length === 0) continue
    groups.push({
      key: `project:${path}`,
      label: shortenPath(path),
      scope: 'other',
      path,
      memories: projectMemories,
    })
  }

  return groups
}

/** 行尾那行灰字的写作用域：全局 / 项目 / 其他项目名。 */
export function memoryScopeLabel(memory: Memory, projectPath: string | null): string {
  if (memory.scope === 'global') return '全局'
  if (memory.projectPath && memory.projectPath === projectPath) return '项目'
  if (!memory.projectPath) return '项目'
  return `其他项目 · ${lastPathSegment(memory.projectPath)}`
}

/** 当前项目路径的展示名（未打开项目时给一句解释）。 */
export function memoryProjectTitle(projectPath: string | null): string {
  if (!projectPath) return '未打开项目'
  return lastPathSegment(projectPath)
}
