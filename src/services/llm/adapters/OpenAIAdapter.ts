import { ApiConfigGroup, LLMRequest, LLMStreamChunk, LLMToolCall, normalizeReasoningEffort } from '@/types'
import { LLMAdapter } from '../types'
import { mapOpenAiUsage, ParsedUsage } from '../usage'
import { llmFetch } from '../http'
import { buildChatUrl, buildModelsUrl, EndpointFormat } from '../endpoints'
import { openAiVisionContent } from './vision'

/**
 * OpenAI Chat Completions adapter.
 *
 * Also used for Azure OpenAI (deployments URL scheme) via `new OpenAIAdapter('azure')`.
 * The azure `model` field carries the deployment name.
 */
export class OpenAIAdapter implements LLMAdapter {
  constructor(private format: 'openai' | 'azure' = 'openai') {}

  async *sendRequest(req: LLMRequest, config: ApiConfigGroup, signal?: AbortSignal): AsyncGenerator<LLMStreamChunk> {
    const format: EndpointFormat = this.format === 'azure' ? 'azure' : 'openai'
    const url = buildChatUrl(config.baseUrl, format, req.model)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...config.customHeaders,
    }

    const messages = req.messages.map((m) => {
      const msg: Record<string, any> = {
        role: m.role,
        content: m.content,
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }))
      }
      if (m.role === 'tool' && m.toolCallId) {
        msg.tool_call_id = m.toolCallId
      }
      // Vision: content switches to the multi-part form.
      const vision = openAiVisionContent(m)
      if (vision) msg.content = vision
      return msg
    })

    const body: Record<string, any> = {
      model: req.model,
      messages,
      stream: req.stream,
      temperature: req.temperature,
      top_p: req.topP,
      frequency_penalty: req.frequencyPenalty,
      presence_penalty: req.presencePenalty,
    }
    // OpenAI-compatible streams omit usage by default — ask for the final
    // usage chunk so token tracking works (deepseek/groq/etc. all accept it).
    if (req.stream) {
      body.stream_options = { include_usage: true }
    }

    if (req.maxTokens > 0) {
      body.max_tokens = req.maxTokens
    }

    // Add tools if provided
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools
    }

    // Deep thinking: OpenAI reasoning models (o-series) use `reasoning_effort`
    if (req.thinking) {
      body.reasoning_effort = normalizeReasoningEffort(req.reasoningEffort)
    }

    const response = await llmFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, { stream: true, skipTlsVerify: !!config.skipTlsVerify })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`API 请求失败 (${response.status}): ${errorText || response.statusText}`)
    }

    if (!req.stream) {
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content || ''
      const thinking = data.choices?.[0]?.message?.reasoning_content || ''
      const toolCalls = data.choices?.[0]?.message?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }))
      const finishReason = data.choices?.[0]?.finish_reason || undefined
      yield {
        content,
        thinking: thinking || undefined,
        done: false,
        toolCalls,
        usage: mapOpenAiUsage(data.usage),
      }
      yield { content: '', done: true, finishReason }
      return
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const toolCallsAcc: Map<number, { id: string; name: string; arguments: string }> = new Map()
    // Usage arrives in a dedicated final chunk (empty choices) — capture it on
    // ANY chunk and surface it on the done yield, not just content chunks.
    let lastUsage: ParsedUsage | undefined
    // finish_reason rides the terminal chunk; capture it and surface it on the
    // done yield so callers can detect silent overflow (length + zero output).
    let lastFinishReason: string | undefined
    // With stream_options.include_usage the usage chunk comes AFTER the
    // finish_reason chunk — so on tool_calls we must NOT return immediately:
    // keep reading until [DONE], accumulating usage, then emit the calls.
    let pendingToolCalls: LLMToolCall[] | null = null

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
          if (data === '[DONE]') {
            if (pendingToolCalls) {
              yield { content: '', toolCalls: pendingToolCalls, done: true, usage: lastUsage, finishReason: lastFinishReason }
            } else {
              yield { content: '', done: true, usage: lastUsage, finishReason: lastFinishReason }
            }
            return
          }

          try {
            const json = JSON.parse(data)
            const delta = json.choices?.[0]?.delta
            const parsed = mapOpenAiUsage(json.usage)
            if (parsed) {
              lastUsage = parsed
            }

            if (delta?.content) {
              yield {
                content: delta.content,
                done: false,
                usage: parsed,
              }
            }

            // Support reasoning_content (DeepSeek, etc.)
            if (delta?.reasoning_content) {
              yield {
                content: '',
                thinking: delta.reasoning_content,
                done: false,
              }
            }

            // Accumulate tool calls
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCallsAcc.has(idx)) {
                  toolCallsAcc.set(idx, { id: tc.id || '', name: '', arguments: '' })
                }
                const acc = toolCallsAcc.get(idx)!
                if (tc.id) acc.id = tc.id
                if (tc.function?.name) acc.name = tc.function.name
                if (tc.function?.arguments) acc.arguments += tc.function.arguments
              }
            }

            // When finish_reason is tool_calls, remember the accumulated calls
            // but keep reading — the usage chunk (include_usage) trails behind.
            const finishReason = json.choices?.[0]?.finish_reason
            if (finishReason) lastFinishReason = finishReason
            if ((finishReason === 'tool_calls' || finishReason === 'function_call') && !pendingToolCalls) {
              pendingToolCalls = Array.from(toolCallsAcc.values()).map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: tc.arguments,
                },
              }))
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async fetchModels(config: ApiConfigGroup, signal?: AbortSignal): Promise<string[]> {
    const format: EndpointFormat = this.format === 'azure' ? 'azure' : 'openai'
    const url = buildModelsUrl(config.baseUrl, format)
    if (!url) return []
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...config.customHeaders,
    }

    const response = await llmFetch(url, { headers, signal }, { skipTlsVerify: !!config.skipTlsVerify })
    if (!response.ok) {
      throw new Error(`获取模型列表失败 (${response.status}): ${response.statusText}`)
    }

    const data = await response.json()
    // OpenAI /v1/models returns { data: [...] }; Azure deployments returns { value: [...] }
    const list: any[] = data?.data || data?.value || []
    return list.map((m: any) => m.id).filter(Boolean).sort()
  }
}
