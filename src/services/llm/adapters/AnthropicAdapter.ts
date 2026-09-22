import { ApiConfigGroup, LLMRequest, LLMStreamChunk, LLMToolCall } from '@/types'
import { LLMAdapter } from '../types'
import { mapAnthropicUsage, mergeUsage, ParsedUsage } from '../usage'
import { llmFetch } from '../http'
import { buildChatUrl } from '../endpoints'

const ANTHROPIC_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307',
]

/**
 * Rough per-character token estimate split by script family. CJK characters
 * cost roughly one token each in Claude's tokenizer while ASCII runs average
 * ~0.3 (≈4 chars/token); the old flat chars÷3.5 divisor undercounted CJK by
 * ~3x, which emitted breakpoints on prompts the provider rejects with a 400.
 * Kept slightly conservative (over-estimate) so breakpoints only appear when
 * safely above the per-segment minimum.
 */
function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    // CJK ideographs + full-width punctuation + kana + hangul
    if (/[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk * 1.1 + other * 0.3)
}

/** Estimate a content value (string, or Anthropic-style block array). */
function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  if (Array.isArray(content)) {
    let tokens = 0
    for (const block of content) {
      if (typeof block === 'string') tokens += estimateTextTokens(block)
      else if (block && typeof block.text === 'string') tokens += estimateTextTokens(block.text)
      else if (block?.type === 'tool_use') {
        tokens += estimateTextTokens(block.name || '')
        tokens += estimateTextTokens(JSON.stringify(block.input || {}))
      } else if (block?.type === 'tool_result') {
        tokens += estimateTextTokens(typeof block.content === 'string' ? block.content : '')
      }
    }
    return tokens
  }
  return 0
}

/** Estimate the system + tools prefix (converted Anthropic shapes). */
function estimateBodyTokens(system: unknown, tools: any[] | undefined): number {
  let tokens = 0
  if (typeof system === 'string') tokens += estimateTextTokens(system)
  else if (Array.isArray(system)) {
    for (const block of system) tokens += estimateTextTokens(block?.text || '')
  }
  for (const tool of tools || []) {
    tokens += estimateTextTokens(tool?.name || '')
    tokens += estimateTextTokens(tool?.description || '')
    tokens += estimateTextTokens(JSON.stringify(tool?.input_schema || {}))
  }
  return tokens
}

/**
 * Rough input-token estimate. Used only to guard prompt caching: Anthropic
 * requires every cached segment to be ≥ 1024 tokens (2048 on some models) and
 * returns a 400 when a cache_control breakpoint sits on a smaller prompt, so
 * we skip breakpoints below a safe margin.
 */
function estimateRequestTokens(req: LLMRequest): number {
  let tokens = 0
  for (const m of req.messages) {
    tokens += estimateContentTokens(m.content)
    for (const tc of m.toolCalls || []) {
      tokens += estimateTextTokens(tc.function.name) + estimateTextTokens(tc.function.arguments)
    }
  }
  for (const t of req.tools || []) {
    tokens += estimateTextTokens(t.function.name) + estimateTextTokens(t.function.description)
    tokens += estimateTextTokens(JSON.stringify(t.function.parameters || {}))
  }
  return tokens
}

/**
 * Add a cache_control breakpoint to a message's LAST content block when that
 * block can carry one (text, or tool_use — tool_result blocks can't). Returns
 * true when a breakpoint was placed. The block array is copied so the
 * caller's request objects are never mutated. `cc` is the cache_control value
 * (plain ephemeral, or ephemeral + ttl: '1h' when the 1h-TTL pref is on).
 */
function addHistoryBreakpoint(m: any, cc: Record<string, unknown>): boolean {
  const content = m.content
  if (typeof content === 'string') {
    if (!content) return false
    m.content = [{ type: 'text', text: content, cache_control: cc }]
    return true
  }
  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1]
    if (last && (last.type === 'text' || last.type === 'tool_use')) {
      m.content = [...content.slice(0, -1), { ...last, cache_control: cc }]
      return true
    }
  }
  return false
}

/** Minimum estimated tokens before cache_control breakpoints are emitted. */
const PROMPT_CACHE_MIN_TOKENS = 2048
/** Minimum estimated tokens for a single cached segment (provider-enforced). */
const MIN_CACHE_SEGMENT_TOKENS = 1024

export class AnthropicAdapter implements LLMAdapter {
  async *sendRequest(req: LLMRequest, config: ApiConfigGroup, signal?: AbortSignal): AsyncGenerator<LLMStreamChunk> {
    const url = buildChatUrl(config.baseUrl, 'anthropic', req.model)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      ...config.customHeaders,
    }
    // Prompt caching (cache_control) needs the beta header on some gateways;
    // harmless on GA accounts.
    if (req.providerCache) {
      headers['anthropic-beta'] = 'prompt-caching-2024-07-31'
    }

