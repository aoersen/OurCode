import { ApiConfigGroup, LLMRequest, LLMStreamChunk } from '@/types'
import { LLMAdapter, ProviderType } from './types'
import { OpenAIAdapter } from './adapters/OpenAIAdapter'
import { ResponsesAdapter } from './adapters/ResponsesAdapter'
import { AnthropicAdapter } from './adapters/AnthropicAdapter'
import { GeminiAdapter } from './adapters/GeminiAdapter'
import { OllamaAdapter } from './adapters/OllamaAdapter'
import { DeepSeekAdapter } from './adapters/DeepSeekAdapter'
import { GroqAdapter } from './adapters/GroqAdapter'
import { buildCacheKey, fetchCachedResponse, shouldCache, storeCachedResponse, CachedResponse } from './responseCache'
import { classifyLLMError } from './classify'
import { redactError, redactSecrets, type RedactSecretsOptions } from './redact'
import { v4 as uuidv4 } from 'uuid'

const REQUEST_TIMEOUT_MS = 600_000 // 10 min idle (no-data) timeout for LLM streams

// ── Retry configuration (wired from chatStore, defaults = on, 2 retries). ────
// Retries happen ONLY before the stream has produced anything — once a chunk
// has been yielded, retrying would replay partial output. Only transient
// failures (timeout / network / rate-limit / 5xx) are retried; auth errors,
// bad requests and context-overflow rejections surface immediately.

interface LLMRetryConfig {
  enabled?: () => boolean
  maxRetries?: () => number
  /** Backoff for attempt N (ms). Injectable for tests; default = exponential. */
  delay?: (attempt: number) => number
}

let retryEnabled: () => boolean = () => true
let retryMaxRetries: () => number = () => 2
let retryDelay: (attempt: number) => number = (attempt) =>
  Math.min(10_000, 1_000 * 2 ** attempt) * (1 + (Math.random() - 0.5) * 0.25)

/** Wire retry toggles (lazily evaluated per request). */
export function configureLLMRetry(config: LLMRetryConfig): void {
  if (config.enabled) retryEnabled = config.enabled
  if (config.maxRetries) retryMaxRetries = config.maxRetries
  if (config.delay) retryDelay = config.delay
}

const openaiAdapter = new OpenAIAdapter()

const adapters: Record<ProviderType, LLMAdapter> = {
  openai: openaiAdapter,
  responses: new ResponsesAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
  ollama: new OllamaAdapter(),
  deepseek: new DeepSeekAdapter(),
  groq: new GroqAdapter(),
  azure: new OpenAIAdapter('azure'), // Azure uses the deployments URL scheme
  custom: openaiAdapter, // Custom uses OpenAI-compatible format
}

export function getAdapter(provider: ProviderType, apiFormat?: string): LLMAdapter {
  // If an explicit format override is set (and not 'auto'), use that adapter
  const resolvedProvider = (apiFormat && apiFormat !== 'auto')
    ? apiFormat as ProviderType
    : provider
  return adapters[resolvedProvider] || adapters.openai
}

// ── Cache configuration (wired from chatStore so every sendLLMRequest caller
// ── benefits without each of them knowing about the preferences). ──────────

interface LLMCacheConfig {
  /** Client-side response cache: replay exact-duplicate deterministic requests. */
  responseCacheEnabled?: () => boolean
  /** Provider prompt-caching markers (Anthropic cache_control). */
  anthropicPromptCacheEnabled?: () => boolean
  /** Anthropic 1-hour cache TTL (cache_control { type: 'ephemeral', ttl: '1h' })
   *  instead of the default 5 minutes. */
  anthropicPromptCache1hEnabled?: () => boolean
}

let responseCacheEnabled: () => boolean = () => false
let anthropicPromptCacheEnabled: () => boolean = () => true
let anthropicPromptCache1hEnabled: () => boolean = () => false

/** Wire cache toggles (lazily evaluated per request, defaults = cache off). */
export function configureLLMCache(config: LLMCacheConfig): void {
  if (config.responseCacheEnabled) responseCacheEnabled = config.responseCacheEnabled
  if (config.anthropicPromptCacheEnabled) anthropicPromptCacheEnabled = config.anthropicPromptCacheEnabled
  if (config.anthropicPromptCache1hEnabled) anthropicPromptCache1hEnabled = config.anthropicPromptCache1hEnabled
}

