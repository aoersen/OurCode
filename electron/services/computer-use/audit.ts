/**
 * Computer Use — audit trail.
 *
 * One JSON line per action. Typed text is recorded as length + a 2-char prefix
 * only; anything that looks like a credential is not recorded at all. The file
 * lives under `<userData>/cua/audit.jsonl` and is what the settings panel's
 * "最近动作" list reads from.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'

export interface AuditRecord {
  ts: number
  owner: string
  kind: string
  app?: string
  target?: string
  /** Never the full text — see the module note. */
  textLen?: number
  textPrefix?: string
  keys?: string
  ok: boolean
  code?: string
  effect?: string
  elapsedMs?: number
}

export interface AuditLogger {
  write(record: AuditRecord): void
}

export function createAuditLogger(file: string | null): AuditLogger {
  return {
    write(record: AuditRecord): void {
      if (!file) return
      try {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
      } catch {
        // Audit is best-effort: never fail a tool call because the log is unwritable.
      }
    },
  }
}

/** Newest-last slice of the audit trail (settings panel「最近动作」). */
export function readRecentAudit(file: string | null, limit = 50): AuditRecord[] {
  if (!file) return []
  try {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim())
    return lines
      .slice(-Math.max(1, Math.min(limit, 500)))
      .map((line) => {
        try {
          return JSON.parse(line) as AuditRecord
        } catch {
          return null
        }
      })
      .filter((record): record is AuditRecord => !!record)
  } catch {
    return []
  }
}

