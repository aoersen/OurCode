/**
 * Model wire-log store — main process.
 *
 * The renderer emits one JSON line per model-request event (request body,
 * per-attempt outcome, cache hits) and this service appends them to
 * `<userData>/wire-logs/<sessionId>.jsonl`. It is the replayable record the
 * usage dashboard cannot provide: usage_events stores only aggregate metadata,
 * while the wire log keeps the exact (redacted) request/response so a
 * misbehaving turn can be reconstructed after the fact.
 *
 * Hardening mirrors the spill store:
 *  - session ids are sanitized before touching the filesystem (no traversal);
 *  - per-session byte budget with one rotation generation (current + `.1`), so
 *    a runaway agent cannot fill the disk;
 *  - 0600 where the OS enforces it — log lines may contain user code;
 *  - startup sweep removes files older than the TTL; deleting a chat session
 *    deletes its log file.
 *
 * All writes are best-effort: a logging failure must never affect the request
 * path.
 */
import { promises as fs } from 'fs'
import { join } from 'path'

/** Hard cap per appended line (bytes) — above any realistic request body. */
export const WIRE_LOG_MAX_LINE_BYTES = 4 * 1024 * 1024
/** Hard cap per session file (bytes) — protects the disk from unbounded logs. */
export const WIRE_LOG_MAX_SESSION_BYTES = 50 * 1024 * 1024
/** Log files older than this are swept at startup (7 days). */
export const WIRE_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Session ids are uuids, but defend the filesystem regardless. */
function safeDirName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

export interface WireLogLimits {
  /** Overrides WIRE_LOG_MAX_LINE_BYTES (tests inject small values). */
  maxLineBytes?: number
  /** Overrides WIRE_LOG_MAX_SESSION_BYTES (tests inject small values). */
  maxSessionBytes?: number
}

export class WireLogService {
  private readonly maxLineBytes: number
  private readonly maxSessionBytes: number
  /** Appends are serialized through this chain: stat→rotate→append is not
   *  atomic, and concurrent appends (main loop + subagents) at the rotation
   *  boundary could otherwise drop a generation or interleave lines. */
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly baseDir: string,
    limits: WireLogLimits = {},
  ) {
    this.maxLineBytes = limits.maxLineBytes ?? WIRE_LOG_MAX_LINE_BYTES
    this.maxSessionBytes = limits.maxSessionBytes ?? WIRE_LOG_MAX_SESSION_BYTES
  }

  /** Absolute path of the log directory (surfaced in Settings). */
  get root(): string {
    return this.baseDir
  }

  /**
   * Append one JSON line to the session's log file. Returns false when the
   * arguments are unusable, the line is oversized, or the write fails —
   * callers treat logging as best-effort and never block on the outcome.
   */
  append(sessionId: string, line: string): Promise<boolean> {
    if (!sessionId || typeof line !== 'string' || !line) return Promise.resolve(false)
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) return Promise.resolve(false)
    const task = this.chain.then(() => this.doAppend(sessionId, line))
    // The chain survives failed appends so one bad write never wedges the rest.
    this.chain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async doAppend(sessionId: string, line: string): Promise<boolean> {
    const file = this.fileOf(sessionId)
    try {
      await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 })
    } catch {
      return false
    }
    try {
      // Rotate when the next append would blow the session budget: the current
      // file becomes `.1` (its previous `.1` is dropped), so at most two
      // generations survive and the session's disk usage stays bounded.
      const st = await fs.stat(file).catch(() => null)
      if (st && st.size + Buffer.byteLength(line, 'utf8') > this.maxSessionBytes) {
        await fs.rm(`${file}.1`, { force: true }).catch(() => {})
        await fs.rename(file, `${file}.1`).catch(() => {})
      }
      await fs.appendFile(file, `${line}\n`, { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  /** Delete a session's log file(s) (session deletion / reset). */
  async deleteSession(sessionId: string): Promise<void> {
    const file = this.fileOf(sessionId)
    await fs.rm(file, { force: true }).catch(() => {})
    await fs.rm(`${file}.1`, { force: true }).catch(() => {})
  }

  /** Remove log files older than `maxAgeMs`. Returns how many were removed. */
  async sweep(maxAgeMs: number = WIRE_LOG_TTL_MS): Promise<number> {
    let removed = 0
    let entries: string[]
    try {
      entries = await fs.readdir(this.baseDir)
    } catch {
      return 0
    }
    const now = Date.now()
    for (const name of entries) {
      const p = join(this.baseDir, name)
      try {
        const st = await fs.stat(p)
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
          await fs.unlink(p)
          removed++
        }
      } catch { /* raced */ }
    }
    return removed
  }

  private fileOf(sessionId: string): string {
    return join(this.baseDir, `${safeDirName(sessionId)}.jsonl`)
  }
}
