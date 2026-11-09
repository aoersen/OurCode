import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { buildSnippet, matchProject, matchSession, normalizeQuery } from '@/shell/agent/rail/railSearch'

let seq = 0
function msg(content: string): ChatMessage {
  seq += 1
  return {
    id: `m${seq}`,
    role: 'user',
    content,
    sortOrder: seq,
    contextFiles: [],
    tokenCount: 0,
    createdAt: seq,
  } as ChatMessage
}

describe('buildSnippet：把命中点截成一行', () => {
  it('长文本只保留命中点前后各 radius 个字符，两端加省略号', () => {
    const text = `${'a'.repeat(100)}TARGET${'b'.repeat(100)}`
    const snippet = buildSnippet(text, 'target', 5)
    expect(snippet).toBe('…aaaaaTARGETbbbbb…')
  })

  it('命中在开头 / 结尾时只加对应一侧的省略号', () => {
    // radius 足够大 → 整段保留，两端都不加省略号
    expect(buildSnippet('TARGET tail', 'target', 20)).toBe('TARGET tail')
    expect(buildSnippet('head TARGET', 'target', 20)).toBe('head TARGET')
    // radius 小 → 只截掉一侧
    expect(buildSnippet('TARGET tail', 'target', 4)).toBe('TARGET tai…')
    expect(buildSnippet('head TARGET', 'target', 4)).toBe('…ead TARGET')
  })

  it('换行与连续空白折成单空格（片段必须单行）', () => {
    const snippet = buildSnippet('第一行\n\n第二行\t\t命中点', '命中点', 20)
    expect(snippet).not.toBeNull()
    expect(snippet).not.toContain('\n')
    expect(snippet).not.toContain('\t')
    expect(snippet).toContain('命中点')
  })

  it('大小写不敏感；未命中 / 空查询返回 null', () => {
    expect(buildSnippet('Hello World', 'hello')).toBe('Hello World')
    expect(buildSnippet('Hello World', 'nope')).toBeNull()
    expect(buildSnippet('Hello World', '   ')).toBeNull()
    expect(buildSnippet('', 'x')).toBeNull()
  })
})

describe('matchSession：标题优先，其次从最新消息往回找正文', () => {
  it('标题命中 → inTitle，且不产生正文片段', () => {
    const res = matchSession({ title: '项目树重构', messages: [msg('项目树')] }, '项目树')
    expect(res.inTitle).toBe(true)
    expect(res.snippet).toBeNull()
  })

  it('正文命中 → 返回命中位置附近的一行片段', () => {
    const res = matchSession({ title: '无关标题', messages: [msg('把左侧栏改成项目树，缩进 20px')] }, '项目树')
    expect(res.inTitle).toBe(false)
    expect(res.snippet).toContain('项目树')
  })

  it('多命中时取最新一条消息', () => {
    const res = matchSession(
      { title: 'T', messages: [msg('旧：命中点'), msg('无关'), msg('新：命中点在这里')] },
      '命中点',
    )
    expect(res.snippet).toContain('新')
  })

  it('完全没命中 → 两个字段都为空', () => {
    const res = matchSession({ title: 'T', messages: [msg('abc')] }, 'zzz')
    expect(res).toEqual({ inTitle: false, snippet: null })
  })

  it('空查询不命中任何东西（避免搜索框一聚焦就全蓝）', () => {
    expect(matchSession({ title: 'T', messages: [msg('abc')] }, '  ')).toEqual({
      inTitle: false,
      snippet: null,
    })
  })
})

describe('matchProject / normalizeQuery', () => {
  it('项目名或路径命中即可', () => {
    expect(matchProject('OurCode-ide', 'C:\\work\\OurCode-ide', 'ourcode')).toBe(true)
    expect(matchProject('OurCode-ide', 'C:\\work\\OurCode-ide', 'C:\\work')).toBe(true)
    expect(matchProject('OurCode-ide', 'C:\\work\\OurCode-ide', 'zzz')).toBe(false)
  })

  it('空查询视为不过滤', () => {
    expect(matchProject('任意', 'C:\\x', '   ')).toBe(true)
  })

  it('normalizeQuery 去空白并小写', () => {
    expect(normalizeQuery('  ABC  ')).toBe('abc')
  })
})
