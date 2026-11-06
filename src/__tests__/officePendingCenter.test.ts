import { describe, it, expect } from 'vitest'
import {
  GOAL_REVISION_RE,
  SEEN_REVISION_CAP,
  collectFreshRevisions,
  listGoalRevisions,
  mergeSeenRevisions,
  revisionSignature,
} from '@/services/office/pendingCenter'
import type { DirEntryLike } from '@/services/office/pendingCenter'

const file = (name: string, extra: Partial<DirEntryLike> = {}): DirEntryLike => ({
  name,
  isDirectory: false,
  size: 100,
  modifiedAt: 1000,
  ...extra,
})

describe('待决中心：目标修订快照识别', () => {
  it('只认 finalGoal_v{N}.md，忽略 finalGoal.md 与目录', () => {
    expect(GOAL_REVISION_RE.test('finalGoal_v1.md')).toBe(true)
    expect(GOAL_REVISION_RE.test('finalGoal.md')).toBe(false)
    const entries = [
      file('finalGoal.md'),
      file('finalGoal_v1.md'),
      file('finalGoal_v2.md'),
      { name: 'finalGoal_v3.md', isDirectory: true },
      file('notes.md'),
    ]
    expect(listGoalRevisions(entries)).toEqual(['finalGoal_v1.md', 'finalGoal_v2.md'])
  })

  it('按版本号数值排序（v2 在 v10 之前）', () => {
    const entries = [file('finalGoal_v10.md'), file('finalGoal_v2.md'), file('finalGoal_v1.md')]
    expect(listGoalRevisions(entries)).toEqual([
      'finalGoal_v1.md',
      'finalGoal_v2.md',
      'finalGoal_v10.md',
    ])
  })

  it('签名含项目根、文件名、mtime、size——同名文件被重写算新修订', () => {
    const root = 'C:\\work\\proj\\'
    const a = revisionSignature(root, file('finalGoal_v1.md'))
    // 结尾斜杠不同不影响签名
    expect(revisionSignature('C:\\work\\proj', file('finalGoal_v1.md'))).toBe(a)
    // 内容变化 → mtime/size 变 → 签名变
    expect(revisionSignature(root, file('finalGoal_v1.md', { modifiedAt: 2000 }))).not.toBe(a)
    expect(revisionSignature(root, file('finalGoal_v1.md', { size: 999 }))).not.toBe(a)
    // 不同项目互不影响
    expect(revisionSignature('C:\\work\\other', file('finalGoal_v1.md'))).not.toBe(a)
  })
})

describe('待决中心：一次性提示去重', () => {
  it('首次扫描返回全部修订，已提示过的不再返回', () => {
    const root = 'C:\\work\\proj'
    const entries = [file('finalGoal.md'), file('finalGoal_v1.md'), file('finalGoal_v2.md')]

    const first = collectFreshRevisions(root, entries, new Set())
    expect(first.map((e) => e.name)).toEqual(['finalGoal_v1.md', 'finalGoal_v2.md'])

    const seen = new Set(first.map((e) => revisionSignature(root, e)))
    // 重新进看板（组件重挂载）→ 同一份快照不再报待办（正是用户抱怨的那条）
    expect(collectFreshRevisions(root, entries, seen)).toEqual([])

    // 出现新修订 → 只提示新的那一份
    const withV3 = [...entries, file('finalGoal_v3.md')]
    expect(collectFreshRevisions(root, withV3, seen).map((e) => e.name)).toEqual(['finalGoal_v3.md'])
  })

  it('mergeSeenRevisions 去重并按上限裁剪（保留最近的）', () => {
    const merged = mergeSeenRevisions(['a', 'b'], ['b', 'c'])
    expect(merged).toEqual(['a', 'b', 'c'])

    const many = Array.from({ length: SEEN_REVISION_CAP + 20 }, (_, i) => `k${i}`)
    const capped = mergeSeenRevisions([], many)
    expect(capped).toHaveLength(SEEN_REVISION_CAP)
    expect(capped[capped.length - 1]).toBe(`k${many.length - 1}`)
    expect(capped[0]).toBe(`k20`)
  })
})
