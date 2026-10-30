/**
 * Settings UI primitives — the single source of truth for how the settings
 * surface looks. Every settings tab is built from these parts, so typography,
 * spacing, radii and colour stay identical across tabs.
 *
 * Design contract (aioli default theme, mapped onto the app's `nova` tokens):
 *  - type scale: 18 / 14 / 13 / 12 px only (no 10px body text)
 *  - spacing: 4px grid → gap-1 / gap-2 / gap-3 / gap-4 / gap-5 / gap-6
 *  - radii: controls 8px, cards 12px, capsules full
 *  - colour: semantic CSS variables only (`nova-*`, `accent`, `error`, …) —
 *    no literal hex, no raw tailwind palette (red-400 / green-400 / yellow-400)
 *  - a11y: every control has an accessible name, every toggle is a real
 *    `role="switch"` with `aria-checked`
 */
import {
  createContext,
  useContext,
  type ReactNode,
  type SelectHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type ButtonHTMLAttributes,
} from 'react'

// ── type scale ──────────────────────────────────────────────────────────────
export const T_PAGE = 'text-[18px] leading-[26px] font-semibold tracking-[-0.2px] text-nova-text-primary'
export const T_PANEL = 'text-[16px] leading-[24px] font-semibold text-nova-text-primary'
export const T_SECTION = 'text-[14px] leading-[20px] font-semibold text-nova-text-primary'
export const T_LABEL = 'text-[13px] leading-[18px] font-medium text-nova-text-primary'
export const T_BODY = 'text-[13px] leading-[18px] text-nova-text-secondary'
export const T_META = 'text-[12px] leading-[18px] text-nova-text-secondary'
export const T_GROUP = 'text-[12px] leading-[18px] font-semibold uppercase tracking-[0.08em] text-nova-text-secondary'

// ── search filter ───────────────────────────────────────────────────────────

/** `null` = not filtering. A string filters rows/sections by substring. */
export const SettingsQueryContext = createContext<string | null>(null)

/** True when every given text is hidden by the active filter. */
export function useSettingsHidden(...texts: Array<string | undefined>): boolean {
  const query = useContext(SettingsQueryContext)
  if (!query) return false
  const q = query.trim().toLowerCase()
  if (!q) return false
  return !texts.some((t) => (t ?? '').toLowerCase().includes(q))
}

// ── section card ────────────────────────────────────────────────────────────

