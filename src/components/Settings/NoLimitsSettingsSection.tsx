import { useMemo, useState } from 'react'

import { useI18n } from '@/i18n/useI18n'
import {
  NO_LIMITS_COMPANY_EXCLUDED_NOTE,
  NO_LIMITS_MAX_PROMPT_CHARS,
  isNoLimitsPresetId,
  type NoLimitsLayer,
  type NoLimitsPresetId,
} from '@/services/noLimits/policy'
import { DSH_PURGE_REPO, NO_LIMITS_PRESETS, getPresetText } from '@/services/noLimits/presets'
import { useNoLimitsStore } from '@/stores/noLimitsStore'
import type { TranslationKey } from '@/i18n'

/** 三层的文案键（枚举式映射，避免模板字符串拼 key）。 */
const LAYER_KEYS: Record<NoLimitsLayer, { label: TranslationKey; desc: TranslationKey }> = {
  prompt: { label: 'noLimits.layer.prompt', desc: 'noLimits.layer.promptDesc' },
  permissions: { label: 'noLimits.layer.permissions', desc: 'noLimits.layer.permissionsDesc' },
  dangerGuard: { label: 'noLimits.layer.dangerGuard', desc: 'noLimits.layer.dangerGuardDesc' },
}

/** 预设显示名（内置预设 + 自定义，枚举式映射保证新增预设不会漏文案）。 */
const PRESET_LABEL_KEYS: Record<NoLimitsPresetId, TranslationKey> = {
  'dsh-purge-zh': 'noLimits.presetDshPurge',
  'keyijiang-zh': 'noLimits.presetKeyijiang',
  custom: 'noLimits.presetCustom',
}

const LAYERS: NoLimitsLayer[] = ['prompt', 'permissions', 'dangerGuard']

/**
 * 设置 → 功能 → 无限制模式（no-limits）。
 *
 * dsh-purge 破甲能力在 OurCode-ide 里的开关面板：总开关默认关闭，打开后三层
 * （提示词覆盖 / 免审批 / 危险命令豁免）各自独立。面板自带还原入口——关掉总开关
 * 即回到接入前的行为，不残留任何状态。
 *
 * 无障碍：开关是原生 <button role="switch" aria-checked>，键盘可操作、有 label；
 * 颜色全部走 nova-* 语义 token，不硬编码色值。
 */
