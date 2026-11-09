/**
 * composer 浮层的键盘模型（`menus/menuNav.ts`）。
 *
 * 键盘交互是最容易在视觉重构里被悄悄改坏的一层，所以把「哪个键算什么意图」
 * 抽成纯函数钉死：Esc 关闭、↑/↓ 移动、Enter 选中、←/→ 只在非输入框里改档位。
 */
import { describe, it, expect } from 'vitest'
import {
  clampHighlight,
  menuKeyIntent,
  moveHighlight,
} from '@/shell/agent/composer/menus/menuNav'

describe('menuKeyIntent', () => {
  it('maps the shared keys', () => {
    expect(menuKeyIntent('Escape')).toBe('close')
    expect(menuKeyIntent('ArrowUp')).toBe('up')
    expect(menuKeyIntent('ArrowDown')).toBe('down')
    expect(menuKeyIntent('Enter')).toBe('select')
  })

  it('ignores every other key', () => {
    expect(menuKeyIntent('a')).toBeNull()
    expect(menuKeyIntent('Tab')).toBeNull()
    expect(menuKeyIntent('Enter', { allowLevels: true })).toBe('select')
  })

  it('only gives ←/→ to panels that own a thinking-level control', () => {
    expect(menuKeyIntent('ArrowLeft')).toBeNull()
    expect(menuKeyIntent('ArrowLeft', { allowLevels: true })).toBe('level-prev')
    expect(menuKeyIntent('ArrowRight', { allowLevels: true })).toBe('level-next')
  })

  it('leaves ←/→ to the caret when the search input has focus', () => {
    expect(menuKeyIntent('ArrowLeft', { allowLevels: true, inTextInput: true })).toBeNull()
    expect(menuKeyIntent('ArrowRight', { allowLevels: true, inTextInput: true })).toBeNull()
    // 但 ↑/↓/Enter/Esc 仍然归面板（列表要继续能动）
    expect(menuKeyIntent('ArrowDown', { allowLevels: true, inTextInput: true })).toBe('down')
    expect(menuKeyIntent('Escape', { allowLevels: true, inTextInput: true })).toBe('close')
  })
})

describe('highlight movement', () => {
  it('clamps inside the list instead of wrapping', () => {
    expect(moveHighlight(0, 3, -1)).toBe(0)
    expect(moveHighlight(0, 3, 1)).toBe(1)
    expect(moveHighlight(2, 3, 1)).toBe(2)
    expect(moveHighlight(1, 3, -1)).toBe(0)
  })

  it('handles an empty list', () => {
    expect(clampHighlight(5, 0)).toBe(0)
    expect(moveHighlight(0, 0, 1)).toBe(0)
  })

  it('re-clamps when the filtered list shrinks', () => {
    expect(clampHighlight(4, 2)).toBe(1)
    expect(clampHighlight(-3, 2)).toBe(0)
  })
})
