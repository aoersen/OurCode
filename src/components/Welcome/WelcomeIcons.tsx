/**
 * Minimal inline icon set for the welcome hub.
 *
 * The app's MSIcon renders Material Symbols from a font; the welcome screen
 * must stay correct even before that font settles (it is the first screen a
 * user sees), so these are plain SVGs — no font dependency, no layout shift.
 */
interface IconProps {
  className?: string
}

const BASE = 'shrink-0'

export function FolderIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={`${BASE} ${className}`} aria-hidden>
      <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

export function PlayIcon({ className = 'w-3.5 h-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={`${BASE} ${className}`} aria-hidden>
      <path d="M5 3.5a.75.75 0 011.14-.64l6 3.5a.75.75 0 010 1.28l-6 3.5A.75.75 0 015 10.5v-7z" />
    </svg>
  )
}

export function ArrowRightIcon({ className = 'w-3.5 h-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={`${BASE} ${className}`} aria-hidden>
      <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ArrowUpIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" className={`${BASE} ${className}`} aria-hidden>
      <path d="M8 13V3.5M4.5 7L8 3.5 11.5 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ClockIcon({ className = 'w-3.5 h-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={`${BASE} ${className}`} aria-hidden>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.8V8l2.2 1.4" strokeLinecap="round" />
    </svg>
  )
}

export function FileIcon({ className = 'w-3.5 h-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className={`${BASE} ${className}`} aria-hidden>
      <path d="M9.2 2H4.6A1.6 1.6 0 003 3.6v8.8A1.6 1.6 0 004.6 14h6.8a1.6 1.6 0 001.6-1.6V5.4L9.2 2z" strokeLinejoin="round" />
      <path d="M9 2.2V5.5h3.4" strokeLinejoin="round" />
    </svg>
  )
}

export function ChatIcon({ className = 'w-3.5 h-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className={`${BASE} ${className}`} aria-hidden>
      <path d="M13 9.2a1.6 1.6 0 01-1.6 1.6H6.4L3.4 13.4V4a1.6 1.6 0 011.6-1.6h6.4A1.6 1.6 0 0113 4v5.2z" strokeLinejoin="round" />
    </svg>
  )
}

export function WarningIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={`${BASE} ${className}`} aria-hidden>
      <path d="M8 2.6l5.4 9.6H2.6L8 2.6z" strokeLinejoin="round" />
      <path d="M8 6.4v2.6" strokeLinecap="round" />
      <circle cx="8" cy="10.9" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
