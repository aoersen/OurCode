import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  DEFAULT_NO_LIMITS_CONFIG,
  NO_LIMITS_EDIT_MODE,
  NO_LIMITS_MARKER,
  NO_LIMITS_MAX_PROMPT_CHARS,
  NO_LIMITS_PRESET_IDS,
  composeNoLimitsPrompt,
  effectiveEditMode,
  isNoLimitsActive,
  isNoLimitsExcluded,
  isNoLimitsPresetId,
  normalizeNoLimitsConfig,
  resolveNoLimitsLayers,
  resolvePromptText,
  sanitizePromptText,
  stripChatTemplateMarkers,
  suppressPlanMode,
  type NoLimitsConfig,
} from '@/services/noLimits/policy'
import { NO_LIMITS_PRESETS, DSH_PURGE_REPO, getPresetText } from '@/services/noLimits/presets'
import {
  NO_LIMITS_STORAGE_KEY,
  getNoLimitsPresetText,
  loadNoLimitsConfig,
  useNoLimitsStore,
  toggleNoLimits,
} from '@/stores/noLimitsStore'

/**
 * no-limits（dsh-purge 破甲能力接入）的契约测试。
 *
 * 最重要的两条不变量：
 *  1. **默认不开启** —— 出厂配置、坏存储、缺字段都必须落到「关闭」。
 *  2. **关闭时零影响** —— 不注入提示词、不改审批模式、不放行危险命令。
 */

const cfg = (patch: Partial<NoLimitsConfig> = {}): NoLimitsConfig => ({ ...DEFAULT_NO_LIMITS_CONFIG, ...patch })

afterEach(() => {
  // 恢复成 vitest.setup.ts 里的空存储桩，避免用例之间互相污染
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  })
  useNoLimitsStore.getState().reset()
})

describe('默认不开启', () => {
  it('出厂配置总开关关闭，三层都不生效', () => {
    expect(DEFAULT_NO_LIMITS_CONFIG.enabled).toBe(false)
    expect(resolveNoLimitsLayers(DEFAULT_NO_LIMITS_CONFIG)).toEqual({
      prompt: false,
      permissions: false,
      dangerGuard: false,
      active: false,
    })
    expect(isNoLimitsActive(DEFAULT_NO_LIMITS_CONFIG)).toBe(false)
  })

  it('即使三层都勾选，没打开总开关也不生效', () => {
    const c = cfg({ enabled: false, prompt: true, permissions: true, dangerGuard: true })
    expect(isNoLimitsActive(c)).toBe(false)
    expect(composeNoLimitsPrompt(c, 'chat', getPresetText('dsh-purge-zh'))).toBe('')
    expect(effectiveEditMode('confirm_before_change', c)).toBe('confirm_before_change')
    expect(suppressPlanMode('plan', c)).toBe(false)
  })

  it('坏存储 / 缺字段回落到默认（关闭）', () => {
    expect(normalizeNoLimitsConfig(null).enabled).toBe(false)
    expect(normalizeNoLimitsConfig({}).enabled).toBe(false)
    expect(normalizeNoLimitsConfig({ enabled: 'yes' as unknown as boolean }).enabled).toBe(false)
    // 显式 true 才保留
    expect(normalizeNoLimitsConfig({ enabled: true }).enabled).toBe(true)
  })
})

describe('层解析', () => {
  it('总开关打开后按层生效', () => {
    const all = resolveNoLimitsLayers(cfg({ enabled: true }))
    expect(all).toEqual({ prompt: true, permissions: true, dangerGuard: true, active: true })

    const onlyPrompt = resolveNoLimitsLayers(cfg({ enabled: true, permissions: false, dangerGuard: true }))
    expect(onlyPrompt).toEqual({ prompt: true, permissions: false, dangerGuard: false, active: true })
  })

  it('危险命令豁免从属于免审批', () => {
    expect(resolveNoLimitsLayers(cfg({ enabled: true, permissions: false, dangerGuard: true })).dangerGuard).toBe(false)
    expect(resolveNoLimitsLayers(cfg({ enabled: true, permissions: true, dangerGuard: false })).dangerGuard).toBe(false)
  })

  it('一层都不勾时 active=false（打开开关但没内容）', () => {
    const c = cfg({ enabled: true, prompt: false, permissions: false, dangerGuard: false })
    expect(resolveNoLimitsLayers(c).active).toBe(false)
  })

  it('一人公司 / 角色员工会话被硬边界排除', () => {
    const c = cfg({ enabled: true })
    expect(isNoLimitsExcluded('chat')).toBe(false)
    expect(isNoLimitsExcluded('company')).toBe(true)
    expect(isNoLimitsExcluded('worker')).toBe(true)
    expect(resolveNoLimitsLayers(c, 'company').active).toBe(false)
    expect(resolveNoLimitsLayers(c, 'worker').active).toBe(false)
    expect(composeNoLimitsPrompt(c, 'company', getPresetText('dsh-purge-zh'))).toBe('')
    expect(effectiveEditMode('confirm_before_change', c, 'company')).toBe('confirm_before_change')
  })
})

