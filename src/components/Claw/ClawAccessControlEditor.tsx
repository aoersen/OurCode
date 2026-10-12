import { useI18n } from '@/i18n/useI18n'
import {
  MAX_MINUTE_LIMIT,
  MIN_MINUTE_LIMIT,
  type ClawAccessPolicy,
} from '@shared/claw'

const inputCls = 'px-2.5 py-1.5 rounded-md text-xs outline-none transition-colors'
const inputStyle = { background: 'var(--hover)', border: '1px solid var(--border)', color: 'var(--text-primary)' }

/**
 * 接入控制编辑器（每个渠道一份策略）。
 *
 * 这些开关的判定点在**主进程**（ClawManager.screenInbound），在消息到达 agent
 * 之前生效——所以被拦截的消息根本不会进入对话，面板上的「最近拦截」是唯一
 * 线索。这里只编辑策略本身，不做判定。
 */
export default function ClawAccessControlEditor({
  policy,
  onChange,
}: {
  policy: ClawAccessPolicy
  onChange: (next: ClawAccessPolicy) => void
}) {
  const t = useI18n()
  const patch = (part: Partial<ClawAccessPolicy>) => onChange({ ...policy, ...part })

  return (
    <div className="flex flex-col gap-2">
      <Field
        label={t('claw.allowlist')}
        desc={t('claw.allowlistHelp')}
        control={
          <textarea
            value={policy.allowlist.join('\n')}
            onChange={(e) =>
              patch({ allowlist: e.target.value.split(/[\n,，;；]/).map((v) => v.trim()).filter(Boolean) })
            }
            rows={3}
            placeholder={t('claw.allowlistPlaceholder')}
            className={`${inputCls} font-mono w-[280px] resize-y`}
            style={inputStyle}
          />
        }
      />

      <Field
        label={t('claw.blocklist')}
        desc={t('claw.blocklistHelp')}
        control={
          <textarea
            value={policy.blocklist.join('\n')}
            onChange={(e) =>
              patch({ blocklist: e.target.value.split(/[\n,，;；]/).map((v) => v.trim()).filter(Boolean) })
            }
            rows={2}
            placeholder={t('claw.blocklistPlaceholder')}
            className={`${inputCls} font-mono w-[280px] resize-y`}
            style={inputStyle}
          />
        }
      />

      <Field
        label={t('claw.groupMention')}
        desc={t('claw.groupMentionHelp')}
        control={<Toggle on={policy.groupRequireMention} onClick={() => patch({ groupRequireMention: !policy.groupRequireMention })} label={t('claw.groupMention')} />}
      />

      <Field
        label={t('claw.strictDirect')}
        desc={t('claw.strictDirectHelp')}
        control={<Toggle on={policy.strictDirect} onClick={() => patch({ strictDirect: !policy.strictDirect })} label={t('claw.strictDirect')} />}
      />

      <Field
        label={t('claw.minuteLimit')}
        desc={t('claw.minuteLimitHelp')}
        control={
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={MIN_MINUTE_LIMIT}
              max={MAX_MINUTE_LIMIT}
              value={policy.minuteLimit}
              onChange={(e) => {
                const n = Number(e.target.value)
                patch({ minuteLimit: Number.isFinite(n) ? Math.min(MAX_MINUTE_LIMIT, Math.max(MIN_MINUTE_LIMIT, Math.trunc(n))) : 0 })
              }}
              className={`${inputCls} w-[88px] text-right`}
              style={inputStyle}
            />
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {t('claw.perMinute')}
            </span>
          </div>
        }
      />

      <Field
        label={t('claw.quietHours')}
        desc={t('claw.quietHoursHelp')}
        control={
          <div className="flex items-center gap-2">
            <Toggle
              on={policy.quietHours.enabled}
              onClick={() => patch({ quietHours: { ...policy.quietHours, enabled: !policy.quietHours.enabled } })}
              label={t('claw.quietHours')}
            />
            <input
              type="time"
              value={policy.quietHours.from}
              disabled={!policy.quietHours.enabled}
              onChange={(e) => patch({ quietHours: { ...policy.quietHours, from: e.target.value || policy.quietHours.from } })}
              className={`${inputCls} w-[92px] disabled:opacity-40`}
              style={inputStyle}
            />
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              →
            </span>
            <input
              type="time"
              value={policy.quietHours.to}
              disabled={!policy.quietHours.enabled}
              onChange={(e) => patch({ quietHours: { ...policy.quietHours, to: e.target.value || policy.quietHours.to } })}
              className={`${inputCls} w-[92px] disabled:opacity-40`}
              style={inputStyle}
            />
          </div>
        }
      />
    </div>
  )
}

function Field({ label, desc, control }: { label: string; desc: string; control: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-between gap-4 px-3.5 py-2.5 rounded-lg"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {label}
        </span>
        <span className="text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {desc}
        </span>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      className="w-10 h-[22px] rounded-full relative shrink-0 border-none cursor-pointer transition-colors"
      style={{ background: on ? 'var(--accent)' : 'var(--border-strong)' }}
    >
      <span
        className="block w-[18px] h-[18px] rounded-full bg-white absolute top-[2px] transition-all"
        style={{ left: on ? '20px' : '2px' }}
      />
    </button>
  )
}
