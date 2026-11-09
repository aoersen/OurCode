/**
 * 浮层键盘模型（纯逻辑 + 一个受控 hook）。
 *
 * 三个 composer 浮层（模型 / 权限 / 附件…）共用同一套键位：
 *   ↑/↓ 移动高亮行 · Enter 选中 · Esc 关闭 · ←/→ 只在模型浮层里改思考档位。
 *
 * 键位解释被抽成纯函数 `menuKeyIntent`，测试不需要 DOM；hook 只负责把意图
 * 落成状态变化。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

export type MenuKeyIntent = 'up' | 'down' | 'select' | 'close' | 'level-prev' | 'level-next'

export interface MenuKeyContext {
  /** 焦点在搜索输入框里：←/→ 归输入框（挪光标），不归分段控件 */
  inTextInput?: boolean
  /** 这个浮层有没有思考档位分段控件 */
  allowLevels?: boolean
}

export function menuKeyIntent(key: string, ctx: MenuKeyContext = {}): MenuKeyIntent | null {
  if (key === 'Escape') return 'close'
  if (key === 'ArrowDown') return 'down'
  if (key === 'ArrowUp') return 'up'
  if (key === 'Enter') return 'select'
  if (!ctx.allowLevels || ctx.inTextInput) return null
  if (key === 'ArrowLeft') return 'level-prev'
  if (key === 'ArrowRight') return 'level-next'
  return null
}

/** 高亮索引夹在 [0, count-1]；count 为 0 时返回 0。 */
export function clampHighlight(index: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(count - 1, Math.max(0, index))
}

/** 上下移动：到边界停住（和 @ 文件列表、斜杠菜单的旧行为一致，不回绕）。 */
export function moveHighlight(index: number, count: number, delta: number): number {
  return clampHighlight(index + delta, count)
}

export interface MenuKeyboardOptions {
  /** 当前可选中行数 */
  count: number
  /** 打开时默认高亮（通常是当前选中项） */
  initialIndex?: number
  /** 这个值变化时把高亮重置回 initialIndex（例如搜索词变了） */
  resetKey?: unknown
  onSelect: (index: number) => void
  onClose: () => void
  /** 有则启用 ←/→ */
  onLevelStep?: (direction: 1 | -1) => void
}

export interface MenuKeyboard {
  index: number
  setIndex: (index: number) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  /** 行元素绑 ref，用于键盘移动时把它滚进可视区 */
  rowRef: (index: number) => (node: HTMLElement | null) => void
}

export function useMenuKeyboard({
  count,
  initialIndex = 0,
  resetKey,
  onSelect,
  onClose,
  onLevelStep,
}: MenuKeyboardOptions): MenuKeyboard {
  const [index, setIndex] = useState(() => clampHighlight(initialIndex, count))
  const rows = useRef(new Map<number, HTMLElement>())

  // 搜索词/模型列表变化：高亮回到默认行，且不能越界
  useEffect(() => {
    setIndex(clampHighlight(initialIndex, count))
  }, [count, initialIndex, resetKey])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inTextInput =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true)
      const intent = menuKeyIntent(e.key, { inTextInput, allowLevels: !!onLevelStep })
      if (!intent) return
      e.preventDefault()
      e.stopPropagation()

      if (intent === 'close') {
        onClose()
        return
      }
      if (intent === 'select') {
        if (count > 0) onSelect(clampHighlight(index, count))
        return
      }
      if (intent === 'level-prev' || intent === 'level-next') {
        onLevelStep?.(intent === 'level-next' ? 1 : -1)
        return
      }
      const next = moveHighlight(index, count, intent === 'down' ? 1 : -1)
      setIndex(next)
      rows.current.get(next)?.scrollIntoView({ block: 'nearest' })
    },
    [count, index, onClose, onLevelStep, onSelect],
  )

  const rowRef = useCallback(
    (i: number) => (node: HTMLElement | null) => {
      if (node) rows.current.set(i, node)
      else rows.current.delete(i)
    },
    [],
  )

  return { index, setIndex: (i) => setIndex(clampHighlight(i, count)), onKeyDown, rowRef }
}
