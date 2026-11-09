import { useEffect, useMemo, useState } from 'react'

import { useShortcutStore, type ShortcutBinding, type ShortcutPreset } from '@/stores/shortcutStore'
import {
  findShortcutConflicts,
  formatShortcut,
  groupShortcuts,
  isEditablePreset,
  normalizeShortcutText,
  shortcutTokens,
} from '../shortcutKeys'
import { GroupLabel, KeyCap, Row, SectionHeading, SelectField, StatusLine, TextAction, TextInput } from '../settingsParts'

const PRESET_OPTIONS = [
  { value: 'vscode', label: 'VS Code 预设' },
  { value: 'jetbrains', label: 'JetBrains 预设' },
  { value: 'custom', label: '自定义' },
]

/**
 * 「快捷键」：预设切换 + 单条重绑。
 *
 * 与旧面板一致：只有「自定义」方案才允许重绑（预设方案是只读的），切换预设会
 * 覆盖当前自定义键位。重绑用行内输入框 —— 可直接敲组合键（带修饰键时立即
 * 识别），也可以手输 `Ctrl+Shift+K`；Esc 取消、Enter 保存。
 */
export default function ShortcutsSection() {
  const preset = useShortcutStore((state) => state.preset)
  const shortcuts = useShortcutStore((state) => state.shortcuts)
  const setPreset = useShortcutStore((state) => state.setPreset)
  const resetToPreset = useShortcutStore((state) => state.resetToPreset)
  const updateShortcut = useShortcutStore((state) => state.updateShortcut)
  const loadShortcuts = useShortcutStore((state) => state.loadShortcuts)

  const [rebindingId, setRebindingId] = useState<string | null>(null)
  const [rebindText, setRebindText] = useState('')
  const [rebindError, setRebindError] = useState<string | null>(null)

  useEffect(() => {
    loadShortcuts()
  }, [loadShortcuts])

  const editable = isEditablePreset(preset)
  const groups = useMemo(() => groupShortcuts(shortcuts), [shortcuts])
  const conflicts = useMemo(() => findShortcutConflicts(shortcuts), [shortcuts])
  const conflictIds = useMemo(
    () => new Set(conflicts.flatMap((conflict) => conflict.ids)),
    [conflicts],
  )

  const beginRebind = (item: ShortcutBinding) => {
    if (!editable) return
    setRebindingId(item.id)
    setRebindText(item.keys)
    setRebindError(null)
  }

  const cancelRebind = () => {
    setRebindingId(null)
    setRebindText('')
    setRebindError(null)
  }

  const commitRebind = (raw: string) => {
    if (!rebindingId) return
    const normalized = normalizeShortcutText(raw)
    if (!normalized) {
      setRebindError('无法识别这个组合键：请带 Ctrl / Alt / Shift，或使用 F1–F12、Enter 这类功能键')
      return
    }
    updateShortcut(rebindingId, normalized)
    cancelRebind()
  }

  return (
    <div>
      <SectionHeading
        title="快捷键"
        hint="切换预设会覆盖当前自定义键位；随时可以重置回 VS Code 方案。"
      >
        {preset === 'custom' ? (
          <TextAction onClick={() => resetToPreset('vscode')} label="重置为 VS Code 预设">
            重置
          </TextAction>
        ) : null}
      </SectionHeading>

      <GroupLabel trailing={`${shortcuts.length} 个快捷键`}>键位方案</GroupLabel>
      <Row
        label="当前方案"
        description={
          editable ? '点任意键位即可重新录入' : '预设方案是只读的，切到「自定义」后才能逐条重绑'
        }
      >
        <SelectField
          label="键位方案"
          value={preset}
          options={PRESET_OPTIONS}
          onChange={(event) => setPreset(event.target.value as ShortcutPreset)}
        />
        {!editable ? (
          <TextAction onClick={() => setPreset('custom')} label="改为自定义方案">
            改为自定义
          </TextAction>
        ) : null}
      </Row>

      {conflicts.length > 0 ? (
        <div className="pt-1">
          {conflicts.map((conflict) => (
            <StatusLine key={conflict.keys} tone="error">
              {conflict.keys} 被 {conflict.ids.length} 个动作共用：{conflict.ids.join('、')}
            </StatusLine>
          ))}
        </div>
      ) : null}

      {groups.map((group) => (
        <div key={group.category}>
          <GroupLabel trailing={`${group.items.length} 个`}>{group.label}</GroupLabel>
          {group.items.map((item) => {
            const open = rebindingId === item.id
            return (
              <div key={item.id}>
                <Row
                  label={item.description}
                  description={
                    conflictIds.has(item.id) ? (
                      <span className="text-[var(--pure-danger)]">键位与其他动作重复</span>
                    ) : (
                      <span className="font-mono">{item.action}</span>
                    )
                  }
                >
                  {open ? (
                    <span className="text-[11.5px] leading-[18px] text-[var(--pure-muted)]">录入中…</span>
                  ) : (
                    <KeyCap
                      label={
                        editable
                          ? `重新绑定「${item.description}」，当前 ${item.keys}`
                          : `${item.description} 当前键位 ${item.keys}（切换到自定义后可重绑）`
                      }
                      editable={editable}
                      onClick={() => beginRebind(item)}
                    >
                      {shortcutTokens(item.keys).map((token, index) => (
                        <span key={`${token}-${index}`}>
                          {index > 0 ? <span className="px-0.5 text-[var(--pure-muted)]">+</span> : null}
                          {token}
                        </span>
                      ))}
                    </KeyCap>
                  )}
                </Row>
                {open ? (
                  <div className="pb-2 pl-0">
                    <div className="flex items-center gap-2">
                      <TextInput
                        label={`「${item.description}」的新键位`}
                        mono
                        autoFocus
                        value={rebindText}
                        onChange={(event) => {
                          setRebindText(event.target.value)
                          setRebindError(null)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            // 取消重绑，别让 Esc 冒泡到面板把设置关掉
                            event.preventDefault()
                            event.stopPropagation()
                            cancelRebind()
                            return
                          }
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            commitRebind(rebindText)
                            return
                          }
                          if (event.ctrlKey || event.metaKey || event.altKey) {
                            const captured = formatShortcut(event)
                            if (captured) {
                              event.preventDefault()
                              setRebindText(captured)
                              commitRebind(captured)
                            }
                          }
                        }}
                        className="w-[240px]"
                      />
                      <TextAction onClick={() => commitRebind(rebindText)} label="保存键位">
                        保存
                      </TextAction>
                      <TextAction onClick={cancelRebind} label="取消重绑">
                        取消
                      </TextAction>
                    </div>
                    {rebindError ? (
                      <div className="pt-1">
                        <StatusLine tone="error">{rebindError}</StatusLine>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
