/**
 * Stable-prefix token registry — the size of the byte-stable request prefix
 * (system prompt + tool definitions) in tokens, per session.
 *
 * The agent loop already estimates this once per request (see chatStore's
 * `stablePrefixEstTokens`) long before any UI needs it. Remembering the number
 * here lets the context-usage popover split "system + tools" from "history"
 * WITHOUT rebuilding the system prompt inside the renderer — that would mean
 * re-running prompt assembly (skills, memory, workspace context) on every
 * render, which is exactly the kind of work the streaming path must not do.
 *
 * Diagnostics only: a module Map keyed by session id, never persisted, reset
 * with the app. Absent value = "no request in this process yet", and the UI
 * degrades to an estimate that says so.
 */

const prefixTokensBySession = new Map<string, number>()

/** Called by the agent loop right after it estimates the stable prefix. */
export function rememberStablePrefixTokens(sessionId: string, tokens: number): void {
  if (!sessionId || !Number.isFinite(tokens) || tokens <= 0) return
  prefixTokensBySession.set(sessionId, Math.round(tokens))
}

/** undefined = this process never issued a request for the session. */
export function getStablePrefixTokens(sessionId: string): number | undefined {
  return prefixTokensBySession.get(sessionId)
}

export function clearStablePrefixTokens(sessionId: string): void {
  prefixTokensBySession.delete(sessionId)
}
