/**
 * composer 浮层的共用壳与图标（纯视觉，无业务）。
 *
 * 纯风契约：唯一阴影（`pure-card-shadow`）、12px 圆角、1px `--pure-border`、
 * 一律走 `var(--pure-*)`，不出现 hex、不写内联 style。
 *
 * a11y：每个浮层都是 `role="dialog"` + `aria-label`（设计稿里的三个浮层都是
 * 「带标题的面板」而不是操作菜单：里面还有搜索框、分段控件这些非 menuitem 控件）。
 */
import { useEffect, useRef, type ReactNode } from 'react'

/** 点击外部 / Esc 关闭浮层：ref 同时包住触发器和面板，避免 toggle 与 outside 打架 */
export function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      // 浮层内部的 Esc 由面板自己处理（要顺手把焦点还给触发器）；这里只兜底
      if (e.key === 'Escape' && !e.defaultPrevented) close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [close, open])
  return ref
}

export function Chevron({ open }: { open?: boolean }) {
  return (
    <svg
      className={`w-3 h-3 shrink-0 text-[var(--pure-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function Check({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg
      className={`${className} shrink-0 text-[var(--pure-ink)]`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 13l5 5L20 6" />
    </svg>
  )
}

export interface PopoverProps {
  children: ReactNode
  /** 宽度/对齐的 tailwind class（历史调用点传的是整串 class） */
  width?: string
  /** role=dialog 的可读名字，必填（图标按钮的浮层也要能被读屏叫出来） */
  label: string
  /** 面板内边距 12px（设计稿：模型/权限浮层是「有留白的面板」，附件菜单是行列表） */
  padded?: boolean
  maxHeightClass?: string
  /** 屏幕小的时候允许横向收窄 */
  extraClass?: string
}

/** 浮层外壳：向上展开（composer 永远贴底） */
export function Popover({
  children,
  width = 'w-[224px]',
  label,
  padded = false,
  maxHeightClass = 'max-h-[320px]',
  extraClass = '',
}: PopoverProps) {
  return (
    <div
      role="dialog"
      aria-label={label}
      className={`absolute bottom-full left-0 mb-2 z-50 ${width} rounded-xl border border-[var(--pure-border)] bg-[var(--surface)] pure-card-shadow ${maxHeightClass} overflow-y-auto pure-scroll ${
        padded ? 'p-3' : 'py-1'
      } ${extraClass}`}
    >
      {children}
    </div>
  )
}

/** 附件菜单用的一行（图标 + 文本），与设计稿的行高节奏一致 */
export function MenuRow({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean
  onClick: () => void
  children: ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors ${
        active
          ? 'text-[var(--pure-ink)] bg-[var(--pure-hover)]'
          : 'text-[var(--pure-secondary)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]'
      }`}
    >
      {children}
    </button>
  )
}
