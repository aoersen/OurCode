/**
 * composer 权限模式浮层的纯逻辑（`menus/modeMenu.ts`）+ 浮层文案（`menus/copy.ts`）。
 *
 * 重点是把设计稿定死的「五档人话描述」和 Shift+Tab 轮换顺序钉住：这两样
 * 一改就是产品语义变化，不能只靠肉眼看界面。
 */
import { describe, it, expect } from 'vitest'
import { MODE_CYCLE, type EditMode } from '@/services/permissions/modePolicy'
import {
  TARGET_MODE_MODES,
  displayMode,
  modeCopy,
  modeCycle,
  modeItems,
  modeLabel,
  nextMode,
  normalizeMode,
} from '@/shell/agent/composer/menus/modeMenu'
import { copyFor, currentModeLine, fill, usedThisChatText } from '@/shell/agent/composer/menus/copy'

describe('modeItems', () => {
  it('lists five modes in the Shift+Tab order', () => {
    const items = modeItems('zh-CN', false)
    expect(items.map((i) => i.mode)).toEqual([...MODE_CYCLE])
    expect(items).toHaveLength(5)
  })

  it('uses the plain-language copy from the design', () => {
    const zh = modeItems('zh-CN', false)
    expect(zh.map((i) => [i.label, i.description])).toEqual([
      ['手动确认', '每个工具调用都要你点一下'],
      ['自动编辑', '只在工作区内自动改文件'],
      ['计划模式', '先出计划，批准后才动手'],
      ['自主执行', '自动批准并自动继续'],
      ['完全访问', '跳过沙箱限制，风险自负'],
    ])
  })

  it('gives every mode a one-sentence consequence for the header line', () => {
    for (const item of modeItems('zh-CN', false)) {
      expect(item.consequence.length).toBeGreaterThan(0)
      expect(item.consequence).not.toBe(item.description)
    }
  })

  it('localizes to English without dropping any mode', () => {
    const en = modeItems('en-US', false)
    expect(en).toHaveLength(5)
    expect(en[0].label).toBe('Manual confirm')
    expect(en[1].description).toBe('Only edits files inside the workspace')
  })

  it('only offers manual/autonomous while target mode is on', () => {
    expect(modeItems('zh-CN', true).map((i) => i.mode)).toEqual([...TARGET_MODE_MODES])
    expect(modeCycle(true)).toEqual(['confirm_before_change', 'guarded'])
  })
})

describe('mode cycling', () => {
  it('walks the five modes and wraps back to manual', () => {
    let mode: EditMode = 'confirm_before_change'
    const seen: EditMode[] = [mode]
    for (let i = 0; i < 5; i += 1) {
      mode = nextMode(mode, false)
      seen.push(mode)
    }
    expect(seen).toEqual([
      'confirm_before_change',
      'auto_edit',
      'plan',
      'guarded',
      'yolo',
      'confirm_before_change',
    ])
  })

  it('rotates only manual → autonomous in target mode', () => {
    expect(nextMode('confirm_before_change', true)).toBe('guarded')
    expect(nextMode('guarded', true)).toBe('confirm_before_change')
  })

  it('recovers from a mode that is not in the active cycle', () => {
    expect(nextMode('yolo', true)).toBe('confirm_before_change')
  })
})

describe('normalizeMode / displayMode', () => {
  it('falls back to manual confirm for empty or unknown values', () => {
    expect(normalizeMode(undefined)).toBe('confirm_before_change')
    expect(normalizeMode('')).toBe('confirm_before_change')
    expect(normalizeMode('full_access')).toBe('confirm_before_change')
    expect(normalizeMode('plan')).toBe('plan')
  })

  it('collapses a mode the target-mode cycle hides', () => {
    expect(displayMode('plan', true)).toBe('confirm_before_change')
    expect(displayMode('plan', false)).toBe('plan')
    expect(displayMode('guarded', true)).toBe('guarded')
  })
})

describe('mode copy', () => {
  it('resolves labels per mode and locale', () => {
    expect(modeLabel('guarded', 'zh-CN')).toBe('自主执行')
    expect(modeLabel('guarded', 'en-US')).toBe('Autonomous')
    expect(modeCopy('yolo', 'zh-CN').description).toContain('风险自负')
  })
})

describe('composer menu copy', () => {
  it('interpolates {var} placeholders and leaves unknown ones alone', () => {
    expect(fill('a {x} b', { x: 2 })).toBe('a 2 b')
    expect(fill('a {y} b', { x: 2 })).toBe('a {y} b')
    expect(fill('plain')).toBe('plain')
  })

  it('formats the usage suffix and the current-mode header line', () => {
    expect(usedThisChatText('zh-CN', 42)).toBe('本次已用 42%')
    expect(usedThisChatText('en-US', 7)).toBe('Used 7% this chat')
    expect(currentModeLine('zh-CN', '计划模式', '先只读调研并给出计划，批准前不动文件')).toBe(
      '当前：计划模式 · 先只读调研并给出计划，批准前不动文件',
    )
    expect(currentModeLine('en-US', 'Plan mode', 'Read-only research')).toBe(
      'Current: Plan mode — Read-only research',
    )
  })

  it('carries the strings the design panels show', () => {
    const zh = copyFor('zh-CN')
    expect(zh.favoritesLabel).toBe('收藏')
    expect(zh.emptySearch).toBe('没有匹配的模型')
    expect(zh.thinkingLabel).toBe('思考档位')
    expect(zh.modeHint).toBe('Shift+Tab 循环切换 · 当前会话内生效')
    // 三个浮层都得有 aria-label，否则 role=dialog 读不出名字
    expect(zh.modeDialog).toBeTruthy()
    expect(zh.modelDialog).toBeTruthy()
    expect(copyFor('en-US').modeHint).toContain('Shift+Tab')
  })
})
