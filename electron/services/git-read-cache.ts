/**
 * Shared cache for read-only git commands.
 *
 * Several surfaces poll git independently (status bar 10 s, file tree 15 s,
 * source-control panel on mount + on change, chat context on session switch).
 * On a big repo one `git status --porcelain` costs hundreds of ms to seconds and
 * concurrent runs contend for `.git/index.lock`, so the main process runs each
 * distinct read-only command at most once per TTL window and hands every caller
 * the same promise.
 *
 * Two rules keep this honest:
 *  - a REJECTED result is never cached (a repo that was broken for a second must
 *    not look broken for the whole TTL);
 *  - any mutating git command invalidates everything, so a poll right after a
 *    commit/stage/checkout never serves the pre-mutation snapshot.
 *
 * Callers decide what is read-only (see `GIT_READ_ONLY_SUBCOMMANDS` in main.ts);
 * this module only keys, dedupes and evicts.
 */
export interface GitReadCacheOptions {
  /** How long a resolved result may be reused (ms). */
  ttlMs?: number
  /** Soft cap on cached entries — oldest inserted is evicted first. */
  maxEntries?: number
  /** Clock, injectable for tests. */
  now?: () => number
}

export interface GitReadCache {
  /** Serve the cached promise when fresh, otherwise start `runner` once. */
  run: (key: string, runner: () => Promise<string>) => Promise<string>
  /** Drop everything (called after a mutating git command). */
  invalidateAll: () => void
  /** Number of live entries (tests / diagnostics). */
  size: () => number
}

interface Entry {
  at: number
  promise: Promise<string>
}

const DEFAULT_TTL_MS = 5_000
const DEFAULT_MAX_ENTRIES = 256

export function createGitReadCache(options: GitReadCacheOptions = {}): GitReadCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()

  return {
    run(key, runner) {
      const at = now()
      const hit = entries.get(key)
      if (hit && at - hit.at < ttlMs) return hit.promise

      const promise = Promise.resolve().then(runner)
      entries.set(key, { at, promise })
      // Never memoise a failure: the next caller must be able to retry.
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key)
      })
      // FIFO eviction — the map keeps insertion order and only holds a handful
      // of keys per project, so this is a safety net rather than real pressure.
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      return promise
    },

    invalidateAll() {
      entries.clear()
    },

    size() {
      return entries.size
    },
  }
}