export default function NoLimitsSettingsSection() {
  const t = useI18n()
  const config = useNoLimitsStore((s) => s.config)
  const setEnabled = useNoLimitsStore((s) => s.setEnabled)
  const setLayer = useNoLimitsStore((s) => s.setLayer)
  const setPreset = useNoLimitsStore((s) => s.setPreset)
  const setCustomPrompt = useNoLimitsStore((s) => s.setCustomPrompt)
  const reset = useNoLimitsStore((s) => s.reset)

  const [showPresetText, setShowPresetText] = useState(false)
  // 预览跟随当前预设：内置预设读各自的 .md，自定义读用户正文。
  const activeText = useMemo(
    () => (config.presetId === 'custom' ? config.customPrompt : getPresetText(config.presetId)),
    [config.presetId, config.customPrompt],
  )

  const statusLabel = config.enabled
    ? t('noLimits.statusOn', {
        layers: LAYERS.filter((l) => config[l]).map((l) => t(LAYER_KEYS[l].label)).join(' · ') ||
          t('noLimits.statusNoLayer'),
      })
    : t('noLimits.statusOff')

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-nova-border bg-nova-card px-5 py-4" aria-labelledby="no-limits-heading">
      <div className="flex flex-col gap-1">
        <h3 id="no-limits-heading" className="text-[14px] leading-[20px] font-semibold text-nova-text-primary">
          {t('noLimits.title')}
        </h3>
        <p className="text-[12px] leading-[18px] text-nova-text-muted">{t('noLimits.subtitle')}</p>
      </div>

      <Row
        label={t('noLimits.master')}
        desc={t('noLimits.masterDesc')}
        right={
          <div className="flex items-center gap-2.5">
            <span className={`text-[12px] leading-[18px] font-mono ${config.enabled ? 'text-accent-text' : 'text-nova-text-muted'}`}>
              {statusLabel}
            </span>
            <Switch checked={config.enabled} onChange={setEnabled} label={t('noLimits.master')} />
          </div>
        }
      />

      {LAYERS.map((layer) => (
        <Row
          key={layer}
          label={t(LAYER_KEYS[layer].label)}
          desc={t(LAYER_KEYS[layer].desc)}
          dimmed={!config.enabled}
          right={
            <Switch
              checked={config.enabled && Boolean(config[layer])}
              disabled={!config.enabled}
              onChange={(on) => setLayer(layer, on)}
              label={t(LAYER_KEYS[layer].label)}
            />
          }
        />
      ))}

      <Row
        label={t('noLimits.preset')}
        desc={t('noLimits.presetDesc')}
        dimmed={!config.enabled}
        right={
          <select
            value={config.presetId}
            disabled={!config.enabled}
            aria-label={t('noLimits.preset')}
            onChange={(e) => {
              const next = e.target.value
              if (isNoLimitsPresetId(next)) setPreset(next)
            }}
            className="h-9 rounded-lg bg-nova-input-bg border border-nova-border px-2.5 text-[12px] leading-[18px] text-nova-text-primary outline-none focus:border-accent-50 transition-colors disabled:opacity-50"
          >
            {NO_LIMITS_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {t(PRESET_LABEL_KEYS[p.id])}
              </option>
            ))}
            <option value="custom">{t('noLimits.presetCustom')}</option>
          </select>
        }
      />

      {config.presetId === 'custom' ? (
        <div className="flex flex-col gap-1.5 border-b border-nova-border py-3 last:border-b-0">
          <label htmlFor="no-limits-custom" className="text-[13px] leading-[18px] font-medium text-nova-text-primary">
            {t('noLimits.customLabel')}
          </label>
          <textarea
            id="no-limits-custom"
            value={config.customPrompt}
            disabled={!config.enabled}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={t('noLimits.customPlaceholder')}
            rows={8}
            spellCheck={false}
            className="w-full rounded-lg border border-nova-border bg-nova-input-bg px-2.5 py-2 text-[12px] leading-[18px] font-mono text-nova-text-primary outline-none focus:border-accent-50 transition-colors resize-y disabled:opacity-50"
          />
          <span className="text-[12px] leading-[18px] text-nova-text-muted self-end">
            {t('noLimits.chars', { count: config.customPrompt.length, max: NO_LIMITS_MAX_PROMPT_CHARS })}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 border-b border-nova-border py-3 last:border-b-0">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] leading-[18px] font-medium text-nova-text-primary">{t('noLimits.preview')}</span>
            <button
              type="button"
              onClick={() => setShowPresetText((v) => !v)}
              className="inline-flex h-8 items-center rounded-lg bg-accent-10 px-2.5 text-[13px] leading-[18px] text-accent-text transition-colors hover:bg-accent-20"
              aria-expanded={showPresetText}
            >
              {showPresetText ? t('noLimits.hidePreview') : t('noLimits.showPreview')}
            </button>
          </div>
          {showPresetText && (
            <pre className="max-h-[240px] overflow-auto px-2.5 py-2 bg-nova-input-bg border border-nova-border rounded-md text-[12px] text-nova-text-secondary whitespace-pre-wrap break-words">
              {activeText.slice(0, 6000)}
              {activeText.length > 6000 ? '\n…' : ''}
            </pre>
          )}
          <span className="text-[12px] leading-[18px] text-nova-text-muted">
            {t('noLimits.chars', { count: activeText.length, max: NO_LIMITS_MAX_PROMPT_CHARS })}
          </span>
        </div>
      )}

      <Row
        label={t('noLimits.reset')}
        desc={t('noLimits.resetDesc')}
        right={
          <button
            type="button"
            onClick={reset}
            className="px-3 py-1.5 text-[12px] leading-[18px] text-nova-text-secondary bg-nova-hover hover:text-nova-text-primary rounded-md transition-colors"
          >
            {t('noLimits.resetAction')}
          </button>
        }
      />

      <p className="text-[12px] leading-[18px] text-nova-text-muted">
        {NO_LIMITS_COMPANY_EXCLUDED_NOTE}
        <br />
        {t('noLimits.attribution')}{' '}
        <a href={DSH_PURGE_REPO} target="_blank" rel="noreferrer noopener" className="text-accent-text hover:underline">
          {DSH_PURGE_REPO}
        </a>
        <br />
        {t('noLimits.attributionLocal')}
      </p>
    </section>
  )
}

function Row({
  label,
  desc,
  right,
  dimmed = false,
}: {
  label: string
  desc: string
  right: React.ReactNode
  dimmed?: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between gap-6 border-b border-nova-border py-3 first:pt-1 last:border-b-0 last:pb-1 ${dimmed ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[13px] leading-[18px] font-medium text-nova-text-primary">{label}</span>
        <span className="text-[12px] leading-[18px] text-nova-text-muted">{desc}</span>
      </div>
      <div className="flex items-center gap-2.5 shrink-0">{right}</div>
    </div>
  )
}

function Switch({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border border-transparent transition-colors ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
      style={{ background: checked ? 'var(--accent)' : 'var(--border)' }}
    >
      <span
        className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  )
}
