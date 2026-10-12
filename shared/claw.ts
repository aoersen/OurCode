/**
 * Claw：多渠道接入的共享定义（主进程 / 渲染层 / 网关三边共用）。
 *
 * 一个 Claw Agent（常驻数字员工）可以被多个 IM 渠道接入：微信、企业微信、QQ、
 * 飞书、Telegram。渠道之间共享同一个 Agent 状态（工作区/审批模式/模型/记忆），
 * 但每个渠道有**独立的连接配置与接入控制策略**。
 *
 * 【连接方式统一为长连接，不要回调地址】
 * 所有渠道都通过**主动建立的长连接**收发消息，因此每个渠道只需要 1–2 个凭据，
 * 不需要公网 IP、域名、回调地址、Token、EncodingAESKey 这类东西：
 *   - 微信：官方 ilink 协议 + 长轮询（扫码登录，无凭据）
 *   - 企业微信：官方 @wecom/aibot-node-sdk 的 WebSocket 通道（botId + secret）
 *   - 飞书：官方 @larksuiteoapi/node-sdk 的 createLarkChannel（WebSocket 传输，appId + appSecret）
 *   - QQ：官方 WS 网关 + HTTP 发消息（appId + appSecret）
 *   - Telegram：grammY 长轮询（botToken）
 *
 * 本文件是渠道目录与接入控制策略的唯一来源：主进程用它校验入站、渲染层用它渲染
 * 面板与设置页（表单字段直接由 fields 生成）、网关用它决定要哪些凭据。纯数据 +
 * 纯函数，无副作用，可直接被单元测试与网关子进程引用。
 */

export type ClawChannelId = 'wechat' | 'wecom' | 'qq' | 'feishu' | 'telegram'

/** 渠道目录顺序 = 面板与设置页的展示顺序。 */
export const CLAW_CHANNEL_IDS: ClawChannelId[] = ['wechat', 'wecom', 'qq', 'feishu', 'telegram']

/** 登录方式：qr = 扫码（微信）；credentials = 凭据（其余渠道）。 */
export type ClawLoginMode = 'qr' | 'credentials'

export type ClawFieldType = 'text' | 'password' | 'number' | 'switch'

export interface ClawChannelField {
  key: string
  label: string
  labelEn: string
  type: ClawFieldType
  placeholder?: string
  required?: boolean
  help?: string
  helpEn?: string
}

/**
 * 渠道元数据。
 *
 * `fields` 直接驱动设置页表单：**字段越少越好**。长连接模式下每个渠道最多 2 个
 * 必填凭据；任何「端口 / 回调地址 / 加密密钥 / 签名密钥」都不应该出现在这里。
 * `maturity` 是诚实的成熟度标注：stable 表示协议由官方 SDK 承担、本仓库只做映射
 * 与接入控制；beta 表示按平台公开文档实现、需要真实账号联调验证。
 */
export interface ClawChannelMeta {
  id: ClawChannelId
  label: string
  labelEn: string
  description: string
  descriptionEn: string
  /** 品牌色，仅用于图标识别，描边会向正文色混色以满足对比度。 */
  brandColor: string
  loginMode: ClawLoginMode
  /** 凭据从哪来（设置页直接展示，用户不必翻文档就知道去哪拿）。 */
  credentialHint: string
  credentialHintEn: string
  fields: ClawChannelField[]
  maturity: 'stable' | 'beta'
}

const WECOM_FIELDS: ClawChannelField[] = [
  {
    key: 'botId',
    label: '机器人 ID',
    labelEn: 'Bot ID',
    type: 'text',
    required: true,
    placeholder: '企业微信后台 → 智能机器人 → API 模式',
    help: '在企业微信管理后台创建「智能机器人」并开启 API 模式后获得。',
    helpEn: 'Create an intelligent bot in the WeCom admin console and enable API mode.',
  },
  {
    key: 'secret',
    label: '机器人 Secret',
    labelEn: 'Bot Secret',
    type: 'password',
    required: true,
    help: '与机器人 ID 成对出现；插件用它建立 WebSocket 长连接，无需回调地址。',
    helpEn: 'Pairs with the bot ID; used for the WebSocket channel — no callback URL needed.',
  },
]

