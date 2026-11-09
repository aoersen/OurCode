import { useMemo } from 'react'

import { NO_LIMITS_COMPANY_EXCLUDED_NOTE, type NoLimitsLayer } from '@/services/noLimits/policy'
import { DSH_PURGE_REPO, NO_LIMITS_PRESETS } from '@/services/noLimits/presets'
import { useNoLimitsStore } from '@/stores/noLimitsStore'
import { GroupLabel, Row, SelectField, StatusLine, Switch, TextAction } from '../../settingsParts'

const LAYERS: ReadonlyArray<{ id: NoLimitsLayer; label: string; description: string }> = [
  { id: 'prompt', label: '提示词覆盖', description: '在系统提示里追加破甲正文' },
  { id: 'permissions', label: '免审批', description: '编辑类动作不再逐条弹审批' },
  { id: 'dangerGuard', label: '危险命令豁免', description: '高危命令不再被拦截' },
]

/**
 * 功能 › 无限制模式（no-limits）。
 *
 * 出厂关闭；总开关打开后三层各自独立。所有写入走 noLimitsStore（localStorage
 * 持久化），关掉总开关即回到接入前的行为，不留残留状态。
 */
export default function NoLimitsSettings() {
  const config = useNoLimitsStore((state) => state.config)
  const setEnabled = useNoLimitsStore((state) => state.setEnabled)
  const setLayer = useNoLimitsStore((state) => state.setLayer)
  const setPreset = useNoLimitsStore((state) => state.setPreset)
  const reset = useNoLimitsStore((state) => state.reset)

  const statusLine = useMemo(() => {
    if (!config.enabled) return '已关闭（出厂默认）'
    const active = LAYERS.filter((layer) => config[layer.id]).map((layer) => layer.label)
    return active.length > 0 ? `已开启：${active.join(' · ')}` : '已开启（三层都未勾选）'
  }, [config])

  return (
    <div>
      <GroupLabel>无限制模式</GroupLabel>
      <Row label="总开关" description={statusLine}>
        <Switch label="无限制模式总开关" checked={config.enabled} onChange={setEnabled} />
      </Row>

      {LAYERS.map((layer) => (
        <Row
          key={layer.id}
          label={layer.label}
          description={layer.description}
        >
          <Switch
            label={layer.label}
            checked={config.enabled && Boolean(config[layer.id])}
            disabled={!config.enabled}
            onChange={(next) => setLayer(layer.id, next)}
          />
        </Row>
      ))}

      <Row label="提示词预设" description="内置两套正文；自定义时使用你自己维护的那份">
        <SelectField
          label="无限制模式提示词预设"
          value={config.presetId}
          disabled={!config.enabled}
          onChange={(event) => {
            const next = event.target.value
            if (next === 'custom' || NO_LIMITS_PRESETS.some((preset) => preset.id === next)) {
              setPreset(next as typeof config.presetId)
            }
          }}
          options={[
            ...NO_LIMITS_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
            { value: 'custom', label: '自定义' },
          ]}
        />
      </Row>

      <Row label="还原" description="回到出厂状态（关闭总开关，三层保留原勾选值）">
        <TextAction onClick={reset} label="还原无限制模式">
          还原
        </TextAction>
      </Row>

      <div className="pt-2">
        <StatusLine>
          {NO_LIMITS_COMPANY_EXCLUDED_NOTE} 正文来源：
          <a
            href={DSH_PURGE_REPO}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-[var(--pure-ink)]"
          >
            {DSH_PURGE_REPO}
          </a>
        </StatusLine>
      </div>
    </div>
  )
}
