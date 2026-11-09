/**
 * 设置面的排版件（不是组件库，只是把「纯白 + 单一无衬线 + 纯文字动作」这套
 * 规则落成几个可复用的壳）。
 *
 * 约定（OurCode Pure）：
 *  - 行与行只靠留白分开，不画分隔线、不包卡片、不加彩色 chip；
 *  - 容器圆角最大 12px；动作一律是文字，hover 才从 muted 变 ink；
 *  - 等宽只出现在键位、URL、命令、请求头这类机器串上；
 *  - 颜色只走 pure.css 的 CSS 变量，不写色值。
 */
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

export const TEXT_ACTION =
  'pure-focus whitespace-nowrap text-[12px] leading-[18px] text-[var(--pure-muted)] hover:text-[var(--pure-ink)] transition-colors disabled:opacity-40 disabled:hover:text-[var(--pure-muted)]'

export const TEXT_ACTION_DANGER =
  'pure-focus whitespace-nowrap text-[12px] leading-[18px] text-[var(--pure-muted)] hover:text-[var(--pure-danger)] transition-colors disabled:opacity-40'

interface TextActionProps {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
  /** 读屏用的明确标签（默认取 title） */
  label?: string
  danger?: boolean
  autoFocus?: boolean
}

export function TextAction({ children, onClick, disabled, title, label, danger, autoFocus }: TextActionProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        // 行内动作不冒泡成「整行激活」，避免点一次触发两次
        event.stopPropagation()
        onClick()
      }}
      disabled={disabled}
      title={title}
      aria-label={label ?? title}
      autoFocus={autoFocus}
      className={danger ? TEXT_ACTION_DANGER : TEXT_ACTION}
    >
      {children}
    </button>
  )
}

interface SectionHeadingProps {
  title: string
  hint?: string
  children?: ReactNode
}

/** 内容列的标题行：20px ink + 右侧文字动作。 */
export function SectionHeading({ title, hint, children }: SectionHeadingProps) {
  return (
    <header className="flex items-start gap-4 pb-1">
      <div className="min-w-0 flex-1">
        <h2 className="text-[20px] leading-[28px] text-[var(--pure-ink)]">{title}</h2>
        {hint ? <p className="pt-1 text-[12px] leading-[18px] text-[var(--pure-muted)]">{hint}</p> : null}
      </div>
      {children ? <div className="shrink-0 flex items-center gap-3 pt-1.5">{children}</div> : null}
    </header>
  )
}

/**
 * 分组小标签：12px muted。
 *
 * 分组之间有一条 1px 极浅分隔线 —— 这是设置面唯一使用分隔线的地方：
 * 行内仍然只靠留白，组与组之间要有「这里是另一块」的边界（长表单里
 * 纯留白会让人读成一整片）。
 */
export function GroupLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="mt-7 flex items-baseline gap-2 border-t border-[var(--pure-border)] pb-1 pt-4">
      <span className="text-[12px] leading-[18px] text-[var(--pure-muted)]">{children}</span>
      {trailing ? (
        <span className="ml-auto text-[11.5px] leading-[18px] text-[var(--pure-muted)]">{trailing}</span>
      ) : null}
    </div>
  )
}

interface RowProps {
  label: string
  description?: ReactNode
  children?: ReactNode
  /** 控件另起一行占满宽度（长 URL / 多行文本） */
  stacked?: boolean
}

/** 一行设置：左标题 + 说明，右侧控件；不画分隔线。 */
export function Row({ label, description, children, stacked }: RowProps) {
  if (stacked) {
    return (
      <div className="py-2.5">
        <div className="text-[13px] leading-[20px] text-[var(--pure-ink)]">{label}</div>
        {description ? (
          <div className="pt-0.5 text-[12px] leading-[18px] text-[var(--pure-muted)]">{description}</div>
        ) : null}
        {children ? <div className="pt-2">{children}</div> : null}
      </div>
    )
  }
  return (
    <div className="flex items-start justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] leading-[20px] text-[var(--pure-ink)]">{label}</div>
        {description ? (
          <div className="pt-0.5 text-[12px] leading-[18px] text-[var(--pure-muted)]">{description}</div>
        ) : null}
      </div>
      <div className="shrink-0 flex items-center gap-2">{children}</div>
    </div>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}

/** 开关：原生 button + role=switch，键盘可达；开=ink 轨道，关=浅灰轨道。 */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`pure-focus relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
      }`}
      style={{ background: checked ? 'var(--pure-ink)' : 'var(--pure-hover)' }}
    >
      <span
        aria-hidden="true"
        className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-[var(--pure-canvas)] transition-transform"
        style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  )
}

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (next: T) => void
  disabled?: boolean
}

