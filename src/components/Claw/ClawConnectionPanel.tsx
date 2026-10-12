import { useState } from 'react'

import { useI18n } from '@/i18n/useI18n'
import type { ClawChannelConfig, ClawChannelStatus } from '@/types'
import type { ClawChannelMeta } from '@shared/claw'
import { useClawStore } from '@/stores/clawStore'

const smallBtn =
  'px-2.5 py-1.5 text-xs rounded-md transition-colors disabled:opacity-50 shrink-0'
const smallBtnStyle = { background: 'var(--hover)', color: 'var(--text-secondary)' }
const accentBtn = 'px-3 py-1.5 text-xs rounded-md transition-colors disabled:opacity-50 shrink-0'

/**
 * 渠道连接区：二维码渠道（微信）走扫码登录；凭据渠道展示回调地址、连接动作与
 * 最后一条错误。二维码内容是一条链接（官方协议返回的是链接而不是图片），
 * 因此这里给「打开/复制」而不是画一个假二维码。
 */
export default function ClawConnectionPanel({
  meta,
  status,
  config,
}: {
  meta: ClawChannelMeta
  status?: ClawChannelStatus
  config?: ClawChannelConfig
}) {
  const t = useI18n()
  const ui = useClawStore((s) => s.channels[meta.id])
  const startLogin = useClawStore((s) => s.startLogin)
  const submitVerifyCode = useClawStore((s) => s.submitVerifyCode)
  const logout = useClawStore((s) => s.logout)
  const [verifyCode, setVerifyCode] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const enabled = config?.enabled ?? false
  const configured = status?.configured ?? true
  const state = ui?.state ?? status?.state ?? 'stopped'

  const copy = (value: string, tag: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(tag)
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500)
    })
  }

  return (
    <div className="flex flex-col gap-2">
      {meta.loginMode === 'qr' && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {status?.accountId ? t('claw.loggedInAs', { account: status.accountId }) : t('claw.qrHint')}
            </span>
            <div className="flex items-center gap-2">
              {state === 'connected' ? (
                <button
                  className={accentBtn}
                  style={smallBtnStyle}
                  onClick={() => void logout(meta.id)}
                >
                  {t('claw.logout')}
                </button>
              ) : (
                <button
                  className={accentBtn}
                  style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
                  disabled={state === 'loggingIn' || !enabled}
                  onClick={() => void startLogin(meta.id)}
                >
                  {state === 'loggingIn' ? t('claw.loggingIn') : t('claw.startLogin')}
                </button>
              )}
            </div>
          </div>

          {ui?.qrUrl && (
            <div
              className="rounded-lg px-3 py-2.5 flex flex-col gap-2"
              style={{ background: 'var(--hover)' }}
            >
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {ui.scanned ? t('claw.scanned') : t('claw.scanPrompt')}
              </span>
              {ui.needVerifyCode ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                    placeholder={t('claw.verifyCodePlaceholder')}
                    className="px-2.5 py-1.5 rounded-md text-xs outline-none font-mono w-[200px]"
                    style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  />
                  <button
                    className={accentBtn}
                    style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
                    onClick={() => {
                      void submitVerifyCode(meta.id, verifyCode)
                      setVerifyCode('')
                    }}
                  >
                    {t('claw.submit')}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 min-w-0">
                  <a
                    href={ui.qrUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs underline truncate flex-1"
                    style={{ color: 'var(--accent)' }}
                  >
                    {ui.qrUrl}
                  </a>
                  <button className={smallBtn} style={smallBtnStyle} onClick={() => copy(ui.qrUrl ?? '', 'qr')}>
                    {copied === 'qr' ? t('claw.copied') : t('claw.copy')}
                  </button>
                </div>
              )}
              {ui.verifyBlocked && (
                <span className="text-[11px]" style={{ color: 'var(--warning)' }}>
                  {t('claw.verifyBlocked')}
                </span>
              )}
            </div>
          )}
        </>
      )}

      {!configured && (
        <span className="text-[11px]" style={{ color: 'var(--warning)' }}>
          {t('claw.channelNeedConfig')}
        </span>
      )}

      {ui?.lastError && enabled && (
        <span className="text-[11px] leading-4" style={{ color: 'var(--error)' }}>
          {ui.lastError}
        </span>
      )}
    </div>
  )
}
