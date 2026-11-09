import { describe, expect, it } from 'vitest'

import {
  SETTINGS_TABS,
  SETTINGS_TAB_IDS,
  isSettingsTabId,
  nextSettingsTab,
  resolveSettingsTab,
  settingsTabIndexOf,
  settingsTabLabel,
  settingsTabTitle,
} from '@/shell/settings/settingsNav'

describe('settingsNav · 栏目清单', () => {
  it('七栏，顺序固定且 id 不重复', () => {
    expect(SETTINGS_TAB_IDS).toEqual([
      'api',
      'appearance',
      'editor',
      'shortcuts',
      'features',
      'mcp',
      'about',
    ])
    expect(new Set(SETTINGS_TAB_IDS).size).toBe(7)
  })

  it('每栏都有非空的中文标题与读屏说明', () => {
    for (const tab of SETTINGS_TABS) {
      expect(tab.label.length).toBeGreaterThan(0)
      expect(tab.title.length).toBeGreaterThan(0)
    }
    expect(settingsTabLabel('api')).toBe('API 与模型')
    expect(settingsTabLabel('editor')).toBe('编辑器与 AI')
    expect(settingsTabTitle('mcp')).toContain('表单')
  })
})

describe('settingsNav · 打开目标解析', () => {
  it('按 id 直落', () => {
    expect(resolveSettingsTab('shortcuts')).toBe('shortcuts')
    expect(resolveSettingsTab('about')).toBe('about')
  })

  it('旧弹窗的 tab 名（appearance / editor / features）原样落到同义栏', () => {
    expect(resolveSettingsTab('appearance')).toBe('appearance')
    expect(resolveSettingsTab('editor')).toBe('editor')
    expect(resolveSettingsTab('features')).toBe('features')
    expect(resolveSettingsTab('api')).toBe('api')
  })

  it('别名（渠道 / 插件 / 主题 / MCP）落到最近的栏', () => {
    expect(resolveSettingsTab('channel')).toBe('features')
    expect(resolveSettingsTab('plugins')).toBe('features')
    expect(resolveSettingsTab('theme')).toBe('appearance')
    expect(resolveSettingsTab('mcp-servers')).toBe('mcp')
    expect(resolveSettingsTab('keys')).toBe('shortcuts')
  })

  it('大小写与空白不敏感；未知值回到首栏而不是空白栏', () => {
    expect(resolveSettingsTab('  APPEARANCE ')).toBe('appearance')
    expect(resolveSettingsTab('MCP')).toBe('mcp')
    expect(resolveSettingsTab('whatever')).toBe('api')
    expect(resolveSettingsTab('')).toBe('api')
    expect(resolveSettingsTab(undefined)).toBe('api')
    expect(resolveSettingsTab(null)).toBe('api')
  })

  it('isSettingsTabId 只认七个 id', () => {
    expect(isSettingsTabId('api')).toBe(true)
    expect(isSettingsTabId('models')).toBe(false)
    expect(isSettingsTabId(undefined)).toBe(false)
    expect(isSettingsTabId(7)).toBe(false)
  })
})

describe('settingsNav · 方向键', () => {
  it('↓ / ↑ 首尾循环', () => {
    expect(nextSettingsTab('api', 'ArrowDown')).toBe('appearance')
    expect(nextSettingsTab('about', 'ArrowDown')).toBe('api')
    expect(nextSettingsTab('api', 'ArrowUp')).toBe('about')
    expect(nextSettingsTab('editor', 'ArrowUp')).toBe('appearance')
  })

  it('Home / End 到首尾', () => {
    expect(nextSettingsTab('mcp', 'Home')).toBe('api')
    expect(nextSettingsTab('appearance', 'End')).toBe('about')
  })

  it('其余键返回 null（Tab / Enter / ArrowLeft 留给浏览器）', () => {
    expect(nextSettingsTab('api', 'Tab')).toBeNull()
    expect(nextSettingsTab('api', 'Enter')).toBeNull()
    expect(nextSettingsTab('api', 'ArrowRight')).toBeNull()
  })

  it('索引越界兜底为 0', () => {
    expect(settingsTabIndexOf('api')).toBe(0)
    expect(settingsTabIndexOf('about')).toBe(6)
  })
})
