import { describe, expect, it } from 'vitest'

import {
  ACCENT_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LANGUAGE_OPTIONS,
  THEME_OPTIONS,
  clampFontSize,
  isAccentPreset,
  isLanguageValue,
  isThemeValue,
  languageLabel,
  normalizeHexColor,
  themeLabel,
} from '@/shell/settings/appearanceModel'

describe('appearanceModel · 选项清单', () => {
  it('主题三态与旧面板一致', () => {
    expect(THEME_OPTIONS.map((option) => option.value)).toEqual(['light', 'dark', 'system'])
    expect(themeLabel('light')).toBe('浅色')
    expect(themeLabel('system')).toBe('跟随系统')
    expect(themeLabel('unknown')).toBe('unknown')
  })

  it('语言三态与旧面板一致', () => {
    expect(LANGUAGE_OPTIONS.map((option) => option.value)).toEqual(['zh-CN', 'en-US', 'system'])
    expect(languageLabel('en-US')).toBe('English')
    expect(languageLabel('zh-CN')).toBe('简体中文')
  })

  it('强调色保持旧面板的六个预设，且都是合法色值', () => {
    expect(ACCENT_PRESETS).toHaveLength(6)
    for (const preset of ACCENT_PRESETS) {
      expect(normalizeHexColor(preset.value)).toBe(preset.value)
      expect(preset.label.length).toBeGreaterThan(0)
    }
  })

  it('类型守卫', () => {
    expect(isThemeValue('dark')).toBe(true)
    expect(isThemeValue('dim')).toBe(false)
    expect(isLanguageValue('system')).toBe(true)
    expect(isLanguageValue('fr-FR')).toBe(false)
  })
})

describe('appearanceModel · 强调色', () => {
  it('大小写不敏感识别预设', () => {
    expect(isAccentPreset('#2563EB')).toBe(true)
    expect(isAccentPreset('  #2563eb ')).toBe(true)
    expect(isAccentPreset('#123456')).toBe(false)
  })

  it('颜色输入归一：#RGB 展开、非法值拒绝', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc')
    expect(normalizeHexColor('#A1B2C3')).toBe('#a1b2c3')
    expect(normalizeHexColor('a1b2c3')).toBeNull()
    expect(normalizeHexColor('#12345')).toBeNull()
    expect(normalizeHexColor('#gggggg')).toBeNull()
  })
})

describe('appearanceModel · 字号', () => {
  it('夹在 10–24 之间并取整', () => {
    expect(FONT_SIZE_MIN).toBe(10)
    expect(FONT_SIZE_MAX).toBe(24)
    expect(clampFontSize(13.4)).toBe(13)
    expect(clampFontSize(2)).toBe(10)
    expect(clampFontSize(99)).toBe(24)
  })

  it('非数字回落到默认 13', () => {
    expect(clampFontSize(Number.NaN)).toBe(13)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(24)
  })
})
