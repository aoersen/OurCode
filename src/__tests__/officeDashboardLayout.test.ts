import { describe, it, expect } from 'vitest'
import {
  TAB_BAR_H,
  HANDLE_H,
  BOARD_MIN_H,
  BOARD_FLOOR_H,
  WORKBENCH_MIN_H,
  DEFAULT_BOARD_RATIO,
  STACK_BREAKPOINT,
  adjustBoardHeight,
  clampBoardHeight,
  resolveBoardBounds,
  resolveBoardHeight,
  shouldStackDashboard,
} from '@/services/office/dashboardLayout'

describe('resolveBoardBounds', () => {
  it('keeps both panes at their minimums when there is enough room', () => {
    const { min, max } = resolveBoardBounds(900)
    expect(min).toBe(BOARD_MIN_H)
    expect(max).toBe(900 - WORKBENCH_MIN_H)
  })

  it('splits the space when both minimums cannot fit', () => {
    // 200px 可用高度：工作台下限 180 会让上限变 20，改成按比例分，
    // 避免「看板吃满、工作台被压成 0」
    const { min, max } = resolveBoardBounds(200)
    expect(min).toBeGreaterThanOrEqual(BOARD_FLOOR_H)
    expect(max).toBeLessThanOrEqual(200)
    expect(200 - max).toBeGreaterThanOrEqual(40)
  })

  it('never lets the maximum exceed the available space', () => {
    for (const available of [60, 120, 260, 444, 700, 1200]) {
      const { min, max } = resolveBoardBounds(available)
      expect(max).toBeLessThanOrEqual(available)
      expect(min).toBeLessThanOrEqual(max)
    }
  })

  it('leaves the workbench some room even on short panes', () => {
    for (const available of [200, 300, 400]) {
      const { max } = resolveBoardBounds(available)
      expect(available - max).toBeGreaterThan(0)
    }
  })

  it('falls back to the ideal minimum before the pane is measured', () => {
    expect(resolveBoardBounds(0)).toEqual({ min: BOARD_MIN_H, max: BOARD_MIN_H })
    expect(resolveBoardBounds(NaN)).toEqual({ min: BOARD_MIN_H, max: BOARD_MIN_H })
  })
})

describe('resolveBoardHeight', () => {
  it('uses the default ratio on first open', () => {
    expect(resolveBoardHeight(900)).toBe(Math.round(900 * DEFAULT_BOARD_RATIO))
  })

  it('respects a stored pixel height inside the bounds', () => {
    expect(resolveBoardHeight(900, 400)).toBe(400)
  })

  it('clamps a stored height saved on a much taller window', () => {
    expect(resolveBoardHeight(600, 1200)).toBe(600 - WORKBENCH_MIN_H)
  })

  it('clamps a stored height that would squash the dashboard', () => {
    expect(resolveBoardHeight(900, 80)).toBe(BOARD_MIN_H)
  })

  it('ignores corrupt stored values', () => {
    expect(resolveBoardHeight(900, NaN)).toBe(Math.round(900 * DEFAULT_BOARD_RATIO))
    expect(resolveBoardHeight(900, -40)).toBe(Math.round(900 * DEFAULT_BOARD_RATIO))
    expect(resolveBoardHeight(900, null)).toBe(Math.round(900 * DEFAULT_BOARD_RATIO))
  })

  it('migrates a legacy ratio preference', () => {
    // 旧版只存比例：0.5 → 450，仍要落在合法区间内
    expect(resolveBoardHeight(900, null, 0.5)).toBe(450)
    expect(resolveBoardHeight(900, null, 0.15)).toBe(BOARD_MIN_H)
  })

  it('always leaves room for the workbench once the pane is tall enough', () => {
    for (const available of [444, 520, 700, 1200]) {
      const board = resolveBoardHeight(available, 9999)
      expect(board + WORKBENCH_MIN_H).toBeLessThanOrEqual(available)
    }
  })

  it('returns the ideal minimum before measurement', () => {
    expect(resolveBoardHeight(0, 400)).toBe(BOARD_MIN_H)
  })
})

describe('adjustBoardHeight', () => {
  it('applies the drag delta', () => {
    expect(adjustBoardHeight(300, 120, 900)).toBe(420)
    expect(adjustBoardHeight(300, -120, 900)).toBe(BOARD_MIN_H)
  })

  it('stops at the maximum so the workbench keeps its floor', () => {
    expect(adjustBoardHeight(300, 2000, 900)).toBe(900 - WORKBENCH_MIN_H)
  })

  it('ignores a non-finite delta', () => {
    expect(adjustBoardHeight(300, NaN, 900)).toBe(300)
  })
})

describe('clampBoardHeight', () => {
  it('rounds to whole pixels', () => {
    expect(clampBoardHeight(300.6, 900)).toBe(301)
  })
})

describe('shouldStackDashboard', () => {
  it('stacks the three columns on narrow panes', () => {
    expect(shouldStackDashboard(STACK_BREAKPOINT - 1)).toBe(true)
  })

  it('keeps the 3:5:4 columns on wide panes', () => {
    expect(shouldStackDashboard(STACK_BREAKPOINT)).toBe(false)
    expect(shouldStackDashboard(1200)).toBe(false)
  })

  it('does not stack before the width is measured', () => {
    expect(shouldStackDashboard(0)).toBe(false)
  })
})

describe('layout constants', () => {
  it('reserve a grabbable resize handle and a usable header', () => {
    // 旧实现的分割条只有 1px，鼠标基本抓不住
    expect(HANDLE_H).toBeGreaterThanOrEqual(8)
    expect(TAB_BAR_H).toBeGreaterThanOrEqual(32)
    expect(BOARD_MIN_H).toBeGreaterThan(BOARD_FLOOR_H)
    expect(BOARD_MIN_H).toBeLessThanOrEqual(360)
  })
})
