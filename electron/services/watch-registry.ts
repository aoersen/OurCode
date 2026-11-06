/**
 * Reference-counted workspace watchers.
 *
 * The renderer models "this workspace is being watched" as a property of the
 * file-tree component: mount → `fs:watch`, unmount → `fs:unwatch`. Every view
 * that shows that tree (sidebar files tab, the project list ↔ tree toggle, the
 * office rail, a second window) therefore restarted chokidar's recursive walk —
 * a full main-process scan of the workspace — every time it appeared, and
 * collapsing the sidebar stopped watching for every other view as well.
 *
 * This registry turns that into a count per root: the watcher starts on the
 * first acquire and stops only when the last holder releases it. The scan is
 * paid once per project instead of once per UI interaction.
 *
 * Semantics worth keeping in mind:
 *  - `acquire` is serialised per root: a second acquire that lands while the
 *    first `start` is still running joins that promise instead of starting a
 *    second watcher.
 *  - `release` without a matching `acquire` is a no-op — it must never stop a
 *    watcher that another window is still holding.
 *  - `start` failures drop the reference back so a later attempt can retry,
 *    instead of leaking a phantom count that would keep a watcher alive forever.
 *  - `stop` always receives the root recorded by the first `acquire`, so a
 *    caller that spells the path differently can't strand the watcher.
 */
export interface WatchRegistryHooks {
  /** Called on 0 → 1. May be async (starting the watcher also loads MCP config). */
  start: (root: string) => void | Promise<void>
  /** Called on 1 → 0. */
  stop: (root: string) => void
  /** Canonicalise a root so different spellings hit the same entry. */
  keyOf?: (root: string) => string
}

export interface WatchRegistry {
  /** Take a reference; resolves once the watcher for that root is running. */
  acquire: (root: string) => Promise<void>
  /** Drop a reference; stops the watcher when the last one goes away. */
  release: (root: string) => void
  /** Current reference count (0 = not watching). */
  count: (root: string) => number
  /** Roots currently held, in acquire order. */
  roots: () => string[]
  /** Stop watching immediately and forget every reference (trust revoked,
   *  workspace dropped) — the next acquire starts a fresh watcher. */
  forget: (root: string) => void
  /** Stop every held watcher (app shutdown / hard reset). */
  dispose: () => void
}

interface HeldRoot {
  /** Root as spelled by the first acquire — what `stop` is called with. */
  root: string
  count: number
}

export function createWatchRegistry(hooks: WatchRegistryHooks): WatchRegistry {
  const held = new Map<string, HeldRoot>()
  const starting = new Map<string, Promise<void>>()
  const keyOf = hooks.keyOf ?? ((root: string) => root)

  const stopHeld = (key: string): void => {
    const entry = held.get(key)
    held.delete(key)
    if (entry) hooks.stop(entry.root)
  }

  return {
    async acquire(root) {
      const key = keyOf(root)
      const inFlight = starting.get(key)
      if (inFlight) {
        const entry = held.get(key)
        if (entry) entry.count += 1
        await inFlight
        return
      }

      const existing = held.get(key)
      if (existing) {
        existing.count += 1
        return
      }

      const entry: HeldRoot = { root, count: 1 }
      held.set(key, entry)
      const started = Promise.resolve()
        .then(() => hooks.start(root))
        .then(() => undefined)
      starting.set(key, started)
      try {
        await started
      } catch (error) {
        // Roll the 0 → 1 reference back so the next acquire is a real retry.
        const current = held.get(key)
        if (current) {
          current.count -= 1
          if (current.count <= 0) held.delete(key)
        }
        throw error
      } finally {
        starting.delete(key)
      }
    },

    release(root) {
      const key = keyOf(root)
      const entry = held.get(key)
      if (!entry) return // never held — nothing of ours to stop
      entry.count -= 1
      if (entry.count <= 0) stopHeld(key)
    },

    count(root) {
      return held.get(keyOf(root))?.count ?? 0
    },

    roots() {
      return Array.from(held.values(), (entry) => entry.root)
    },

    forget(root) {
      const key = keyOf(root)
      starting.delete(key)
      if (held.has(key)) stopHeld(key)
      else hooks.stop(root)
    },

    dispose() {
      for (const key of Array.from(held.keys())) stopHeld(key)
      starting.clear()
    },
  }
}
