import { describe, expect, it } from 'vitest'
import {
  ROW_PAGE_SIZE,
  SURFACES,
  isSurfaceId,
  lastPathSegment,
  matchesQuery,
  nextRowLimit,
  rowWindow,
  shortenPath,
  surfaceForNavKey,
  surfaceIndexOf,
  surfaceLabel,
} from '@/shell/agent/surfaces/surfaceModel'

describe('surfaceModel · 注册表', () => {
  it('六项管理面按固定顺序排列', () => {
    expect(SURFACES.map((entry) => entry.id)).toEqual([
      'memory',
      'skills',
      'mcp',
      'workflow',
      'usage',
      'channel',
    ])
    expect(SURFACES.map((entry) => entry.label)).toEqual(['记忆', '技能', 'MCP', '工作流', '用量', '渠道'])
  })

  it('label 与 index 都能按 id 取到', () => {
    expect(surfaceLabel('mcp')).toBe('MCP')
    expect(surfaceIndexOf('usage')).toBe(4)
    expect(surfaceIndexOf('channel')).toBe(5)
  })

  it('isSurfaceId 挡住陈旧/伪造的 id', () => {
    expect(isSurfaceId('memory')).toBe(true)
    expect(isSurfaceId('nope')).toBe(false)
    expect(isSurfaceId(null)).toBe(false)
    expect(isSurfaceId(3)).toBe(false)
  })
})

describe('surfaceModel · 方向键', () => {
  it('←/→ 循环，Home/End 跳首尾', () => {
    expect(surfaceForNavKey('memory', 'ArrowRight')).toBe('skills')
    expect(surfaceForNavKey('channel', 'ArrowRight')).toBe('memory')
    expect(surfaceForNavKey('memory', 'ArrowLeft')).toBe('channel')
    expect(surfaceForNavKey('usage', 'Home')).toBe('memory')
    expect(surfaceForNavKey('memory', 'End')).toBe('channel')
  })

  it('↑/↓ 留给列表，不在这里抢键', () => {
    expect(surfaceForNavKey('memory', 'ArrowDown')).toBeNull()
    expect(surfaceForNavKey('memory', 'ArrowUp')).toBeNull()
    expect(surfaceForNavKey('memory', 'Enter')).toBeNull()
    expect(surfaceForNavKey('memory', 'Escape')).toBeNull()
  })
})

describe('surfaceModel · 路径显示', () => {
  it('lastPathSegment 兼容两种分隔符与尾部斜杠', () => {
    expect(lastPathSegment('E:\\ls\\ideUtil\\OurCode-ide')).toBe('OurCode-ide')
    expect(lastPathSegment('/home/me/proj/')).toBe('proj')
    expect(lastPathSegment('proj')).toBe('proj')
    expect(lastPathSegment('')).toBe('')
    expect(lastPathSegment(null)).toBe('')
  })

  it('shortenPath 只留末几段，短路径原样返回', () => {
    expect(shortenPath('E:\\ls\\ideUtil\\OurCode-ide')).toBe('…/ideUtil/OurCode-ide')
    expect(shortenPath('E:\\a\\b', 1)).toBe('…/b')
    expect(shortenPath('C:\\proj')).toBe('C:\\proj')
  })
})

describe('surfaceModel · 搜索与截断', () => {
  it('matchesQuery 大小写不敏感，空查询全通过', () => {
    expect(matchesQuery('Code-Review', 'review')).toBe(true)
    expect(matchesQuery('Code-Review', '  ')).toBe(true)
    expect(matchesQuery('Code-Review', 'docs')).toBe(false)
  })

  it('rowWindow 默认截到 100 行并报出隐藏数', () => {
    const rows = Array.from({ length: 250 }, (_, index) => index)
    const windowed = rowWindow(rows)
    expect(windowed.rows).toHaveLength(ROW_PAGE_SIZE)
    expect(windowed.rows[0]).toBe(0)
    expect(windowed.hidden).toBe(150)
    expect(rowWindow(rows, 300).hidden).toBe(0)
    expect(rowWindow([], 10)).toEqual({ rows: [], hidden: 0 })
  })

  it('nextRowLimit 每次 +一页', () => {
    expect(nextRowLimit(100)).toBe(200)
    expect(nextRowLimit(100, 50)).toBe(150)
    expect(nextRowLimit(-5)).toBe(100)
  })
})