// ── Wire-log configuration (wired from chatStore, defaults ON) ───────────
// The wire log records one JSON line per request event — the redacted request
// body, each attempt's outcome and cache hits — appended to
// <userData>/wire-logs/<sessionId>.jsonl by the main process. It is the
// replayable record the usage dashboard cannot provide (usage_events keeps
// only aggregate metadata). Emission is best-effort and never affects the
// request path.

/** Session/turn attribution for the wire log (set by the agent loop). */
export interface WireLogContext {
  sessionId?: string
  turnId?: number
}

interface WireLogConfig {
  /** Master switch — lazily evaluated per request (default: enabled). */
  enabled?: () => boolean
  /** Attribution — chatStore sets its run context before each request. */
  getContext?: () => WireLogContext
}

let wireLogEnabled: () => boolean = () => true
let wireLogContext: () => WireLogContext = () => ({})

/** Wire the master switch + session/turn attribution. */
export function configureWireLog(config: WireLogConfig): void {
  if (config.enabled) wireLogEnabled = config.enabled
  if (config.getContext) wireLogContext = config.getContext
}

/** Emit one redacted wire-log line. Never throws, never blocks the request. */
async function emitWireLine(sessionId: string, line: Record<string, unknown>): Promise<void> {
  try {
    const api = (window as any).electronAPI
    if (!api?.wireLogAppend) return
    await api.wireLogAppend(sessionId, JSON.stringify(line))
  } catch { /* wire logging is best-effort */ }
}

/** Serialize + redact a value so logged bodies never leak request secrets. */
function scrubToJson(value: unknown, secrets: RedactSecretsOptions): unknown | undefined {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value), secrets))
  } catch {
    return undefined
  }
}

/** Replay a cached response as stream chunks, zeroing usage (no tokens billed). */
function* replayCached(cached: CachedResponse): Generator<LLMStreamChunk> {
  const marker = { savedTokensIn: cached.tokensIn, savedTokensOut: cached.tokensOut }
  for (const c of cached.chunks) {
    yield {
      content: c.content,
      thinking: c.thinking,
      done: c.done,
      toolCalls: c.toolCalls,
      cacheHit: marker,
    }
  }
}

