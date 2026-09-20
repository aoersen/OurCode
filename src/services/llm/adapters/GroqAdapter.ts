import { LLMRequest, LLMStreamChunk, ApiConfigGroup, LLMToolCall, normalizeReasoningEffort } from '@/types'
import { LLMAdapter } from '../types'
import { mapOpenAiUsage } from '../usage'
import { llmFetch } from '../http'
import { buildChatUrl, buildModelsUrl } from '../endpoints'
import { openAiVisionContent } from './vision'

/**
 * Groq adapter — uses OpenAI-compatible API with Groq-specific optimizations
 * Supports: llama, mixtral, gemma models on Groq's LPU inference engine
 */
export class GroqAdapter implements LLMAdapter {
  async *sendRequest(req: LLMRequest, config: ApiConfigGroup, signal?: AbortSignal): AsyncGenerator<LLMStreamChunk> {
    const url = buildChatUrl(config.baseUrl, 'openai', req.model)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      ...config.customHeaders,
    }

    const body = {
      model: req.model,
      messages: req.messages.map((m) => {
        const msg: Record<string, any> = { role: m.role, content: m.content }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }))
        }
        if (m.role === 'tool' && m.toolCallId) {
          msg.tool_call_id = m.toolCallId
        }
        const vision = openAiVisionContent(m)
        if (vision) msg.content = vision
        return msg
      }),
      temperature: req.temperature,
      max_tokens: req.maxTokens || undefined,
      top_p: req.topP,
      frequency_penalty: req.frequencyPenalty,
      presence_penalty: req.presencePenalty,
      stream: req.stream,
    }
    // Groq streams omit usage unless asked — without this the run badge
    // never sees token counts.
    if (req.stream) {
      (body as any).stream_options = { include_usage: true }
    }
    // Add tools if provided
    if (req.tools && req.tools.length > 0) {
      (body as any).tools = req.tools
    }
    // Deep thinking: Groq is OpenAI-compatible, reasoning models use `reasoning_effort`
    if (req.thinking) {
      Object.assign(body, { reasoning_effort: normalizeReasoningEffort(req.reasoningEffort) })
    }

    const response = await llmFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, { stream: true, skipTlsVerify: !!config.skipTlsVerify })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Groq API error (${response.status}): ${errorText}`)
    }

    if (req.stream && response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // Groq is OpenAI-compatible: tool calls arrive as delta.tool_calls and
      // must be accumulated (like OpenAIAdapter) or agent loops get empty
      // output. releaseLock in finally so an abort/early break releases the
      // reader (otherwise the underlying stream is never cancelled).
      const toolCallsAcc: Map<number, { id: string; name: string; arguments: string }> = new Map()
      let lastFinishReason: string | undefined

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') {
              const toolCalls = toLlmToolCalls(toolCallsAcc)
              yield { content: '', done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, finishReason: lastFinishReason }
              return
            }

            try {
              const json = JSON.parse(data)
              const delta = json.choices?.[0]?.delta
              if (json.choices?.[0]?.finish_reason) lastFinishReason = json.choices?.[0]?.finish_reason

              if (delta?.content) {
                yield { content: delta.content, done: false }
              }
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

              if (json.x_groq?.usage) {
                yield {
                  content: '',
                  done: false,
                  usage: mapOpenAiUsage(json.x_groq.usage),
                }
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        yield { content: '', done: true, finishReason: lastFinishReason }
      } finally {
        reader.releaseLock()
      }
    } else {
      const json = await response.json()
      const content = json.choices?.[0]?.message?.content || ''

      yield {
        content,
        done: true,
        usage: mapOpenAiUsage(json.usage),
        finishReason: json.choices?.[0]?.finish_reason || undefined,
      }
    }
  }

  async fetchModels(config: ApiConfigGroup, signal?: AbortSignal): Promise<string[]> {
    const url = buildModelsUrl(config.baseUrl, 'openai')
    if (!url) return []
    const response = await llmFetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...config.customHeaders,
      },
      signal,
    }, { skipTlsVerify: !!config.skipTlsVerify })

    if (!response.ok) {
      throw new Error(`获取模型列表失败 (${response.status}): ${response.statusText}`)
    }

    const data = await response.json()
    return data.data?.map((m: { id: string }) => m.id) || []
  }
}

/** Convert the accumulated tool-call map into the LLMToolCall wire format. */
function toLlmToolCalls(acc: Map<number, { id: string; name: string; arguments: string }>): LLMToolCall[] {
  return Array.from(acc.values()).map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.name, arguments: tc.arguments },
  }))
}