    // Prompt caching minimums: each cached segment must be ≥1024 tokens (some
    // models 2048+) or the provider rejects the request with a 400. Only emit
    // breakpoints when the estimated input is comfortably above the minimum.
    const providerCache = !!(req.providerCache && estimateRequestTokens(req) >= PROMPT_CACHE_MIN_TOKENS)

    /**
     * Build the request body. `cache` controls cache_control breakpoints; the
     * body is rebuilt from scratch on the cache fallback path so the previous
     * mutation can't leak into the retry.
     */
    const buildBody = (cache: boolean): { body: Record<string, any>; messages: any[] } => {
      // cache_control value for every breakpoint — plain ephemeral (~5 min TTL),
      // or ttl: '1h' when the user enabled the 1h prompt-cache preference.
      const cc: Record<string, unknown> = req.providerCacheTtl1h
        ? { type: 'ephemeral', ttl: '1h' }
        : { type: 'ephemeral' }
      // Anthropic: separate system message from messages array
      let systemPrompt = ''
      // any[] — the cache_control breakpoint below rewrites a message's content
      // into a block array, which doesn't fit the mapped union type.
      const messages: any[] = req.messages
        .filter((m) => {
          if (m.role === 'system') {
            systemPrompt = m.content
            return false
          }
          return true
        })
        .map((m) => {
          // Tool result messages for Anthropic
          if (m.role === 'tool' && m.toolCallId) {
            return {
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: m.toolCallId,
                  content: m.content,
                },
              ],
            }
          }
          // Assistant messages with tool calls
          if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            const content: any[] = []
            if (m.content) {
              content.push({ type: 'text', text: m.content })
            }
            for (const tc of m.toolCalls) {
              // History replays store arguments as a JSON string; it can be ''
              // (empty-args calls) or partial (a call captured mid-stream), so
              // a throw here would break every subsequent turn of the loop.
              let input: Record<string, any> = {}
              try { input = JSON.parse(tc.function.arguments) } catch { /* keep empty */ }
              content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input,
              })
            }
            return { role: 'assistant' as const, content }
          }
          // Vision: Anthropic takes image blocks before the text so the text
          // block stays last — addHistoryBreakpoint only places cache_control on
          // a trailing text/tool_use block, and images can't carry one.
          if (m.role === 'user' && m.images?.length) {
            const content: any[] = m.images.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mimeType, data: img.dataBase64 },
            }))
            if (m.content) content.push({ type: 'text', text: m.content })
            return { role: 'user' as const, content }
          }
          return {
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }
        })

      const body: Record<string, any> = {
        model: req.model,
        messages,
        max_tokens: req.maxTokens > 0 ? req.maxTokens : 4096,
        stream: req.stream,
        temperature: req.temperature,
        top_p: req.topP,
      }

      // Deep thinking: Anthropic extended thinking maps effort to a token budget
      // (off/low/medium/high/max -> 2048/4096/8192/16384). max_tokens must stay
      // above the budget.
      if (req.thinking) {
        const effortBudgets = { low: 2048, medium: 4096, high: 8192, max: 16384 }
        const budget = effortBudgets[req.reasoningEffort || 'high']
        body.thinking = { type: 'enabled', budget_tokens: budget }
        if (body.max_tokens <= budget) body.max_tokens = budget + 2048
      }

      if (systemPrompt) {
        body.system = systemPrompt
      }

      // Add tools if provided (convert from OpenAI format to Anthropic format)
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        }))
      }

      // Anthropic prompt caching: mark cache_control breakpoints so the repeated
      // prefix (system + tools + conversation history) is billed at the cached
      // read rate instead of full price on every turn.
      if (cache) {
        // The system+tools segment must clear the per-segment minimum on its
        // own, or the provider rejects the whole request with a 400. When the
        // prompt is large only because of the history, skip system/tools
        // breakpoints and let the history breakpoints carry the caching.
        const sysToolsTokens = estimateBodyTokens(body.system, body.tools)
        if (sysToolsTokens >= MIN_CACHE_SEGMENT_TOKENS) {
          if (typeof body.system === 'string' && body.system) {
            body.system = [{ type: 'text', text: body.system, cache_control: cc }]
          }
          // Cache the tools segment: the breakpoint goes on the LAST tool.
          if (Array.isArray(body.tools) && body.tools.length > 0) {
            const last = body.tools[body.tools.length - 1]
            body.tools[body.tools.length - 1] = { ...last, cache_control: cc }
          }
        }
        // Recent-history breakpoint: walk back from the second-to-last message
        // (the final message can't carry cache_control) and place the
        // breakpoint on the last block that can hold one — plain text, or
        // tool_use on assistant messages. Agent-loop turns end on tool_use
        // blocks, so this is what makes the history prefix roll: turn N's
        // request ends on a tool_use block and turn N+1's request shares that
        // byte-identical prefix. tool_result blocks can't carry cache_control
        // and are skipped. A candidate segment below the per-segment minimum
        // would trip a provider 400, so it's skipped in favor of an earlier,
        // longer prefix.
        const msgTokens = messages.map((m) => estimateContentTokens(m.content))
        let acc = estimateBodyTokens(body.system, body.tools)
        // prefixTokens[i] = estimated tokens up to (not including) message i
        const prefixTokens: number[] = []
        for (let i = 0; i < messages.length; i++) {
          prefixTokens.push(acc)
          acc += msgTokens[i]
        }
        const start = Math.max(0, messages.length - 6)
        let recentIdx = -1
        for (let i = messages.length - 2; i >= start; i--) {
          if (prefixTokens[i] + msgTokens[i] < MIN_CACHE_SEGMENT_TOKENS) continue
          if (addHistoryBreakpoint(messages[i], cc)) {
            recentIdx = i
            break
          }
        }
        // Early-history breakpoint: the first plain-text message is byte-stable
        // across turns, so its segment keeps hitting even while the recent
        // segment rolls forward past the provider's ~5min cache window. Only
        // emitted when the prefix up to it clears the per-segment minimum, and
        // never on the message the recent breakpoint already marked.
        if (recentIdx !== 0) {
          for (let i = 0; i < messages.length - 1; i++) {
            if (i === recentIdx) continue
            const m = messages[i]
            if (
              typeof m.content === 'string' && m.content &&
              prefixTokens[i] + msgTokens[i] >= MIN_CACHE_SEGMENT_TOKENS
            ) {
              messages[i] = {
                ...m,
                content: [{ type: 'text', text: m.content, cache_control: cc }],
              }
              break
            }
          }
        }
      }

      return { body, messages }
    }

    const { body } = buildBody(providerCache)
    let response = await llmFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, { stream: true, skipTlsVerify: !!config.skipTlsVerify })

    if (!response.ok) {
      // The provider rejected the cache_control breakpoints (usually a segment
      // below the token minimum) — retry once without prompt caching.
      let errorText = await response.text().catch(() => '')
      if (providerCache && /cache/i.test(errorText)) {
        const { body: retryBody } = buildBody(false)
        response = await llmFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(retryBody),
          signal,
        }, { stream: true, skipTlsVerify: !!config.skipTlsVerify })
        errorText = ''
      }
      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        throw new Error(`Anthropic API 请求失败 (${response.status}): ${errText || response.statusText}`)
      }
    }

    if (!req.stream) {
      const data = await response.json()
      const textBlock = data.content?.find((b: any) => b.type === 'text')
      const toolBlocks = data.content?.filter((b: any) => b.type === 'tool_use') || []
      const toolCalls: LLMToolCall[] = toolBlocks.map((b: any) => ({
        id: b.id,
        type: 'function' as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input),
        },
      }))
      yield {
        content: textBlock?.text || '',
        done: false,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: mapAnthropicUsage(data.usage),
      }
      yield { content: '', done: true }
      return
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const toolCallsAcc: Map<number, { id: string; name: string; arguments: string }> = new Map()
    // Streaming usage arrives split across events: message_start carries
    // input_tokens + cache fields, message_delta carries only output_tokens.
    // Merge the pieces so the run badge sees real input/cache numbers.
    let lastUsage: ParsedUsage | undefined

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)

          try {
            const json = JSON.parse(data)

            if (json.type === 'message_start' && json.message?.usage) {
              lastUsage = mapAnthropicUsage(json.message.usage)
            }

            if (json.type === 'content_block_start') {
              if (json.content_block?.type === 'tool_use') {
                toolCallsAcc.set(json.index, {
                  id: json.content_block.id,
                  name: json.content_block.name,
                  arguments: '',
                })
              }
            }

            if (json.type === 'content_block_delta') {
              if (json.delta?.type === 'text_delta' && json.delta?.text) {
                yield { content: json.delta.text, done: false }
              }
              if (json.delta?.type === 'thinking_delta' && json.delta?.thinking) {
                yield { content: '', thinking: json.delta.thinking, done: false }
              }
              if (json.delta?.type === 'input_json_delta' && json.delta?.partial_json) {
                const acc = toolCallsAcc.get(json.index)
                if (acc) {
                  acc.arguments += json.delta.partial_json
                }
              }
            }

            if (json.type === 'message_delta' && json.usage) {
              lastUsage = mergeUsage(lastUsage, mapAnthropicUsage(json.usage))
              yield {
                content: '',
                done: false,
                usage: lastUsage,
              }
            }

            if (json.type === 'message_stop') {
              // Yield accumulated tool calls if any
              if (toolCallsAcc.size > 0) {
                const toolCalls: LLMToolCall[] = Array.from(toolCallsAcc.values()).map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.name,
                    arguments: tc.arguments,
                  },
                }))
                yield { content: '', toolCalls, done: true }
              } else {
                yield { content: '', done: true }
              }
              return
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async fetchModels(_config: ApiConfigGroup): Promise<string[]> {
    return ANTHROPIC_MODELS
  }
}