const FEISHU_FIELDS: ClawChannelField[] = [
  {
    key: 'appId',
    label: 'App ID',
    labelEn: 'App ID',
    type: 'text',
    required: true,
    placeholder: 'cli_xxxxxxxxxxxx',
    help: '飞书开放平台 → 自建应用 → 凭证与基础信息。',
    helpEn: 'Feishu open platform → custom app → credentials.',
  },
  {
    key: 'appSecret',
    label: 'App Secret',
    labelEn: 'App Secret',
    type: 'password',
    required: true,
    help: '与 App ID 成对；长连接模式不需要配置事件订阅地址。',
    helpEn: 'Pairs with the App ID; long-connection mode needs no event subscription URL.',
  },
]

const QQ_FIELDS: ClawChannelField[] = [
  {
    key: 'appId',
    label: 'AppID',
    labelEn: 'App ID',
    type: 'text',
    required: true,
    help: 'QQ 开放平台 → 机器人 → 开发设置。',
    helpEn: 'QQ bot open platform → bot → development settings.',
  },
  {
    key: 'appSecret',
    label: 'AppSecret',
    labelEn: 'App Secret',
    type: 'password',
    required: true,
    help: '与 AppID 成对；走官方 WebSocket 网关，不需要回调地址。',
    helpEn: 'Pairs with the App ID; uses the official WebSocket gateway — no callback URL.',
  },
  {
    key: 'sandbox',
    label: '沙箱环境',
    labelEn: 'Sandbox environment',
    type: 'switch',
    help: '开启后连到 QQ 沙箱网关（调试用，仅沙箱成员可用）。',
    helpEn: 'Connect to the QQ sandbox gateway (debug only, sandbox members).',
  },
]

const TELEGRAM_FIELDS: ClawChannelField[] = [
  {
    key: 'botToken',
    label: 'Bot Token',
    labelEn: 'Bot Token',
    type: 'password',
    required: true,
    placeholder: '123456789:AA...',
    help: '在 Telegram 里找 @BotFather，发 /newbot 后拿到的 token。',
    helpEn: 'Talk to @BotFather in Telegram and send /newbot to get the token.',
  },
]

export const CLAW_CHANNELS: ClawChannelMeta[] = [
  {
    id: 'wechat',
    label: '微信',
    labelEn: 'WeChat',
    description: '扫码接入，消息按联系人分别成会话。',
    descriptionEn: 'Scan to connect; one thread per contact.',
    brandColor: '#07c160',
    loginMode: 'qr',
    credentialHint: '无需凭据：点「扫码登录」，用手机微信扫一下即可。',
    credentialHintEn: 'No credentials: click “Scan to log in” with your phone.',
    fields: [],
    maturity: 'stable',
  },
  {
    id: 'wecom',
    label: '企业微信',
    labelEn: 'WeCom',
    description: '智能机器人 API 模式 + WebSocket 长连接，无需公网回调。',
    descriptionEn: 'Bot API mode over a WebSocket channel — no public callback needed.',
    brandColor: '#2e7bef',
    loginMode: 'credentials',
    credentialHint: '企业微信管理后台 → 智能机器人 → 开启 API 模式，取「机器人 ID + Secret」。',
    credentialHintEn: 'WeCom admin → intelligent bot → enable API mode → copy Bot ID + Secret.',
    fields: WECOM_FIELDS,
    maturity: 'stable',
  },
  {
    id: 'qq',
    label: 'QQ',
    labelEn: 'QQ',
    description: '官方 WebSocket 网关接收单聊与群 @ 消息，HTTP 被动回复。',
    descriptionEn: 'Official WebSocket gateway for direct and group @ messages; HTTP passive replies.',
    brandColor: '#12b7f5',
    loginMode: 'credentials',
    credentialHint: 'QQ 开放平台 → 机器人 → 取 AppID + AppSecret（需完成主体认证）。',
    credentialHintEn: 'QQ bot platform → bot → AppID + AppSecret (verified entity required).',
    fields: QQ_FIELDS,
    maturity: 'beta',
  },
  {
    id: 'feishu',
    label: '飞书',
    labelEn: 'Feishu',
    description: '长连接接收事件，Bot 自身处理重连、去重与流式输出。',
    descriptionEn: 'Events over a long connection; the bot handles reconnect, dedup and streaming.',
    brandColor: '#3370ff',
    loginMode: 'credentials',
    credentialHint: '飞书开放平台 → 自建应用（开启机器人能力）→ 取 App ID + App Secret。',
    credentialHintEn: 'Feishu open platform → custom app with bot ability → App ID + App Secret.',
    fields: FEISHU_FIELDS,
    maturity: 'stable',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    labelEn: 'Telegram',
    description: 'Bot API 长轮询，一条 token 就能跑，内网也能用。',
    descriptionEn: 'Bot API long polling — a single token, works behind NAT.',
    brandColor: '#229ed9',
    loginMode: 'credentials',
    credentialHint: '在 Telegram 里找 @BotFather 发 /newbot，取它给的 token。',
    credentialHintEn: 'Message @BotFather in Telegram, send /newbot, copy the token.',
    fields: TELEGRAM_FIELDS,
    maturity: 'stable',
  },
]

