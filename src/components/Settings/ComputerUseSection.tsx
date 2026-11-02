import { useCallback, useEffect, useState } from 'react'

import { useEditorStore } from '@/stores/editorStore'
import type { CuaStatus } from '@shared/computer'
import { SettingRow, SettingsButton, SettingsInput, SettingsSection, SettingsSwitch } from './settings-ui'

function toList(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 设置 → 功能 → 电脑操控。
 *
 * 总开关默认关：关闭时不启动 helper、不把 `computer_*` 暴露给模型，主进程也会
 * 拒绝任何调用（纵深防御）。面板同时给出运行时状态（交互式会话 / DPI / 截图能力）
 * 和分级错误原因，避免"开了却不能用"的黑盒。
 */
export default function ComputerUseSection() {
  const preferences = useEditorStore((s) => s.preferences)
  const savePreferences = useEditorStore((s) => s.savePreferences)
  const [status, setStatus] = useState<CuaStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [audit, setAudit] = useState<Array<{ ts: number; kind: string; app?: string; target?: string; ok: boolean; code?: string; effect?: string }>>([])

  const refresh = useCallback(async () => {
    try {
      const res = await window.electronAPI.computerStatus()
      if (res.ok && res.status) {
        setStatus(res.status)
        setError(null)
      } else {
        setError(res.error?.message ?? '无法读取运行时状态')
      }
      const log = await window.electronAPI.computerAudit(12)
      setAudit(Array.isArray(log.records) ? log.records : [])
    } catch (err: any) {
      setError(String(err?.message ?? err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, preferences.computerUseEnabled])

  const runSelfTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.electronAPI.computerAction({
        owner: 'settings-test',
        app: {},
        kind: 'launch',
        target: 'notepad',
      })
      setTestResult(
        res.ok
          ? '已发出启动请求。记事本窗口出现即表示观察/动作链路可用。'
          : `失败：${res.error?.code ?? 'ERROR'} — ${res.error?.message ?? ''}`,
      )
      await refresh()
    } catch (err: any) {
      setTestResult(`失败：${String(err?.message ?? err)}`)
    } finally {
      setTesting(false)
    }
  }

  const enabled = preferences.computerUseEnabled === true
  const statusLine = status
    ? status.available
      ? `运行时就绪（${status.backend}${status.protocol ? ` / ${status.protocol}` : ''}）`
      : `运行时未就绪：${status.lastError ?? '尚未启动'}`
    : error ?? '状态未知'

  return (
    <SettingsSection
      id="settings-feature-computer"
      title="电脑操控"
      description="让 AI 观察并操作桌面应用（UI Automation 语义动作优先，坐标点击需要截图凭证）。默认关闭；敏感应用（密码管理器、网银、UAC）一律拒绝。"
    >
      <SettingRow
        label="启用电脑操控"
        desc="关闭时不启动运行时，模型也看不到 computer_* 工具"
        right={<SettingsSwitch label="启用电脑操控" checked={enabled} onChange={(v) => savePreferences({ computerUseEnabled: v })} />}
      />

      <SettingRow
        label="运行时状态"
        desc={statusLine}
        right={
          <div className="flex items-center gap-2">
            <SettingsButton onClick={() => void refresh()}>刷新</SettingsButton>
            <SettingsButton onClick={() => void runSelfTest()} disabled={!enabled || testing}>
              {testing ? '测试中…' : '测试：打开记事本'}
            </SettingsButton>
          </div>
        }
      />

      {status?.permission ? (
        <SettingRow
          label="系统权限"
          right={null}
          desc={`交互式桌面：${status.permission.interactiveSession ? '是' : '否'} · DPI 感知：${status.permission.dpiAware ? 'v2' : '否'} · 截图：${status.permission.screenCapture ? '可用' : '不可用'} · 辅助功能：${status.permission.accessibility} · 屏幕录制：${status.permission.screenRecording}`}
        />
      ) : null}

      {testResult ? <SettingRow label="测试结果" desc={testResult} right={null} /> : null}

      <SettingRow
        label="只允许白名单应用"
        desc="开启后，只有下方列表里的应用可以被观察和操作（公司/演示环境）"
        right={
          <SettingsSwitch
            label="只允许白名单应用"
            checked={preferences.computerUseAllowlistMode === true}
            onChange={(v) => savePreferences({ computerUseAllowlistMode: v })}
          />
        }
      />
      <SettingRow
        label="允许列表"
        desc="逗号或换行分隔，按窗口标题/进程名子串匹配"
        stacked
        right={
          <SettingsInput
            label="允许列表"
            value={(preferences.computerUseAppAllowlist ?? []).join(', ')}
            onChange={(e) => savePreferences({ computerUseAppAllowlist: toList(e.target.value) })}
            placeholder="excel, notepad, 记事本"
            className="w-full"
          />
        }
      />
      <SettingRow
        label="额外禁止列表"
        desc="逗号或换行分隔；内置黑名单（密码管理器/网银/UAC/远程桌面）始终生效"
        stacked
        right={
          <SettingsInput
            label="额外禁止列表"
            value={(preferences.computerUseAppDenylist ?? []).join(', ')}
            onChange={(e) => savePreferences({ computerUseAppDenylist: toList(e.target.value) })}
            placeholder="企业微信, 微信"
            className="w-full"
          />
        }
      />
      <SettingRow
        label="允许子智能体使用"
        desc="默认禁止：子智能体无人监督，桌面输入风险更高"
        right={
          <SettingsSwitch
            label="允许子智能体使用"
            checked={preferences.computerUseInSubagent === true}
            onChange={(v) => savePreferences({ computerUseInSubagent: v })}
          />
        }
      />
      <SettingRow
        label="最近动作"
        desc={audit.length ? '审计记录（只记录动作目标与结果；输入内容仅长度与前两个字符）' : '还没有动作记录'}
        stacked
        right={
          <div className="w-full space-y-1 font-mono text-[12px] leading-[18px] text-nova-text-secondary">
            {audit.length === 0 ? (
              <div className="text-nova-text-secondary">—</div>
            ) : (
              audit
                .slice()
                .reverse()
                .map((record, index) => (
                  <div key={`${record.ts}-${index}`} className="truncate">
                    {new Date(record.ts).toLocaleTimeString()} · {record.kind} · {record.app ?? '—'}
                    {record.target ? ` · ${record.target}` : ''} · {record.ok ? 'ok' : `error(${record.code ?? '?'})`}
                    {record.effect ? ` · ${record.effect}` : ''}
                  </div>
                ))
            )}
          </div>
        }
      />
    </SettingsSection>
  )
}
