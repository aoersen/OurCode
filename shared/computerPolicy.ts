/**
 * Computer Use — pure policy rules, shared by the main process and the renderer.
 *
 * The main process is authoritative (it refuses the call); the renderer uses the
 * same rules to explain *why* in the approval card before the call is even sent.
 *
 *  - Application allow/deny: observing or controlling a password manager, a
 *    banking client, UAC or a remote-desktop client is refused outright.
 *  - Action danger: irreversible verbs, credential-looking input and downloaded
 *    executables force an explicit user confirmation (never silently allowed).
 */
import type { CuaActionKind } from './computer'

/** Always-on blacklist: observing or controlling these is refused outright. */
export const BUILTIN_DENY_PATTERNS: readonly RegExp[] = [
  /1password/i,
  /bitwarden/i,
  /keepass/i,
  /lastpass/i,
  /dashlane/i,
  /密码/,
  /凭据/,
  /密钥管理/,
  /网银|银行|支付宝|微信支付|paypal|stripe/i,
  /windows\s*安全|windows\s*security|用户账户控制|\buac\b|凭据管理器/i,
  /regedit|注册表编辑器/i,
  /远程桌面连接|teamviewer|anydesk|向日葵/i,
]

/** Window/menu labels that imply an irreversible or high-impact outcome. */
export const DANGER_VERBS: readonly RegExp[] = [
  /删除|移除|清空|卸载|格式化|抹除|注销|退出登录|关闭账户/,
  /\bdelete\b|\bremove\b|\buninstall\b|\bformat\b|\bwipe\b|\bsign\s*out\b|\blog\s*out\b/i,
  /支付|付款|转账|汇款|购买|下单|充值|提现/,
  /\bpay\b|\bpurchase\b|\btransfer\b|\bcheckout\b|\bwithdraw\b/i,
  /发送|发布|提交订单|群发/,
  /\bsend\b|\bpublish\b|\bpost\b|\bsubmit\b/i,
]

export interface PolicyPrefs {
  computerUseAppDenylist?: string[]
  computerUseAllowlistMode?: boolean
  computerUseAppAllowlist?: string[]
}

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string }

/** `identity` = window title + process name, lower-cased by the caller or not. */
export function matchesDenyList(identity: string, extra: string[] = []): string | null {
  for (const re of BUILTIN_DENY_PATTERNS) {
    if (re.test(identity)) return `命中内置敏感应用黑名单（${re.source}）`
  }
  for (const raw of extra) {
    const needle = String(raw || '').trim().toLowerCase()
    if (!needle) continue
    if (identity.toLowerCase().includes(needle)) return `命中自定义黑名单（${needle}）`
  }
  return null
}

export function checkAppAllowed(identity: string, prefs: PolicyPrefs): PolicyVerdict {
  const denied = matchesDenyList(identity, prefs.computerUseAppDenylist)
  if (denied) return { allowed: false, reason: `该应用被策略屏蔽：${denied}。需要用户手动操作。` }
  if (prefs.computerUseAllowlistMode) {
    const allow = (prefs.computerUseAppAllowlist ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    if (allow.length) {
      const id = identity.toLowerCase()
      if (!allow.some((a) => id.includes(a))) {
        return { allowed: false, reason: '当前是白名单模式，该应用不在允许列表里。' }
      }
    }
  }
  return { allowed: true }
}

const CREDENTIAL_LIKE = [
  /^\d{6}$/,                                        // OTP
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/,         // strong password shape
  /\b(?:password|passwd|pwd|token|secret)\s*[:=]/i,
]

export function looksLikeCredential(text: string): boolean {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return false
  return CREDENTIAL_LIKE.some((re) => re.test(trimmed))
}

export interface DangerVerdict {
  danger?: { reason: string }
}

/**
 * Action-level danger analysis. A hit forces the approval card (allow once /
 * deny) and makes the main process refuse the call unless `confirm === true`.
 */
export function analyzeActionDanger(opts: {
  kind: CuaActionKind
  appIdentity: string
  targetLabel?: string
  text?: string
  path?: string
}): DangerVerdict {
  const label = `${opts.targetLabel ?? ''}`
  if ((opts.kind === 'click' || opts.kind === 'performAction' || opts.kind === 'key') && label) {
    for (const re of DANGER_VERBS) {
      if (re.test(label)) return { danger: { reason: `目标「${label}」看起来不可逆或高影响（${re.source}）` } }
    }
  }
  if (opts.kind === 'type' || opts.kind === 'setValue' || opts.kind === 'paste') {
    if (looksLikeCredential(opts.text ?? '')) {
      return { danger: { reason: '输入内容看起来是密码/验证码/令牌：请用户亲自输入。' } }
    }
  }
  if (opts.kind === 'launch') {
    const p = String(opts.path ?? '')
    if (/\.(exe|msi|bat|cmd|ps1|scr|vbs)$/i.test(p) && /[\\/](downloads|下载|temp|tmp)[\\/]/i.test(p)) {
      return { danger: { reason: `启动的是下载目录里的可执行文件（${p}）` } }
    }
  }
  return {}
}
