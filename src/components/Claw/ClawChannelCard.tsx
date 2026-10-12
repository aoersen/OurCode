import { useI18n } from '@/i18n/useI18n'
import type { ClawChannelConfig, ClawChannelStatus } from '@/types'
import type { ClawChannelMeta } from '@shared/claw'
import { useClawStore } from '@/stores/clawStore'
import ClawChannelIcon from './ClawChannelIcon'

/**
 * 面板里的单渠道卡片：一眼看清「连上没连上 / 开没开」。
 *
 * 交互分层：卡片上的开关直接启停渠道（最常用的动作）；凭据、回调地址与接入控制
 * 在设置页里编辑——面板保持短小，设置页承担完整配置。
 */
export default function ClawChannelCard({
  meta,
  status,
  config,
  onToggle,
}: {
  meta: ClawChannelMeta
  status?: ClawChannelStatus
  config?: ClawChannelConfig
  onToggle: (enabled: boolean) => void
}) {
  const t = useI18n()
  const openSettings = useClawStore((s) => s.startLogin)
  const uiState = useClawStore((s) => s.channels[meta.id])
  const enabled = config?.enabled ?? status?.enabled ?? false
  const state = uiState?.state ?? status?.state ?? 'stopped'
  const configured = status?.configured ?? true

  const badge = statusBadge(t, state, enabled, configured)
  const notice = uiState?.notice

  return (
    <div
      className="rounded-xl px-2.5 py-2 flex flex-col gap-2"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-2">
        <ClawChannelIcon id={meta.id} color={meta.brandColor} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {meta.label}
            </span>
            {meta.maturity === 'beta' && (
              <span
                className="px-1.5 py-[1px] text-[9px] font-semibold rounded-full uppercase"
                style={{ background: 'var(--hover)', color: 'var(--text-muted)' }}
                title={t('claw.betaHint')}
              >
                beta
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="inline-block rounded-full" style={{ width: 6, height: 6, background: badge.color }} />
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {badge.label}
            </span>
          </div>
        </div>
        <Toggle on={enabled} onClick={() => onToggle(!enabled)} label={t('claw.toggleChannel', { name: meta.label })} />
      </div>

      {enabled && !configured && (
        <span className="text-[11px] leading-4" style={{ color: 'var(--warning)' }}>
          {t('claw.channelNeedConfig')}
        </span>
      )}

      {enabled && configured && meta.loginMode === 'qr' && state !== 'connected' && (
        <button
          className="self-start px-2.5 py-1 text-[11px] rounded-md"
          style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
          onClick={() => void openSettings(meta.id)}
        >
          {state === 'loggingIn' ? t('claw.loggingIn') : t('claw.startLogin')}
        </button>
      )}

      {notice && (
        <span className="text-[11px] leading-4" style={{ color: 'var(--error)' }}>
          {notice}
        </span>
      )}
    </div>
  )
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      className="w-9 h-[20px] rounded-full relative shrink-0 border-none cursor-pointer transition-colors"
      style={{ background: on ? 'var(--accent)' : 'var(--border-strong)' }}
    >
      <span
        className="block w-[16px] h-[16px] rounded-full bg-white absolute top-[2px] transition-all"
        style={{ left: on ? '19px' : '2px' }}
      />
    </button>
  )
}

/** 状态徽章：颜色只表示「可用/需动作/停用」三态，不追求区分所有内部状态。 */
function statusBadge(
  t: ReturnType<typeof useI18n>,
  state: ClawChannelStatus['state'],
  enabled: boolean,
  configured: boolean,
): { label: string; color: string } {
  if (!enabled) return { label: t('claw.stateDisabled'), color: 'var(--text-muted)' }
  if (!configured) return { label: t('claw.stateUnconfigured'), color: 'var(--text-muted)' }
  switch (state) {
    case 'connected':
      return { label: t('claw.stateConnected'), color: 'var(--success)' }
    case 'loggingIn':
      return { label: t('claw.stateLoggingIn'), color: 'var(--warning)' }
    case 'disconnected':
      return { label: t('claw.stateDisconnected'), color: 'var(--warning)' }
    case 'idle':
      return { label: t('claw.stateIdle'), color: 'var(--warning)' }
    default:
      return { label: t('claw.stateStopped'), color: 'var(--text-muted)' }
  }
}
