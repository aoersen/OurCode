/**
 * 设置面的导航模型 —— 纯函数，node 环境可单测。
 *
 * 新壳的设置是全窗口两栏面（左 200px 纯文字导航 + 右 760px 内容列），
 * 不再是旧弹窗的五个 tab。这里只负责「有哪几栏 / 打开目标落到哪一栏 /
 * ↑↓ 怎么走」，状态与副作用全部留在 SettingsSurface 里。
 */

/** 设置面的七栏（顺序即导航顺序）。 */
export type SettingsTabId =
  | 'api'
  | 'appearance'
  | 'editor'
  | 'shortcuts'
  | 'features'
  | 'mcp'
  | 'about'

export interface SettingsTabEntry {
  id: SettingsTabId
  /** 导航里的纯文字（不加图标、不加胶囊） */
  label: string
  /** 读屏与 title 用的补充说明 */
  title: string
}

export const SETTINGS_TABS: ReadonlyArray<SettingsTabEntry> = [
  { id: 'api', label: 'API 与模型', title: '接入点、密钥、默认模型、请求头与连接测试' },
  { id: 'appearance', label: '外观', title: '主题、强调色、界面语言与字号' },
  { id: 'editor', label: '编辑器与 AI', title: '编辑器行为、AI 助手开关、语言服务与请求日志' },
  { id: 'shortcuts', label: '快捷键', title: '键位预设与单条重绑' },
  { id: 'features', label: '功能', title: '软件更新、渠道接入、插件、电脑操控与无限制模式' },
  { id: 'mcp', label: 'MCP 服务器', title: 'stdio / HTTP 服务器列表、表单与校验' },
  { id: 'about', label: '关于', title: '版本、协议与危险重置' },
]

export const SETTINGS_TAB_IDS: ReadonlyArray<SettingsTabId> = SETTINGS_TABS.map((tab) => tab.id)

/**
 * 旧弹窗的设置目标（`uiStore.settingsTarget.tab` 是 'api' | 'appearance' |
 * 'editor' | 'shortcuts' | 'features'）以及外部调用方可能传来的别名。
 * 新壳多出 'mcp' / 'about' 两栏，旧名一律按语义落到最近的栏。
 */
const TAB_ALIASES: Record<string, SettingsTabId> = {
  api: 'api',
  apis: 'api',
  models: 'api',
  model: 'api',
  'api-models': 'api',
  'api-config': 'api',
  connection: 'api',
  appearance: 'appearance',
  theme: 'appearance',
  ui: 'appearance',
  editor: 'editor',
  'editor-ai': 'editor',
  editorai: 'editor',
  ai: 'editor',
  lsp: 'editor',
  shortcuts: 'shortcuts',
  shortcut: 'shortcuts',
  keys: 'shortcuts',
  keybindings: 'shortcuts',
  features: 'features',
  feature: 'features',
  plugins: 'features',
  plugin: 'features',
  update: 'features',
  computer: 'features',
  nolimits: 'features',
  'no-limits': 'features',
  channel: 'features',
  claw: 'features',
  mcp: 'mcp',
  'mcp-servers': 'mcp',
  mcpservers: 'mcp',
  about: 'about',
  info: 'about',
  reset: 'about',
}

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return typeof value === 'string' && (SETTINGS_TAB_IDS as ReadonlyArray<string>).includes(value)
}

/**
 * 打开目标 → 栏。未知值（含 undefined / 空串 / 垃圾字符串）一律回到首栏，
 * 这样「去设置」永远不会把用户丢在一个空白栏上。
 */
export function resolveSettingsTab(value?: string | null): SettingsTabId {
  const key = (value ?? '').trim().toLowerCase()
  if (!key) return 'api'
  if (isSettingsTabId(key)) return key
  return TAB_ALIASES[key] ?? 'api'
}

export function settingsTabLabel(id: SettingsTabId): string {
  return SETTINGS_TABS.find((tab) => tab.id === id)?.label ?? id
}

export function settingsTabTitle(id: SettingsTabId): string {
  return SETTINGS_TABS.find((tab) => tab.id === id)?.title ?? ''
}

export function settingsTabIndexOf(id: SettingsTabId): number {
  const index = SETTINGS_TAB_IDS.indexOf(id)
  return index < 0 ? 0 : index
}

/**
 * 导航的方向键（循环）。只吃 ↑/↓ 与 Home/End；其余键返回 null 交给调用方。
 */
export function nextSettingsTab(current: SettingsTabId, key: string): SettingsTabId | null {
  const index = settingsTabIndexOf(current)
  const last = SETTINGS_TABS.length - 1
  switch (key) {
    case 'ArrowDown':
      return SETTINGS_TABS[index === last ? 0 : index + 1].id
    case 'ArrowUp':
      return SETTINGS_TABS[index === 0 ? last : index - 1].id
    case 'Home':
      return SETTINGS_TABS[0].id
    case 'End':
      return SETTINGS_TABS[last].id
    default:
      return null
  }
}
