import { forwardRef } from 'react'

/**
 * 统一输入框样式。此前 68 个 input/textarea 各自重复
 * `rounded-lg outline-none focus:border-nova-accent`，其中只 4 个写了聚焦态，
 * 其余在键盘操作时看不出焦点在哪。
 */
const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`w-full px-3 py-2 text-sm rounded-lg bg-nova-input-bg border border-nova-border text-nova-text-primary placeholder:text-nova-text-placeholder outline-none focus:border-nova-accent${className ? ` ${className}` : ''}`}
        {...rest}
      />
    )
  },
)

export default Input
