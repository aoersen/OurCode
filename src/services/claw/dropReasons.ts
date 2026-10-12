/**
 * 接入控制拦截原因的展示文案。
 *
 * 判定在主进程（ClawManager），文案在渲染层：同一个 reason 在不同语言下要有
 * 不同说法，而主进程只该产出稳定的 reason id。日志用的中文短句留在主进程，
 * 这里只服务界面。
 */
import type { TranslationKey } from '@/i18n'
import { isClawDropReason } from '@shared/claw'

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

export function dropReasonText(reason: string, t: Translate): string {
  if (!isClawDropReason(reason)) return reason
  return t(`claw.drop.${reason}` as TranslationKey)
}
