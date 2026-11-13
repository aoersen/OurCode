import { useState } from 'react'

import { useEditorStore } from '@/stores/editorStore'
import { useI18n } from '@/i18n/useI18n'
import { useBrowserSession } from '@/hooks/useBrowserSession'
import { SettingRow, SettingsButton, SettingsSection, SettingsSwitch } from './settings-ui'

/**
 * 设置 → 功能 → 内置浏览器。
 *
 * Agent 的 browser_* 工具跑在一个隐藏 BrowserWindow 里。这里给用户两个入口：
 * “自动化时自动显示”总开关（默认开，showInactive 不抢焦点），以及手动显示/
 * 隐藏当前窗口。窗口是独立的原生窗口，不占用 IDE 的编辑区。
 */
export default function BrowserSection() {
  const t = useI18n()
  const preferences = useEditorStore((s) => s.preferences)
  const savePreferences = useEditorStore((s) => s.savePreferences)
  const { state, setVisible } = useBrowserSession()
  const [busy, setBusy] = useState(false)

  const autoShow = preferences.browserAutoShow !== false
  const hasPage = Boolean(state.url)
  const title = state.title || state.url || t('browser.idle')

  const toggleVisible = async (): Promise<void> => {
    setBusy(true)
    try {
      await setVisible(!state.visible)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      id="settings-feature-browser"
      title={t('browser.title')}
      description={t('browser.settingsDesc')}
    >
      <SettingRow
        label={t('browser.autoShow')}
        desc={t('browser.autoShowSettingDesc')}
        right={
          <SettingsSwitch
            label={t('browser.autoShow')}
            checked={autoShow}
            onChange={(v) => { void savePreferences({ browserAutoShow: v }) }}
          />
        }
      />

      <SettingRow
        label={t('browser.currentWindow')}
        desc={hasPage ? `${title}${state.loading ? ` · ${t('browser.loading')}` : ''}` : t('browser.idleHint')}
        right={
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-nova-text-secondary">
              {state.visible ? t('browser.visible') : t('browser.hidden')}
            </span>
            <SettingsButton onClick={() => void toggleVisible()} disabled={busy || (!hasPage && !state.visible)}>
              {state.visible ? t('browser.hide') : t('browser.show')}
            </SettingsButton>
          </div>
        }
      />
    </SettingsSection>
  )
}
