import { useEffect, useState } from 'react'

import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUpdateStore } from '@/stores/updateStore'
import { errorText } from '../errorText'
import { reduceResetPhase, type ResetPhase } from '../featuresModel'
import { GroupLabel, InlineConfirm, Row, SectionHeading, StatusLine, TextAction } from '../settingsParts'

const PLATFORM_WORDS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}

const LICENSE_NAME = 'PolyForm Noncommercial 1.0.0'
const LICENSE_URL = 'https://polyformproject.org/licenses/noncommercial/1.0.0'

/**
 * 「关于」：版本、平台、许可协议、危险重置（双重确认）。
 *
 * 重置的行为与旧面板一致：主进程 resetAll() → 清 configStore / chatStore →
 * 清 localStorage → reload。这里把两次 window.confirm 换成了行内两次确认，
 * 状态机由 featuresModel.reduceResetPhase 提供（可单测）。
 */
export default function AboutSection() {
  const appVersion = useUpdateStore((state) => state.appVersion)
  const [version, setVersion] = useState(appVersion)
  const [phase, setPhase] = useState<ResetPhase>('idle')
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  useEffect(() => {
    setVersion(appVersion)
  }, [appVersion])

  useEffect(() => {
    if (version) return
    void window.electronAPI
      ?.getVersion?.()
      .then((value: string) => {
        if (value) setVersion(value)
      })
      .catch(() => {
        /* 版本号拿不到就不显示，不影响其它行 */
      })
  }, [version])

  const platform = window.electronAPI?.platform ?? ''
  const platformLabel = platform ? (PLATFORM_WORDS[platform] ?? platform) : '—'

  const runReset = async () => {
    setResetting(true)
    setResetError(null)
    try {
      await window.electronAPI.resetAll()
      useConfigStore.getState().resetStore()
      useChatStore.getState().resetStore()
      localStorage.clear()
      window.location.reload()
    } catch (error) {
      setResetError(errorText(error, '重置失败'))
      setResetting(false)
      setPhase('idle')
    }
  }

  const confirmSecond = () => {
    const next = reduceResetPhase(phase, 'confirmSecond')
    setPhase(next)
    if (next === 'idle' && phase === 'second') void runReset()
  }

  return (
    <div>
      <SectionHeading title="关于" hint="版本、许可协议与危险重置。" />

      <GroupLabel>应用</GroupLabel>
      <Row label="版本" description={version || '正在读取…'}>
        <TextAction onClick={() => window.location.reload()} label="重新加载界面">
          重新加载
        </TextAction>
      </Row>
      <Row label="运行平台" description={platformLabel} />
      <Row label="许可协议" description={`${LICENSE_NAME}（仅限非商业使用）`}>
        <a
          href={LICENSE_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="pure-focus text-[12px] leading-[18px] text-[var(--pure-muted)] underline underline-offset-2 hover:text-[var(--pure-ink)]"
        >
          查看协议
        </a>
      </Row>
      <Row label="键盘" description="Esc 关闭设置；⌘/Ctrl+Enter 保存有改动的表单" />

      <GroupLabel>危险重置</GroupLabel>
      <Row
        label="重置所有设置"
        description="清空 API 配置、聊天记录与本地偏好，此操作不可撤销"
        stacked
      >
        {phase === 'idle' ? (
          <TextAction
            onClick={() => setPhase(reduceResetPhase(phase, 'request'))}
            danger
            disabled={resetting}
            label="重置所有设置"
            title="重置所有设置"
          >
            全部清空…
          </TextAction>
        ) : null}
        {phase === 'first' ? (
          <InlineConfirm
            message="确定要重置所有设置吗？此操作不可撤销。"
            detail="API 配置、聊天记录和偏好设置都会被清空。"
            confirmLabel="继续"
            danger
            onConfirm={() => setPhase(reduceResetPhase(phase, 'confirmFirst'))}
            onCancel={() => setPhase(reduceResetPhase(phase, 'cancel'))}
          />
        ) : null}
        {phase === 'second' ? (
          <InlineConfirm
            message="再次确认：所有数据将被清空。"
            detail="包括 API 配置、聊天记录和偏好设置；完成后应用会重新加载。"
            confirmLabel={resetting ? '重置中…' : '清空并重启'}
            danger
            onConfirm={confirmSecond}
            onCancel={() => setPhase(reduceResetPhase(phase, 'cancel'))}
          />
        ) : null}
        {resetError ? (
          <div className="pt-1">
            <StatusLine tone="error">{resetError}</StatusLine>
          </div>
        ) : null}
      </Row>
    </div>
  )
}
