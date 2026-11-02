/**
 * no-limits 提示词预设。
 *
 * `dsh-purge-zh` 的正文逐字取自上游 dsh-purge（Apache-2.0，
 * https://github.com/YuJunZhiXue/dsh-purge，lib/default-prompt-inject.zh.md），
 * 署名与许可见同目录 NOTICE.md 与 docs/no-limits.md。除去掉聊天模板标记外不改写。
 *
 * `keyijiang-zh` 是本项目内置的「可以酱」工作人格，正文维护在
 * keyijiang.zh.md，不来自第三方。
 */
import dshPurgeZh from './dsh-purge.zh.md?raw'
import keyijiangZh from './keyijiang.zh.md?raw'
import type { NoLimitsPresetId } from '../policy'

export interface NoLimitsPreset {
  id: NoLimitsPresetId
  /** 设置面板里的显示名。 */
  label: string
  /** 一句话说明。 */
  description: string
  /** 来源仓库（本地内置 / 自定义预设为空）。 */
  source: string
  /** 许可（本地内置 / 自定义预设为空）。 */
  license: string
  text: string
}

export const DSH_PURGE_REPO = 'https://github.com/YuJunZhiXue/dsh-purge'

export const NO_LIMITS_PRESETS: NoLimitsPreset[] = [
  {
    id: 'dsh-purge-zh',
    label: 'dsh-purge 原版（中文）',
    description: '上游 dsh-purge 的默认破甲提示词：工作人格、任务优先级、路由与交付风格。',
    source: DSH_PURGE_REPO,
    license: 'Apache-2.0',
    text: dshPurgeZh,
  },
  {
    id: 'keyijiang-zh',
    label: '可以酱（中文）',
    description: '本项目内置的「可以酱」工作人格：任务优先、直接交付、不做范围检查。',
    source: '',
    license: '',
    text: keyijiangZh,
  },
]

/** 取预设正文；找不到或自定义时返回空串（自定义正文由 config.customPrompt 提供）。 */
export function getPresetText(id: NoLimitsPresetId): string {
  return NO_LIMITS_PRESETS.find((p) => p.id === id)?.text ?? ''
}

export function getPreset(id: NoLimitsPresetId): NoLimitsPreset | undefined {
  return NO_LIMITS_PRESETS.find((p) => p.id === id)
}
