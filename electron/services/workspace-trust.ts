/**
 * Workspace trust — who may decide what the renderer is allowed to reach.
 *
 * The main process gates every `fs:*` call on an allowlist, but the allowlist
 * used to be self-service: `fs:authorize` / `fs:watch` registered any path the
 * renderer named, so a compromised renderer (or an agent steered into one)
 * could read and write anything the OS user can. Registration now requires a
 * reason that does not depend on the renderer's word: a folder the user picked
 * in a native dialog, a path the app owns, or an earlier grant stored on disk.
 */
import { basename, dirname, join, resolve } from 'path'
import { existsSync, realpathSync } from 'fs'

/**
 * Resolve symlinks/junctions as far as the filesystem lets us.
 *
 * `resolve()` is purely lexical, so `<trusted>\link` pointing at `C:\Windows`
 * would still pass an allowlist check — on Windows a junction is one
 * `run_command` away. Paths that don't exist yet (createFile) resolve their
 * deepest existing ancestor and re-attach the remainder.
 */
export function realPathOrBest(p: string): string {
  const full = resolve(p)
  let probe = full
  const missing: string[] = []
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return full
    missing.unshift(basename(probe))
    probe = parent
  }
  try {
    const real = realpathSync(probe)
    return missing.length ? join(real, ...missing) : real
  } catch {
    return full
  }
}

const win32 = () => process.platform === 'win32'

/** Comparable form of a directory: links resolved, separators normalized,
 *  case folded on Windows (where the same folder has many spellings). */
export function canonicalDir(p: string): string {
  if (!p) return ''
  const real = realPathOrBest(p)
  return win32() ? real.toLowerCase() : real
}

/**
 * True when `probe` is `root` or sits inside it.
 *
 * The boundary test has to survive every spelling of a root: 'C:\' and 'C:'
 * both mean the drive, '/' is already a separator, and a plain child path needs
 * one appended before prefix-comparing — otherwise 'C:\project-evil' would read
 * as inside 'C:\project'.
 */
export function isWithinDir(root: string, probe: string): boolean {
  if (!root || !probe) return false
  if (probe === root) return true
  const base = root.length > 1 && (root.endsWith('\\') || root.endsWith('/')) ? root.slice(0, -1) : root
  const boundary = base.endsWith('\\') || base.endsWith('/') ? base : base + (win32() ? '\\' : '/')
  return probe.startsWith(boundary)
}

/** Persistence seam — backed by SQLite in the app, in-memory in tests. */
export interface TrustPersistence {
  load(): string[]
  add(path: string): void
  remove(path: string): void
}

export class WorkspaceTrust {
  /** Granted in an earlier run (survives restart) */
  private persisted = new Set<string>()
  /** Directories the app itself owns (userData and what lives under it) */
  private appOwned: string[] = []

  constructor(private readonly persist: TrustPersistence) {
    let stored: string[] = []
    try {
      stored = persist.load() || []
    } catch {
      stored = []
    }
    for (const p of stored) {
      const canonical = canonicalDir(p)
      if (canonical) this.persisted.add(canonical)
    }
  }

  addAppOwned(dir: string): void {
    const canonical = canonicalDir(dir)
    if (canonical) this.appOwned.push(canonical)
  }

  /**
   * The user picked this folder in a dialog we opened, or confirmed a trust
   * request through one — either way the answer did not come from the renderer.
   */
  grant(dir: string): void {
    const canonical = canonicalDir(dir)
    if (!canonical || this.persisted.has(canonical)) return
    this.persisted.add(canonical)
    try {
      this.persist.add(canonical)
    } catch {
      // Losing the durable record only means being asked again next run.
    }
  }

  revoke(dir: string): void {
    const canonical = canonicalDir(dir)
    if (!canonical) return
    this.persisted.delete(canonical)
    try {
      this.persist.remove(canonical)
    } catch {
      /* already forgotten in memory */
    }
  }

  isTrusted(dir: string): boolean {
    const canonical = canonicalDir(dir)
    if (!canonical) return false
    if (this.appOwned.some((root) => isWithinDir(root, canonical))) return true
    for (const root of this.persisted) if (isWithinDir(root, canonical)) return true
    return false
  }
}
