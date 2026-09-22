import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'
import MSIcon from '@/components/Common/icons/MSIcon'
import type { EditMode } from '@/services/permissions/modePolicy'

interface ModeMenuProps {
  value: EditMode
  targetMode: boolean
  onChange: (mode: EditMode) => void
}

/** 菜单项：图标 + 模式名 + 一句话说明（i18n 表在 chat.projectEditMode*Hint）。 */
const MODE_ITEMS: Array<{ mode: EditMode; icon: string; labelKey: TranslationKey; hintKey: TranslationKey; warning?: boolean }> = [
  { mode: 'confirm_before_change', icon: 'back_hand', labelKey: 'chat.projectEditModeConfirm', hintKey: 'chat.projectEditModeConfirmHint' },
  { mode: 'auto_edit', icon: 'edit', labelKey: 'chat.projectEditModeAuto', hintKey: 'chat.projectEditModeAutoHint' },
  { mode: 'plan', icon: 'checklist', labelKey: 'chat.projectEditModePlan', hintKey: 'chat.projectEditModePlanHint' },
  { mode: 'full_access', icon: 'bolt', labelKey: 'chat.projectEditModeFull', hintKey: 'chat.projectEditModeFullHint', warning: true },
]

/**
 * 编辑方式下拉菜单（权限模式重设计 C2）：替换原生的 <select>。
 * 弹出面板向上展开（模式栏位于面板底部），列出四档模式（图标 + 名称 + 一句话
 * 说明），当前项高亮；完全访问用琥珀警示色。底部提示 ⇧Tab 快速循环。
 * 目标模式开启时只保留 手动确认/完全访问（其自身流程取代 auto_edit/plan）。
 */
export default function ModeMenu({ value, targetMode, onChange }: ModeMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const t = useI18n()

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const items = targetMode ? MODE_ITEMS.filter((i) => i.mode === 'confirm_before_change' || i.mode === 'full_access') : MODE_ITEMS
  const current = items.find((i) => i.mode === value)
  const label = current ? t(current.labelKey) : t('chat.projectEditModeLabel')

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={t('chat.projectEditModeLabel')}
        className={`text-xs rounded-md px-2 py-1 border outline-none cursor-pointer transition-colors flex items-center gap-1 ${
          value === 'full_access'
            ? 'border-orange-500/50 bg-orange-500/10 text-orange-400'
            : 'border-nova-border bg-nova-input-bg text-nova-text-primary hover:border-nova-accent focus:border-nova-accent'
        }`}
      >
        {current && <MSIcon name={current.icon} className="text-[14px] leading-none" />}
        {label}
        <MSIcon name={open ? 'expand_less' : 'expand_more'} className="text-[14px] leading-none" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 w-[300px] bg-nova-surface border border-nova-border rounded-lg overflow-hidden shadow-sm">
          <div className="px-3 py-2 border-b border-nova-border">
            <span className="text-[12px] font-semibold text-nova-text-primary">{t('chat.projectEditModeLabel')}</span>
            <span className="ml-1.5 text-[10px] text-nova-text-muted">{t('chat.modeMenuSubtitle')}</span>
          </div>
          <div className="py-1">
            {items.map((item) => {
              const active = item.mode === value
              return (
                <button
                  key={item.mode}
                  onClick={() => { setOpen(false); onChange(item.mode) }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                    active ? 'bg-nova-accent/5' : 'hover:bg-nova-hover'
                  }`}
                >
                  <MSIcon
                    name={item.icon}
                    className={`text-[16px] leading-none shrink-0 ${active ? 'text-nova-accent' : item.warning ? 'text-orange-400' : 'text-nova-text-muted'}`}
                  />
                  <span className="flex-1 min-w-0">
                    <span className={`block text-[12px] font-semibold ${item.warning && !active ? 'text-orange-400' : 'text-nova-text-primary'}`}>
                      {t(item.labelKey)}
                    </span>
                    <span className="block text-[10px] text-nova-text-muted truncate">{t(item.hintKey)}</span>
                  </span>
                  {active && <MSIcon name="check" className="text-[15px] leading-none text-nova-accent shrink-0" />}
                </button>
              )
            })}
          </div>
          <div className="px-3 py-1.5 border-t border-nova-border flex items-center gap-1.5 text-[10px] text-nova-text-muted">
            <MSIcon name="refresh" className="text-[11px] leading-none" />
            {t('chat.modeSwitchHint')}
          </div>
        </div>
      )}
    </div>
  )
}
