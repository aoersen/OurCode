/**
 * Claw：多渠道接入的共享定义（主进程 / 渲染层 / 网关三边共用）。
 *
 * 一个 Claw Agent（常驻数字员工）可以被多个 IM 渠道接入：微信、企业微信、QQ、
 * 飞书、Telegram。渠道之间共享同一个 Agent 状态（工作区/审批模式/模型/记忆），
 * 但每个渠道有**独立的连接配置与接入控制策略**（谁能用这个渠道跟 Agent 说话、
 * 群聊是否必须 @、频率与免打扰）。
 *
 * 本文件是渠道目录与接入控制策略的唯一来源：主进程用它校验入站、渲染层用它
 * 渲染面板与设置页、网关用它决定需要哪些凭据字段。纯数据 + 纯函数，无副作用，
 * 因此可以直接被单元测试和网关子进程（无 Electron 环境）引用。
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
 * `webhook: true` 表示接入依赖一个**公网可达的回调地址**：网关会在本机拉起
 * HTTP 服务器并在面板里展示完整回调 URL，用户把它填到对应平台的开发者后台。
 * `maturity` 是**诚实的成熟度标注**，直接展示给用户：
 *  - stable：协议已随本仓库实现并有测试覆盖（微信、Telegram）；
 *  - beta：按平台公开文档实现，但需要用户自己的凭据联调才能确认（企业微信/QQ/飞书）。
 */
export interface ClawChannelMeta {
  id: ClawChannelId
  label: string
  labelEn: string
  description: string
  descriptionEn: string
  /** 品牌色，仅用于图标底与状态强调，不作为语义色。 */
  brandColor: string
  loginMode: ClawLoginMode
  /** 是否需要公网回调地址。 */
  webhook: boolean
  fields: ClawChannelField[]
  maturity: 'stable' | 'beta'
  docsUrl?: string
}

/**
 * 回调类渠道共有的两个字段：本机监听端口 + 对外地址前缀。
 *
 * 刻意分开：网关只能在**本机**监听（并回报实际端口），而平台要填的是**公网**
 * 地址。有反向代理/内网穿透时这两者不同，用户填前缀后组装出的地址才是平台能
 * 访问到的那个。两个都留空时面板展示网关实际监听的本地地址，并提示需要穿透。
 */
const WEBHOOK_FIELDS: ClawChannelField[] = [
  {
    key: 'webhookPort',
    label: '回调监听端口',
    labelEn: 'Callback port',
    type: 'number',
    placeholder: '留空 = 自动分配',
    help: '网关在本机监听的端口；建议固定（如 8790/8791/8792），便于平台侧配置。',
    helpEn: 'Port the gateway listens on locally; fix it so the platform config stays stable.',
  },
  {
    key: 'webhookPublicBase',
    label: '对外地址前缀（可选）',
    labelEn: 'Public base URL (optional)',
    type: 'text',
    placeholder: 'https://claw.example.com',
    help: '有反向代理 / 内网穿透时填公网前缀，用于拼出平台要填的回调地址。',
    helpEn: 'Public prefix (reverse proxy / tunnel) used to build the callback URL.',
  },
]

const WECOM_FIELDS: ClawChannelField[] = [
  {
    key: 'corpId',
    label: '企业 ID（CorpID）',
    labelEn: 'Corp ID',
    type: 'text',
    required: true,
    placeholder: 'ww1234567890abcdef',
    help: '企业微信管理后台 → 我的企业 → 企业信息。',
    helpEn: 'WeCom admin → My Enterprise → Enterprise Info.',
  },
  {
    key: 'corpSecret',
    label: '应用 Secret',
    labelEn: 'App Secret',
    type: 'password',
    required: true,
    help: '自建应用的 Secret，用于换取 access_token。',
    helpEn: 'Secret of the self-built app, used to obtain access_token.',
  },
  {
    key: 'agentId',
    label: '应用 ID（AgentId）',
    labelEn: 'Agent ID',
    type: 'text',
    required: true,
    placeholder: '1000002',
    help: '自建应用的应用 ID，发送消息时必须携带。',
    helpEn: 'Agent ID of the self-built app; required when sending messages.',
  },
  {
    key: 'callbackToken',
    label: '回调 Token',
    labelEn: 'Callback Token',
    type: 'password',
    help: '自建应用「接收消息」里的 Token；不填则不校验回调签名（仅建议本机调试）。',
    helpEn: 'Token from the app’s message-receiving config; empty skips callback signature checks.',
  },
  {
    key: 'encodingAesKey',
    label: 'EncodingAESKey',
    labelEn: 'Encoding AES Key',
    type: 'password',
    help: '43 位，用于解密回调消息体。留空则无法读取入站消息。',
    helpEn: '43 chars; decrypts callback payloads. Required to read inbound messages.',
  },
]