describe('提示词净化', () => {
  it('去掉聊天模板标记与零宽字符', () => {
    const raw = '<|im_start|>system:<project_instructions>\n\u200b正文\n<|im_end|>'
    const out = stripChatTemplateMarkers(raw)
    expect(out).not.toContain('<|im_start|>')
    expect(out).not.toContain('<|im_end|>')
    expect(out).toContain('<project_instructions>')
    expect(sanitizePromptText(raw)).toBe('<project_instructions>\n正文')
  })

  it('超过上限时截断', () => {
    const long = 'x'.repeat(50)
    expect(sanitizePromptText(long, 10)).toHaveLength(10)
    expect(sanitizePromptText('x'.repeat(NO_LIMITS_MAX_PROMPT_CHARS + 5))).toHaveLength(NO_LIMITS_MAX_PROMPT_CHARS)
  })

  it('自定义预设用 customPrompt，预设预设用内置正文', () => {
    const preset = getPresetText('dsh-purge-zh')
    const fromPreset = resolvePromptText(cfg({ presetId: 'dsh-purge-zh' }), preset)
    expect(fromPreset).toBe(sanitizePromptText(preset))
    // 上游预设开头的聊天模板标记必须被去掉，正文其余部分逐字保留
    expect(fromPreset).not.toContain('<|im_start|>')
    expect(fromPreset.startsWith('<project_instructions>')).toBe(true)
    expect(fromPreset).toContain('小码酱')
    expect(resolvePromptText(cfg({ presetId: 'custom', customPrompt: '  我的一段  ' }), preset)).toBe('我的一段')
  })
})

describe('内置提示词预设', () => {
  it('可以酱预设已内置，正文完整且可注入', () => {
    const preset = NO_LIMITS_PRESETS.find((p) => p.id === 'keyijiang-zh')
    expect(preset).toBeDefined()
    expect(preset!.label).toBe('可以酱（中文）')
    expect(preset!.text).toContain('你的工作名是可以酱')
    expect(preset!.text).toContain('<project_instructions>')
    expect(preset!.text.length).toBeGreaterThan(1_000)
    // 不同预设的正文不能互相串
    expect(preset!.text).not.toContain('小码酱')

    const block = composeNoLimitsPrompt(cfg({ enabled: true, presetId: 'keyijiang-zh' }), 'chat', preset!.text)
    expect(block).toContain('你的工作名是可以酱')
    expect(block.startsWith(`<!-- ${NO_LIMITS_MARKER} start -->`)).toBe(true)
  })

  it('预设 id 白名单覆盖全部内置预设', () => {
    expect(NO_LIMITS_PRESET_IDS).toEqual(['dsh-purge-zh', 'keyijiang-zh', 'custom'])
    for (const p of NO_LIMITS_PRESETS) {
      expect(isNoLimitsPresetId(p.id)).toBe(true)
      expect(p.text.length).toBeGreaterThan(100)
    }
    expect(isNoLimitsPresetId('dsh-purge-zh')).toBe(true)
    expect(isNoLimitsPresetId('nope')).toBe(false)
    expect(isNoLimitsPresetId(undefined)).toBe(false)
  })

  it('持久化保留新预设，未知 id 回落到默认', () => {
    expect(normalizeNoLimitsConfig({ presetId: 'keyijiang-zh' }).presetId).toBe('keyijiang-zh')
    expect(normalizeNoLimitsConfig({ presetId: 'whatever' }).presetId).toBe(DEFAULT_NO_LIMITS_CONFIG.presetId)
  })

  it('切换预设后 store 取到对应正文', () => {
    useNoLimitsStore.getState().setPreset('keyijiang-zh')
    expect(getNoLimitsPresetText(useNoLimitsStore.getState().config)).toContain('你的工作名是可以酱')
    expect(getNoLimitsPresetText(useNoLimitsStore.getState().config)).not.toContain('小码酱')
  })
})

