import { forwardRef } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-nova-accent text-white hover:opacity-90',
  secondary: 'bg-nova-hover text-nova-text-secondary hover:text-nova-text-primary',
  ghost: 'text-nova-text-secondary hover:bg-nova-hover hover:text-nova-text-primary',
  danger: 'bg-error text-white hover:opacity-90',
}

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-1 text-xs rounded-md',
  md: 'px-4 py-2 text-sm rounded-lg',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** 撑满父容器宽度（对话框主按钮、空状态 CTA 常用） */
  block?: boolean
}

/**
 * 全站此前有 388 个各写各的 <button>：同一层级的"主按钮"在对话框里是
 * `px-4 py-2 text-sm rounded-lg`，在设置里是 `px-3.5 py-1.5 text-[13px]`，
 * 在空状态里又是另一套，禁用态和 hover 反馈也时有时无。统一收在这里。
 * 焦点环由 global.css 的 :focus-visible 全局规则提供。
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block, className = '', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]}${block ? ' w-full' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    />
  )
})

export default Button
