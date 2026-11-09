import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import {
  ACCENT_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LANGUAGE_OPTIONS,
  THEME_OPTIONS,
  clampFontSize,
  normalizeHexColor,
} from '../appearanceModel'
import { GroupLabel, Row, SectionHeading, Segmented, TextInput } from '../settingsParts'

/**
 * 「外观」：主题三态、强调色、界面语言、编辑器字号。
 *
 * 主题与强调色沿用旧面板的两段式写入 —— 偏好落盘（savePreferences）之后
 * 再调 uiStore.setTheme / setThemeColor 让 DOM 立刻变，不用等重启。
 */
export default function AppearanceSection() {
  const preferences = useEditorStore((state) => state.preferences)
  const savePreferences = useEditorStore((state) => state.savePreferences)
  const themeColor = useUIStore((state) => state.themeColor)
  const setTheme = useUIStore((state) => state.setTheme)
  const setThemeColor = useUIStore((state) => state.setThemeColor)

  const applyThemeColor = (value: string) => {
    const normalized = normalizeHexColor(value)
    if (normalized) setThemeColor(normalized)
  }

  return (
    <div>
      <SectionHeading title="外观" hint="主题与强调色即时生效；语言重启后完全生效。" />

      <GroupLabel>主题</GroupLabel>
      <Row label="界面主题" description="选择浅色、深色或跟随系统">
        <Segmented
          label="界面主题"
          value={preferences.theme}
          options={THEME_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(next) => {
            void savePreferences({ theme: next })
            setTheme(next)
          }}
        />
      </Row>
      <Row label="强调色" description="用于按钮、选中态与焦点环" stacked>
        <div className="flex flex-wrap items-center gap-2">
          {ACCENT_PRESETS.map((preset) => {
            const active = themeColor.toLowerCase() === preset.value
            return (
              <button
                key={preset.value}
                type="button"
                onClick={() => setThemeColor(preset.value)}
                aria-label={`使用强调色 ${preset.label}`}
                aria-pressed={active}
                title={preset.label}
                className={`pure-focus h-5 w-5 rounded-full transition-transform ${
                  active ? 'ring-2 ring-[var(--pure-ink)] ring-offset-2 ring-offset-white' : 'hover:scale-110'
                }`}
                style={{ background: preset.value }}
              />
            )
          })}
          <span className="pl-2 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">自定义</span>
          <input
            type="color"
            aria-label="自定义强调色"
            value={normalizeHexColor(themeColor) ?? themeColor}
            onChange={(event) => applyThemeColor(event.target.value)}
            className="pure-focus h-6 w-8 cursor-pointer rounded-md border-0 bg-transparent p-0"
          />
          <TextInput
            label="强调色色值"
            mono
            value={themeColor}
            onChange={(event) => applyThemeColor(event.target.value)}
            className="w-[110px]"
          />
        </div>
      </Row>

      <GroupLabel>语言与字号</GroupLabel>
      <Row label="界面语言" description="切换中文或英文界面，重启后完全生效">
        <Segmented
          label="界面语言"
          value={preferences.language}
          options={LANGUAGE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(next) => void savePreferences({ language: next })}
        />
      </Row>
      <Row label="编辑器字号" description="只影响代码编辑器，不影响界面字号">
        <input
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          aria-label="编辑器字号"
          value={clampFontSize(preferences.fontSize)}
          onChange={(event) => void savePreferences({ fontSize: clampFontSize(Number(event.target.value)) })}
          className="w-[140px] accent-[var(--pure-ink)]"
        />
        <span className="w-10 text-right font-mono text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
          {clampFontSize(preferences.fontSize)}px
        </span>
      </Row>
    </div>
  )
}
