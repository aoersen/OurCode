// Client-side LLM response cache.
//
// Exact-duplicate requests (same provider + model + params + tools + messages)
// are stored in sqlite (via the llmCache* IPC bridge) and replayed without
// calling the API — saving the user's tokens. Only deterministic requests
// (temperature 0) are cached, so "regenerate" with a non-zero temperature
// still produces fresh answers.
//
// The cache key deliberately excludes apiKey/baseUrl: the same provider+model
// produces the same answer regardless of which relay serves it.
//
// System messages are excluded from the cache key because they contain
// frequently-changing workspace context (git status, open files, etc.) that
// would otherwise cause cache misses even when the user asks the exact same
// question. The system prompt hash is included separately so a user-edited
// custom system prompt still busts the cache appropriately.

import { LLMRequest, LLMStreamChunk } from '@/types'

/** Skip caching responses larger than this (chars) to keep sqlite lean. */
export const MAX_CACHE_RESPONSE_CHARS = 500_000

/** Max entries in the renderer-side L1 memory cache (LRU eviction). */
const L1_CACHE_MAX = 100

/** True when the request is deterministic enough to cache (temperature 0). */
export function shouldCache(req: LLMRequest): boolean {
  const t = req.temperature ?? 0
  return t === 0
}

/** Serialize any value with a stable key order (objects sorted by key). */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']'
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function fnv1a(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return 'fnv' + (hash >>> 0).toString(16)
}

async function sha256(text: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined') {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    // Non-secure context or unavailable API — fall through to FNV.
  }
  return fnv1a(text)
}

/**
 * Build a cache key for a request: provider + model + params + tools +
 * system-prompt hash + user/assistant/tool messages, canonically serialized
 * then hashed.
 *
 * System messages are excluded from the main hash because they carry
 * frequently-changing workspace context (git status, open files, tool
 * definitions, target-mode instructions, etc.) that would make the cache key
 * unique on every turn — even when the user asks the same question. Instead,
 * only a lightweight FNV-1a hash of the system messages is included: when the
 * user edits their custom system prompt the cache auto-busts, but workspace
 * noise (git branch name, file list, etc.) doesn't prevent a hit.
 */
export async function buildCacheKey(req: LLMRequest, provider: string): Promise<string> {
  // Separate system messages from user-facing messages
  const systemMessages: unknown[] = []
  const visibleMessages: unknown[] = []
  for (const m of req.messages) {
    if (m.role === 'system') {
      systemMessages.push(m)
    } else {
      visibleMessages.push(m)
    }
  }
  // Lightweight hash of system messages — only changes when the user edits
  // their custom system prompt or the tool definitions change.
  const systemHash = fnv1a(stableStringify(systemMessages))

  const canonical = [
    provider,
    req.model,
    req.temperature ?? 0,
    req.topP ?? 1,
    req.frequencyPenalty ?? 0,
    req.presencePenalty ?? 0,
    req.maxTokens ?? 0,
    req.thinking ? 1 : 0,
    req.reasoningEffort || '',
    stableStringify(req.extraBody || {}),
    stableStringify(req.tools || []),
    systemHash,
    stableStringify(visibleMessages),
  ].join('\u0001')
  return sha256(canonical)
}

export interface CachedResponse {
  chunks: LLMStreamChunk[]
  tokensIn: number
  tokensOut: number
}

// ── Renderer-side L1 memory cache (LRU) ──────────────────────────────────
// Sits in front of the IPC→SQLite L2 cache to avoid the async bridge overhead
// for frequently repeated requests (e.g. agent-loop sub-calls within a turn).

const l1Cache = new Map<string, CachedResponse>()

function getElectronApi(): any {
  return typeof window !== 'undefined' ? (window as any).electronAPI : null
}

/** Look up a cached response — L1 first, then L2 (IPC→SQLite). */
export async function fetchCachedResponse(key: string): Promise<CachedResponse | null> {
  // L1 hit — no IPC, near-zero latency
  const l1Hit = l1Cache.get(key)
  if (l1Hit) {
    // Refresh LRU position by re-inserting
    l1Cache.delete(key)
    l1Cache.set(key, l1Hit)
    return l1Hit
  }

  // L2: IPC → SQLite
  const api = getElectronApi()
  if (!api || typeof api.llmCacheGet !== 'function') return null
  try {
    const row = await api.llmCacheGet(key)
    if (!row || typeof row.response !== 'string') return null
    const parsed = JSON.parse(row.response)
    if (!Array.isArray(parsed?.chunks) || parsed.chunks.length === 0) return null
    const result: CachedResponse = {
      chunks: parsed.chunks,
      tokensIn: row.tokensIn || 0,
      tokensOut: row.tokensOut || 0,
    }
    // Promote to L1 (LRU eviction: drop oldest when full)
    if (l1Cache.size >= L1_CACHE_MAX) {
      l1Cache.delete(l1Cache.keys().next().value!)
    }
    l1Cache.set(key, result)
    return result
  } catch {
    return null
  }
}

/** Store a completed response in L1 + L2. Best-effort: never throws. */
export async function storeCachedResponse(
  key: string,
  provider: string,
  model: string,
  chunks: LLMStreamChunk[],
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  const api = getElectronApi()
  if (!api || typeof api.llmCachePut !== 'function') return
  try {
    const json = JSON.stringify({
      chunks: chunks.map((c) => ({
        content: c.content,
        thinking: c.thinking,
        done: c.done,
        toolCalls: c.toolCalls,
        usage: c.usage,
      })),
    })
    if (json.length > MAX_CACHE_RESPONSE_CHARS) return
    await api.llmCachePut({ key, provider, model, response: json, tokensIn, tokensOut })

    // Also populate L1 so the next identical request hits memory
    if (l1Cache.size >= L1_CACHE_MAX) {
      l1Cache.delete(l1Cache.keys().next().value!)
    }
    l1Cache.set(key, { chunks, tokensIn, tokensOut })
  } catch {
    // Cache is best-effort — a write failure must not break the request.
  }
}

/** Clear only the renderer-side L1 cache (IPC→SQLite cache untouched). */
export function clearL1Cache(): void {
  l1Cache.clear()
}
