import { useI18n } from '@/i18n/useI18n'
import { CLAW_CHANNELS } from '@shared/claw'
import { useClawStore } from '@/stores/clawStore'
import { dropReasonText } from '@/services/claw/dropReasons'
import ClawChannelCard from './ClawChannelCard'

/**
 * Claw 接入面板（左侧活动栏）。
 *
 * 结构（Stitch 设计稿）：面板头（状态汇总）→ 概览指标 → CHANNELS（每渠道一张
 * 卡片：状态、开关、登录/配置入口）→ ACCESS CONTROL（接入控制摘要）→ 底部
 * 网关状态行。完整的凭据编辑与策略编辑在设置页（ClawSettingsSection），
 * 这里只放「看一眼就知道能不能用」的信息与最常用的开关。
 */
export default function ClawPanel() {
  const t = useI18n()
  const hub = useClawStore((s) => s.hub)
  const configs = useClawStore((s) => s.configs)
  const drops = useClawStore((s) => s.drops)
  const clearDrops = useClawStore((s) => s.clearDrops)
  const setChannelEnabled = useClawStore((s) => s.setChannelEnabled)

  const enabledCount = hub?.channels.filter((c) => c.enabled).length ?? 0
  const connectedCount = hub?.channels.filter((c) => c.state === 'connected').length ?? 0
  const pendingLogins = hub?.channels.filter((c) => c.state === 'loggingIn').length ?? 0

  return (
    <div className="h-full flex flex-col">
      {/* 面板头 */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('claw.title')}
          </h2>
          <span
            className="px-2 py-0.5 text-[11px] font-semibold rounded-full"
            style={{ background: 'var(--bg-selected)', color: 'var(--accent-text)' }}
          >
            {t('claw.hubSummary', { enabled: enabledCount, total: CLAW_CHANNELS.length })}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {t('claw.subtitle')}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {/* 概览指标 */}
        <div
          className="rounded-xl px-3 py-2.5 mb-3"
          style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-end justify-between">
            <Metric label={t('claw.metricConnected')} value={String(connectedCount)} />
            <Metric label={t('claw.metricEnabled')} value={String(enabledCount)} />
            <Metric label={t('claw.metricPending')} value={String(pendingLogins)} />
          </div>
        </div>

        {/* 渠道列表 */}
        <SectionLabel>{t('claw.sectionChannels')}</SectionLabel>
        <div className="flex flex-col gap-2 mb-4">
          {CLAW_CHANNELS.map((meta) => (
            <ClawChannelCard
              key={meta.id}
              meta={meta}
              status={hub?.channels.find((c) => c.id === meta.id)}
              config={configs.find((c) => c.id === meta.id)}
              onToggle={(enabled) => void setChannelEnabled(meta.id, enabled)}
            />
          ))}
        </div>

        {/* 接入控制摘要 */}
        <SectionLabel>{t('claw.sectionAccessControl')}</SectionLabel>
        <div
          className="rounded-xl px-3 py-2 mb-3 text-[12px] leading-5"
          style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        >
          {(() => {
            const enabled = configs.filter((c) => c.enabled)
            if (enabled.length === 0) return t('claw.policyNoChannel')
            const allow = enabled.reduce((n, c) => n + (c.policy?.allowlist?.length ?? 0), 0)
            const mention = enabled.filter((c) => c.policy?.groupRequireMention).length
            const quiet = enabled.filter((c) => c.policy?.quietHours?.enabled).length
            return t('claw.policySummary', { allow, mention, quiet })
          })()}
        </div>

        {/* 最近拦截 */}
        {drops.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-1">
              <SectionLabel>{t('claw.sectionDrops')}</SectionLabel>
              <button
                className="text-[11px] mb-1"
                style={{ color: 'var(--text-muted)' }}
                onClick={clearDrops}
              >
                {t('claw.clearDrops')}
              </button>
            </div>
            <div
              className="rounded-xl px-3 py-2 mb-3 flex flex-col gap-1"
              style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
            >
              {drops.slice(0, 4).map((d, i) => (
                <div key={`${d.channel}-${d.at}-${i}`} className="flex items-start gap-2 text-[11px] leading-4">
                  <span className="mt-1.5 shrink-0 rounded-full" style={{ width: 6, height: 6, background: 'var(--warning)' }} />
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {dropReasonText(d.reason, t)}
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' · '}
                      {CLAW_CHANNELS.find((c) => c.id === d.channel)?.label ?? d.channel}
                      {d.from ? ` · ${d.from}` : ''}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 底部：网关状态 + 设置入口 */}
      <div
        className="shrink-0 flex items-center justify-between px-3 py-2 text-[11px]"
        style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}
      >
        <span>{t('claw.gatewayFooter', { count: CLAW_CHANNELS.length })}</span>
        <button style={{ color: 'var(--accent-text)' }} onClick={() => useClawStore.getState().loadConfigs()}>
          {t('claw.refresh')}
        </button>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="text-[17px] font-semibold leading-6" style={{ color: 'var(--text-primary)' }}>
        {value}
      </span>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
      {children}
    </div>
  )
}