/** 分段选择：浅灰轨道 + 白色当前项，没有描边。 */
export function Segmented<T extends string>({ label, value, options, onChange, disabled }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-0.5 rounded-xl bg-[var(--pure-hover)] p-0.5">
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            aria-label={`${label}：${option.label}`}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`pure-focus rounded-[10px] px-2.5 py-1 text-[12px] leading-[18px] transition-colors ${
              active
                ? 'bg-[var(--pure-canvas)] text-[var(--pure-ink)]'
                : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
            } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-label'> {
  label: string
  /** 机器串（URL / 模型名 / 密钥）用等宽 */
  mono?: boolean
}

export function TextInput({ label, mono, className = '', ...rest }: TextInputProps) {
  // 调用方显式给了宽度（w-[220px] / w-full）时不再叠加默认 w-full，
  // 免得两条宽度工具类打架、谁后生成谁赢。
  const widthClass = /(^|\s)w-/.test(className) ? '' : 'w-full'
  return (
    <input
      aria-label={label}
      spellCheck={false}
      {...rest}
      className={`pure-focus h-8 ${widthClass} rounded-xl border-0 bg-[var(--pure-code)] px-3 text-[12.5px] leading-[18px] text-[var(--pure-ink)] outline-none placeholder:text-[var(--pure-muted)] ${
        mono ? 'font-mono text-[11.5px]' : ''
      } ${className}`}
    />
  )
}

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-label'> {
  label: string
  mono?: boolean
}

export function TextArea({ label, mono, className = '', ...rest }: TextAreaProps) {
  return (
    <textarea
      aria-label={label}
      spellCheck={false}
      {...rest}
      className={`pure-focus w-full resize-y rounded-xl border-0 bg-[var(--pure-code)] px-3 py-2 text-[12.5px] leading-[19px] text-[var(--pure-ink)] outline-none placeholder:text-[var(--pure-muted)] ${
        mono ? 'font-mono text-[11.5px] leading-[18px]' : ''
      } ${className}`}
    />
  )
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-label'> {
  label: string
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
}

export function SelectField({ label, options, className = '', ...rest }: SelectFieldProps) {
  return (
    <select
      aria-label={label}
      {...rest}
      className={`pure-focus h-8 max-w-full rounded-xl border-0 bg-[var(--pure-code)] pl-2.5 pr-1.5 text-[12.5px] leading-[18px] text-[var(--pure-ink)] outline-none cursor-pointer ${className}`}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

interface KeyCapProps {
  children: ReactNode
  onClick?: () => void
  label: string
  editable?: boolean
}

/** 键位：等宽浅灰小块；只有可编辑时才是一个按钮。 */
export function KeyCap({ children, onClick, label, editable }: KeyCapProps) {
  const shell =
    'inline-flex items-center rounded-md bg-[var(--pure-code)] px-1.5 py-0.5 font-mono text-[11.5px] leading-[18px] text-[var(--pure-ink)]'
  if (!editable || !onClick) {
    return <span className={shell}>{children}</span>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`pure-focus ${shell} hover:bg-[var(--pure-hover)] transition-colors`}
    >
      {children}
    </button>
  )
}

interface InlineConfirmProps {
  message: string
  detail?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 行内二次确认（不用 window.confirm，键盘可达、样式与面板一致）。
 * 语义上是 alertdialog 的轻量版：读屏会立即念出确认文案。
 */
export function InlineConfirm({
  message,
  detail,
  confirmLabel,
  cancelLabel = '取消',
  danger,
  onConfirm,
  onCancel,
}: InlineConfirmProps) {
  return (
    <div className="rounded-xl bg-[var(--pure-code)] px-3 py-2.5" role="group" aria-label={message}>
      <div className="text-[12.5px] leading-[19px] text-[var(--pure-ink)]" role="alert">
        {message}
      </div>
      {detail ? <div className="pt-0.5 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">{detail}</div> : null}
      <div className="flex items-center gap-3 pt-2">
        <TextAction onClick={onCancel} label={cancelLabel}>
          {cancelLabel}
        </TextAction>
        <TextAction onClick={onConfirm} danger={danger} label={confirmLabel}>
          {confirmLabel}
        </TextAction>
      </div>
    </div>
  )
}

export type StatusTone = 'muted' | 'ok' | 'error'

export function StatusLine({ tone = 'muted', children }: { tone?: StatusTone; children: ReactNode }) {
  const color =
    tone === 'error'
      ? 'text-[var(--pure-danger)]'
      : tone === 'ok'
        ? 'text-[var(--pure-ink)]'
        : 'text-[var(--pure-muted)]'
  return (
    <div className={`text-[11.5px] leading-[18px] ${color}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

/** 等宽信息行（URL / 命令 / 路径），浅灰底、无描边。 */
export function MonoLine({ children }: { children: ReactNode }) {
  return <div className="pure-mono-well break-all">{children}</div>
}
