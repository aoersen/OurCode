import { describe, expect, it } from 'vitest'

import {
  categoryLabel,
  findShortcutConflicts,
  formatShortcut,
  groupShortcuts,
  isEditablePreset,
  isModifierKey,
  normalizeKeyToken,
  normalizeShortcutText,
  shortcutTokens,
  SHORTCUT_CATEGORY_ORDER,
} from '@/shell/settings/shortcutKeys'

describe('shortcutKeys · 键名收敛', () => {
  it('字母大写、功能键标准化', () => {
    expect(normalizeKeyToken('p')).toBe('P')
    expect(normalizeKeyToken('f4')).toBe('F4')
    expect(normalizeKeyToken('insert')).toBe('Insert')
    expect(normalizeKeyToken('pgdn')).toBe('PageDown')
  })

  it('空格 / Esc / 方向键有明确写法', () => {
    expect(normalizeKeyToken(' ')).toBe('Space')
    expect(normalizeKeyToken('space')).toBe('Space')
    expect(normalizeKeyToken('esc')).toBe('Escape')
    expect(normalizeKeyToken('up')).toBe('ArrowUp')
  })

  it('修饰键与空值返回 null', () => {
    expect(normalizeKeyToken('Control')).toBeNull()
    expect(normalizeKeyToken('meta')).toBeNull()
    expect(normalizeKeyToken('shift')).toBeNull()
    expect(normalizeKeyToken('   ')).toBeNull()
    expect(normalizeKeyToken('+')).toBeNull()
  })

  it('isModifierKey 不会被对象原型上的名字骗到', () => {
    expect(isModifierKey('Shift')).toBe(true)
    expect(isModifierKey('option')).toBe(true)
    expect(isModifierKey('constructor')).toBe(false)
    expect(normalizeKeyToken('toString')).not.toBeTypeOf('function')
  })
})

describe('shortcutKeys · 键盘事件 → 键位串', () => {
  it('修饰键按 Ctrl / Alt / Shift 固定顺序输出', () => {
    expect(formatShortcut({ key: 'p', shiftKey: true, ctrlKey: true })).toBe('Ctrl+Shift+P')
    expect(formatShortcut({ key: 'Insert', ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+Insert')
    expect(formatShortcut({ key: 'Enter', altKey: true })).toBe('Alt+Enter')
  })

  it('Cmd（metaKey）与 Ctrl 等价', () => {
    expect(formatShortcut({ key: 'k', metaKey: true })).toBe('Ctrl+K')
    expect(formatShortcut({ key: 'k', metaKey: true, shiftKey: true })).toBe('Ctrl+Shift+K')
  })

  it('裸可打印字符被拒绝（否则输入即触发）', () => {
    expect(formatShortcut({ key: 'a' })).toBeNull()
    expect(formatShortcut({ key: '=' })).toBeNull()
    expect(formatShortcut({ key: '1' })).toBeNull()
  })

  it('裸功能键 / 导航键可以单独绑定', () => {
    expect(formatShortcut({ key: 'F12' })).toBe('F12')
    expect(formatShortcut({ key: 'Enter' })).toBe('Enter')
    expect(formatShortcut({ key: 'Escape' })).toBe('Escape')
  })

  it('只有修饰键 → null', () => {
    expect(formatShortcut({ key: 'Shift', shiftKey: true })).toBeNull()
    expect(formatShortcut({ key: 'Control', ctrlKey: true })).toBeNull()
  })
})

describe('shortcutKeys · 手输文本归一', () => {
  it('大小写 / 顺序 / 空白都归一', () => {
    expect(normalizeShortcutText('ctrl + shift + p')).toBe('Ctrl+Shift+P')
    expect(normalizeShortcutText('Shift+Ctrl+p')).toBe('Ctrl+Shift+P')
    expect(normalizeShortcutText('cmd+k')).toBe('Ctrl+K')
    expect(normalizeShortcutText('option+enter')).toBe('Alt+Enter')
  })

  it('重复修饰键只算一次', () => {
    expect(normalizeShortcutText('Ctrl+Ctrl+S')).toBe('Ctrl+S')
  })

  it('无法识别的输入返回 null', () => {
    expect(normalizeShortcutText('')).toBeNull()
    expect(normalizeShortcutText('ctrl')).toBeNull()
    expect(normalizeShortcutText('ctrl+')).toBeNull()
    expect(normalizeShortcutText('p')).toBeNull()
    expect(normalizeShortcutText('+++')).toBeNull()
  })

  it('裸功能键允许，裸字母不允许', () => {
    expect(normalizeShortcutText('F4')).toBe('F4')
    expect(normalizeShortcutText('enter')).toBe('Enter')
    expect(normalizeShortcutText('a')).toBeNull()
  })
})

describe('shortcutKeys · 键帽与分组', () => {
  it('键帽拆分', () => {
    expect(shortcutTokens('Ctrl+Shift+P')).toEqual(['Ctrl', 'Shift', 'P'])
    expect(shortcutTokens('F4')).toEqual(['F4'])
    expect(shortcutTokens('')).toEqual([])
  })

  it('按固定类别顺序分组，空类别不出现', () => {
    const groups = groupShortcuts([
      { id: 'ai.explain', category: 'ai' },
      { id: 'file.save', category: 'file' },
      { id: 'file.open', category: 'file' },
    ])
    expect(groups.map((group) => group.category)).toEqual(['file', 'ai'])
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].label).toBe('文件操作')
    expect(SHORTCUT_CATEGORY_ORDER[0]).toBe('file')
  })

  it('未知类别排在最后并原样显示', () => {
    const groups = groupShortcuts([
      { id: 'x', category: 'terminal' },
      { id: 'y', category: 'weird' },
    ])
    expect(groups.map((group) => group.category)).toEqual(['terminal', 'weird'])
    expect(groups[1].label).toBe('weird')
    expect(categoryLabel('terminal')).toBe('终端')
  })
})

describe('shortcutKeys · 冲突检测', () => {
  it('同一键位绑给多个动作时列出', () => {
    const conflicts = findShortcutConflicts([
      { id: 'a', keys: 'Ctrl+K' },
      { id: 'b', keys: 'ctrl+k' },
      { id: 'c', keys: 'Ctrl+Shift+K' },
    ])
    expect(conflicts).toEqual([{ keys: 'Ctrl+K', ids: ['a', 'b'] }])
  })

  it('顺序不同的等价写法也算冲突', () => {
    expect(findShortcutConflicts([
      { id: 'a', keys: 'Ctrl+Shift+P' },
      { id: 'b', keys: 'Shift+Ctrl+P' },
    ])).toEqual([{ keys: 'Ctrl+Shift+P', ids: ['a', 'b'] }])
  })

  it('没有冲突时返回空数组；无法解析的键位被忽略', () => {
    expect(findShortcutConflicts([{ id: 'a', keys: 'Ctrl+K' }, { id: 'b', keys: 'Ctrl+L' }])).toEqual([])
    expect(findShortcutConflicts([{ id: 'a', keys: '' }, { id: 'b', keys: '' }])).toEqual([])
  })
})

describe('shortcutKeys · 可编辑性', () => {
  it('只有自定义方案允许重绑（与旧面板一致）', () => {
    expect(isEditablePreset('custom')).toBe(true)
    expect(isEditablePreset('vscode')).toBe(false)
    expect(isEditablePreset('jetbrains')).toBe(false)
  })
})