export async function* sendLLMRequest(
  req: LLMRequest,
  config: ApiConfigGroup,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): AsyncGenerator<LLMStreamChunk> {
  const adapter = getAdapter(config.provider, config.apiFormat)
  // Trim stray whitespace/newlines so a pasted key can't silently break auth.
  const safeConfig = { ...config, apiKey: (config.apiKey || '').trim() }

  // Wire-log setup — one trace per request; all emission is best-effort.
  const wireOn = wireLogEnabled()
  const wctx = wireOn ? wireLogContext() : undefined
  const wireSession = wctx?.sessionId || ''
  const traceId = wireOn && wireSession ? uuidv4() : ''
  const wireSecrets: RedactSecretsOptions = {
    apiKey: safeConfig.apiKey,
    baseUrl: safeConfig.baseUrl,
    customHeaders: safeConfig.customHeaders,
  }
  const startedAt = Date.now()

  // Client-side response cache: exact-duplicate deterministic requests are
  // replayed locally instead of hitting the API (saves the user's tokens).
  let cacheKey: string | null = null
  if (responseCacheEnabled() && shouldCache(req)) {
    cacheKey = await buildCacheKey(req, config.provider)
    const hit = await fetchCachedResponse(cacheKey)
    if (hit) {
      if (traceId) {
        void emitWireLine(wireSession, {
          type: 'cache_hit',
          traceId,
          turnId: wctx?.turnId,
          startedAt,
          durationMs: Date.now() - startedAt,
          provider: config.provider,
          model: req.model,
          request: scrubToJson(req, wireSecrets),
          chunks: scrubToJson(hit.chunks, wireSecrets),
          savedTokensIn: hit.tokensIn,
          savedTokensOut: hit.tokensOut,
        })
      }
      yield* replayCached(hit)
      return
    }
  }

  // Provider prompt-caching markers (Anthropic cache_control breakpoints, DeepSeek
  // auto-caches repeated prefixes server-side) so repeated prefixes are billed
  // at the cached read rate. Anthropic optionally extends the breakpoints to a
  // 1-hour TTL (default is ~5 min) so long agent runs keep their prefix cached.
  const reqWithCache = (config.provider === 'anthropic' || config.provider === 'deepseek') && anthropicPromptCacheEnabled()
    ? {
        ...req,
        providerCache: true,
        ...(config.provider === 'anthropic' && anthropicPromptCache1hEnabled()
          ? { providerCacheTtl1h: true }
          : {}),
      }
    : req

  const chunks: LLMStreamChunk[] = []
  let completed = false
  let tokensIn = 0
  let tokensOut = 0

  if (traceId) {
    void emitWireLine(wireSession, {
      type: 'request',
      traceId,
      turnId: wctx?.turnId,
      startedAt,
      provider: config.provider,
      model: req.model,
      request: scrubToJson(reqWithCache, wireSecrets),
    })
  }

  const maxRetries = retryEnabled() ? Math.max(0, retryMaxRetries()) : 0

  for (let attempt = 0; ; attempt++) {
    const attemptStart = Date.now()
    // A FRESH controller per attempt — the finally below aborts unconditionally,
    // and an aborted signal can't be reused for the retry.
    const controller = new AbortController()
    // IDLE timeout, not a wall-clock deadline: long reasoning streams (DeepSeek
    // reasoner etc.) legitimately run past 120s as long as chunks keep arriving.
    // The timer is re-armed on every chunk, so only a connection that goes
    // silent for `timeoutMs` gets aborted.
    let timer = setTimeout(() => controller.abort(), timeoutMs)
    const armTimeout = () => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), timeoutMs)
    }
    const clearTimer = () => clearTimeout(timer)

    try {
      for await (const chunk of adapter.sendRequest(reqWithCache, safeConfig, controller.signal)) {
        armTimeout() // any data (or the final [DONE] chunk) extends the deadline
        if (chunk.usage) {
          tokensIn = chunk.usage.promptTokens || 0
          tokensOut = chunk.usage.completionTokens || 0
        }
        chunks.push(chunk)
        yield chunk
        // Reached the natural end of the response — safe to cache below.
        if (chunk.done) {
          completed = true
          break
        }
      }
      if (traceId) {
        void emitWireLine(wireSession, {
          type: 'attempt',
          traceId,
          attempt,
          startedAt: attemptStart,
          durationMs: Date.now() - attemptStart,
          ok: true,
          truncated: !completed,
          tokensIn,
          tokensOut,
          chunks: scrubToJson(chunks, wireSecrets),
        })
      }
      break // request finished (naturally or via the done chunk)
    } catch (error: any) {
      // API key and custom header values must never surface in an error the
      // chat/model can see — some providers echo the key back in the error
      // body, and URL-keyed ones (Gemini) put it in the URL. Redact here, the
      // single choke point where the request's own secrets are in scope.
      const err = (error.name === 'AbortError' || controller.signal.aborted)
        ? new Error('请求超时，请稍后重试')
        : redactError(error, {
            apiKey: safeConfig.apiKey,
            baseUrl: safeConfig.baseUrl,
            customHeaders: safeConfig.customHeaders,
          })
      // Auto-retry transient failures ONLY before the stream produced anything
      // (chunks.length === 0). Once output has started, retrying would replay
      // partial content — surface the error instead. Context-overflow is never
      // retried: the fix is compaction, not a duplicate request.
      const info = classifyLLMError(err)
      if (traceId) {
        void emitWireLine(wireSession, {
          type: 'attempt',
          traceId,
          attempt,
          startedAt: attemptStart,
          durationMs: Date.now() - attemptStart,
          ok: false,
          error: err.message,
          retried: chunks.length === 0 && attempt < maxRetries && info.retryable,
        })
      }
      if (chunks.length === 0 && attempt < maxRetries && info.retryable) {
        clearTimer()
        await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)))
        continue
      }
      throw err
    } finally {
      clearTimer()
      // Abort the underlying HTTP request unconditionally. A consumer that
      // stops early (stop generation / abort) breaks out of the for-await —
      // without this the main-process fetch keeps downloading the rest of the
      // body and the renderer keeps buffering chunks until the idle timeout
      // fires. (Also aborts the in-flight attempt when a retry was skipped.)
      controller.abort()
    }
  }

  // Persist only on a completed (non-aborted, non-failed) response.
  if (cacheKey && completed) {
    void storeCachedResponse(cacheKey, config.provider, req.model, chunks, tokensIn, tokensOut)
  }
}

export async function fetchModels(
  config: ApiConfigGroup,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<string[]> {
  const adapter = getAdapter(config.provider, config.apiFormat)
  const safeConfig = { ...config, apiKey: (config.apiKey || '').trim() }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await adapter.fetchModels(safeConfig, controller.signal)
  } catch (error: any) {
    if (error.name === 'AbortError' || controller.signal.aborted) {
      throw new Error('获取模型列表超时，请检查网络连接后重试')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