export function SettingsSection({
  title,
  description,
  children,
  actions,
  tone = 'default',
  as = 'section',
  id,
}: {
  title: string
  description?: string
  children: ReactNode
  actions?: ReactNode
  /** `danger` paints the card with the error token (reset / destructive). */
  tone?: 'default' | 'danger'
  /** Some tabs are asserted as `section` in e2e — keep the default. */
  as?: 'section' | 'div'
  id?: string
}) {
  const hidden = useSettingsHidden(title, description)
  if (hidden) return null
  const Tag = as
  const headingId = id ? `${id}-heading` : undefined
  return (
    <Tag
      id={id}
      aria-labelledby={headingId}
      className={`flex flex-col gap-3 rounded-xl border px-5 py-4 ${
        tone === 'danger'
          ? 'border-error-20 bg-error-10'
          : 'border-nova-border bg-nova-card'
      }`}
    >
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={headingId} className={tone === 'danger' ? `${T_SECTION} text-error` : T_SECTION}>
            {title}
          </h3>
          {description ? <p className={T_META}>{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="flex flex-col">{children}</div>
    </Tag>
  )
}

/** A horizontal row inside a section: label + hint on the left, control right. */
export function SettingRow({
  label,
  desc,
  right,
  stacked = false,
}: {
  label: string
  desc?: string
  right: ReactNode
  /** Stack the control under the label (long inputs, textareas). */
  stacked?: boolean
}) {
  const hidden = useSettingsHidden(label, desc)
  if (hidden) return null
  return (
    <div
      className={`group flex justify-between gap-6 border-b border-nova-border py-3 last:border-b-0 last:pb-1 first:pt-1 ${
        stacked ? 'flex-col items-stretch' : 'items-center'
      }`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={T_LABEL}>{label}</span>
        {desc ? <span className={T_META}>{desc}</span> : null}
      </div>
      <div className={`flex items-center gap-2 ${stacked ? 'w-full' : 'shrink-0'}`}>{right}</div>
    </div>
  )
}

// ── controls ────────────────────────────────────────────────────────────────

export function SettingsSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible name (the visible label is not associated, so name it here). */
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border border-transparent transition-colors ${
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
      }`}
      style={{ background: checked ? 'var(--accent)' : 'var(--border)' }}
    >
      <span
        className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150"
        style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  )
}

const CONTROL_BASE =
  'h-9 rounded-lg border border-nova-border bg-nova-input-bg px-2.5 text-[13px] leading-[18px] text-nova-text-primary outline-none transition-colors focus:border-accent-60 focus:ring-2 focus:ring-accent-15 disabled:opacity-50'

export function SettingsSelect({
  label,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <select aria-label={label} className={`${CONTROL_BASE} min-w-[168px] cursor-pointer ${className}`} {...rest}>
      {children}
    </select>
  )
}

export function SettingsInput({
  label,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <input aria-label={label} className={`${CONTROL_BASE} ${className}`} {...rest} />
}

export function SettingsTextarea({
  label,
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return (
    <textarea
      aria-label={label}
      className={`min-h-[88px] w-full resize-y rounded-lg border border-nova-border bg-nova-input-bg px-2.5 py-2 font-mono text-[12px] leading-[18px] text-nova-text-primary outline-none transition-colors focus:border-accent-60 focus:ring-2 focus:ring-accent-15 ${className}`}
      {...rest}
    />
  )
}

export function SettingsButton({
  variant = 'secondary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const variants = {
    primary: 'bg-nova-accent text-white hover:opacity-90',
    secondary: 'border border-nova-border bg-nova-hover text-nova-text-secondary hover:text-nova-text-primary',
    ghost: 'text-nova-text-secondary hover:bg-nova-hover hover:text-nova-text-primary',
    danger: 'border border-error-20 bg-error-10 text-error hover:bg-error-20',
  } as const
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] leading-[18px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function SettingsSegmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (next: string) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-nova-border bg-nova-input-bg p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`h-7 rounded-md px-2.5 text-[12px] leading-[18px] font-medium transition-colors ${
              active ? 'bg-nova-accent text-white' : 'text-nova-text-secondary hover:text-nova-text-primary'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Coloured pill used for status / counts. */
export function SettingsBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
}) {
  const tones = {
    neutral: 'bg-nova-hover text-nova-text-muted',
    accent: 'bg-accent-10 text-accent-text',
    success: 'bg-success-10 text-success',
    warning: 'bg-warning-10 text-warning',
    danger: 'bg-error-10 text-error',
  } as const
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] leading-[18px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function KeyCap({ children, onClick, editable }: { children: ReactNode; onClick?: () => void; editable?: boolean }) {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      onClick={onClick}
      type={onClick ? 'button' : undefined}
      className={`inline-flex h-6 min-w-[52px] items-center justify-center rounded-md border border-nova-border bg-nova-input-bg px-2 font-mono text-[12px] leading-[18px] ${
        editable ? 'cursor-pointer text-accent-text hover:border-accent-50' : 'text-nova-text-secondary'
      }`}
    >
      {children}
    </Tag>
  )
}

/** Empty state used when a tab has nothing to configure yet. */
export function SettingsEmpty({ title, desc, action }: { title: string; desc: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-nova-border px-6 py-10 text-center">
      <p className={T_SECTION}>{title}</p>
      <p className={`${T_META} max-w-[320px]`}>{desc}</p>
      {action}
    </div>
  )
}

/** Small label above grouped controls (providers, shortcut categories …). */
export function SettingsGroupLabel({ children }: { children: ReactNode }) {
  return <p className={`${T_GROUP} px-1`}>{children}</p>
}
