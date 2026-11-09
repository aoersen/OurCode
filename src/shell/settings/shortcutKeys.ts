/**
 * 快捷键的纯文本模型 —— 纯函数，node 环境可单测。
 *
 * 键位字符串是 store 里既有的口径（`matchesShortcut` 按 `+` 拆、最后一段是键、
 * `Ctrl` 同时代表 Cmd）。这里只做三件事：
 *   1. 把键盘事件 / 手输文本收敛成同一种写法（`Ctrl+Shift+P`）；
 *   2. 拦住「裸的可打印字符」——否则单按一个 a 就会触发动作；
 *   3. 找出重复绑定、按类别分组。
 */

export interface KeyChord {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

const MODIFIER_KEYS = new Set([
  'Control',
  'Ctrl',
  'Meta',
  'Cmd',
  'Command',
  'OS',
  'Alt',
  'AltGraph',
  'Option',
  'Shift',
  'CapsLock',
])

/** 修饰键写法归一：Ctrl 与 Cmd 在 store 里是同一件事。 */
const MODIFIER_ALIASES: Record<string, 'Ctrl' | 'Alt' | 'Shift'> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  meta: 'Ctrl',
  super: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
}

/**
 * 不带修饰键也允许单独绑定的键：功能键与导航/编辑键。
 * 其余可打印字符必须带修饰键，避免「输入即触发」。
 */
const BARE_KEYS = new Set([
  'Enter',
  'Return',
  'Tab',
  'Space',
  'Escape',
  'Esc',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Up',
  'Down',
  'Left',
  'Right',
])

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  space: 'Space',
  spacebar: 'Space',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  bs: 'Backspace',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
}

function hasOwn(map: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key)
}

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key) || hasOwn(MODIFIER_ALIASES, key.toLowerCase())
}

/** 把单个键名收敛成展示写法；修饰键或空值返回 null。 */
export function normalizeKeyToken(key: string): string | null {
  // 空格键在 trim 之后就是空串，必须在 trim 之前认出来
  if (key === ' ') return 'Space'
  const raw = key.trim()
  if (!raw) return null
  // '+' 本身没有可用写法：键位字符串以 '+' 分段，必然拆坏
  if (raw === '+') return null
  if (isModifierKey(raw)) return null

  const lower = raw.toLowerCase()
  if (hasOwn(KEY_ALIASES, lower)) return KEY_ALIASES[lower]
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase()
  if (raw.length === 1) return raw === ' ' ? 'Space' : raw.toUpperCase()
  // 其余（MediaPlayPause 之类）原样保留，首字母大写方便阅读
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

function allowedBareKey(token: string): boolean {
  return BARE_KEYS.has(token) || /^F\d{1,2}$/.test(token)
}

/** 键盘事件 → `Ctrl+Shift+P`；非法（只有修饰键 / 裸可打印字符）返回 null。 */
export function formatShortcut(chord: KeyChord): string | null {
  const token = normalizeKeyToken(chord.key)
  if (!token) return null
  const parts: string[] = []
  if (chord.ctrlKey || chord.metaKey) parts.push('Ctrl')
  if (chord.altKey) parts.push('Alt')
  if (chord.shiftKey) parts.push('Shift')
  if (parts.length === 0 && !allowedBareKey(token)) return null
  parts.push(token)
  return parts.join('+')
}

/** 手输文本 → 与 store 一致的写法；无法识别返回 null。 */
export function normalizeShortcutText(text: string): string | null {
  const raw = text.trim()
  if (!raw) return null
  const segments = raw
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (segments.length === 0) return null

  const modifiers = new Set<'Ctrl' | 'Alt' | 'Shift'>()
  let keyToken: string | null = null

  for (const segment of segments) {
    const lower = segment.toLowerCase()
    const alias = hasOwn(MODIFIER_ALIASES, lower) ? MODIFIER_ALIASES[lower] : undefined
    if (alias) {
      modifiers.add(alias)
      continue
    }
    // 键名只取第一段非修饰键（多出来的段视为噪声）
    if (keyToken === null) keyToken = normalizeKeyToken(segment)
  }

  if (!keyToken) return null
  if (modifiers.size === 0 && !allowedBareKey(keyToken)) return null

  const parts: string[] = []
  if (modifiers.has('Ctrl')) parts.push('Ctrl')
  if (modifiers.has('Alt')) parts.push('Alt')
  if (modifiers.has('Shift')) parts.push('Shift')
  parts.push(keyToken)
  return parts.join('+')
}

/** 键帽展示用：`Ctrl+Shift+P` → ['Ctrl', 'Shift', 'P']。 */
export function shortcutTokens(keys: string): string[] {
  return keys
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
}

export const SHORTCUT_CATEGORY_ORDER = ['file', 'edit', 'view', 'chat', 'ai', 'terminal'] as const

export const SHORTCUT_CATEGORY_LABELS: Record<string, string> = {
  file: '文件操作',
  edit: '编辑',
  view: '视图',
  chat: 'AI 助手',
  ai: 'AI 内联',
  terminal: '终端',
}

export function categoryLabel(category: string): string {
  return SHORTCUT_CATEGORY_LABELS[category] ?? category
}

export interface ShortcutGroup<T> {
  category: string
  label: string
  items: T[]
}

/**
 * 按固定类别顺序分组；空类别不出现，未知类别排在最后（保持出现顺序）。
 */
export function groupShortcuts<T extends { category: string }>(items: ReadonlyArray<T>): ShortcutGroup<T>[] {
  const known = SHORTCUT_CATEGORY_ORDER as ReadonlyArray<string>
  const order: string[] = [...known]
  for (const item of items) {
    if (!order.includes(item.category)) order.push(item.category)
  }
  const groups: ShortcutGroup<T>[] = []
  for (const category of order) {
    const groupItems = items.filter((item) => item.category === category)
    if (groupItems.length === 0) continue
    groups.push({ category, label: categoryLabel(category), items: groupItems })
  }
  return groups
}

export interface ShortcutConflict {
  keys: string
  ids: string[]
}

/** 找出被多个动作共用的键位（忽略大小写与顺序差异）。 */
export function findShortcutConflicts(items: ReadonlyArray<{ id: string; keys: string }>): ShortcutConflict[] {
  const buckets = new Map<string, string[]>()
  for (const item of items) {
    const normalized = normalizeShortcutText(item.keys)
    if (!normalized) continue
    const bucket = buckets.get(normalized)
    if (bucket) bucket.push(item.id)
    else buckets.set(normalized, [item.id])
  }
  const conflicts: ShortcutConflict[] = []
  for (const [keys, ids] of buckets) {
    if (ids.length > 1) conflicts.push({ keys, ids })
  }
  return conflicts.sort((a, b) => a.keys.localeCompare(b.keys))
}

/** 只有「自定义」方案才允许逐条重绑（与旧设置面板一致）。 */
export function isEditablePreset(preset: string): boolean {
  return preset === 'custom'
}
