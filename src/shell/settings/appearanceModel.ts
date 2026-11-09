/**
 * 外观面的选项模型 —— 纯函数，node 环境可单测。
 *
 * 全部选项都来自旧设置面板（主题三态 / 界面语言三态 / 六个强调色预设 /
 * 字号 10–24），这样新壳不会凭空发明用户没见过的取值。
 *
 * 说明：`ACCENT_PRESETS` 是**用户可选的颜色数据**，不是样式 token —— 强调色
 * 本身必须是一个色值，否则 <input type="color"> 无法回填。界面里除这一处
 * 色板外不出现任何硬编码色值，样式一律走 pure.css 的 CSS 变量。
 */

export type ThemeValue = 'light' | 'dark' | 'system'
export type LanguageValue = 'zh-CN' | 'en-US' | 'system'

export interface OptionEntry<T extends string> {
  value: T
  label: string
}

export const THEME_OPTIONS: ReadonlyArray<OptionEntry<ThemeValue>> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

export const LANGUAGE_OPTIONS: ReadonlyArray<OptionEntry<LanguageValue>> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
  { value: 'system', label: '跟随系统' },
]

/** 旧设置面板的强调色预设（六个）。 */
export const ACCENT_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '#2563eb', label: '蓝' },
  { value: '#7c5cbf', label: '紫' },
  { value: '#059669', label: '绿' },
  { value: '#e11d48', label: '玫红' },
  { value: '#f59e0b', label: '琥珀' },
  { value: '#0891b2', label: '青' },
]

export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 24

export function isThemeValue(value: unknown): value is ThemeValue {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function isLanguageValue(value: unknown): value is LanguageValue {
  return value === 'zh-CN' || value === 'en-US' || value === 'system'
}

export function themeLabel(value: string): string {
  return THEME_OPTIONS.find((option) => option.value === value)?.label ?? value
}

export function languageLabel(value: string): string {
  return LANGUAGE_OPTIONS.find((option) => option.value === value)?.label ?? value
}

/** 大小写不敏感地判断「当前强调色是否就是某个预设」。 */
export function isAccentPreset(color: string): boolean {
  const needle = color.trim().toLowerCase()
  return ACCENT_PRESETS.some((preset) => preset.value === needle)
}

/** 颜色输入的取值校验：只接受 #RGB / #RRGGBB，统一返回小写 #rrggbb。 */
export function normalizeHexColor(input: string): string | null {
  const raw = input.trim().toLowerCase()
  if (!raw.startsWith('#')) return null
  const body = raw.slice(1)
  if (/^[0-9a-f]{3}$/.test(body)) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
  }
  if (/^[0-9a-f]{6}$/.test(body)) return `#${body}`
  return null
}

/** 字号滑块/输入的收敛：非数字回落到默认 13，越界值夹到 10–24。 */
export function clampFontSize(value: number): number {
  if (Number.isNaN(value)) return 13
  if (!Number.isFinite(value)) return value > 0 ? FONT_SIZE_MAX : FONT_SIZE_MIN
  const rounded = Math.round(value)
  if (rounded < FONT_SIZE_MIN) return FONT_SIZE_MIN
  if (rounded > FONT_SIZE_MAX) return FONT_SIZE_MAX
  return rounded
}
