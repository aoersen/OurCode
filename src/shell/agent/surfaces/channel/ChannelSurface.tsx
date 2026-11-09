import { useEffect, useMemo, useState } from 'react'
import { useClawStore } from '@/stores/clawStore'
import {
  EmptyHint,
  SectionLabel,
  SurfaceRow,
  TextAction,
  useListKeyboard,
} from '../surfaceParts'
import {
  CHANNEL_LOG_UNAVAILABLE,
  buildChannelRows,
  channelCounts,
} from './channelModel'

/**
 * 「渠道」面：微信 / 企业微信 / QQ / 飞书 / Telegram 的连接状态与启停。
 *
 * 全部读写 clawStore 的既有动作（refreshStatus / loadConfigs /
 * setChannelEnabled / startLogin / logout）。clawBridge 在 App 启动时已经
 * init 过 store，所以这里不重复 init，只刷新快照。
 *
 * 能力缺失的地方按灰色「未接入」呈现，而不是画一个假按钮：
 *  - 最后消息时间：store 不记录 → 未接入
 *  - 渠道日志：没有日志 IPC → 未接入
 */
export default function ChannelSurface() {
  const hub = useClawStore((s) => s.hub)
  const configs = useClawStore((s) => s.configs)
  const uiChannels = useClawStore((s) => s.channels)
  const refreshStatus = useClawStore((s) => s.refreshStatus)
  const loadConfigs = useClawStore((s) => s.loadConfigs)
  const setChannelEnabled = useClawStore((s) => s.setChannelEnabled)
  const startLogin = useClawStore((s) => s.startLogin)

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const listKeyboard = useListKeyboard()

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        await Promise.all([refreshStatus(), loadConfigs()])
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [refreshStatus, loadConfigs])

  const rows = useMemo(
    () => buildChannelRows({ configs, statuses: hub?.channels ?? [], ui: uiChannels }),
    [configs, hub, uiChannels],
  )
  const counts = useMemo(() => channelCounts(rows), [rows])

  const toggle = async (id: (typeof rows)[number]['id'], enabled: boolean) => {
    if (busy) return
    setBusy(id)
    setError(null)
    try {
      await setChannelEnabled(id, !enabled)
      // 扫码登录类渠道：启动后顺带拉起登录，否则停在「未运行」
      if (!enabled) {
        const ui = useClawStore.getState().channels[id]
        const row = rows.find((entry) => entry.id === id)
        if (row?.loginMode === 'qr' && ui?.state !== 'connected' && ui?.state !== 'loggingIn') {
          await startLogin(id)
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async () => {
    setError(null)
    try {
      await Promise.all([refreshStatus(), loadConfigs()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto pure-scroll px-5 pb-6">
      <div className="flex items-center gap-3 pt-1">
        <span className="text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
          {counts.total} 个渠道 · {counts.enabled} 已启用 · {counts.connected} 已连接
        </span>
        <span className="ml-auto inline-flex">
          <TextAction onClick={() => void refresh()} title="刷新渠道状态">
            刷新
          </TextAction>
        </span>
      </div>

      {error && (
        <div className="pt-2 text-[12px] leading-[18px] text-[var(--pure-danger)]" role="alert">
          {error}
        </div>
      )}

      <div onKeyDown={listKeyboard}>
        {rows.length === 0 ? (
          <EmptyHint>没有可接入的渠道。</EmptyHint>
        ) : (
          <>
            <SectionLabel>渠道</SectionLabel>
            {rows.map((row) => {
              const ui = uiChannels[row.id]
              const dot =
                !row.enabled
                  ? 'bg-[var(--pure-border)]'
                  : !row.configured
                    ? 'bg-[var(--pure-warn)]'
                    : row.state === 'connected'
                      ? 'bg-[var(--pure-ink)]'
                      : row.state === 'disconnected'
                        ? 'bg-[var(--pure-danger)]'
                        : 'bg-[var(--pure-muted)]'
              const meta = [
                `最近消息 ${row.lastMessage}`,
                `日志 ${CHANNEL_LOG_UNAVAILABLE}`,
                row.accountId ? `账号 ${row.accountId}` : null,
                !row.configured ? '凭据未填全' : null,
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <SurfaceRow key={row.id} label={`${row.label} ${row.stateWord}`} className="pure-row">
                  <div className="flex items-baseline gap-2.5">
                    <span className="flex-1 min-w-0 text-[13px] leading-[20px] text-[var(--pure-ink)] truncate">
                      {row.label}
                    </span>
                    <span className="shrink-0 inline-flex items-center gap-1.5 whitespace-nowrap text-[10.5px] leading-[18px] text-[var(--pure-secondary)]">
                      <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                      {row.stateWord}
                    </span>
                    <TextAction
                      onClick={() => void toggle(row.id, row.enabled)}
                      disabled={busy === row.id}
                      title={`${row.action}${row.label}`}
                    >
                      {busy === row.id ? '处理中…' : row.action}
                    </TextAction>
                  </div>

                  <div
                    className="truncate text-[10.5px] leading-[18px] text-[var(--pure-muted)]"
                    title={meta}
                  >
                    {meta}
                  </div>

                  {ui?.qrUrl && (
                    <div className="pt-0.5 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
                      扫码登录：
                      <a
                        href={ui.qrUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--pure-ink)] underline underline-offset-2"
                      >
                        打开登录链接
                      </a>
                    </div>
                  )}

                  {row.error && (
                    <div className="pt-0.5 text-[11.5px] leading-[18px] text-[var(--pure-danger)]" title={row.error}>
                      {row.error}
                    </div>
                  )}
                </SurfaceRow>
              )
            })}
          </>
        )}
      </div>

      <div className="pt-3 text-[11px] leading-[16px] text-[var(--pure-muted)]">
        渠道凭据与接入控制在设置 · 渠道里编辑；这里只做状态查看与启停。
      </div>
    </div>
  )
}
