import { describe, it, expect } from 'vitest'

import {
  CLAW_CHANNELS,
  CLAW_CHANNEL_IDS,
  DEFAULT_CLAW_POLICY,
  checkSenderAccess,
  clawChannelMeta,
  hasMention,
  inQuietHours,
  isChannelConfigured,
  isClawChannelId,
  isRateLimited,
  matchesRule,
  normalizeAccessPolicy,
  parseClock,
  rulesToText,
  textToRules,
  type ClawAccessPolicy,
} from '@shared/claw'

/**
 * 接入控制的策略层单测：这些函数是「谁能让 agent 干活」的唯一判定依据，
 * 主进程与面板都用它们，因此边界（跨午夜、前缀通配、脏数据）必须钉住。
 */
const policy = (patch: Partial<ClawAccessPolicy> = {}): ClawAccessPolicy => ({
  ...DEFAULT_CLAW_POLICY,
  allowlist: [],
  blocklist: [],
  quietHours: { ...DEFAULT_CLAW_POLICY.quietHours },
  ...patch,
})

describe('渠道目录', () => {
  it('五个渠道 id 唯一且与顺序常量一致', () => {
    expect(CLAW_CHANNELS.map((c) => c.id)).toEqual(CLAW_CHANNEL_IDS)
    expect(new Set(CLAW_CHANNEL_IDS).size).toBe(CLAW_CHANNEL_IDS.length)
  })

  it('isClawChannelId 只认目录里的 id', () => {
    expect(isClawChannelId('telegram')).toBe(true)
    expect(isClawChannelId('discord')).toBe(false)
    expect(isClawChannelId(undefined)).toBe(false)
  })

  it('clawChannelMeta 对未知渠道抛错（调用方不该静默拿到空对象）', () => {
    expect(clawChannelMeta('wechat').label).toBe('微信')
    expect(() => clawChannelMeta('nope' as never)).toThrow()
  })

  it('凭据渠道都声明了必填字段，回调渠道都带回调配置字段', () => {
    for (const meta of CLAW_CHANNELS) {
      if (meta.loginMode === 'credentials') {
        expect(meta.fields.some((f) => f.required)).toBe(true)
      }
      if (meta.webhook) {
        const keys = meta.fields.map((f) => f.key)
        expect(keys).toContain('webhookPort')
        expect(keys).toContain('webhookPublicBase')
      }
    }
  })

  it('isChannelConfigured：扫码渠道可直接启动，凭据渠道要求必填项齐全', () => {
    expect(isChannelConfigured('wechat', {})).toBe(true)
    expect(isChannelConfigured('telegram', {})).toBe(false)
    expect(isChannelConfigured('telegram', { botToken: '  ' })).toBe(false)
    expect(isChannelConfigured('telegram', { botToken: '123:abc' })).toBe(true)
    // 企业微信需要三项，缺一不可
    expect(isChannelConfigured('wecom', { corpId: 'ww1', corpSecret: 's' })).toBe(false)
    expect(isChannelConfigured('wecom', { corpId: 'ww1', corpSecret: 's', agentId: '1000002' })).toBe(true)
  })
})

describe('normalizeAccessPolicy（脏数据收敛）', () => {
  it('非法输入回退默认值，不抛出', () => {
    const out = normalizeAccessPolicy(undefined)
    expect(out.groupRequireMention).toBe(DEFAULT_CLAW_POLICY.groupRequireMention)
    expect(out.minuteLimit).toBe(DEFAULT_CLAW_POLICY.minuteLimit)
    expect(out.quietHours.enabled).toBe(false)
  })

  it('数值与时间被裁剪到合法范围', () => {
    const out = normalizeAccessPolicy({ minuteLimit: 99_999, quietHours: { enabled: true, from: '25:00', to: '7:5' } })
    expect(out.minuteLimit).toBe(600)
    // 非法时间回退默认（而不是留一个会让判定逻辑崩掉的值）
    expect(out.quietHours.from).toBe(DEFAULT_CLAW_POLICY.quietHours.from)
    expect(out.quietHours.to).toBe(DEFAULT_CLAW_POLICY.quietHours.to)
  })

  it('列表字段去空白、去空项、限量', () => {
    const out = normalizeAccessPolicy({ allowlist: ['  a ', '', 'b', null] as never, blocklist: 'not-an-array' as never })
    expect(out.allowlist).toEqual(['a', 'b'])
    expect(out.blocklist).toEqual([])
  })

  it('负数与小数被规整为整数下限', () => {
    expect(normalizeAccessPolicy({ minuteLimit: -5 }).minuteLimit).toBe(0)
    expect(normalizeAccessPolicy({ minuteLimit: 12.7 }).minuteLimit).toBe(12)
  })
})

