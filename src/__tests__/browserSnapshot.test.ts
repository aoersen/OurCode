import { describe, it, expect } from 'vitest'
import { formatAxTree, type AxInputNode } from '@shared/browser'

function node(role: string, name?: string, extra: Partial<AxInputNode> = {}): AxInputNode {
  return { role, name, ...extra }
}

describe('formatAxTree — ARIA snapshot rendering', () => {
  it('renders roles, names and refs for nodes with a backend id', () => {
    const tree = node('document', '示例页面', {
      backendDOMNodeId: 1,
      children: [
        node('navigation', '', { backendDOMNodeId: 2, children: [node('link', '首页', { backendDOMNodeId: 3 })] }),
        node('button', '提交', { backendDOMNodeId: 4, children: [] }),
      ],
    })
    const result = formatAxTree(tree)
    expect(result.text).toContain('- document "示例页面" [ref=e0]')
    expect(result.text).toContain('- link "首页" [ref=e2]')
    expect(result.text).toContain('- button "提交" [ref=e3]')
    expect(result.refs).toEqual({ e0: 1, e1: 2, e2: 3, e3: 4 })
    expect(result.nodes).toBe(4)
  })

  it('hoists children of ignored nodes instead of dropping the subtree', () => {
    const tree = node('rootwebarea', '', {
      ignored: true,
      children: [node('button', '保存', { backendDOMNodeId: 7 })],
    })
    const result = formatAxTree(tree)
    expect(result.text).toContain('- button "保存" [ref=e0]')
    expect(result.refs).toEqual({ e0: 7 })
  })

  it('drops unnamed generic containers but keeps their ancestors’ children', () => {
    const tree = node('document', 'page', {
      children: [
        node('generic', '', { children: [node('text', '内容', { backendDOMNodeId: 9 })] }),
      ],
    })
    const text = formatAxTree(tree).text
    expect(text).toContain('text "内容"')
    expect(text).not.toContain('generic')
  })

  it('prints values that differ from the accessible name', () => {
    const tree = node('textbox', '邮箱', { value: 'a@b.com', backendDOMNodeId: 11 })
    expect(formatAxTree(tree).text).toContain('value="a@b.com"')
  })

  it('caps the node count and says so', () => {
    const children = Array.from({ length: 30 }, (_, i) => node('button', `b${i}`, { backendDOMNodeId: 100 + i }))
    const result = formatAxTree(node('document', 'many', { children }), { maxNodes: 10 })
    expect(result.nodes).toBeLessThanOrEqual(10)
    expect(result.text).toContain('已截断')
  })

  it('caps characters for very wide trees', () => {
    const children = Array.from({ length: 200 }, (_, i) => node('button', `按钮${i}-`.repeat(20), { backendDOMNodeId: 200 + i }))
    const result = formatAxTree(node('document', 'wide', { children }), { maxNodes: 500, maxChars: 500 })
    expect(result.text).toContain('已截断')
    expect(result.text.length).toBeLessThan(2_000)
  })
})
