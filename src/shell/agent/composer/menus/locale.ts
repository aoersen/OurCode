/**
 * 界面语言解析（composer 浮层用，纯函数 + 一个订阅 hook）。
 *
 * 和 `useI18n` 走同一套规则（偏好 → 系统 locale → 具体语言），只是这里要的是
 * 「语言本身」而不是翻译函数：浮层文案在 `menus/copy.ts` 里成对存放。
 */
import { useEditorStore } from '@/stores/editorStore'
import { getSystemLocale, resolveLocale, type LanguagePreference } from '@/i18n'

export type MenuLocale = 'zh-CN' | 'en-US'

export function resolveMenuLocale(
  preference: LanguagePreference | undefined,
  systemLocale: string,
): MenuLocale {
  return resolveLocale(preference, systemLocale) === 'en-US' ? 'en-US' : 'zh-CN'
}

/** 语言切换时随 zustand 订阅重渲染，文案即时跟着变。 */
export function useMenuLocale(): MenuLocale {
  const language = useEditorStore((s) => s.preferences.language)
  return resolveMenuLocale((language ?? 'system') as LanguagePreference, getSystemLocale())
}
