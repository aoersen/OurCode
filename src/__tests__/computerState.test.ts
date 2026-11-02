import { describe, it, expect } from 'vitest'
import {
  diffElements,
  elementSignature,
  healElement,
  isFrameActionable,
  renderElementLine,
  renderStateText,
  type CuaElementInfo,
  type CuaState,
} from '@shared/computer'

function el(index: number, role: string, name: string, extra: Partial<CuaElementInfo> = {}): CuaElementInfo {
  return { index, role, name, enabled: true, actions: [], ...extra }
}

function state(overrides: Partial<CuaState> = {}): CuaState {
  return {
    stateId: 's-1',
    mode: 'full',
    app: { pid: 1, name: 'notepad' },
    window: {
      windowId: 2,
      title: '无标题 - 记事本',
      main: true,
      focused: true,
      visible: true,
      minimized: false,
      bounds: [0, 0, 800, 600],
    },
    elements: [el(0, 'window', '无标题 - 记事本'), el(3, 'document', '文本编辑器', { value: '' })],
    capturedAt: 0,
    nodeCount: 2,
    truncated: false,
    ...overrides,
  }
}

describe('computer state diffing', () => {
  it('marks the first observation as full', () => {
    expect(diffElements(undefined, [el(0, 'window', 'x')])).toEqual({ mode: 'full', changed: [0] })
  })

  it('reports no_change when nothing moved', () => {
    const els = [el(0, 'window', 'x'), el(1, 'button', '保存')]
    expect(diffElements(els, els.map((e) => ({ ...e })), 's-1')).toMatchObject({ mode: 'no_change', changed: [] })
  })

  it('reports delta for a single changed node', () => {
    const before = Array.from({ length: 10 }, (_, i) => el(i, 'text', `row ${i}`))
    const after = before.map((e) => ({ ...e }))
    after[4] = { ...after[4], value: 'changed' }
    const diff = diffElements(before, after, 's-1')
    expect(diff.mode).toBe('delta')
    expect(diff.changed).toEqual([4])
  })

  it('falls back to full when more than 40% of the tree changed', () => {
    const before = Array.from({ length: 10 }, (_, i) => el(i, 'text', `row ${i}`))
    const after = before.map((e, i) => (i < 5 ? { ...e, value: 'x' } : { ...e }))
    expect(diffElements(before, after, 's-1').mode).toBe('full')
  })
})

describe('computer element healing', () => {
  it('matches role + name when the index moved', () => {
    const previous = el(4, 'button', '保存', { bounds: [100, 100, 80, 30] })
    const current = [el(9, 'button', '保存', { bounds: [110, 102, 80, 30] })]
    const healed = healElement(previous, current)
    expect(healed?.element.index).toBe(9)
    expect(healed?.displacement).toBeLessThanOrEqual(12)
  })

  it('refuses a candidate that moved too far', () => {
    const previous = el(4, 'button', '保存', { bounds: [0, 0, 80, 30] })
    const current = [el(9, 'button', '保存', { bounds: [2000, 2000, 80, 30] })]
    expect(healElement(previous, current)).toBeNull()
  })

  it('prefers automation id matches', () => {
    const previous = el(1, 'edit', '', { automationId: 'probeInput', bounds: [0, 0, 100, 30] })
    const current = [
      el(3, 'edit', '', { automationId: 'other', bounds: [0, 0, 100, 30] }),
      el(8, 'edit', '', { automationId: 'probeInput', bounds: [10, 10, 100, 30] }),
    ]
    expect(healElement(previous, current)?.element.index).toBe(8)
  })
})

describe('computer rendering', () => {
  it('renders role/name/actions without bounds', () => {
    const line = renderElementLine(el(4, 'button', '保存', { actions: ['press'], bounds: [1, 2, 3, 4] }))
    expect(line).toBe('[4] button "保存" actions=[press]')
  })

  it('compresses no_change to one line', () => {
    const text = renderStateText(state({ mode: 'no_change', baseStateId: 's-0' }))
    expect(text).toContain('no_change')
    expect(text).not.toContain('[0] window')
  })

  it('renders a full tree with the window header', () => {
    const text = renderStateText(state())
    expect(text).toContain('app: notepad (pid 1)')
    expect(text).toContain('[3] document "文本编辑器"')
  })
})

describe('computer frame TTL', () => {
  it('treats a frame as actionable only inside the TTL', () => {
    const frame = { frameId: 'f', width: 1, height: 1, unit: 'physical_pixel' as const, scale: 1, capturedAt: 1_000 }
    expect(isFrameActionable(frame, 1_500)).toBe(true)
    expect(isFrameActionable(frame, 1_000 + 10 * 60_000 + 1)).toBe(false)
    expect(isFrameActionable(undefined, 1_500)).toBe(false)
  })

  it('keeps signatures stable for identical elements', () => {
    expect(elementSignature(el(1, 'button', '保存', { actions: ['press'] }))).toBe(
      elementSignature(el(7, 'button', '保存', { actions: ['press'] })),
    )
  })
})