const QQ_FIELDS: ClawChannelField[] = [
  {
    key: 'appId',
    label: 'AppID',
    labelEn: 'App ID',
    type: 'text',
    required: true,
    help: 'QQ 开放平台机器人 → 开发设置。',
    helpEn: 'QQ Bot open platform → Development settings.',
  },
  {
    key: 'appSecret',
    label: 'AppSecret',
    labelEn: 'App Secret',
    type: 'password',
    required: true,
    help: '用于换取 AppAccessToken。',
    helpEn: 'Used to obtain the AppAccessToken.',
  },
  {
    key: 'privateKeySeed',
    label: 'Ed25519 私钥种子',
    labelEn: 'Ed25519 private key seed',
    type: 'password',
    help: '32 字节 hex（64 个字符），平台回调地址校验时用它签名。',
    helpEn: '32-byte hex seed (64 chars), used to sign callback URL validation.',
  },
  {
    key: 'publicKey',
    label: '平台公钥（可选）',
    labelEn: 'Platform public key (optional)',
    type: 'password',
    help: '32 字节 hex；填写后校验入站回调签名，留空则接受并标记「来源未验证」。',
    helpEn: '32-byte hex; when set, inbound signatures are verified. Empty accepts unverified.',
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
    help: '飞书开放平台 → 凭证与基础信息。',
    helpEn: 'Feishu open platform → Credentials & basic info.',
  },
  {
    key: 'appSecret',
    label: 'App Secret',
    labelEn: 'App Secret',
    type: 'password',
    required: true,
    help: '用于换取 tenant_access_token。',
    helpEn: 'Used to obtain tenant_access_token.',
  },
  {
    key: 'verificationToken',
    label: 'Verification Token',
    labelEn: 'Verification Token',
    type: 'password',
    help: '事件订阅的 Verification Token，用于校验回调来源。',
    helpEn: 'Verification token of event subscription; validates callback origin.',
  },
  {
    key: 'encryptKey',
    label: 'Encrypt Key（可选）',
    labelEn: 'Encrypt Key (optional)',
    type: 'password',
    help: '开启事件加密后填此项，网关按 AES-256-CBC 解密回调。',
    helpEn: 'Set when event encryption is enabled; callbacks are AES-256-CBC decrypted.',
  },
]

const TELEGRAM_FIELDS: ClawChannelField[] = [
  {
    key: 'botToken',
    label: 'Bot Token',
    labelEn: 'Bot Token',
    type: 'password',
    required: true,
    placeholder: '123456:ABC-DEF…',
    help: '找 @BotFather 创建机器人后拿到的 token。',
    helpEn: 'Token from @BotFather after creating the bot.',
  },
  {
    key: 'apiBase',
    label: 'API 地址（可选）',
    labelEn: 'API base (optional)',
    type: 'text',
    placeholder: 'https://api.telegram.org',
    help: '留空用官方地址；内网可用自建反代。',
    helpEn: 'Empty uses the official endpoint; set a self-hosted relay for restricted networks.',
  },
  {
    key: 'proxy',
    label: '代理（可选）',
    labelEn: 'Proxy (optional)',
    type: 'text',
    placeholder: 'http://127.0.0.1:7890',
    help: 'HTTP(S) 代理地址。',
    helpEn: 'HTTP(S) proxy URL.',
  },
]

export const CLAW_CHANNELS: ClawChannelMeta[] = [
  {
    id: 'wechat',
    label: '微信',
    labelEn: 'WeChat',
    description: '扫码接入微信机器人账号，消息按联系人分别成会话。',
    descriptionEn: 'Scan to log in a WeChat bot account; one thread per contact.',
    brandColor: '#07c160',
    loginMode: 'qr',
    webhook: false,
    fields: [],
    maturity: 'stable',
  },
  {
    id: 'wecom',
    label: '企业微信',
    labelEn: 'WeCom',
    description: '自建应用接入：主动发消息走 API，接收消息走回调地址。',
    descriptionEn: 'Self-built app: send via API, receive via callback URL.',
    brandColor: '#2e7bef',
    loginMode: 'credentials',
    webhook: true,
    fields: [...WECOM_FIELDS, ...WEBHOOK_FIELDS],
    maturity: 'beta',
    docsUrl: 'https://developer.work.weixin.qq.com/document/path/90930',
  },
  {
    id: 'qq',
    label: 'QQ',
    labelEn: 'QQ',
    description: 'QQ 机器人开放平台：被动回复单聊与群 @ 消息。',
    descriptionEn: 'QQ bot platform: passive replies to direct and group @ messages.',
    brandColor: '#12b7f5',
    loginMode: 'credentials',
    webhook: true,
    fields: [...QQ_FIELDS, ...WEBHOOK_FIELDS],
    maturity: 'beta',
    docsUrl: 'https://bot.q.qq.com/wiki/',
  },
  {
    id: 'feishu',
    label: '飞书',
    labelEn: 'Feishu',
    description: '飞书自建应用：事件订阅接收消息，IM API 回复。',
    descriptionEn: 'Feishu self-built app: event subscription in, IM API out.',
    brandColor: '#3370ff',
    loginMode: 'credentials',
    webhook: true,
    fields: [...FEISHU_FIELDS, ...WEBHOOK_FIELDS],
    maturity: 'beta',
    docsUrl: 'https://open.feishu.cn/document/home/index',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    labelEn: 'Telegram',
    description: 'Bot API 长轮询，无需公网回调地址，内网也能用。',
    descriptionEn: 'Bot API long polling — no public callback URL needed.',
    brandColor: '#229ed9',
    loginMode: 'credentials',
    webhook: false,
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

// ── 接入控制（Access Control）──────────────────────────────────────────────
/**
 * 每个渠道一份接入策略，由主进程在**入站事件进入 agent 之前**强制执行（渲染层
 * 也要用同一份策略做提示，避免「面板显示被拦截、实际没拦」这类不一致）。
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

/** 每分钟上限的可选值（设置页步进器用），避免用户填出无意义的极值。 */
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
export function isRateLimited(
  timestamps: number[],
  limit: number,
  now: number,
  windowMs = 60_000,
): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return false
  let count = 0
  for (const ts of timestamps) {
    if (Number.isFinite(ts) && now - ts < windowMs && ts <= now) count++
  }
  return count >= limit
}

/** 群消息是否真的 @ 了机器人（各渠道适配器在 text 上做归一化后由这里统一判定）。 */
export function hasMention(text: string, botNames: string[]): boolean {
  if (!text) return false
  if (/(^|\s)@\S+/.test(text)) return true
  return botNames.some((name) => name.length > 0 && text.includes(`@${name}`))
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
