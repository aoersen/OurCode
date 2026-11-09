import { useEffect, useState } from 'react'

import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { useUpdateStore } from '@/stores/updateStore'
import { errorText } from '../../errorText'
import { updateStateLabel } from '../../featuresModel'
import { GroupLabel, Row, StatusLine, Switch, TextAction, TextInput } from '../../settingsParts'

/**
 * 功能 › 软件更新：自动检查/自动下载、自定义更新源、立即检查。
 *
 * 写入沿用旧面板：偏好存 updateFeedUrl，同时把地址推给主进程
 * （`setUpdateFeedUrl`），否则 electron-updater 仍用打包内置的默认源。
 */
export default function UpdateSettings() {
  const preferences = useEditorStore((state) => state.preferences)
  const savePreferences = useEditorStore((state) => state.savePreferences)
  const notify = useUIStore((state) => state.showNotification)

  const appVersion = useUpdateStore((state) => state.appVersion)
  const uiState = useUpdateStore((state) => state.uiState)
  const newVersion = useUpdateStore((state) => state.newVersion)
  const check = useUpdateStore((state) => state.check)

  const [feedUrl, setFeedUrl] = useState(preferences.updateFeedUrl ?? '')
  const [feedError, setFeedError] = useState<string | null>(null)

  useEffect(() => {
    setFeedUrl(preferences.updateFeedUrl ?? '')
  }, [preferences.updateFeedUrl])

  const feedDirty = feedUrl.trim() !== (preferences.updateFeedUrl ?? '')

  const saveFeedUrl = async () => {
    const url = feedUrl.trim()
    setFeedError(null)
    try {
      await savePreferences({ updateFeedUrl: url })
      const result = await window.electronAPI.setUpdateFeedUrl(url)
      if (!result.ok) {
        setFeedError('更新源已保存，但主进程拒绝应用（检查 URL 是否可访问）')
        return
      }
      notify('更新源已保存', 'success')
    } catch (error) {
      const message = errorText(error, '保存更新源失败')
      setFeedError(message)
      notify(message, 'error')
    }
  }

  return (
    <div>
      <GroupLabel trailing={appVersion ? `当前版本 ${appVersion}` : undefined}>软件更新</GroupLabel>
      <Row label="自动检查更新" description="启动后后台静默检查，只有发现新版本才提示">
        <Switch
          label="自动检查更新"
          checked={preferences.autoUpdateCheck !== false}
          onChange={(next) => void savePreferences({ autoUpdateCheck: next })}
        />
      </Row>
      <Row label="自动下载更新" description="发现新版本后后台静默下载，重启时安装">
        <Switch
          label="自动下载更新"
          checked={preferences.autoUpdateDownload === true}
          onChange={(next) => void savePreferences({ autoUpdateDownload: next })}
        />
      </Row>
      <Row
        label="更新服务器"
        description="留空使用默认源（GitHub Releases）；自建源目录下需放 latest.yml 与安装包"
        stacked
      >
        <div className="flex items-center gap-2">
          <TextInput
            label="更新服务器地址"
            mono
            value={feedUrl}
            onChange={(event) => setFeedUrl(event.target.value)}
            placeholder="https://example.com/updates"
            className="flex-1"
          />
          <TextAction onClick={() => void saveFeedUrl()} disabled={!feedDirty} label="保存更新服务器地址">
            保存
          </TextAction>
        </div>
        {feedError ? (
          <div className="pt-1">
            <StatusLine tone="error">{feedError}</StatusLine>
          </div>
        ) : null}
      </Row>
      <Row label="立即检查" description={updateStateLabel(uiState, newVersion)}>
        <TextAction onClick={() => void check()} disabled={uiState === 'checking'} label="立即检查更新">
          {uiState === 'checking' ? '检查中…' : '检查更新'}
        </TextAction>
      </Row>
    </div>
  )
}