const CHANNEL_BY_ID = new Map<string, ClawChannelMeta>(CLAW_CHANNELS.map((c) => [c.id, c]))

export function isClawChannelId(value: unknown): value is ClawChannelId {
  return typeof value === 'string' && CHANNEL_BY_ID.has(value)
}

export function clawChannelMeta(id: ClawChannelId): ClawChannelMeta {
  const meta = CHANNEL_BY_ID.get(id)
  if (!meta) throw new Error(`未知 Claw 渠道：${id}`)
  return meta
}

/** 渠道是否已配置到「可以启动」的程度（必填项都有值）。 */
export function isChannelConfigured(id: ClawChannelId, values: Record<string, string> | undefined): boolean {
  const meta = clawChannelMeta(id)
  if (meta.loginMode === 'qr') return true
  return meta.fields
    .filter((f) => f.required)
    .every((f) => String(values?.[f.key] ?? '').trim().length > 0)
}

/** 开关型字段的真值判定（表单里存的是字符串）。 */
export function isFieldOn(values: Record<string, string> | undefined, key: string): boolean {
  const raw = String(values?.[key] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

// ── 接入控制（Access Control）──────────────────────────────────────────────
/**
 * 每个渠道一份接入策略，由主进程在**入站事件进入 agent 之前**强制执行（渲染层
 * 也用同一份策略做展示，避免「面板显示被拦截、实际没拦」这类不一致）。
 */
export interface ClawQuietHours {
  enabled: boolean
  /** "HH:MM"，24 小时制。from > to 表示跨午夜（如 22:00–08:00）。 */
  from: string
  to: string
}

export interface ClawAccessPolicy {
  /** 允许的联系人/群 id（空 = 不限制）。`*` 结尾表示前缀匹配。 */
  allowlist: string[]
  /** 永远忽略的联系人/群 id，优先级高于 allowlist。 */
  blocklist: string[]
  /** 群聊里必须 @ 机器人才应答。 */
  groupRequireMention: boolean
  /** 严格模式：私聊也必须在 allowlist 里（allowlist 为空时此项无意义）。 */
  strictDirect: boolean
  /** 每联系人每分钟消息上限；0 = 不限。 */
  minuteLimit: number
  /** 免打扰：时段内只记录（不计入 agent 队列），也不回发。 */
  quietHours: ClawQuietHours
}

export const DEFAULT_CLAW_POLICY: ClawAccessPolicy = {
  allowlist: [],
  blocklist: [],
  groupRequireMention: true,
  strictDirect: false,
  minuteLimit: 20,
  quietHours: { enabled: false, from: '22:00', to: '08:00' },
}

/**
 * 入站被接入控制拦截的原因（主进程判定、渲染层翻译）。
 * 每个原因在 i18n 里对应一条 `claw.drop.<reason>`，面板据此解释「为什么没回」。
 */
export const CLAW_DROP_REASONS = [
  'blocked',
  'not_allowed',
  'need_mention',
  'rate_limited',
  'quiet_hours',
  'channel_disabled',
] as const

export type ClawDropReason = (typeof CLAW_DROP_REASONS)[number]

export function isClawDropReason(value: unknown): value is ClawDropReason {
  return typeof value === 'string' && (CLAW_DROP_REASONS as readonly string[]).includes(value)
}

/** 每分钟上限的可选范围（设置页步进器用），避免填出无意义的极值。 */
export const MIN_MINUTE_LIMIT = 0
export const MAX_MINUTE_LIMIT = 600

/** 把可能来自磁盘 / IPC 的脏策略收敛成合法策略（任何字段非法都回退默认值）。 */
export function normalizeAccessPolicy(raw: unknown): ClawAccessPolicy {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<ClawAccessPolicy>
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((v) => String(v ?? '').trim())
          .filter(Boolean)
          .slice(0, 500)
      : []
  const limit = Number(input.minuteLimit)
  const quiet = (input.quietHours && typeof input.quietHours === 'object' ? input.quietHours : {}) as Partial<ClawQuietHours>
  return {
    allowlist: input.allowlist === undefined ? [...DEFAULT_CLAW_POLICY.allowlist] : list(input.allowlist),
    blocklist: list(input.blocklist),
    groupRequireMention:
      typeof input.groupRequireMention === 'boolean' ? input.groupRequireMention : DEFAULT_CLAW_POLICY.groupRequireMention,
    strictDirect: typeof input.strictDirect === 'boolean' ? input.strictDirect : DEFAULT_CLAW_POLICY.strictDirect,
    minuteLimit: Number.isFinite(limit)
      ? Math.min(MAX_MINUTE_LIMIT, Math.max(MIN_MINUTE_LIMIT, Math.trunc(limit)))
      : DEFAULT_CLAW_POLICY.minuteLimit,
    quietHours: {
      enabled: typeof quiet.enabled === 'boolean' ? quiet.enabled : DEFAULT_CLAW_POLICY.quietHours.enabled,
      from: isValidClock(quiet.from) ? String(quiet.from) : DEFAULT_CLAW_POLICY.quietHours.from,
      to: isValidClock(quiet.to) ? String(quiet.to) : DEFAULT_CLAW_POLICY.quietHours.to,
    },
  }
}

/** "HH:MM" → 当天第几分钟；非法返回 null。 */
export function parseClock(value: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

function isValidClock(value: unknown): boolean {
  return parseClock(value) !== null
}

/** 单条 id 是否命中规则表；`prefix*` 做前缀匹配，裸 `*` 匹配全部，其余精确匹配。 */
export function matchesRule(rules: string[], id: string): boolean {
  const target = String(id ?? '').trim()
  if (!target) return false
  for (const rule of rules) {
    const r = String(rule ?? '').trim()
    if (!r) continue
    if (r === '*') return true
    if (r.endsWith('*')) {
      const prefix = r.slice(0, -1)
      if (prefix && target.startsWith(prefix)) return true
    } else if (r === target) {
      return true
    }
  }
  return false
}

/**
 * 发件人是否允许进入 agent。群聊按群 id（即 replyTo）判定，私聊按发送者判定。
 * 返回值同时给出原因，便于面板与回执给出**可解释**的拒绝理由。
 */
export function checkSenderAccess(
  policy: ClawAccessPolicy,
  senderId: string,
  isGroup: boolean,
): { allowed: boolean; reason?: 'blocked' | 'not_allowed' } {
  if (matchesRule(policy.blocklist, senderId)) return { allowed: false, reason: 'blocked' }
  if (policy.allowlist.length === 0) return { allowed: true }
  if (matchesRule(policy.allowlist, senderId)) return { allowed: true }
  // 严格模式只约束私聊：群里没被点名的成员不该因为「不在 allowlist」而让整条
  // 群消息被丢弃（群维度已在上面判过）。
  if (isGroup || !policy.strictDirect) return { allowed: true }
  return { allowed: false, reason: 'not_allowed' }
}

/** 免打扰判定：跨午夜时段（from > to）按「大于等于 from 或小于 to」处理。 */
export function inQuietHours(policy: ClawAccessPolicy, at: Date = new Date()): boolean {
  const { enabled, from, to } = policy.quietHours
  if (!enabled) return false
  const f = parseClock(from)
  const t = parseClock(to)
  if (f === null || t === null || f === t) return false
  const now = at.getHours() * 60 + at.getMinutes()
  return f < t ? now >= f && now < t : now >= f || now < t
}

/**
 * 频率限制（纯函数）：给定该联系人最近的到达时间戳，判断这一条是否超限。
 * 只统计 `windowMs` 内的记录，避免调用方需要自己清理历史。
 */
export function isRateLimited(timestamps: number[], limit: number, now: number, windowMs = 60_000): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return false
  let count = 0
  for (const ts of timestamps) {
    if (Number.isFinite(ts) && now - ts < windowMs && ts <= now) count++
  }
  return count >= limit
}

/** 白名单/黑名单在设置页用多行文本框编辑：一行一条。 */
export function rulesToText(rules: string[]): string {
  return (rules ?? []).join('\n')
}

export function textToRules(text: string): string[] {
  return String(text ?? '')
    .split(/[\n,，;；]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 500)
}
