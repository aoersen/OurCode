import { useCallback, useEffect, useState } from 'react'

import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import type { CuaStatus } from '@shared/computer'
import type { UserPreferences } from '@/types'
import { errorText } from '../../errorText'
import { formatAppList, parseAppList } from '../../featuresModel'
import { GroupLabel, Row, StatusLine, Switch, TextAction, TextInput } from '../../settingsParts'

/**
 * 功能 › 电脑操控（CUA）。
 *
 * 总开关默认关；关闭时不启动 helper、模型也看不到 computer_* 工具（主进程同样
 * 拒绝调用）。面板给出运行时状态，避免「开了却不能用」的黑盒。名单输入用了
 * 本地草稿 + 失焦保存：逐键写偏好会与异步落盘抢顺序。
 */
export default function ComputerUseSettings() {
  const preferences = useEditorStore((state) => state.preferences)
  const savePreferences = useEditorStore((state) => state.savePreferences)
  const notify = useUIStore((state) => state.showNotification)

  const [status, setStatus] = useState<CuaStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [allowDraft, setAllowDraft] = useState(() => formatAppList(preferences.computerUseAppAllowlist))
  const [denyDraft, setDenyDraft] = useState(() => formatAppList(preferences.computerUseAppDenylist))

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.computerStatus()
      if (result.ok && result.status) {
        setStatus(result.status)
        setStatusError(null)
      } else {
        setStatus(null)
        setStatusError(result.error?.message ?? '无法读取运行时状态')
      }
    } catch (error) {
      setStatus(null)
      setStatusError(errorText(error, '无法读取运行时状态'))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, preferences.computerUseEnabled])

  useEffect(() => {
    setAllowDraft(formatAppList(preferences.computerUseAppAllowlist))
    setDenyDraft(formatAppList(preferences.computerUseAppDenylist))
  }, [preferences.computerUseAppAllowlist, preferences.computerUseAppDenylist])

  const enabled = preferences.computerUseEnabled === true

  const save = async (patch: Partial<UserPreferences>) => {
    try {
      await savePreferences(patch)
    } catch (error) {
      notify(errorText(error, '保存电脑操控设置失败'), 'error')
    }
  }

  const statusLine = status
    ? status.available
      ? `运行时就绪（${status.backend}${status.protocol ? ` / ${status.protocol}` : ''}）`
      : `运行时未就绪：${status.lastError ?? '尚未启动'}`
    : statusError ?? '状态未知'

  return (
    <div>
      <GroupLabel>电脑操控</GroupLabel>
      <Row label="启用电脑操控" description="关闭时不启动运行时，模型也看不到 computer_* 工具">
        <Switch
          label="启用电脑操控"
          checked={enabled}
          onChange={(next) => void save({ computerUseEnabled: next })}
        />
      </Row>
      <Row label="运行时状态" description={statusLine}>
        <TextAction onClick={() => void refresh()} label="刷新电脑操控运行时状态">
          刷新
        </TextAction>
      </Row>
      {status?.permission ? (
        <Row
          label="系统权限"
          description={`交互式桌面：${status.permission.interactiveSession ? '是' : '否'} · DPI 感知：${status.permission.dpiAware ? 'v2' : '否'} · 截图：${status.permission.screenCapture ? '可用' : '不可用'} · 辅助功能：${status.permission.accessibility} · 屏幕录制：${status.permission.screenRecording}`}
        />
      ) : null}
      <Row label="只允许白名单应用" description="开启后只有下方名单里的应用能被观察和操作">
        <Switch
          label="只允许白名单应用"
          checked={preferences.computerUseAllowlistMode === true}
          onChange={(next) => void save({ computerUseAllowlistMode: next })}
        />
      </Row>
      <Row label="允许列表" description="逗号或换行分隔，按窗口标题 / 进程名子串匹配" stacked>
        <TextInput
          label="电脑操控允许列表"
          value={allowDraft}
          onChange={(event) => setAllowDraft(event.target.value)}
          onBlur={() => void save({ computerUseAppAllowlist: parseAppList(allowDraft) })}
          placeholder="excel, notepad, 记事本"
        />
      </Row>
      <Row
        label="额外禁止列表"
        description="逗号或换行分隔；内置黑名单（密码管理器 / 网银 / UAC / 远程桌面）始终生效"
        stacked
      >
        <TextInput
          label="电脑操控额外禁止列表"
          value={denyDraft}
          onChange={(event) => setDenyDraft(event.target.value)}
          onBlur={() => void save({ computerUseAppDenylist: parseAppList(denyDraft) })}
          placeholder="企业微信, 微信"
        />
      </Row>
      <Row label="允许子智能体使用" description="默认禁止：子智能体无人监督，桌面输入风险更高">
        <Switch
          label="允许子智能体使用电脑操控"
          checked={preferences.computerUseInSubagent === true}
          onChange={(next) => void save({ computerUseInSubagent: next })}
        />
      </Row>
      {statusError ? (
        <div className="pt-1">
          <StatusLine tone="error">{statusError}</StatusLine>
        </div>
      ) : null}
    </div>
  )
}