describe('规则匹配', () => {
  it('精确匹配与 * 前缀匹配', () => {
    expect(matchesRule(['wx_123'], 'wx_123')).toBe(true)
    expect(matchesRule(['wx_'], 'wx_123')).toBe(false)
    expect(matchesRule(['wx_*'], 'wx_123')).toBe(true)
    expect(matchesRule(['wx_*'], 'wx123')).toBe(false)
    expect(matchesRule(['*'], 'anything')).toBe(true)
    expect(matchesRule([], 'anything')).toBe(false)
    expect(matchesRule(['a'], '')).toBe(false)
  })

  it('多行文本编辑：换行/逗号/分号都能分隔，去空项', () => {
      expect(textToRules(['a', 'b, c；d; e'].join('\n'))).toEqual(['a', 'b', 'c', 'd', 'e'])
      expect(rulesToText(['a', 'b'])).toBe(['a', 'b'].join('\n'))
    expect(textToRules('')).toEqual([])
  })
})

describe('checkSenderAccess', () => {
  it('黑名单优先级最高', () => {
    const p = policy({ allowlist: ['user-1'], blocklist: ['user-1'] })
    expect(checkSenderAccess(p, 'user-1', false)).toEqual({ allowed: false, reason: 'blocked' })
  })

  it('白名单为空 = 不限制', () => {
    expect(checkSenderAccess(policy(), 'anyone', false)).toEqual({ allowed: true })
  })

  it('非空的私聊白名单默认放行外人（strictDirect 才收紧）', () => {
    const p = policy({ allowlist: ['vip'] })
    expect(checkSenderAccess(p, 'stranger', false).allowed).toBe(true)
    expect(checkSenderAccess(policy({ allowlist: ['vip'], strictDirect: true }), 'stranger', false)).toEqual({
      allowed: false,
      reason: 'not_allowed',
    })
  })

  it('严格模式不影响群聊（群维度单独判定，避免整群被误杀）', () => {
    const p = policy({ allowlist: ['vip'], strictDirect: true })
    expect(checkSenderAccess(p, 'group-9', true).allowed).toBe(true)
  })

  it('白名单支持前缀通配', () => {
    expect(checkSenderAccess(policy({ allowlist: ['team_*'], strictDirect: true }), 'team_alice', false).allowed).toBe(true)
  })
})

describe('免打扰时段', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m)

  it('关闭时永远不生效', () => {
    expect(inQuietHours(policy({ quietHours: { enabled: false, from: '22:00', to: '08:00' } }), at(23))).toBe(false)
  })

  it('跨午夜时段（22:00–08:00）', () => {
    const p = policy({ quietHours: { enabled: true, from: '22:00', to: '08:00' } })
    expect(inQuietHours(p, at(23))).toBe(true)
    expect(inQuietHours(p, at(3))).toBe(true)
    expect(inQuietHours(p, at(7, 59))).toBe(true)
    expect(inQuietHours(p, at(8))).toBe(false)
    expect(inQuietHours(p, at(12))).toBe(false)
    expect(inQuietHours(p, at(21, 59))).toBe(false)
  })

  it('同日时段（09:00–18:00）', () => {
    const p = policy({ quietHours: { enabled: true, from: '09:00', to: '18:00' } })
    expect(inQuietHours(p, at(9))).toBe(true)
    expect(inQuietHours(p, at(17, 59))).toBe(true)
    expect(inQuietHours(p, at(18))).toBe(false)
    expect(inQuietHours(p, at(8, 59))).toBe(false)
  })

  it('from === to 视为不生效（不是「全天静音」）', () => {
    expect(inQuietHours(policy({ quietHours: { enabled: true, from: '08:00', to: '08:00' } }), at(8))).toBe(false)
  })

  it('parseClock 边界', () => {
    expect(parseClock('00:00')).toBe(0)
    expect(parseClock('23:59')).toBe(1439)
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('8:5')).toBeNull()
    expect(parseClock('')).toBeNull()
  })
})

describe('频率限制', () => {
  const now = 1_000_000

  it('窗口内达到上限即拦截', () => {
    expect(isRateLimited([now - 1000, now - 2000], 3, now)).toBe(false)
    expect(isRateLimited([now - 1000, now - 2000, now - 3000], 3, now)).toBe(true)
  })

  it('窗口外的旧记录不计入', () => {
    expect(isRateLimited([now - 61_000, now - 120_000], 1, now)).toBe(false)
  })

  it('0 / 非法上限 = 不限制', () => {
    expect(isRateLimited([now, now, now], 0, now)).toBe(false)
    expect(isRateLimited([now, now], Number.NaN, now)).toBe(false)
  })

  it('未来时间戳（时钟回拨）不计入', () => {
    expect(isRateLimited([now + 5_000, now + 6_000], 1, now)).toBe(false)
  })
})

describe('@ 提及', () => {
  it('识别 @名称 与任意 @token', () => {
    expect(hasMention('@clawbot 帮我看看', ['clawbot'])).toBe(true)
    expect(hasMention('hi @someone', [])).toBe(true)
    expect(hasMention('没有提及', ['clawbot'])).toBe(false)
    expect(hasMention('', ['clawbot'])).toBe(false)
    // 空名字不该匹配一切
    expect(hasMention('没有提及', [''])).toBe(false)
  })
})
