/**
 * Computer Use — observation store.
 *
 * One slot per (owner session, app+window). Holds the last observation so the
 * service can compute a delta and so a stale element index can be healed against
 * the newest tree instead of failing outright.
 */
import { CUA_STATE_LRU, type CuaState } from '../../../shared/computer'

export function stateKey(app: { pid: number }, window: { windowId: number }): string {
  return `${app.pid}:${window.windowId}`
}

export class StateStore {
  private byOwner = new Map<string, Map<string, CuaState[]>>()
  private counter = 0

  nextId(): string {
    this.counter += 1
    return `s-${this.counter}`
  }

  remember(owner: string, key: string, state: CuaState): void {
    let perOwner = this.byOwner.get(owner)
    if (!perOwner) {
      perOwner = new Map()
      this.byOwner.set(owner, perOwner)
    }
    const list = perOwner.get(key) ?? []
    list.push(state)
    // Keep the newest N; observations are append-ordered.
    while (list.length > CUA_STATE_LRU) list.shift()
    perOwner.set(key, list)
  }

  previous(owner: string, key: string): CuaState | undefined {
    const list = this.byOwner.get(owner)?.get(key)
    return list && list.length ? list[list.length - 1] : undefined
  }

  /** Look one observation up by id (used by diagnostics and tests). */
  byId(owner: string, key: string, stateId: string): CuaState | undefined {
    return this.byOwner.get(owner)?.get(key)?.find((s) => s.stateId === stateId)
  }

  clearOwner(owner: string): void {
    this.byOwner.delete(owner)
  }

  clear(): void {
    this.byOwner.clear()
  }
}
