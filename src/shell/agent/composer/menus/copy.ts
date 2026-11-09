/**
 * composer 三个浮层的全部文案（中英双语，纯数据，无 React / 无 store 依赖）。
 *
 * 为什么单独一份，而不是塞进 `src/i18n`：
 *  - 这里的措辞是设计稿定死的「纯语言描述」（`detail-01-permission-modes` /
 *    `detail-03-model-picker`），和 i18n 里已有的短标签不是同一批字符串；
 *  - i18n 的词条被 `TranslationKey` 类型锁死，新增词条要改 i18n 字典；composer
 *    这一片自带一份可单测的文案表，改设计时只动这一个文件。
 *  - 数据是纯的：`copyFor(locale)` 只是查表，测试可以直接断言。
 */

export type MenuLocale = 'zh-CN' | 'en-US'

export interface MenuCopy {
  /** 模型浮层搜索框占位 */
  searchModels: string
  /** 收藏行前缀标签 */
  favoritesLabel: string
  /** 搜索无结果行 */
  emptySearch: string
  /** 清空搜索词按钮的 aria-label */
  clearSearch: string
  /** 思考档位分段控件上方的标签 */
  thinkingLabel: string
  /** 当前模型行右侧的用量后缀（`{percent}` 为整数百分比） */
  usedThisChat: string
  /** 权限浮层顶部一行：`当前：<模式> · <一句后果>` */
  currentPrefix: string
  /** 权限浮层底部提示 */
  modeHint: string
  /** 三个浮层的 aria-label */
  modelDialog: string
  modeDialog: string
  attachmentDialog: string
  slashDialog: string
  fileSearchDialog: string
  /** 能力行的词（只在模型配置真的给出该能力时才出现） */
  capabilityVision: string
  capabilityTools: string
  capabilityFree: string
  /** 模型列表为空（还没配 provider） */
  noModels: string
}

export const MENU_COPY: Record<MenuLocale, MenuCopy> = {
  'zh-CN': {
    searchModels: '搜索模型',
    favoritesLabel: '收藏',
    emptySearch: '没有匹配的模型',
    clearSearch: '清空搜索词',
    thinkingLabel: '思考档位',
    usedThisChat: '本次已用 {percent}%',
    currentPrefix: '当前：',
    modeHint: 'Shift+Tab 循环切换 · 当前会话内生效',
    modelDialog: '模型与思考档位',
    modeDialog: '权限模式',
    attachmentDialog: '添加附件',
    slashDialog: '斜杠命令',
    fileSearchDialog: '引用文件',
    capabilityVision: '视觉',
    capabilityTools: '函数调用',
    capabilityFree: '免费',
    noModels: '还没有可用模型：先去设置里添加提供商和 API Key',
  },
  'en-US': {
    searchModels: 'Search models',
    favoritesLabel: 'Favorites',
    emptySearch: 'No matching models',
    clearSearch: 'Clear search',
    thinkingLabel: 'Thinking level',
    usedThisChat: 'Used {percent}% this chat',
    currentPrefix: 'Current: ',
    modeHint: 'Shift+Tab cycles · applies to this session',
    modelDialog: 'Model and thinking level',
    modeDialog: 'Permission mode',
    attachmentDialog: 'Add attachment',
    slashDialog: 'Slash commands',
    fileSearchDialog: 'Reference a file',
    capabilityVision: 'Vision',
    capabilityTools: 'Tool calling',
    capabilityFree: 'Free',
    noModels: 'No models yet — add a provider and API key in Settings',
  },
}

/** 查表 + `{var}` 插值；缺 key 时原样返回模板，绝不抛错。 */
export function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  )
}

export function copyFor(locale: MenuLocale): MenuCopy {
  return MENU_COPY[locale] ?? MENU_COPY['zh-CN']
}

/** `本次已用 42%` / `Used 42% this chat` */
export function usedThisChatText(locale: MenuLocale, percent: number): string {
  return fill(copyFor(locale).usedThisChat, { percent })
}

/** `当前：手动确认 · 每次工具调用都会停下来等你确认` */
export function currentModeLine(locale: MenuLocale, modeLabel: string, consequence: string): string {
  const { currentPrefix } = copyFor(locale)
  return `${currentPrefix}${modeLabel}${locale === 'en-US' ? ' — ' : ' · '}${consequence}`
}