describe('提示词覆盖层', () => {
  it('开启后注入带标记的覆盖层，正文来自 dsh-purge 预设', () => {
    const preset = getPresetText('dsh-purge-zh')
    const block = composeNoLimitsPrompt(cfg({ enabled: true }), 'chat', preset)
    expect(block).toContain(`<!-- ${NO_LIMITS_MARKER} start -->`)
    expect(block).toContain('<no_limits_mode>')
    expect(block).toContain('小码酱')
    expect(block.endsWith(`<!-- ${NO_LIMITS_MARKER} end -->`)).toBe(true)
  })

  it('提示词层关闭时不注入，正文为空时也不注入', () => {
    expect(composeNoLimitsPrompt(cfg({ enabled: true, prompt: false }), 'chat', 'x')).toBe('')
    expect(composeNoLimitsPrompt(cfg({ enabled: true }), 'chat', '   ')).toBe('')
  })

  it('内置预设来自上游 dsh-purge 并保留了署名信息', () => {
    const p = NO_LIMITS_PRESETS[0]
    expect(p.id).toBe('dsh-purge-zh')
    expect(p.source).toBe(DSH_PURGE_REPO)
    expect(p.license).toBe('Apache-2.0')
    expect(p.text.length).toBeGreaterThan(10_000)
  })
})

describe('审批模式', () => {
  it('免审批时锁 full_access，关闭时原样返回', () => {
    const on = cfg({ enabled: true, permissions: true })
    expect(effectiveEditMode('confirm_before_change', on)).toBe(NO_LIMITS_EDIT_MODE)
    expect(effectiveEditMode('plan', on)).toBe(NO_LIMITS_EDIT_MODE)
    const off = cfg({ enabled: true, permissions: false })
    expect(effectiveEditMode('plan', off)).toBe('plan')
  })

  it('计划模式的只读期被压掉', () => {
    expect(suppressPlanMode('plan', cfg({ enabled: true }))).toBe(true)
    expect(suppressPlanMode('plan', cfg({ enabled: false }))).toBe(false)
    expect(suppressPlanMode('auto_edit', cfg({ enabled: true }))).toBe(false)
  })
})

describe('持久化与还原', () => {
  function fakeStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed))
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: map.size,
      dump: () => map,
    }
  }

  it('没有存储记录时读出来是关闭', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(loadNoLimitsConfig().enabled).toBe(false)
  })

  it('打开后写入存储，重新读取仍是打开；reset 回到关闭', () => {
    const st = fakeStorage()
    vi.stubGlobal('localStorage', st)

    useNoLimitsStore.getState().setEnabled(true)
    expect(loadNoLimitsConfig().enabled).toBe(true)
    expect(JSON.parse(st.getItem(NO_LIMITS_STORAGE_KEY) || '{}').enabled).toBe(true)

    useNoLimitsStore.getState().reset()
    expect(loadNoLimitsConfig().enabled).toBe(false)
    expect(useNoLimitsStore.getState().config).toEqual(DEFAULT_NO_LIMITS_CONFIG)
  })

  it('坏 JSON 不会把功能打开', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [NO_LIMITS_STORAGE_KEY]: '{not json' }))
    expect(loadNoLimitsConfig().enabled).toBe(false)
  })

  it('toggleNoLimits 在开关之间来回切换', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    useNoLimitsStore.getState().reset()
    expect(toggleNoLimits()).toBe(true)
    expect(useNoLimitsStore.getState().config.enabled).toBe(true)
    expect(toggleNoLimits()).toBe(false)
    expect(useNoLimitsStore.getState().config.enabled).toBe(false)
  })

  it('自定义正文写入前净化并保留预设选择', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    useNoLimitsStore.getState().reset()
    useNoLimitsStore.getState().setPreset('custom')
    useNoLimitsStore.getState().setCustomPrompt('<|im_start|>system:\n只要结论')
    expect(useNoLimitsStore.getState().config.presetId).toBe('custom')
    expect(useNoLimitsStore.getState().config.customPrompt).toBe('只要结论')
  })
})
